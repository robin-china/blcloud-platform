const crypto = require('crypto');
const { getConfig } = require('../lib/config');

const API = 'https://api.weixin.qq.com';

/**
 * 微信 API 专用 fetch。不能裸调 fetch：
 * Node 内置 fetch 会自动补 accept-language: * / sec-fetch-mode: cors 等请求头，
 * 微信接口收到这些头会直接返回空 body，res.json() 就抛
 * 「Unexpected end of JSON input」（微信支付 v3 实测过同一个坑，见 docs/踩坑记录.md）。
 * 这里把可能被微信校验的头全部显式写死，并用 text() + 手动 parse，
 * 空/非 JSON 响应报出 HTTP 状态码和原文片段，而不是难懂的类型错误。
 */
async function wxFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'zh-CN',
      'User-Agent': 'blcloud-admin/1.0',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`微信接口返回了非 JSON 内容（HTTP ${res.status}）：${(text || '空响应').slice(0, 200)}`);
  }
  return { res, data };
}

let tokenCache = { token: '', expiresAt: 0 };

/** 把微信 errcode 翻译成能直接照做的话，避免只知道「失败」却不知下一步 */
function explainWxError(code, defaultMsg = '') {
  const TABLE = {
    40001: 'AppSecret 错误或不匹配（检查后台是否粘错、有没有多余空格）',
    40013: 'AppID 无效',
    40164: '调用 IP 不在白名单：公众号后台「开发 → 基本配置 → IP白名单」加上本机公网 IP',
    40125: 'AppSecret 格式不合法',
    48001: '接口未授权：此接口的「带参数二维码」需要**已认证服务号**，订阅号/未认证号调不了',
    45009: '接口调用超过限额（日调用上限，次日自动恢复）',
    41001: '缺少 access_token 参数',
    42001: 'access_token 已超时',
    61023: 'refresh_token 无效',
    '-1': '微信服务器内部错误，稍后重试',
  };
  const c = Number(code);
  const tip = TABLE[c] || TABLE[String(c)];
  return tip ? `微信 ${code}：${tip}` : `微信 ${code}: ${defaultMsg}`;
}

async function getAccessToken(force = false) {
  const cfg = getConfig('wechat');
  if (!cfg.appid || !cfg.appsecret) throw new Error('未配置服务号 AppID / AppSecret');
  if (!force && tokenCache.token && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.token;
  const { data } = await wxFetch(`${API}/cgi-bin/token?grant_type=client_credential&appid=${cfg.appid}&secret=${cfg.appsecret}`);
  if (data.errcode) throw new Error(explainWxError(data.errcode, data.errmsg));
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 7200) * 1000 };
  return tokenCache.token;
}

async function createQrScene(scene, expireSeconds = 300) {
  const token = await getAccessToken();
  const { data } = await wxFetch(`${API}/cgi-bin/qrcode/create?access_token=${token}`, {
    method: 'POST',
    body: JSON.stringify({
      expire_seconds: expireSeconds,
      action_name: 'QR_STR_SCENE',
      action_info: { scene: { scene_str: String(scene) } },
    }),
  });
  if (data.errcode) throw new Error(explainWxError(data.errcode, data.errmsg));
  return { ticket: data.ticket, url: data.url, qrcodeUrl: `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(data.ticket)}` };
}

async function getUserInfo(openid) {
  const token = await getAccessToken();
  const { data } = await wxFetch(`${API}/cgi-bin/user/info?access_token=${token}&openid=${openid}&lang=zh_CN`);
  if (data.errcode) throw new Error(`获取用户信息失败 ${data.errcode}: ${data.errmsg}`);
  return data;
}

/* ---------------- 公众号网页授权（微信内免扫码登录） ----------------
 * 扫码登录在微信内置浏览器里体验很怪：用户明明已经登录微信，还要再扫一次。
 * 网页授权（OAuth2）可以直接拿到 openid，静默完成登录：
 *   snsapi_base      → 完全静默，只拿 openid（默认）
 *   snsapi_userinfo  → 首次会弹一次「允许授权」，能拿昵称头像
 * 注意：redirect_uri 的域名必须与公众号后台「网页授权域名」一致（不含路径），
 * 且微信只接受 80/443 端口。
 */

/** 生成跳转到微信授权页的地址 */
function oauthAuthorizeUrl(redirectUri, state, scope = 'snsapi_base') {
  const cfg = getConfig('wechat');
  const s = String(scope) === 'snsapi_userinfo' ? 'snsapi_userinfo' : 'snsapi_base';
  return 'https://open.weixin.qq.com/connect/oauth2/authorize'
    + `?appid=${encodeURIComponent(cfg.appid)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + '&response_type=code'
    + `&scope=${s}`
    + `&state=${encodeURIComponent(state)}`
    + '#wechat_redirect';
}

/** code 换网页授权 access_token（同时拿到 openid / unionid / scope） */
async function oauthAccessToken(code) {
  const cfg = getConfig('wechat');
  if (!cfg.appid || !cfg.appsecret) throw new Error('未配置服务号 AppID / AppSecret');
  const url = `${API}/snsapi/oauth2/access_token?appid=${encodeURIComponent(cfg.appid)}`
    + `&secret=${encodeURIComponent(cfg.appsecret)}`
    + `&code=${encodeURIComponent(code)}`
    + '&grant_type=authorization_code';
  const { data } = await wxFetch(url);
  if (data.errcode) {
    // 40029 = code 无效/已用过（用户刷新回调页就会踩到）；40163 = code 已被使用
    const extra = {
      40029: '授权码无效或已被使用（刷新回调页会导致这个错误，请重新打开页面）',
      40163: '授权码已被使用（同一次授权只能换一次，请重新打开页面）',
      41008: '缺少 code 参数',
    }[Number(data.errcode)];
    throw new Error(extra ? `微信 ${data.errcode}：${extra}` : explainWxError(data.errcode, data.errmsg));
  }
  if (!data || !data.openid) {
    // 没报 errcode 却没拿到 openid：没法登录，也必须把微信的原话留进诊断日志，
    // 否则下游只会看到一句莫名其妙的 TypeError（2026-11-08 线上踩过：openid 缺失
    // 一直到建号兜底 `openid.slice(-4)` 才炸，完全看不出是微信响应的问题）。
    // token 类字段的值截断脱敏，errcode/errmsg/scope/unionid 原样保留。
    const redacted = JSON.stringify(data, (k, v) =>
      (/token/i.test(k) && typeof v === 'string' ? `${v.slice(0, 6)}…` : v));
    throw new Error(`微信授权响应未包含 openid，无法确认用户身份：${(redacted || '空响应').slice(0, 300)}`);
  }
  return data;
}

/** snsapi_userinfo 拉昵称头像（静默授权拿不到，只能拿 openid） */
async function oauthUserInfo(accessToken, openid) {
  const url = `${API}/snsapi/userinfo?access_token=${encodeURIComponent(accessToken)}`
    + `&openid=${encodeURIComponent(openid)}&lang=zh_CN`;
  const { data } = await wxFetch(url);
  if (data.errcode) throw new Error(explainWxError(data.errcode, data.errmsg));
  return data;
}

async function sendTemplateMessage(openid, templateId, data, url = '') {
  const token = await getAccessToken();
  const { data: result } = await wxFetch(`${API}/cgi-bin/message/template/send?access_token=${token}`, {
    method: 'POST',
    body: JSON.stringify({ touser: openid, template_id: templateId, url, data }),
  });
  return result;
}

function checkSignature(signature, timestamp, nonce) {
  const cfg = getConfig('wechat');
  const str = [cfg.token, timestamp, nonce].sort().join('');
  return crypto.createHash('sha1').update(str).digest('hex') === signature;
}

/**
 * 安全模式下微信不再用 URL 上的 signature，而是 msg_signature：
 * sha1(sort([token, timestamp, nonce, encrypt]))
 */
function checkMsgSignature(token, timestamp, nonce, msgSignature, encrypt) {
  if (!msgSignature) return false;
  const str = [token, timestamp, nonce, encrypt].sort().join('');
  return crypto.createHash('sha1').update(str).digest('hex') === msgSignature;
}

function decryptMessage(encrypted, aesKey) {
  const key = Buffer.from(`${aesKey}=`, 'base64');
  // 必须用副本：subarray 是共享视图，Node 的 cipher 会原地更新 iv，复用同一 buffer 会出错
  const iv = Buffer.from(key.subarray(0, 16));
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decoded = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
  // 明文结构：16 字节随机数 + 4 字节网络序长度 + 消息体 + AppId
  // （注意是前 16 字节，不是 20：之前写成 20 会多跳过长度字段，
  //   导致消息体开头被吃掉 4 个字节、AppId 恒为空，安全模式回调永远解析不出内容）
  const content = decoded.subarray(16);
  const len = content.readUInt32BE(0);
  const xml = content.subarray(4, 4 + len).toString('utf8');
  const appId = content.subarray(4 + len).toString('utf8');
  return { xml, appId };
}

function parseXml(xml) {
  const out = {};
  let s = String(xml || '');
  // 微信消息的根节点固定是 <xml>...</xml>。必须先剥掉它：
  // 否则最外层 <xml> 会被当成一个字段来解析，把整段内容吞进去，
  // 最终只能得到 { xml: 第一个CDATA的值 }，FromUserName/MsgType/EventKey 全部丢失
  // —— 回调因此永远解析不出内容，扫码后网页不会有任何反应。
  const root = s.match(/^\s*<xml\s*>([\s\S]*)<\/xml\s*>\s*$/i);
  if (root) s = root[1];
  const re = /<([A-Za-z_][\w.-]*)\s*>([\s\S]*?)<\/\1>/g;
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/;
  let m;
  while ((m = re.exec(s))) {
    const v = cdata.test(m[2]) ? cdata.exec(m[2])[1] : m[2];
    out[m[1]] = v;
  }
  return out;
}

function textReply(toUser, fromUser, content) {
  return `<xml><ToUserName><![CDATA[${toUser}]]></ToUserName><FromUserName><![CDATA[${fromUser}]]></FromUserName><CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content></xml>`;
}

module.exports = {
  getAccessToken, createQrScene, getUserInfo, sendTemplateMessage,
  checkSignature, checkMsgSignature, decryptMessage, parseXml, textReply,
  oauthAuthorizeUrl, oauthAccessToken, oauthUserInfo,
};

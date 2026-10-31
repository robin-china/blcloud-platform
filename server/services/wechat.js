const crypto = require('crypto');
const { getConfig } = require('../lib/config');

const API = 'https://api.weixin.qq.com';

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
  const res = await fetch(`${API}/cgi-bin/token?grant_type=client_credential&appid=${cfg.appid}&secret=${cfg.appsecret}`);
  const data = await res.json();
  if (data.errcode) throw new Error(explainWxError(data.errcode, data.errmsg));
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 7200) * 1000 };
  return tokenCache.token;
}

async function createQrScene(scene, expireSeconds = 300) {
  const token = await getAccessToken();
  const res = await fetch(`${API}/cgi-bin/qrcode/create?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expire_seconds: expireSeconds,
      action_name: 'QR_STR_SCENE',
      action_info: { scene: { scene_str: String(scene) } },
    }),
  });
  const data = await res.json();
  if (data.errcode) throw new Error(explainWxError(data.errcode, data.errmsg));
  return { ticket: data.ticket, url: data.url, qrcodeUrl: `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(data.ticket)}` };
}

async function getUserInfo(openid) {
  const token = await getAccessToken();
  const res = await fetch(`${API}/cgi-bin/user/info?access_token=${token}&openid=${openid}&lang=zh_CN`);
  const data = await res.json();
  if (data.errcode) throw new Error(`获取用户信息失败 ${data.errcode}: ${data.errmsg}`);
  return data;
}

async function sendTemplateMessage(openid, templateId, data, url = '') {
  const token = await getAccessToken();
  const res = await fetch(`${API}/cgi-bin/message/template/send?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ touser: openid, template_id: templateId, url, data }),
  });
  return res.json();
}

function checkSignature(signature, timestamp, nonce) {
  const cfg = getConfig('wechat');
  const str = [cfg.token, timestamp, nonce].sort().join('');
  return crypto.createHash('sha1').update(str).digest('hex') === signature;
}

function decryptMessage(encrypted, aesKey) {
  const key = Buffer.from(`${aesKey}=`, 'base64');
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decoded = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
  const content = decoded.subarray(20);
  const len = content.readUInt32BE(0);
  const xml = content.subarray(4, 4 + len).toString('utf8');
  const appId = content.subarray(4 + len).toString('utf8');
  return { xml, appId };
}

function parseXml(xml) {
  const out = {};
  const re = /<([A-Za-z_][\w.-]*)\s*>([\s\S]*?)<\/\1>/g;
  let m;
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/;
  while ((m = re.exec(xml))) {
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
  checkSignature, decryptMessage, parseXml, textReply,
};

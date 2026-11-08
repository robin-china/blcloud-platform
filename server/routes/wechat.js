const db = require('../db');
const crypto = require('crypto');
const { now, genScene } = require('../lib/util');
const { getConfig, devMode, publicUrl } = require('../lib/config');
const { signUser } = require('../lib/auth');
const wechat = require('../services/wechat');
const wxdiag = require('../lib/wxdiag');
const tb = require('../services/tb');
const plans = require('../lib/plans');
const profileLib = require('../lib/profile');
const handoff = require('../lib/handoff');

async function ensureUser(openid, profile = {}) {
  let user = db.prepare('SELECT * FROM users WHERE openid = ?').get(openid);
  if (user) {
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), user.id);
    // 扫码登录默认取微信昵称/头像；用户自己改过资料后（profile_custom=1）不再覆盖。
    // 微信没返回的值也不清空已有资料（服务号未关注时 getUserInfo 常返回空）。
    if (profileLib.syncFromWechat(user, profile)) {
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }
    // 开关后开、或上次开通失败的历史账户：用户再次登录时自动补开，
    // 否则这些账户会永远停在「待激活」，只能靠管理员逐个手工点
    const cfg = getConfig('tb');
    if (cfg.enabled && user.tb_status !== 'active' && user.openid) {
      const res = await tb.provisionUser(user.openid, user.nickname).catch((e) => ({
        username: user.tb_username || '', password: user.tb_password || '', userId: '',
        status: 'error', message: `开通异常：${e && e.message ? e.message : e}`,
      }));
      db.prepare('UPDATE users SET tb_username = ?, tb_password = ?, tb_user_id = ?, tb_status = ?, tb_message = ? WHERE id = ?')
        .run(res.username, res.password, res.userId || '', res.status, res.message || '', user.id);
      console.log(`[tb] 补开 ${res.username} → ${res.status}：${res.message}`);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }
    // 历史账号补发免费档授权：软件端 activate 强制要 license_key，
    // 没有码就登不进来。已有任何授权（含付费）则不发，避免列表里多出废码。
    plans.ensureFreeLicense(user.id);
    return { user, isNew: false };
  }
  // 新用户默认用微信昵称 / 微信头像；服务号没返回昵称时回退「用户XXXX」，
  // 没返回头像则按 openid 稳定分配一张内置卡通头像（账户中心可随时换）。
  const wxAvatar = profileLib.safeAvatar(profile.avatar);
  const initialAvatar = wxAvatar.ok && wxAvatar.value
    ? wxAvatar.value
    : profileLib.defaultAvatar(openid);
  const info = db.prepare('INSERT INTO users (openid, unionid, nickname, avatar, phone, points, status, created_at, last_login_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(openid, profile.unionid || '', profileLib.cleanText(profile.nickname, 24) || `用户${String(openid || '').slice(-4)}`,
      initialAvatar, null, 0, 'active', now(), now());
  user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const cfg = getConfig('tb');
  const suffix = cfg.email_suffix || '@tb.cn';
  db.prepare('UPDATE users SET tb_username = ?, tb_password = ?, tb_status = ?, tb_message = ? WHERE id = ?')
    .run(`${openid}${suffix}`, openid, 'pending', '尚未向物联平台开通', user.id);
  if (cfg.enabled) {
    // 开通失败绝不能吞掉：吞掉之后管理员只能看到「待激活」，完全没有线索
    const res = await tb.provisionUser(openid, user.nickname).catch((e) => ({
      username: `${openid}${suffix}`, password: openid, userId: '', status: 'error',
      message: `开通异常：${e && e.message ? e.message : e}`,
    }));
    if (res) {
      db.prepare('UPDATE users SET tb_username = ?, tb_password = ?, tb_user_id = ?, tb_status = ?, tb_message = ? WHERE id = ?')
        .run(res.username, res.password, res.userId || '', res.status, res.message || '', user.id);
      console.log(`[tb] 开通 ${res.username} → ${res.status}：${res.message}`);
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  db.prepare('INSERT INTO stats_daily (date, new_users) VALUES (?,1) ON CONFLICT(date) DO UPDATE SET new_users = new_users + 1').run(date);
  // 注册即发一张免费档授权码，让所有档位共用同一套 activate / verify / heartbeat 链路
  plans.ensureFreeLicense(user.id);
  return { user, isNew: true };
}

/**
 * 登录页 URL 带 ?agent=CODE 时，前端把渠道码随 qrcode 请求传上来。
 * 存进 scene 后，扫码登录成功的新用户自动归到该代理商名下；
 * 邀请码无效就静默忽略 —— 登录主链路绝不能因为推广参数挂掉。
 */
function resolveAgentId(agentCode) {
  const code = String(agentCode || '').trim().toUpperCase();
  if (!code) return 0;
  const agent = db.prepare("SELECT id FROM users WHERE UPPER(agent_code) = ? AND agent_status = 'active'").get(code);
  return agent ? agent.id : 0;
}

module.exports = async function wechatRoutes(app) {
  // 微信服务器回调发的是 XML。Fastify 默认只解析 JSON，不注册 XML 解析器的话
  // 请求会在 body parser 阶段就被 415 拒掉——handler 一行都执行不到，
  // 表现为「二维码能扫、手机有反应、网页永远不跳转」，且服务端不留任何日志线索。
  app.addContentTypeParser(['text/xml', 'application/xml'], { parseAs: 'string' }, (req, body, done) => {
    done(null, body);
  });

  app.post('/api/wechat/qrcode', async (req, reply) => {
    const cfg = getConfig('wechat');
    const scene = genScene();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const agentId = resolveAgentId((req.body || {}).agent_code);
    if (!cfg.enabled || !cfg.appid || !cfg.appsecret) {
      db.prepare('INSERT INTO wechat_sessions (scene, ticket, qrcode_url, status, openid, user_id, agent_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(scene, '', '', 'pending', '', null, agentId, now(), expiresAt);
      return { scene, mode: 'simulate', qrcode_url: '', expires_at: expiresAt };
    }
    try {
      const qr = await wechat.createQrScene(scene, 300);
      db.prepare('INSERT INTO wechat_sessions (scene, ticket, qrcode_url, status, openid, user_id, agent_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(scene, qr.ticket, qr.qrcodeUrl, 'pending', '', null, agentId, now(), expiresAt);
      return { scene, mode: 'wechat', qrcode_url: qr.qrcodeUrl, url: qr.url, expires_at: expiresAt };
    } catch (e) {
      // 已配置服务号却调用失败，绝不能降级成 simulate：
      // simulate 接口在检测到 appid/appsecret 后会直接 403，用户点「演示登录」依然无反应，
      // 页面就会呈现既无二维码、也无报错、也不动的假死状态。这里必须把原因暴露出去。
      db.prepare('INSERT INTO wechat_sessions (scene, ticket, qrcode_url, status, openid, user_id, agent_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(scene, '', '', 'error', '', null, agentId, now(), expiresAt);
      return { scene, mode: 'error', qrcode_url: '', error: e.message, expires_at: expiresAt };
    }
  });

  app.get('/api/wechat/qrcode/:scene', async (req, reply) => {
    const s = db.prepare('SELECT * FROM wechat_sessions WHERE scene = ?').get(req.params.scene);
    if (!s) return reply.code(404).send({ error: '二维码已失效' });
    if (s.status === 'pending' && new Date(s.expires_at).getTime() < Date.now()) {
      return { status: 'expired' };
    }
    if (s.status === 'confirmed' && s.user_id) {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
      // 走白名单：既展开内置头像，也保证扫码登录响应不带任何内部物联账户字段
      return { status: 'confirmed', token: signUser(user), user: profileLib.publicUser(user) };
    }
    return { status: s.status };
  });

  /* ---------------- 微信内置浏览器：网页授权免扫码登录 ----------------
   * 扫码在微信里体验很别扭（人已经在微信里，还要再扫一次）。
   * 这里走公众号网页授权：/oauth/start 跳微信授权页 → 微信回 /oauth/callback
   * → 换 openid → 复用 ensureUser → 发一张一次性票据，302 回 /user/?t=…
   * 前端 app.js 的 claimHandoff 会自动把票据换成网页登录态。
   *
   * state 用 AppSecret 做 HMAC 自签名，不落库：既能防伪造回调，
   * 又能顺带带上「登录后去哪一页」和代理渠道码（微信会原样回传 state）。
   */
  function signState(payload, secret) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url').slice(0, 24);
    return `${body}.${mac}`;
  }

  function verifyState(state, secret) {
    const [body, mac] = String(state || '').split('.');
    if (!body || !mac) return null;
    const want = crypto.createHmac('sha256', secret).update(body).digest('base64url').slice(0, 24);
    // 长度不等时 timingSafeEqual 会抛错，先比长度
    if (mac.length !== want.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
    try {
      const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      // 10 分钟内有效：用户授权页停留太久就重来，避免陈旧 state 被重放
      if (!o || !o.ts || Date.now() - Number(o.ts) > 10 * 60 * 1000) return null;
      return o;
    } catch { return null; }
  }

  function oauthReady() {
    const cfg = getConfig('wechat');
    return !!(cfg.enabled && cfg.appid && cfg.appsecret);
  }

  app.get('/api/wechat/oauth/start', async (req, reply) => {
    const cfg = getConfig('wechat');
    const to = handoff.page((req.query || {}).to, 'space');
    // 未配置服务号：回登录页，由页面自己走二维码/演示模式
    if (!oauthReady()) {
      return reply.redirect(publicUrl(req, '/user/#/login?wxerr=off'));
    }
    const agent = String((req.query || {}).agent || '').trim().toUpperCase().slice(0, 24);
    // redirect_uri 的域名必须与公众号后台「网页授权域名」一致；
    // 子路径部署也要带 /platform 前缀，否则回调 404
    const redirectUri = publicUrl(req, '/api/wechat/oauth/callback');
    const state = signState({ to, agent, ts: Date.now() }, cfg.appsecret);
    const url = wechat.oauthAuthorizeUrl(redirectUri, state, cfg.oauth_scope || 'snsapi_base');
    wxdiag.push('info', 'oauth', `发起微信网页授权（${cfg.oauth_scope || 'snsapi_base'}）→ ${to}`);
    reply.header('Cache-Control', 'no-store');
    return reply.redirect(url);
  });

  app.get('/api/wechat/oauth/callback', async (req, reply) => {
    const cfg = getConfig('wechat');
    // 失败一律回登录页并带原因，不给用户看裸 JSON（微信内置浏览器里没法处理）
    const back = (reason) => {
      reply.header('Cache-Control', 'no-store');
      return reply.redirect(publicUrl(req, `/user/#/login?wxerr=${encodeURIComponent(reason)}`));
    };
    if (!oauthReady()) return back('off');

    const st = verifyState((req.query || {}).state, cfg.appsecret);
    if (!st) {
      wxdiag.push('warn', 'oauth', '网页授权回调 state 校验失败或已过期（可能停留太久或链接被伪造）');
      return back('state');
    }
    const code = String((req.query || {}).code || '');
    if (!code) {
      wxdiag.push('warn', 'oauth', `网页授权未返回 code（用户可能取消授权），微信提示：${(req.query || {}).errmsg || '-'}`);
      return back('cancel');
    }

    try {
      const tk = await wechat.oauthAccessToken(code);
      // 昵称头像：已关注用户用普通接口就能拿到（静默授权也可以）；
      // 没关注且 scope 是 userinfo 时再调一次网页授权接口
      let profile = { nickname: '', avatar: '', unionid: tk.unionid };
      try {
        const info = await wechat.getUserInfo(tk.openid);
        if (info && info.nickname) {
          profile = { nickname: info.nickname, avatar: info.headimgurl, unionid: info.unionid || tk.unionid };
        }
      } catch { /* 未关注/接口受限都不影响登录，昵称回退系统默认 */ }
      if (!profile.nickname && String(tk.scope || '').includes('snsapi_userinfo') && tk.access_token) {
        try {
          const u = await wechat.oauthUserInfo(tk.access_token, tk.openid);
          profile = { nickname: u.nickname, avatar: u.headimgurl, unionid: u.unionid || tk.unionid };
        } catch { /* 同上 */ }
      }

      const { user, isNew } = await ensureUser(tk.openid, profile);
      if (user.status && user.status !== 'active') {
        wxdiag.push('warn', 'oauth', `账号已停用，拒绝网页授权登录：user=${user.id}`);
        return back('disabled');
      }
      // 与扫码登录一致的渠道归属：只对新建用户生效，老用户已有归属不抢
      const agentId = resolveAgentId(st.agent);
      if (isNew && agentId && !user.agent_id) {
        db.prepare('UPDATE users SET agent_id = ? WHERE id = ?').run(agentId, user.id);
        wxdiag.push('ok', 'oauth', `新用户已归属代理商 #${agentId}`);
      }

      const ticket = handoff.issue(user.id, { ttlMs: 2 * 60 * 1000 });
      wxdiag.push('ok', 'oauth', `微信内免扫码登录成功：${user.nickname || tk.openid}（id=${user.id}）`);
      reply.header('Cache-Control', 'no-store');
      return reply.redirect(publicUrl(req, `/user/?t=${ticket}#/${st.to}`));
    } catch (e) {
      // 只有 e.message 排不了错（2026-11-08：'Cannot read properties of undefined (reading
      // 'slice')' 完全看不出炸在哪），把堆栈首行带上文件行号一起留进诊断
      const at = String(e.stack || '').split('\n').slice(1, 3).map((l) => l.trim()).join(' <- ');
      wxdiag.push('error', 'oauth', `网页授权失败：${e.message}${at ? `｜${at.slice(0, 300)}` : ''}`);
      console.error('[wechat] 网页授权失败:', e.message, '\n', e.stack);
      return back('fail');
    }
  });

  // 开发/演示：模拟扫码。接入真实服务号后强制关闭，避免任意 openid 登录
  app.post('/api/wechat/simulate/:scene', async (req, reply) => {
    const cfg = getConfig('wechat');
    if (cfg.enabled && cfg.appid && cfg.appsecret) {
      return reply.code(403).send({ error: '已接入微信服务号，模拟扫码已停用' });
    }
    if (!devMode()) return reply.code(403).send({ error: '模拟扫码已停用' });
    const openid = String((req.body || {}).openid || `demo${Math.random().toString(36).slice(2, 10)}`);
    const s = db.prepare('SELECT * FROM wechat_sessions WHERE scene = ?').get(req.params.scene);
    if (!s) return reply.code(404).send({ error: '二维码已失效' });
    const { user, isNew } = await ensureUser(openid, {
      nickname: (req.body || {}).nickname || '演示用户',
      avatar: (req.body || {}).avatar || '',
    });
    // 扫码登录新用户按渠道归属代理商（老用户不动，已有归属也不抢）
    if (isNew && s.agent_id && !user.agent_id) {
      db.prepare('UPDATE users SET agent_id = ? WHERE id = ?').run(s.agent_id, user.id);
    }
    db.prepare('UPDATE wechat_sessions SET status = ?, openid = ?, user_id = ? WHERE scene = ?').run('confirmed', openid, user.id, s.scene);
    return { ok: true };
  });

  // 服务号服务器配置验证
  app.get('/api/wechat/server', async (req, reply) => {
    const { signature, timestamp, nonce, echostr } = req.query || {};
    if (!echostr) {
      // 浏览器直接打开：给一句人话，而不是干巴巴的 403
      wxdiag.push('info', 'verify', '收到无 echostr 的 GET（多半是浏览器直接打开），非微信后台验证请求');
      return reply.code(403).send('forbidden');
    }
    if (wechat.checkSignature(signature, timestamp, nonce)) {
      wxdiag.push('ok', 'verify', '微信后台服务器配置验证通过');
      return echostr;
    }
    wxdiag.push('error', 'verify', '服务器配置验证失败：后台填写的「消息校验 Token」与微信后台不一致');
    return reply.code(403).send('forbidden');
  });

  // 服务号事件回调：扫码登录确认
  app.post('/api/wechat/server', async (req, reply) => {
    const q = req.query || {};
    const cfg = getConfig('wechat');
    const raw = typeof req.body === 'string' ? req.body : String((req.body && (req.body.raw || req.body.xml)) || '');
    const mode = q.encrypt_type === 'aes' ? '安全模式' : '明文模式';
    wxdiag.push('info', 'callback', `收到微信推送（${mode}），body ${raw.length} 字节`);
    let msg = wechat.parseXml(raw);

    // 安全模式 / 兼容模式：body 里只有 <Encrypt>，必须先解密再解析
    if (msg.Encrypt && !msg.MsgType) {
      if (!cfg.aes_key) {
        console.error('[wechat] 收到加密回调，但后台未填「消息加密密钥(EncodingAESKey)」，无法解密。'
          + '请到 系统设置→接入配置→微信服务号 填写，或在微信后台把消息加解密方式改成明文模式');
        wxdiag.push('error', 'decrypt', '后台未填「消息加密密钥(EncodingAESKey)」，无法解密安全模式回调');
        msg = {};
        return 'success';
      }
      if (!wechat.checkMsgSignature(cfg.token, q.timestamp, q.nonce, q.msg_signature || '', msg.Encrypt)) {
        console.error('[wechat] msg_signature 校验失败：Token 或 EncodingAESKey 与微信后台不一致');
        wxdiag.push('error', 'signature', 'msg_signature 校验失败：Token 或 EncodingAESKey 与微信后台不一致');
        return reply.code(403).send('forbidden');
      }
      try {
        const d = wechat.decryptMessage(msg.Encrypt, cfg.aes_key);
        // 微信要求校验解密出的 AppId，防止用别的号伪造回调
        if (cfg.appid && d.appId && d.appId !== cfg.appid) {
          console.error(`[wechat] 解密后 AppId 不匹配：${d.appId} ≠ ${cfg.appid}`);
          wxdiag.push('error', 'signature', `解密后 AppId 不匹配：${d.appId} ≠ ${cfg.appid}，疑似伪造回调`);
          return reply.code(403).send('forbidden');
        }
        msg = wechat.parseXml(d.xml);
      } catch (e) {
        console.error('[wechat] 回调解密失败:', e.message, '—— EncodingAESKey 可能填错');
        wxdiag.push('error', 'decrypt', `回调解密失败（${e.message}）：EncodingAESKey 大概率填错`);
        return 'success';
      }
    } else if (!wechat.checkSignature(q.signature, q.timestamp, q.nonce)) {
      wxdiag.push('error', 'signature', '明文模式 signature 校验失败：后台「消息校验 Token」与微信后台不一致');
      return reply.code(403).send('forbidden');
    }

    const openid = msg.FromUserName;
    const toUser = msg.ToUserName;
    console.log(`[wechat] 回调 ${msg.MsgType}${msg.Event ? '/' + msg.Event : ''} from=${openid} key=${msg.EventKey || '-'}`);
    wxdiag.push('info', 'callback', `解析成功：${msg.MsgType}${msg.Event ? '/' + msg.Event : ''} from=${openid || '未知'}`);

    if (msg.MsgType === 'event') {
      const key = String(msg.EventKey || '');
      const scene = msg.Event === 'subscribe' && key.startsWith('qrscene_') ? key.slice(8) : key;
      if (scene) {
        const s = db.prepare('SELECT * FROM wechat_sessions WHERE scene = ?').get(scene);
        if (s) {
          const profile = await wechat.getUserInfo(openid).catch(() => ({}));
          const { user, isNew } = await ensureUser(openid, { nickname: profile.nickname, avatar: profile.headimgurl, unionid: profile.unionid });
          // 扫码登录新用户按渠道归属代理商（老用户不动，已有归属也不抢）
          if (isNew && s.agent_id && !user.agent_id) {
            db.prepare('UPDATE users SET agent_id = ? WHERE id = ?').run(s.agent_id, user.id);
            wxdiag.push('ok', 'login', `新用户已归属代理商 #${s.agent_id}`);
          }
          db.prepare('UPDATE wechat_sessions SET status = ?, openid = ?, user_id = ? WHERE scene = ?').run('confirmed', openid, user.id, scene);
          console.log(`[wechat] 扫码登录成功 scene=${scene} user=${user.id}`);
          wxdiag.push('ok', 'login', `扫码登录成功：用户 ${user.nickname || openid}（id=${user.id}）`);
          reply.type('application/xml; charset=utf-8');
          return wechat.textReply(openid, toUser, '登录成功，请返回网页继续操作。');
        }
        console.warn(`[wechat] 未找到 scene=${scene} 对应的登录会话（可能已过期）`);
        wxdiag.push('warn', 'login', `未找到 scene=${scene} 对应的登录会话（二维码可能已过期，请刷新后重扫）`);
      }
      if (msg.Event === 'subscribe') {
        reply.type('application/xml; charset=utf-8');
        return wechat.textReply(openid, toUser, '欢迎关注！回复「登录」获取登录入口。');
      }
    }
    if (msg.MsgType === 'text' && String(msg.Content || '').includes('登录')) {
      reply.type('application/xml; charset=utf-8');
      return wechat.textReply(openid, toUser, '请在网页端点击微信登录扫码。');
    }
    reply.type('application/xml; charset=utf-8');
    return 'success';
  });

  // 测试：微信配置连通性
  app.post('/api/wechat/test', async (req, reply) => {
    const { requireAdmin } = require('../lib/auth');
    if (!(await requireAdmin(req, reply))) return;
    try {
      const token = await wechat.getAccessToken(true);
      wxdiag.push('ok', 'api', 'AppID / AppSecret 校验通过（拿到 access_token）');
      return { ok: true, message: '服务号配置可用', token: `${token.slice(0, 8)}...` };
    } catch (e) {
      wxdiag.push('error', 'api', `AppID / AppSecret 校验失败：${e.message}`);
      return reply.code(400).send({ error: e.message });
    }
  });

  // 管理后台「回调诊断」：不扫码也能看出微信这套链路卡在哪一步
  app.get('/api/admin/wechat/diag', async (req, reply) => {
    const { requireAdmin } = require('../lib/auth');
    if (!(await requireAdmin(req, reply))) return;
    const { basePath } = require('../lib/config');
    const cfg = getConfig('wechat');
    const events = wxdiag.list(20);
    const has = (v) => !!(v && String(v).trim());
    // 反代部署下也能拼出对外可见的完整地址（配合 TRUST_PROXY=1 拿真实协议/主机名）
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const serverUrl = `${proto}://${host}${basePath()}/api/wechat/server`;
    const problems = [];
    if (!cfg.enabled) problems.push('「微信服务号」开关没打开，扫码登录不会生效');
    if (!has(cfg.appid)) problems.push('未填 AppID');
    if (!has(cfg.appsecret)) problems.push('未填 AppSecret（此项不出二维码）');
    if (!has(cfg.token)) problems.push('未填「消息校验 Token」，微信后台无法验证服务器地址');
    if (!has(cfg.aes_key)) problems.push('未填「消息加密密钥(EncodingAESKey)」：微信后台选了安全/兼容模式就会解不开回调');
    return {
      enabled: !!cfg.enabled,
      has: {
        appid: has(cfg.appid), appsecret: has(cfg.appsecret),
        token: has(cfg.token), aes_key: has(cfg.aes_key),
      },
      appid_tail: cfg.appid ? String(cfg.appid).slice(-6) : '',
      server_url: serverUrl,
      problems,
      events,
    };
  });
};

module.exports.ensureUser = ensureUser;

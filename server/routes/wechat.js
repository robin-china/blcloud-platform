const db = require('../db');
const { now, genScene } = require('../lib/util');
const { getConfig, devMode } = require('../lib/config');
const { signUser } = require('../lib/auth');
const wechat = require('../services/wechat');
const tb = require('../services/tb');

async function ensureUser(openid, profile = {}) {
  let user = db.prepare('SELECT * FROM users WHERE openid = ?').get(openid);
  if (user) {
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), user.id);
    return { user, isNew: false };
  }
  const info = db.prepare('INSERT INTO users (openid, unionid, nickname, avatar, phone, points, status, created_at, last_login_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(openid, profile.unionid || '', profile.nickname || `用户${openid.slice(-4)}`, profile.avatar || '', null, 0, 'active', now(), now());
  user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const cfg = getConfig('tb');
  const suffix = cfg.email_suffix || '@tb.cn';
  db.prepare('UPDATE users SET tb_username = ?, tb_password = ?, tb_status = ? WHERE id = ?')
    .run(`${openid}${suffix}`, openid, 'pending', user.id);
  if (cfg.enabled) {
    const res = await tb.provisionUser(openid, user.nickname).catch(() => null);
    if (res) {
      db.prepare('UPDATE users SET tb_username = ?, tb_password = ?, tb_user_id = ?, tb_status = ? WHERE id = ?')
        .run(res.username, res.password, res.userId || '', res.status, user.id);
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  db.prepare('INSERT INTO stats_daily (date, new_users) VALUES (?,1) ON CONFLICT(date) DO UPDATE SET new_users = new_users + 1').run(date);
  return { user, isNew: true };
}

module.exports = async function wechatRoutes(app) {
  app.post('/api/wechat/qrcode', async (req, reply) => {
    const cfg = getConfig('wechat');
    const scene = genScene();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    if (!cfg.enabled || !cfg.appid || !cfg.appsecret) {
      db.prepare('INSERT INTO wechat_sessions (scene, ticket, qrcode_url, status, openid, user_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(scene, '', '', 'pending', '', null, now(), expiresAt);
      return { scene, mode: 'simulate', qrcode_url: '', expires_at: expiresAt };
    }
    try {
      const qr = await wechat.createQrScene(scene, 300);
      db.prepare('INSERT INTO wechat_sessions (scene, ticket, qrcode_url, status, openid, user_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(scene, qr.ticket, qr.qrcodeUrl, 'pending', '', null, now(), expiresAt);
      return { scene, mode: 'wechat', qrcode_url: qr.qrcodeUrl, url: qr.url, expires_at: expiresAt };
    } catch (e) {
      db.prepare('INSERT INTO wechat_sessions (scene, ticket, qrcode_url, status, openid, user_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(scene, '', '', 'pending', '', null, now(), expiresAt);
      return { scene, mode: 'simulate', qrcode_url: '', error: e.message, expires_at: expiresAt };
    }
  });

  app.get('/api/wechat/qrcode/:scene', async (req, reply) => {
    const s = db.prepare('SELECT * FROM wechat_sessions WHERE scene = ?').get(req.params.scene);
    if (!s) return reply.code(404).send({ error: '二维码已失效' });
    if (s.status === 'pending' && new Date(s.expires_at).getTime() < Date.now()) {
      return { status: 'expired' };
    }
    if (s.status === 'confirmed' && s.user_id) {
      const user = db.prepare('SELECT id, openid, nickname, avatar, phone, points, tb_status FROM users WHERE id = ?').get(s.user_id);
      return { status: 'confirmed', token: signUser(user), user };
    }
    return { status: s.status };
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
    const { user } = await ensureUser(openid, { nickname: (req.body || {}).nickname || '演示用户' });
    db.prepare('UPDATE wechat_sessions SET status = ?, openid = ?, user_id = ? WHERE scene = ?').run('confirmed', openid, user.id, s.scene);
    return { ok: true };
  });

  // 服务号服务器配置验证
  app.get('/api/wechat/server', async (req, reply) => {
    const { signature, timestamp, nonce, echostr } = req.query || {};
    if (wechat.checkSignature(signature, timestamp, nonce)) return echostr;
    return reply.code(403).send('forbidden');
  });

  // 服务号事件回调：扫码登录确认
  app.post('/api/wechat/server', async (req, reply) => {
    const q = req.query || {};
    if (!wechat.checkSignature(q.signature, q.timestamp, q.nonce)) return reply.code(403).send('forbidden');
    let xml = typeof req.body === 'string' ? req.body : (req.body?.xml || '');
    const enc = q.encrypt_type === 'aes';
    if (enc && !xml) {
      const cfg = getConfig('wechat');
      try {
        xml = wechat.decryptMessage(String(req.body?.Encrypt || ''), cfg.aes_key).xml;
      } catch (e) {
        return 'success';
      }
    }
    const msg = wechat.parseXml(xml);
    const openid = msg.FromUserName;
    const toUser = msg.ToUserName;

    if (msg.MsgType === 'event') {
      const key = msg.EventKey || '';
      const scene = msg.Event === 'subscribe' && key.startsWith('qrscene_') ? key.slice(8) : key;
      if (scene) {
        const s = db.prepare('SELECT * FROM wechat_sessions WHERE scene = ?').get(scene);
        if (s) {
          const profile = await wechat.getUserInfo(openid).catch(() => ({}));
          const { user } = await ensureUser(openid, { nickname: profile.nickname, avatar: profile.headimgurl, unionid: profile.unionid });
          db.prepare('UPDATE wechat_sessions SET status = ?, openid = ?, user_id = ? WHERE scene = ?').run('confirmed', openid, user.id, scene);
          return wechat.textReply(openid, toUser, '登录成功，请返回网页继续操作。');
        }
      }
      if (msg.Event === 'subscribe') {
        return wechat.textReply(openid, toUser, '欢迎关注！回复「登录」获取登录入口。');
      }
    }
    if (msg.MsgType === 'text' && String(msg.Content || '').includes('登录')) {
      return wechat.textReply(openid, toUser, '请在网页端点击微信登录扫码。');
    }
    return 'success';
  });

  // 测试：微信配置连通性
  app.post('/api/wechat/test', async (req, reply) => {
    const { requireAdmin } = require('../lib/auth');
    if (!(await requireAdmin(req, reply))) return;
    try {
      const token = await wechat.getAccessToken(true);
      return { ok: true, message: '服务号配置可用', token: `${token.slice(0, 8)}...` };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });
};

module.exports.ensureUser = ensureUser;

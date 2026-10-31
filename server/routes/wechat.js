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
      // 已配置服务号却调用失败，绝不能降级成 simulate：
      // simulate 接口在检测到 appid/appsecret 后会直接 403，用户点「演示登录」依然无反应，
      // 页面就会呈现既无二维码、也无报错、也不动的假死状态。这里必须把原因暴露出去。
      db.prepare('INSERT INTO wechat_sessions (scene, ticket, qrcode_url, status, openid, user_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(scene, '', '', 'error', '', null, now(), expiresAt);
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
    const cfg = getConfig('wechat');
    const raw = typeof req.body === 'string' ? req.body : String((req.body && (req.body.raw || req.body.xml)) || '');
    let msg = wechat.parseXml(raw);

    // 安全模式 / 兼容模式：body 里只有 <Encrypt>，必须先解密再解析
    if (msg.Encrypt && !msg.MsgType) {
      if (!cfg.aes_key) {
        console.error('[wechat] 收到加密回调，但后台未填「消息加密密钥(EncodingAESKey)」，无法解密。'
          + '请到 系统设置→接入配置→微信服务号 填写，或在微信后台把消息加解密方式改成明文模式');
        return 'success';
      }
      if (!wechat.checkMsgSignature(cfg.token, q.timestamp, q.nonce, q.msg_signature || '', msg.Encrypt)) {
        console.error('[wechat] msg_signature 校验失败：Token 或 EncodingAESKey 与微信后台不一致');
        return reply.code(403).send('forbidden');
      }
      try {
        const d = wechat.decryptMessage(msg.Encrypt, cfg.aes_key);
        // 微信要求校验解密出的 AppId，防止用别的号伪造回调
        if (cfg.appid && d.appId && d.appId !== cfg.appid) {
          console.error(`[wechat] 解密后 AppId 不匹配：${d.appId} ≠ ${cfg.appid}`);
          return reply.code(403).send('forbidden');
        }
        msg = wechat.parseXml(d.xml);
      } catch (e) {
        console.error('[wechat] 回调解密失败:', e.message, '—— EncodingAESKey 可能填错');
        return 'success';
      }
    } else if (!wechat.checkSignature(q.signature, q.timestamp, q.nonce)) {
      return reply.code(403).send('forbidden');
    }

    const openid = msg.FromUserName;
    const toUser = msg.ToUserName;
    console.log(`[wechat] 回调 ${msg.MsgType}${msg.Event ? '/' + msg.Event : ''} from=${openid} key=${msg.EventKey || '-'}`);

    if (msg.MsgType === 'event') {
      const key = String(msg.EventKey || '');
      const scene = msg.Event === 'subscribe' && key.startsWith('qrscene_') ? key.slice(8) : key;
      if (scene) {
        const s = db.prepare('SELECT * FROM wechat_sessions WHERE scene = ?').get(scene);
        if (s) {
          const profile = await wechat.getUserInfo(openid).catch(() => ({}));
          const { user } = await ensureUser(openid, { nickname: profile.nickname, avatar: profile.headimgurl, unionid: profile.unionid });
          db.prepare('UPDATE wechat_sessions SET status = ?, openid = ?, user_id = ? WHERE scene = ?').run('confirmed', openid, user.id, scene);
          console.log(`[wechat] 扫码登录成功 scene=${scene} user=${user.id}`);
          reply.type('application/xml; charset=utf-8');
          return wechat.textReply(openid, toUser, '登录成功，请返回网页继续操作。');
        }
        console.warn(`[wechat] 未找到 scene=${scene} 对应的登录会话（可能已过期）`);
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
      return { ok: true, message: '服务号配置可用', token: `${token.slice(0, 8)}...` };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });
};

module.exports.ensureUser = ensureUser;

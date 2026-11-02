/* 软件端开放接口 /api/open/v1/*
 * 两类鉴权：
 *  1) 应用级：X-App-Key + X-Timestamp + X-Nonce + X-Signature（HMAC-SHA256），用于激活、登录等无用户态接口
 *  2) 用户级：Authorization: Bearer <access_token>，登录后访问个人数据
 */
const db = require('../db');
const { now, today, genScene, genCode } = require('../lib/util');
const { getConfig } = require('../lib/config');
const { verifySignature, issueSession, requireClient, getSession, getSessionState, touchSession, revokeSession } = require('../lib/openauth');
const wechatService = require('../services/wechat');
const { ensureUser } = require('../routes/wechat');

const ACCESS_TTL_MS = 2 * 60 * 60 * 1000;

function track(userId, apiKey, endpoint) {
  const date = today();
  db.prepare('INSERT INTO stats_daily (date, api_calls) VALUES (?,1) ON CONFLICT(date) DO UPDATE SET api_calls = api_calls + 1').run(date);
  db.prepare('INSERT INTO api_usage (user_id, api_key, endpoint, calls, date) VALUES (?,?,?,1,?)')
    .run(userId || 0, String(apiKey || ''), endpoint, date);
}

function clientIp(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || '');
}

/* 应用签名守卫 */
async function withApp(req, reply) {
  const r = verifySignature(req);
  if (!r.ok) {
    reply.code(401).send({ error: r.error, code: 'APP_SIGN_INVALID' });
    return null;
  }
  req.app = r.app;
  return r.app;
}

/* 许可证状态判定 */
function licenseState(lic) {
  if (!lic) return { valid: false, reason: '授权不存在', code: 'LICENSE_NOT_FOUND' };
  if (lic.status === 'revoked') return { valid: false, reason: '授权已被吊销', code: 'LICENSE_REVOKED' };
  if (lic.status !== 'active') return { valid: false, reason: '授权未激活', code: 'LICENSE_INACTIVE' };
  if (lic.end_at && new Date(lic.end_at).getTime() < Date.now()) {
    return { valid: false, reason: '授权已过期', code: 'LICENSE_EXPIRED' };
  }
  return { valid: true };
}

function licensePayload(lic) {
  const product = db.prepare('SELECT id, name, type, version, icon FROM products WHERE id = ?').get(lic.product_id);
  const bound = db.prepare('SELECT COUNT(*) AS c FROM license_devices WHERE license_id = ?').get(lic.id).c;
  return {
    license_key: lic.license_key,
    license_id: lic.id,
    product_id: lic.product_id,
    product_name: product ? product.name : '',
    product_type: product ? product.type : '',
    type: lic.type,
    start_at: lic.start_at,
    end_at: lic.end_at,
    status: lic.status,
    max_devices: lic.max_devices,
    bound_devices: bound,
  };
}

function userPayload(u) {
  return {
    id: u.id,
    openid: u.openid,
    nickname: u.nickname,
    avatar: u.avatar,
    phone: u.phone || '',
    points: u.points || 0,
    balance: u.balance || 0,
    tb_status: u.tb_status || 'none',
  };
}

function bindMachine(lic, machineId, opts = {}) {
  const exist = db.prepare('SELECT * FROM license_devices WHERE license_id = ? AND device_sn = ?').get(lic.id, machineId);
  if (exist) {
    db.prepare('UPDATE license_devices SET last_seen_at = ?, last_ip = ?, last_version = ?, machine_id = ?, app_id = ? WHERE id = ?')
      .run(now(), opts.ip || '', opts.version || '', machineId, opts.appId || null, exist.id);
    return { ok: true, reused: true };
  }
  const count = db.prepare('SELECT COUNT(*) AS c FROM license_devices WHERE license_id = ?').get(lic.id).c;
  if (count >= (lic.max_devices || 1)) {
    return { ok: false, reason: '已超出授权允许的机器数量', code: 'MACHINE_LIMIT' };
  }
  db.prepare(`INSERT INTO license_devices (license_id, device_sn, device_name, machine_id, app_id, last_ip, last_version, last_seen_at, bound_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(lic.id, machineId, opts.name || '', machineId, opts.appId || null, opts.ip || '', opts.version || '', now(), now());
  return { ok: true, reused: false };
}

module.exports = async function openRoutes(app) {
  /* ---------------- 应用信息 ---------------- */

  app.get('/api/open/v1/app/version', async (req, reply) => {
    if (!(await withApp(req, reply))) return;
    const a = req.app;
    track(0, a.app_key, 'app.version');
    return {
      version: a.version || '',
      download_url: a.download_url || '',
      release_note: a.release_note || '',
      // 离线宽限天数必须下发，否则「后台配了宽限、客户端根本不知道」，
      // 断网策略只能各自写死。0 = 必须联网校验。
      offline_days: Number(a.offline_days || 0),
      force_update: false,
      server_time: now(),
    };
  });

  /* ---------------- 激活 ---------------- */

  app.post('/api/open/v1/auth/activate', async (req, reply) => {
    if (!(await withApp(req, reply))) return;
    const b = req.body || {};
    const key = String(b.license_key || '').trim();
    const machineId = String(b.machine_id || b.machine || '').trim();
    if (!key) return reply.code(400).send({ error: '缺少 license_key', code: 'PARAM_MISSING' });
    if (!machineId) return reply.code(400).send({ error: '缺少 machine_id', code: 'PARAM_MISSING' });

    const lic = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(key);
    const st = licenseState(lic);
    if (!st.valid) return reply.code(403).send({ valid: false, ...st });

    if (req.app.product_id && lic.product_id !== req.app.product_id) {
      return reply.code(403).send({ valid: false, reason: '授权与当前应用不匹配', code: 'PRODUCT_MISMATCH' });
    }

    const bound = bindMachine(lic, machineId, {
      name: b.machine_name || b.device_name || '',
      version: b.version || '',
      ip: clientIp(req),
      appId: req.app.id,
    });
    if (!bound.ok) return reply.code(409).send({ valid: false, reason: bound.reason, code: bound.code });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lic.user_id);
    if (!user) return reply.code(404).send({ error: '授权所属用户不存在', code: 'USER_NOT_FOUND' });

    const token = issueSession({
      app: req.app,
      user,
      licenseId: lic.id,
      machineId,
      deviceName: b.machine_name || '',
      appVersion: b.version || '',
      ip: clientIp(req),
    });
    track(user.id, req.app.app_key, 'auth.activate');

    return {
      valid: true,
      ...token,
      user: userPayload(user),
      license: licensePayload(lic),
      server_time: now(),
    };
  });

  /* ---------------- 扫码登录 ---------------- */

  app.post('/api/open/v1/auth/qrcode', async (req, reply) => {
    if (!(await withApp(req, reply))) return;
    const cfg = getConfig('wechat');
    const scene = genScene();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    let mode = 'simulate';
    let qrcodeUrl = '';
    let url = '';
    if (cfg.enabled && cfg.appid && cfg.appsecret) {
      try {
        const qr = await wechatService.createQrScene(scene, 300);
        qrcodeUrl = qr.qrcodeUrl;
        url = qr.url;
        mode = 'wechat';
      } catch (e) {
        mode = 'simulate';
      }
    }
    db.prepare('INSERT INTO wechat_sessions (scene, ticket, qrcode_url, status, openid, user_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(scene, '', qrcodeUrl, 'pending', '', null, now(), expiresAt);
    track(0, req.app.app_key, 'auth.qrcode');
    return { scene, mode, qrcode_url: qrcodeUrl, url, expires_at: expiresAt };
  });

  app.get('/api/open/v1/auth/qrcode/:scene', async (req, reply) => {
    const s = db.prepare('SELECT * FROM wechat_sessions WHERE scene = ?').get(String(req.params.scene || ''));
    if (!s) return reply.code(404).send({ error: '二维码已失效', code: 'SCENE_NOT_FOUND' });
    if (s.status === 'pending') {
      if (new Date(s.expires_at).getTime() < Date.now()) return { status: 'expired' };
      return { status: 'pending' };
    }
    if (s.status === 'confirmed' && s.user_id) {
      const appKey = String(req.query.app_key || '');
      const appRow = db.prepare('SELECT * FROM open_apps WHERE app_key = ?').get(appKey);
      if (!appRow) return { status: 'confirmed', need_app_key: true };
      if (appRow.status !== 'active') return reply.code(401).send({ error: '应用已停用', code: 'APP_DISABLED' });
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
      const machineId = String(req.query.machine_id || '');
      const token = issueSession({
        app: appRow, user, machineId,
        deviceName: String(req.query.machine_name || ''),
        appVersion: String(req.query.version || ''),
        ip: clientIp(req),
      });
      track(user.id, appRow.app_key, 'auth.qrcode.login');
      return { status: 'confirmed', ...token, user: userPayload(user) };
    }
    return { status: s.status };
  });

  /* ---------------- 手机号登录 ---------------- */

  app.post('/api/open/v1/auth/sms/send', async (req, reply) => {
    if (!(await withApp(req, reply))) return;
    const phone = String((req.body || {}).phone || '').trim();
    if (!/^1\d{10}$/.test(phone)) return reply.code(400).send({ error: '手机号格式不正确', code: 'PARAM_INVALID' });
    const code = genCode(6);
    db.prepare('INSERT INTO sms_codes (phone, code, used, expires_at) VALUES (?,?,0,?)')
      .run(phone, code, new Date(Date.now() + 5 * 60 * 1000).toISOString());
    track(0, req.app.app_key, 'auth.sms.send');
    return { ok: true, expires_in: 300, dev_code: code };
  });

  app.post('/api/open/v1/auth/login/phone', async (req, reply) => {
    if (!(await withApp(req, reply))) return;
    const { phone, code } = req.body || {};
    const p = String(phone || '').trim();
    if (!/^1\d{10}$/.test(p)) return reply.code(400).send({ error: '手机号格式不正确', code: 'PARAM_INVALID' });
    const row = db.prepare('SELECT * FROM sms_codes WHERE phone = ? AND used = 0 ORDER BY id DESC LIMIT 1').get(p);
    if (!row || row.code !== String(code || '')) return reply.code(400).send({ error: '验证码错误', code: 'CODE_INVALID' });
    if (new Date(row.expires_at).getTime() < Date.now()) return reply.code(400).send({ error: '验证码已过期', code: 'CODE_EXPIRED' });
    db.prepare('UPDATE sms_codes SET used = 1 WHERE id = ?').run(row.id);

    let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(p);
    if (!user) {
      const { user: created } = await ensureUser(`p_${p}`, { nickname: `用户${p.slice(-4)}` });
      db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(p, created.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(created.id);
    }

    const token = issueSession({
      app: req.app, user,
      machineId: String((req.body || {}).machine_id || ''),
      deviceName: String((req.body || {}).machine_name || ''),
      appVersion: String((req.body || {}).version || ''),
      ip: clientIp(req),
    });
    track(user.id, req.app.app_key, 'auth.login.phone');
    return { ...token, user: userPayload(user), is_new: false };
  });

  /* ---------------- 令牌维护 ---------------- */

  app.post('/api/open/v1/auth/refresh', async (req, reply) => {
    const rt = String((req.body || {}).refresh_token || '');
    const s = db.prepare('SELECT * FROM client_sessions WHERE refresh_token = ?').get(rt);
    if (!s || s.status !== 'active') return reply.code(401).send({ error: '刷新令牌无效', code: 'REFRESH_INVALID' });
    if (new Date(s.refresh_expires_at).getTime() < Date.now()) {
      return reply.code(401).send({ error: '刷新令牌已过期，请重新登录', code: 'REFRESH_EXPIRED' });
    }
    const app = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(s.app_id);
    if (!app || app.status !== 'active') return reply.code(401).send({ error: '应用已停用', code: 'APP_DISABLED' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
    revokeSession(s.token);
    const token = issueSession({
      app, user, licenseId: s.license_id, machineId: s.machine_id,
      deviceName: s.device_name, appVersion: s.app_version, ip: clientIp(req),
    });
    return { ...token, user: userPayload(user) };
  });

  app.post('/api/open/v1/auth/logout', async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    revokeSession(req.session.token);
    return { ok: true };
  });

  /* ---------------- 用户资料 ---------------- */

  app.get('/api/open/v1/user/profile', async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    touchSession(req.session, clientIp(req));
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user_id);
    track(user.id, req.app.app_key, 'user.profile');
    return { user: userPayload(user), session_expires_at: req.session.expires_at };
  });

  app.get('/api/open/v1/user/licenses', async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    touchSession(req.session, clientIp(req));
    const list = db.prepare(`SELECT l.*, p.name AS product_name FROM licenses l
      LEFT JOIN products p ON p.id = l.product_id WHERE l.user_id = ? ORDER BY l.id DESC`).all(req.session.user_id);
    track(req.session.user_id, req.app.app_key, 'user.licenses');
    return { list: list.map((l) => ({ ...licensePayload(l), valid: licenseState(l).valid })) };
  });

  app.get('/api/open/v1/user/devices', async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    touchSession(req.session, clientIp(req));
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user_id);
    const cfg = getConfig('tb');
    const list = db.prepare(`SELECT d.*, p.name AS product_name, p.icon FROM devices d
      LEFT JOIN products p ON p.id = d.product_id WHERE d.user_id = ? ORDER BY d.id DESC`).all(req.session.user_id);
    track(req.session.user_id, req.app.app_key, 'user.devices');
    return {
      tb: {
        url: cfg.base_url || '',
        enabled: !!cfg.enabled,
        status: user.tb_status || 'none',
        note: '设备直连使用每台设备的 tb_token（MQTT 用户名）；账户级访问请使用 blcloud API 密钥',
      },
      list: list.map((d) => ({
        id: d.id, sn: d.sn, name: d.name, product_id: d.product_id, product_name: d.product_name,
        status: d.status, tb_device_id: d.tb_device_id || '', tb_token: d.tb_token || '',
        last_seen_at: d.last_seen_at, bound_at: d.bound_at,
      })),
    };
  });

  /* ---------------- 授权校验 / 心跳 / 解绑 ---------------- */

  app.post('/api/open/v1/license/verify', async (req, reply) => {
    const b = req.body || {};
    let appRow = null;
    let lic = null;
    let machineId = String(b.machine_id || b.device_sn || '').trim();
    const tokenSt = getSessionState(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    // 令牌被作废（解绑 / 吊销 / 后台踢下线）时要直说，别让客户端去猜是不是过期
    if (tokenSt.code === 'SESSION_REVOKED') {
      return reply.code(403).send({ valid: false, reason: '该机器已被解绑或授权已吊销，请重新激活', code: 'SESSION_REVOKED' });
    }
    const tokenSess = tokenSt.session;

    if (tokenSess) {
      appRow = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(tokenSess.app_id);
      if (!machineId) machineId = tokenSess.machine_id || '';
      if (tokenSess.license_id) {
        lic = db.prepare('SELECT * FROM licenses WHERE id = ?').get(tokenSess.license_id);
      }
      touchSession(tokenSess, clientIp(req));
    } else {
      const r = verifySignature(req);
      if (!r.ok) return reply.code(401).send({ error: r.error, code: 'APP_SIGN_INVALID' });
      appRow = r.app;
      if (!b.license_key) return reply.code(400).send({ error: '缺少 license_key', code: 'PARAM_MISSING' });
      lic = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(String(b.license_key).trim());
    }

    const st = licenseState(lic);
    if (!st.valid) return reply.code(403).send({ valid: false, ...st });
    if (appRow.product_id && lic.product_id !== appRow.product_id) {
      return reply.code(403).send({ valid: false, reason: '授权与当前应用不匹配', code: 'PRODUCT_MISMATCH' });
    }

    let boundInfo = null;
    if (machineId) {
      const d = db.prepare('SELECT * FROM license_devices WHERE license_id = ? AND device_sn = ?').get(lic.id, machineId);
      if (!d) {
        return reply.code(403).send({ valid: false, reason: '该机器未激活此授权', code: 'MACHINE_NOT_BOUND' });
      }
      db.prepare('UPDATE license_devices SET last_seen_at = ?, last_ip = ?, last_version = ? WHERE id = ?')
        .run(now(), clientIp(req), String(b.version || ''), d.id);
      boundInfo = { machine_id: machineId, bound_at: d.bound_at };
    }

    const user = db.prepare('SELECT id, nickname FROM users WHERE id = ?').get(lic.user_id);
    track(lic.user_id, appRow.app_key, 'license.verify');
    return {
      valid: true,
      license: licensePayload(lic),
      user: user ? { id: user.id, nickname: user.nickname } : null,
      machine: boundInfo,
      server_time: now(),
    };
  });

  app.post('/api/open/v1/license/heartbeat', async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    const b = req.body || {};
    touchSession(req.session, clientIp(req));
    let lic = req.session.license_id ? db.prepare('SELECT * FROM licenses WHERE id = ?').get(req.session.license_id) : null;
    if (!lic && b.license_key) lic = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(String(b.license_key).trim());
    const payload = { valid: false, server_time: now() };
    if (!lic) return { ...payload, reason: '会话未绑定授权', code: 'LICENSE_NOT_BOUND' };
    const st = licenseState(lic);
    if (!st.valid) return { valid: false, reason: st.reason, code: st.code, server_time: now() };

    if (req.session.machine_id) {
      // 必须确认这台机器仍然绑在这张授权上：后台/用户自助解绑之后，
      // 老令牌不能继续 valid=true —— 否则「解绑」只是清了个名单，
      // 占着名额的客户端还能照常用下去。
      const bound = db.prepare('SELECT id FROM license_devices WHERE license_id = ? AND device_sn = ?')
        .get(lic.id, req.session.machine_id);
      if (!bound) {
        return { valid: false, reason: '该机器已解绑此授权，请重新激活', code: 'MACHINE_NOT_BOUND', server_time: now() };
      }
      db.prepare('UPDATE license_devices SET last_seen_at = ?, last_version = ? WHERE id = ?')
        .run(now(), String(b.version || ''), bound.id);
    }
    db.prepare('UPDATE client_sessions SET app_version = ? WHERE id = ?').run(String(b.version || req.session.app_version || ''), req.session.id);
    track(req.session.user_id, req.app.app_key, 'license.heartbeat');
    return {
      valid: true,
      license: licensePayload(lic),
      expires_at: req.session.expires_at,
      server_time: now(),
    };
  });

  app.post('/api/open/v1/license/unbind', async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    const b = req.body || {};
    const machineId = String(b.machine_id || req.session.machine_id || '').trim();
    if (!machineId) return reply.code(400).send({ error: '缺少 machine_id', code: 'PARAM_MISSING' });
    let lic = req.session.license_id ? db.prepare('SELECT * FROM licenses WHERE id = ?').get(req.session.license_id) : null;
    if (!lic && b.license_key) lic = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(String(b.license_key).trim());
    if (!lic) return reply.code(404).send({ error: '未找到授权', code: 'LICENSE_NOT_FOUND' });
    if (lic.user_id !== req.session.user_id) return reply.code(403).send({ error: '无权操作该授权', code: 'FORBIDDEN' });
    db.prepare('DELETE FROM license_devices WHERE license_id = ? AND device_sn = ?').run(lic.id, machineId);
    // 只踢掉被解绑的那台机器的会话，其他设备不受影响
    db.prepare('UPDATE client_sessions SET status = ? WHERE license_id = ? AND machine_id = ?')
      .run('revoked', lic.id, machineId);
    if (machineId === req.session.machine_id) {
      db.prepare('UPDATE client_sessions SET status = ? WHERE id = ?').run('revoked', req.session.id);
    }
    return { ok: true, license: licensePayload(lic) };
  });

  /* ---------------- 遥测上报 ---------------- */

  app.post('/api/open/v1/telemetry', async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    const b = req.body || {};
    track(req.session.user_id, req.app.app_key, 'telemetry');
    db.prepare('UPDATE client_sessions SET last_seen_at = ?, app_version = ? WHERE id = ?')
      .run(now(), String(b.version || req.session.app_version || ''), req.session.id);
    return { ok: true, server_time: now() };
  });
};

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { now, hashPassword, verifyPassword } = require('../lib/util');
const { signAdmin, requireAdmin } = require('../lib/auth');
const { basePath, getSetting, setSetting, allSettings, getConfig, setConfig, getConfigMasked, DEFAULTS } = require('../lib/config');
const tb = require('../services/tb');
const wxpay = require('../services/wxpay');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 失败计数窗口
const LOGIN_MAX_FAIL = 5;               // 窗口内最大失败次数

function clientIp(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
}

function recentFailures(username) {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS).toISOString();
  return db.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE username = ? AND success = 0 AND created_at > ?')
    .get(String(username || ''), since).c;
}

function recordAttempt(username, ip, success) {
  try {
    db.prepare('INSERT INTO login_attempts (username, ip, success, created_at) VALUES (?,?,?,?)')
      .run(String(username || ''), String(ip || ''), success ? 1 : 0, now());
  } catch { /* 审计失败不影响主流程 */ }
}

function clearAttempts(username) {
  try {
    db.prepare('DELETE FROM login_attempts WHERE username = ?').run(String(username || ''));
  } catch { /* ignore */ }
}

function logAdmin(req, action, detail = '') {
  try {
    db.prepare('INSERT INTO admin_logs (admin_id, admin_name, action, detail, created_at) VALUES (?,?,?,?,?)')
      .run(req.admin?.sub || 0, req.admin?.username || '', action, detail, now());
  } catch { /* ignore */ }
}

module.exports = async function adminRoutes(app) {
  app.post('/api/admin/login', async (req, reply) => {
    const { username, password } = req.body || {};
    const ip = clientIp(req);
    if (recentFailures(username) >= LOGIN_MAX_FAIL) {
      return reply.code(429).send({ error: '登录失败次数过多，请 15 分钟后重试' });
    }
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || ''));
    if (!admin || !verifyPassword(String(password || ''), admin.password_hash)) {
      recordAttempt(username, ip, false);
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    if (admin.status !== 'active') return reply.code(403).send({ error: '账号已停用' });
    clearAttempts(username);
    db.prepare('UPDATE admins SET last_login_at = ? WHERE id = ?').run(now(), admin.id);
    return {
      token: signAdmin(admin),
      must_change_password: Number(admin.must_change_password || 0) === 1,
      admin: { id: admin.id, username: admin.username, name: admin.name, role: admin.role },
    };
  });

  app.get('/api/admin/me', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const admin = db.prepare('SELECT id, username, name, role, last_login_at FROM admins WHERE id = ?').get(req.admin.sub);
    return { admin };
  });

  app.post('/api/admin/password', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const { oldPassword, newPassword } = req.body || {};
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.sub);
    if (!verifyPassword(String(oldPassword || ''), admin.password_hash)) {
      return reply.code(400).send({ error: '原密码不正确' });
    }
    if (String(newPassword || '').length < 8) return reply.code(400).send({ error: '新密码至少 8 位' });
    db.prepare('UPDATE admins SET password_hash = ?, must_change_password = 0 WHERE id = ?')
      .run(hashPassword(String(newPassword || '')), admin.id);
    logAdmin(req, '修改密码');
    return { ok: true };
  });

  app.get('/api/admin/list', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { list: db.prepare('SELECT id, username, name, role, status, last_login_at, created_at FROM admins ORDER BY id').all() };
  });

  app.post('/api/admin/create', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const { username, password, name, role } = req.body || {};
    if (!username || !password) return reply.code(400).send({ error: '用户名和密码必填' });
    const exists = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
    if (exists) return reply.code(400).send({ error: '用户名已存在' });
    db.prepare('INSERT INTO admins (username, password_hash, name, role, status, created_at) VALUES (?,?,?,?,?,?)')
      .run(username, hashPassword(String(password)), name || username, role || 'admin', 'active', now());
    logAdmin(req, '新增管理员', username);
    return { ok: true };
  });

  app.post('/api/admin/:id/update', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = Number(req.params.id);
    const { name, role, status, password } = req.body || {};
    if (password) db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(String(password)), id);
    db.prepare('UPDATE admins SET name = COALESCE(?, name), role = COALESCE(?, role), status = COALESCE(?, status) WHERE id = ?')
      .run(name || null, role || null, status || null, id);
    return { ok: true };
  });

  app.delete('/api/admin/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = Number(req.params.id);
    if (id === req.admin.sub) return reply.code(400).send({ error: '不能删除当前登录账号' });
    db.prepare('DELETE FROM admins WHERE id = ?').run(id);
    return { ok: true };
  });

  app.get('/api/settings', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const all = allSettings();
    const site = {};
    for (const [k, v] of Object.entries(all)) if (!k.startsWith('cfg.')) site[k] = v;
    return { settings: site };
  });

  app.post('/api/settings', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const patch = req.body || {};
    for (const [k, v] of Object.entries(patch)) {
      if (k.startsWith('cfg.')) continue;
      setSetting(k, v);
    }
    logAdmin(req, '更新站点设置');
    return { ok: true };
  });

  app.get('/api/settings/integration', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const out = {};
    for (const name of Object.keys(DEFAULTS)) out[name] = getConfigMasked(name);
    return { config: out };
  });

  app.get('/api/settings/integration/:name', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { config: getConfigMasked(req.params.name) };
  });

  app.post('/api/settings/integration/:name', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const name = req.params.name;
    if (!DEFAULTS[name]) return reply.code(400).send({ error: '未知配置' });
    const cfg = setConfig(name, req.body || {});
    logAdmin(req, '更新接入配置', name);
    return { ok: true, config: getConfigMasked(name), enabled: cfg.enabled };
  });

  app.post('/api/upload', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: '未收到文件' });
    const ext = path.extname(data.filename || '').toLowerCase() || '.png';
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const target = path.join(UPLOAD_DIR, name);
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(target);
      data.file.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });
    return { url: `${basePath()}/uploads/${name}` };
  });

  app.post('/api/settings/integration/test/wxpay', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    try {
      const r = await wxpay.testConfig();
      return { ok: true, message: r.message };
    } catch (e) {
      const extra = getConfig('wxpay').platform_cert
        ? '（当前配置了手动平台证书，不代表线上可用，建议清空后重测）' : '';
      return reply.code(400).send({ error: `微信支付配置不可用：${e.message}${extra}` });
    }
  });

  app.post('/api/settings/integration/test/tb', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    try {
      const token = await tb.adminToken(true);
      const me = await tb.request('GET', '/api/auth/user', null, token);
      return { ok: true, message: `连接成功：${me.email || '已认证'}` };
    } catch (e) {
      return reply.code(400).send({ error: `连接失败：${e.message}` });
    }
  });

  app.get('/api/admin/logs', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    return { list: db.prepare('SELECT * FROM admin_logs ORDER BY id DESC LIMIT ?').all(limit) };
  });
};

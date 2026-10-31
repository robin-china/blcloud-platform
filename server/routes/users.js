const db = require('../db');
const { now } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');
const tb = require('../services/tb');

function bumpDaily(field, delta = 1) {
  const date = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO stats_daily (date, ${field}) VALUES (?, ?)
    ON CONFLICT(date) DO UPDATE SET ${field} = ${field} + ?`).run(date, delta, delta);
}

module.exports = async function userRoutes(app) {
  app.get('/api/users', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
    const where = [];
    const args = [];
    if (q) { where.push('(nickname LIKE ? OR phone LIKE ? OR openid LIKE ? OR tb_username LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    if (status) { where.push('status = ?'); args.push(status); }
    const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM users ${wsql}`).get(...args).c;
    const list = db.prepare(`SELECT u.*,
      (SELECT COUNT(*) FROM licenses l WHERE l.user_id = u.id AND l.status='active') AS license_count,
      (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id) AS device_count,
      (SELECT IFNULL(SUM(o.pay_amount),0) FROM orders o WHERE o.user_id = u.id AND o.status='paid') AS total_paid
      FROM users u ${wsql} ORDER BY u.id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
    return { total, page, pageSize, list };
  });

  app.get('/api/users/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = Number(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    const licenses = db.prepare(`SELECT l.*, p.name AS product_name, p.type AS product_type
      FROM licenses l LEFT JOIN products p ON p.id = l.product_id WHERE l.user_id = ? ORDER BY l.id DESC`).all(id);
    const devices = db.prepare(`SELECT d.*, p.name AS product_name FROM devices d LEFT JOIN products p ON p.id = d.product_id WHERE d.user_id = ? ORDER BY d.id DESC`).all(id);
    const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(id);
    const points = db.prepare('SELECT * FROM points_logs WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(id);
    const apiKeys = db.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY id DESC').all(id);
    return { user, licenses, devices, orders, points, apiKeys };
  });

  app.post('/api/users/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = Number(req.params.id);
    const b = req.body || {};
    db.prepare(`UPDATE users SET nickname = COALESCE(?, nickname), phone = COALESCE(?, phone),
      status = COALESCE(?, status), remark = COALESCE(?, remark) WHERE id = ?`)
      .run(b.nickname ?? null, b.phone ?? null, b.status ?? null, b.remark ?? null, id);
    return { ok: true };
  });

  app.post('/api/users/:id/points', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = Number(req.params.id);
    const change = Number((req.body || {}).change || 0);
    const reason = String((req.body || {}).reason || '管理员调整');
    if (!change) return reply.code(400).send({ error: '积分变动不能为 0' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    const balance = Math.max(0, (user.points || 0) + change);
    db.prepare('UPDATE users SET points = ? WHERE id = ?').run(balance, id);
    db.prepare('INSERT INTO points_logs (user_id, change, balance, reason, created_at) VALUES (?,?,?,?,?)')
      .run(id, change, balance, reason, now());
    return { balance };
  });

  app.post('/api/users/:id/tb-provision', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = Number(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    if (!user.openid) return reply.code(400).send({ error: '用户缺少 openid，无法生成 TB 账户' });
    const res = await tb.provisionUser(user.openid, user.nickname);
    db.prepare(`UPDATE users SET tb_username = ?, tb_password = ?, tb_user_id = ?, tb_status = ? WHERE id = ?`)
      .run(res.username, res.password, res.userId || '', res.status, id);
    return { ok: true, tb: res };
  });

  app.post('/api/users/:id/devices', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = Number(req.params.id);
    const b = req.body || {};
    if (!b.sn) return reply.code(400).send({ error: 'SN 必填' });
    const exists = db.prepare('SELECT id FROM devices WHERE sn = ?').get(b.sn);
    if (exists) return reply.code(400).send({ error: '该 SN 已存在' });
    let tbDeviceId = '';
    let tbToken = '';
    try {
      const created = await tb.createDevice({ name: b.sn, type: b.model || 'default' });
      tbDeviceId = created.deviceId || '';
      tbToken = created.token || '';
    } catch (e) {
      tbDeviceId = '';
      tbToken = '';
    }
    db.prepare(`INSERT INTO devices (user_id, product_id, sn, name, model, tb_device_id, tb_token, status, bound_at)
      VALUES (?,?,?,?,?,?,?, 'online', ?)`)
      .run(id, Number(b.product_id) || null, b.sn, b.name || b.sn, b.model || '', tbDeviceId, tbToken, now());
    return { ok: true, tbDeviceId };
  });

  app.delete('/api/devices/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    db.prepare('DELETE FROM devices WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });

  app.post('/api/users/:id/status', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(String((req.body || {}).status || 'active'), Number(req.params.id));
    return { ok: true };
  });
};

module.exports.bumpDaily = bumpDaily;

const db = require('../db');
const { now, genLicenseKey } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');

function addDays(days) {
  const d = new Date(Date.now() + Number(days) * 86400000);
  return d.toISOString();
}

module.exports = async function licenseRoutes(app) {
  app.get('/api/licenses', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
    const where = [];
    const args = [];
    if (q) { where.push('(l.license_key LIKE ? OR u.nickname LIKE ? OR u.phone LIKE ? OR p.name LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    if (status) { where.push('l.status = ?'); args.push(status); }
    const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM licenses l LEFT JOIN users u ON u.id=l.user_id LEFT JOIN products p ON p.id=l.product_id ${wsql}`).get(...args).c;
    const list = db.prepare(`SELECT l.*, u.nickname, u.phone, p.name AS product_name, p.type AS product_type,
      (SELECT COUNT(*) FROM license_devices d WHERE d.license_id = l.id) AS bound_devices
      FROM licenses l LEFT JOIN users u ON u.id=l.user_id LEFT JOIN products p ON p.id=l.product_id
      ${wsql} ORDER BY l.id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
    return { total, page, pageSize, list };
  });

  app.post('/api/licenses', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    const userId = Number(b.user_id);
    const productId = Number(b.product_id);
    if (!userId || !productId) return reply.code(400).send({ error: '用户与产品必填' });
    const type = b.type || 'permanent';
    const days = Number(b.days) || 365;
    const key = b.license_key || genLicenseKey();
    const info = db.prepare(`INSERT INTO licenses (license_key, user_id, product_id, type, max_devices, start_at, end_at, status, order_id, remark, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(key, userId, productId, type, Number(b.max_devices) || 1, now(), type === 'permanent' ? null : addDays(days),
        'active', Number(b.order_id) || null, b.remark || '', now());
    return { id: info.lastInsertRowid, license_key: key };
  });

  app.post('/api/licenses/:id/revoke', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    db.prepare('UPDATE licenses SET status = ? WHERE id = ?').run('revoked', Number(req.params.id));
    return { ok: true };
  });

  app.post('/api/licenses/:id/resume', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    db.prepare('UPDATE licenses SET status = ? WHERE id = ?').run('active', Number(req.params.id));
    return { ok: true };
  });

  app.post('/api/licenses/:id/extend', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const days = Number((req.body || {}).days || 30);
    const lic = db.prepare('SELECT * FROM licenses WHERE id = ?').get(Number(req.params.id));
    if (!lic) return reply.code(404).send({ error: '授权不存在' });
    const base = lic.end_at && new Date(lic.end_at).getTime() > Date.now() ? new Date(lic.end_at) : new Date();
    db.prepare('UPDATE licenses SET end_at = ?, status = ? WHERE id = ?')
      .run(new Date(base.getTime() + days * 86400000).toISOString(), 'active', lic.id);
    return { ok: true };
  });

  app.delete('/api/licenses/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    db.prepare('DELETE FROM licenses WHERE id = ?').run(Number(req.params.id));
    db.prepare('DELETE FROM license_devices WHERE license_id = ?').run(Number(req.params.id));
    return { ok: true };
  });

  app.get('/api/licenses/:id/devices', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { list: db.prepare('SELECT * FROM license_devices WHERE license_id = ? ORDER BY id DESC').all(Number(req.params.id)) };
  });

  app.delete('/api/license-devices/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    db.prepare('DELETE FROM license_devices WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });
};

module.exports.addDays = addDays;

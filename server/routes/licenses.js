const db = require('../db');
const { now, genLicenseKey } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');
const { logAdmin } = require('../lib/adminlog');

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
    const product = db.prepare('SELECT id, name, type FROM products WHERE id = ?').get(productId);
    if (!product) return reply.code(404).send({ error: '产品不存在' });
    // 服务类（API 额度包）发的是调用次数，不是授权码；发错了用户端会多出一条永远用不上的授权
    if (product.type === 'service') {
      return reply.code(400).send({ error: `「${product.name}」是服务类商品，应发放 API 额度而不是授权码` });
    }
    const type = b.type || 'permanent';
    const days = Number(b.days) || 365;
    const key = b.license_key || genLicenseKey();
    if (db.prepare('SELECT 1 FROM licenses WHERE license_key = ?').get(key)) {
      return reply.code(400).send({ error: '该授权码已存在，请换一个' });
    }
    const info = db.prepare(`INSERT INTO licenses (license_key, user_id, product_id, type, max_devices, start_at, end_at, status, order_id, remark, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(key, userId, productId, type, Number(b.max_devices) || 1, now(), type === 'permanent' ? null : addDays(days),
        'active', Number(b.order_id) || null, b.remark || '', now());
    logAdmin(req, '发放授权', `${product.name} → 用户#${userId}，码 ${key}`);
    return { id: info.lastInsertRowid, license_key: key };
  });

  /**
   * 批量发码：渠道 / 线下客户 / OEM 一次要几十上百个码，
   * 一条条点「发放授权」不现实。整批在一个事务里，要么全成要么全不成。
   */
  app.post('/api/licenses/batch', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    const userId = Number(b.user_id);
    const productId = Number(b.product_id);
    if (!userId || !productId) return reply.code(400).send({ error: '用户与产品必填' });
    const product = db.prepare('SELECT id, name FROM products WHERE id = ?').get(productId);
    if (!product) return reply.code(404).send({ error: '产品不存在' });
    const count = Math.min(Math.max(Number(b.count) || 1, 1), 200);
    const type = b.type || 'permanent';
    const days = Number(b.days) || 365;
    const maxDevices = Math.max(Number(b.max_devices) || 1, 1);
    const remark = String(b.remark || '批量发放');
    const startAt = now();
    const endAt = type === 'permanent' ? null : addDays(days);

    const insert = db.prepare(`INSERT INTO licenses (license_key, user_id, product_id, type, max_devices, start_at, end_at, status, order_id, remark, created_at)
      VALUES (?,?,?,?,?,?,?,'active',NULL,?,?)`);
    const exists = db.prepare('SELECT 1 FROM licenses WHERE license_key = ?');
    const keys = [];
    const run = db.transaction(() => {
      for (let i = 0; i < count; i += 1) {
        let key = genLicenseKey();
        for (let t = 0; t < 5 && exists.get(key); t += 1) key = genLicenseKey();
        insert.run(key, userId, productId, type, maxDevices, startAt, endAt, remark, startAt);
        keys.push(key);
      }
    });
    run();
    logAdmin(req, '批量发放授权', `${product.name} → 用户#${userId}，共 ${keys.length} 个（${keys[0]} … ${keys[keys.length - 1]}）`);
    return { ok: true, count: keys.length, license_keys: keys, product: product.name };
  });

  app.post('/api/licenses/:id/revoke', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    db.prepare('UPDATE licenses SET status = ? WHERE id = ?').run('revoked', Number(req.params.id));
    // 吊销即刻生效：把这张授权下的客户端会话一起作废，别等对方下次心跳
    db.prepare('UPDATE client_sessions SET status = ? WHERE license_id = ?').run('revoked', Number(req.params.id));
    logAdmin(req, '吊销授权', `#${req.params.id}`);
    return { ok: true };
  });

  app.post('/api/licenses/:id/resume', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    db.prepare('UPDATE licenses SET status = ? WHERE id = ?').run('active', Number(req.params.id));
    logAdmin(req, '恢复授权', `#${req.params.id}`);
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
    logAdmin(req, '授权续期', `${lic.license_key} +${days} 天`);
    return { ok: true };
  });

  app.delete('/api/licenses/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const lic = db.prepare('SELECT license_key FROM licenses WHERE id = ?').get(Number(req.params.id));
    db.prepare('DELETE FROM licenses WHERE id = ?').run(Number(req.params.id));
    db.prepare('DELETE FROM license_devices WHERE license_id = ?').run(Number(req.params.id));
    logAdmin(req, '删除授权', lic ? lic.license_key : `#${req.params.id}`);
    return { ok: true };
  });

  app.get('/api/licenses/:id/devices', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { list: db.prepare('SELECT * FROM license_devices WHERE license_id = ? ORDER BY id DESC').all(Number(req.params.id)) };
  });

  app.delete('/api/license-devices/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const d = db.prepare('SELECT * FROM license_devices WHERE id = ?').get(Number(req.params.id));
    if (!d) return reply.code(404).send({ error: '绑定记录不存在' });
    db.prepare('DELETE FROM license_devices WHERE id = ?').run(d.id);
    // 解绑必须连带踢会话：否则这台机器拿着老 token 还能继续调接口
    db.prepare('UPDATE client_sessions SET status = ? WHERE license_id = ? AND machine_id = ?')
      .run('revoked', d.license_id, d.device_sn);
    logAdmin(req, '解绑授权设备', `授权#${d.license_id} 机器 ${d.device_sn}`);
    return { ok: true };
  });
};

module.exports.addDays = addDays;

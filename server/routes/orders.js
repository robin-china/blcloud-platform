const db = require('../db');
const { now, safeJson, genOrderNo } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');
const wxpay = require('../services/wxpay');
const tb = require('../services/tb');
const { addDays } = require('./licenses');

module.exports = async function orderRoutes(app) {
  app.get('/api/orders', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const channel = String(req.query.channel || '').trim();
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
    const where = [];
    const args = [];
    if (q) { where.push('(o.order_no LIKE ? OR u.nickname LIKE ? OR u.phone LIKE ? OR o.trade_no LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    if (status) { where.push('o.status = ?'); args.push(status); }
    if (channel) { where.push('o.channel = ?'); args.push(channel); }
    const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM orders o LEFT JOIN users u ON u.id=o.user_id ${wsql}`).get(...args).c;
    const list = db.prepare(`SELECT o.*, u.nickname, u.phone FROM orders o LEFT JOIN users u ON u.id=o.user_id
      ${wsql} ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
    return { total, page, pageSize, list: list.map((o) => ({ ...o, items: safeJson(o.items, []) })) };
  });

  app.get('/api/orders/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
    if (!order) return reply.code(404).send({ error: '订单不存在' });
    const user = db.prepare('SELECT id, nickname, phone, openid FROM users WHERE id = ?').get(order.user_id);
    const payments = db.prepare('SELECT * FROM payments WHERE order_no = ?').all(order.order_no);
    return { order: { ...order, items: safeJson(order.items, []) }, user, payments };
  });

  // 手动补发授权 / 发货
  app.post('/api/orders/:id/deliver', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
    if (!order) return reply.code(404).send({ error: '订单不存在' });
    if (order.status !== 'paid') return reply.code(400).send({ error: '仅已支付订单可发货' });
    const delivered = deliverOrder(order);
    return { ok: true, delivered };
  });

  app.post('/api/orders/:id/refund', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
    if (!order) return reply.code(404).send({ error: '订单不存在' });
    if (order.status !== 'paid') return reply.code(400).send({ error: '仅已支付订单可退款' });
    if (order.channel === 'wxpay') {
      try {
        await wxpay.refund({
          outTradeNo: order.order_no,
          outRefundNo: `${order.order_no}R`,
          total: order.pay_amount,
          refundAmount: Number((req.body || {}).amount) || order.pay_amount,
          reason: String((req.body || {}).reason || '管理员退款'),
        });
      } catch (e) {
        return reply.code(400).send({ error: `退款失败：${e.message}` });
      }
    }
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('refunded', order.id);
    db.prepare('UPDATE licenses SET status = ? WHERE order_id = ?').run('revoked', order.id);
    return { ok: true };
  });

  app.get('/api/stats/revenue', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const days = Math.min(Number(req.query.days) || 30, 365);
    const rows = db.prepare(`SELECT date, revenue, new_users, api_calls, downloads, installs, active_users
      FROM stats_daily ORDER BY date DESC LIMIT ?`).all(days);
    const byChannel = db.prepare(`SELECT channel AS name, COUNT(*) AS count, IFNULL(SUM(pay_amount),0) AS amount
      FROM orders WHERE status='paid' GROUP BY channel`).all();
    const topProducts = db.prepare(`SELECT name, type, total_sales, active_users FROM products ORDER BY total_sales DESC LIMIT 8`).all();
    return { trend: rows.reverse(), byChannel, topProducts };
  });
};

/** 支付成功后自动发放授权与硬件 */
function deliverOrder(order) {
  const items = safeJson(order.items, []);
  const created = [];
  for (const it of items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(it.product_id));
    if (!product) continue;
    if (product.type === 'service') {
      const key = db.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY id DESC').get(order.user_id);
      const quota = Number((product.description || '').match(/(\d+)\s*万次/)?.[1] || 10) * 10000;
      if (key) {
        db.prepare('UPDATE api_keys SET quota = quota + ? WHERE id = ?').run(quota, key.id);
      } else {
        db.prepare('INSERT INTO api_keys (user_id, api_key, name, quota, used, status, created_at) VALUES (?,?,?,?,0,?,?)')
          .run(order.user_id, `ak_${Math.random().toString(36).slice(2, 18)}`, '默认密钥', quota, 'active', now());
      }
      created.push({ type: 'api_quota', product: product.name });
      continue;
    }
    const licenseKey = `LIC-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const info = db.prepare(`INSERT INTO licenses (license_key, user_id, product_id, type, max_devices, start_at, end_at, status, order_id, remark, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(licenseKey, order.user_id, product.id, product.type === 'software' ? 'permanent' : 'subscription',
        Number(it.qty) || 1, now(), product.type === 'software' ? null : addDays(365), 'active', order.id, '订单自动发放', now());
    db.prepare('UPDATE products SET total_sales = total_sales + ? WHERE id = ?').run(Number(it.qty) || 1, product.id);
    created.push({ type: 'license', license_key: licenseKey, product: product.name, license_id: info.lastInsertRowid });

    if (product.type === 'hardware') {
      const qty = Number(it.qty) || 1;
      for (let i = 0; i < qty; i++) {
        const sn = `HW${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        const dev = db.prepare(`INSERT INTO devices (user_id, product_id, sn, name, model, status, bound_at)
          VALUES (?,?,?,?,?, 'online', ?)`)
          .run(order.user_id, product.id, sn, product.name, product.version || '', now());
        tb.createDevice({ name: sn, type: product.category || 'default' })
          .then((d) => {
            if (d.deviceId) {
              db.prepare('UPDATE devices SET tb_device_id = ?, tb_token = ? WHERE id = ?')
                .run(d.deviceId, d.token || '', dev.lastInsertRowid);
            }
          })
          .catch(() => {});
        created.push({ type: 'device', sn, product: product.name });
      }
    }
  }
  return created;
}

module.exports.deliverOrder = deliverOrder;
module.exports.genOrderNo = genOrderNo;

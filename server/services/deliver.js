const db = require('../db');
const { now, safeJson } = require('../lib/util');
const { addDays } = require('../routes/licenses');
const tb = require('./tb');

/**
 * 支付成功后自动发放授权与硬件。
 * 单独成模块：services/pay.js 与 routes/orders.js 都要用它，
 * 放在任一处都会形成循环依赖（require 拿到未初始化完的 exports）。
 */
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

module.exports = { deliverOrder };

const db = require('../db');
const { now, safeJson, genLicenseKey } = require('../lib/util');
const { addDays } = require('../routes/licenses');
const tb = require('./tb');
const blcloud = require('../lib/blcloud');

/**
 * 支付成功后自动发放授权与硬件。
 * 单独成模块：services/pay.js 与 routes/orders.js 都要用它，
 * 放在任一处都会形成循环依赖（require 拿到未初始化完的 exports）。
 */
/**
 * 额度包商品该发多少次。
 * 优先用后台显式填写的「API 额度」字段；没填才回退到从名称/副标题/描述里
 * 认「10 万次」「10万」「100000 次」这类写法；都认不出才用默认值。
 * 之前只看 description，而种子商品的「10 万次」写在 subtitle 里 —— 直接漏配。
 */
function resolveQuota(product) {
  const explicit = Number(product.quota || 0);
  if (explicit > 0) return explicit;
  const text = [product.name, product.subtitle, product.description].filter(Boolean).join(' ');
  const wan = text.match(/(\d+(?:\.\d+)?)\s*万\s*次?/);
  if (wan) return Math.round(Number(wan[1]) * 10000);
  const plain = text.match(/(\d+)\s*次/);
  if (plain) return Number(plain[1]);
  return 100000;
}

/** 支付成功后自动发放授权与硬件 */
function deliverOrder(order) {
  const items = safeJson(order.items, []);
  const created = [];
  for (const it of items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(it.product_id));
    if (!product) continue;
    if (product.type === 'service') {
      const quota = resolveQuota(product);
      // 关键：用户端真正扣减的额度池是 users.blcloud_quota（blcloud 开放平台），
      // 不是 api_keys 表。以前充到 api_keys，用户付了钱但页面额度纹丝不动。
      const before = db.prepare('SELECT blcloud_quota, blcloud_used FROM users WHERE id = ?').get(order.user_id);
      const q = blcloud.addQuota(order.user_id, quota,
        `订单 ${order.order_no} 购买「${product.name}」发放 API 额度 ${quota} 次`);
      created.push({
        type: 'api_quota',
        quota,
        product: product.name,
        before: Number(before?.blcloud_quota || 0),
        after: Number(q.total || 0),
        remaining: Number(q.remaining || 0),
      });
      continue;
    }
    // 与后台手工发放共用同一个生成器：格式必须一致，
    // 否则文档示例、客服核对、客户端校验兜底用的正则各说各话
    const licenseKey = genLicenseKey();
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

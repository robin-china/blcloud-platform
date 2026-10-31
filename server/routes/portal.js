const db = require('../db');
const { now, safeJson, genOrderNo, genCode } = require('../lib/util');
const { requireUser } = require('../lib/auth');
const { getSetting, getConfig, devMode } = require('../lib/config');
const { createPayment } = require('../services/pay');
const QRCode = require('qrcode');
const bl = require('../lib/blcloud');

const PUBLIC_SETTINGS = ['site_name', 'site_short_name', 'site_logo', 'site_favicon', 'site_icp',
  'site_copyright', 'site_contact', 'site_description', 'theme_color'];

module.exports = async function portalRoutes(app) {
  app.get('/api/portal/qrcode', async (req, reply) => {
    const text = String(req.query.text || '');
    if (!text) return reply.code(400).send({ error: '缺少内容' });
    const png = await QRCode.toBuffer(text, { width: 320, margin: 1, color: { dark: '#111827', light: '#ffffff' } });
    reply.type('image/png').send(png);
  });

  app.get('/api/portal/site', async () => {
    const out = {};
    for (const k of PUBLIC_SETTINGS) out[k] = getSetting(k, '');
    // 只暴露"是否开通"，不泄露任何商户参数
    const channels = [];
    if (getConfig('wxpay').enabled) channels.push('wxpay');
    if (getConfig('alipay').enabled) channels.push('alipay');
    if (!channels.length && String(getSetting('pay_simulate', '0')) === '1') channels.push('simulate');
    return { settings: out, pay_channels: channels };
  });

  app.get('/api/portal/shop', async (req) => {
    const type = String(req.query.type || '');
    const where = type ? 'WHERE type = ? AND status = ?' : 'WHERE status = ?';
    const args = type ? [type, 'on'] : ['on'];
    const list = db.prepare(`SELECT id, type, name, subtitle, description, category, price, original_price,
      icon, images, features, version, file_size, stock, total_downloads, total_installs, active_users, total_sales
      FROM products ${where} ORDER BY sort DESC, id DESC`).all(...args);
    return { list: list.map((p) => ({ ...p, images: safeJson(p.images, []), features: safeJson(p.features, []) })) };
  });

  app.get('/api/portal/product/:id', async (req, reply) => {
    const p = db.prepare('SELECT * FROM products WHERE id = ? AND status = ?').get(Number(req.params.id), 'on');
    if (!p) return reply.code(404).send({ error: '产品不存在或未上架' });
    return { product: { ...p, images: safeJson(p.images, []), features: safeJson(p.features, []) } };
  });

  app.get('/api/portal/me', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const user = db.prepare('SELECT id, openid, nickname, avatar, phone, points, balance, tb_status, created_at FROM users WHERE id = ?').get(req.user.sub);
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    return { user };
  });

  app.post('/api/portal/phone/code', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const phone = String((req.body || {}).phone || '').trim();
    if (!/^1\d{10}$/.test(phone)) return reply.code(400).send({ error: '手机号格式不正确' });
    const code = genCode(6);
    db.prepare('INSERT INTO sms_codes (phone, code, used, expires_at) VALUES (?,?,0,?)')
      .run(phone, code, new Date(Date.now() + 5 * 60 * 1000).toISOString());
    // 验证码一律不下发到客户端；仅在演示模式下附带，便于本地联调
    return devMode() ? { ok: true, devCode: code } : { ok: true };
  });

  app.post('/api/portal/phone/bind', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const { phone, code } = req.body || {};
    const row = db.prepare('SELECT * FROM sms_codes WHERE phone = ? AND used = 0 ORDER BY id DESC LIMIT 1').get(String(phone || ''));
    if (!row || row.code !== String(code || '')) return reply.code(400).send({ error: '验证码错误' });
    if (new Date(row.expires_at).getTime() < Date.now()) return reply.code(400).send({ error: '验证码已过期' });
    db.prepare('UPDATE sms_codes SET used = 1 WHERE id = ?').run(row.id);
    db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(String(phone), req.user.sub);
    return { ok: true };
  });

  app.post('/api/portal/orders', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const b = req.body || {};
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return reply.code(400).send({ error: '购物车为空' });
    let amount = 0;
    const detail = [];
    for (const it of items) {
      const p = db.prepare('SELECT * FROM products WHERE id = ? AND status = ?').get(Number(it.product_id), 'on');
      if (!p) return reply.code(400).send({ error: '包含不可购买的商品' });
      const qty = Math.max(Number(it.qty) || 1, 1);
      amount += p.price * qty;
      detail.push({ product_id: p.id, product_name: p.name, product_type: p.type, price: p.price, qty });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
    const usePoints = Number(b.use_points) || 0;
    const discount = Math.min(Math.floor((user.points || 0) / 100), Math.floor(amount * 100) / 100, usePoints);
    const orderNo = genOrderNo();
    const info = db.prepare(`INSERT INTO orders (order_no, user_id, amount, pay_amount, discount, channel, status, items, remark, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(orderNo, req.user.sub, amount, Math.max(amount - discount, 0), discount, b.channel || '', 'pending', JSON.stringify(detail), b.remark || '', now());
    if (discount > 0) {
      const balance = (user.points || 0) - discount * 100;
      db.prepare('UPDATE users SET points = ? WHERE id = ?').run(balance, req.user.sub);
      db.prepare('INSERT INTO points_logs (user_id, change, balance, reason, created_at) VALUES (?,?,?,?,?)')
        .run(req.user.sub, -discount * 100, balance, `订单 ${orderNo} 积分抵扣`, now());
    }
    return { id: info.lastInsertRowid, order_no: orderNo, amount, pay_amount: Math.max(amount - discount, 0), discount };
  });

  app.post('/api/portal/orders/:orderNo/pay', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(req.params.orderNo);
    if (!order) return reply.code(404).send({ error: '订单不存在' });
    if (order.user_id !== req.user.sub) return reply.code(403).send({ error: '无权操作' });
    if (order.status === 'paid') return { status: 'paid' };
    const channel = String((req.body || {}).channel || order.channel || 'wxpay');
    db.prepare('UPDATE orders SET channel = ? WHERE id = ?').run(channel, order.id);
    try {
      const result = await createPayment(req, { ...order, channel }, channel);
      return { order_no: order.order_no, ...result };
    } catch (e) {
      return reply.code(400).send({ error: `支付下单失败：${e.message}` });
    }
  });

  app.get('/api/portal/orders', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const list = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.sub);
    return { list: list.map((o) => ({ ...o, items: safeJson(o.items, []) })) };
  });

  app.get('/api/portal/licenses', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const list = db.prepare(`SELECT l.*, p.name AS product_name, p.type AS product_type, p.icon
      FROM licenses l LEFT JOIN products p ON p.id = l.product_id WHERE l.user_id = ? ORDER BY l.id DESC`).all(req.user.sub);
    return { list };
  });

  app.get('/api/portal/devices', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const list = db.prepare(`SELECT d.*, p.name AS product_name, p.icon FROM devices d LEFT JOIN products p ON p.id = d.product_id WHERE d.user_id = ? ORDER BY d.id DESC`).all(req.user.sub);
    return { list };
  });

  app.post('/api/portal/devices/bind', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const { sn, name } = req.body || {};
    if (!sn) return reply.code(400).send({ error: '请输入设备 SN' });
    const dev = db.prepare('SELECT * FROM devices WHERE sn = ?').get(String(sn));
    if (!dev) return reply.code(404).send({ error: '未找到该设备，请检查 SN' });
    if (dev.user_id && dev.user_id !== req.user.sub) return reply.code(400).send({ error: '设备已绑定其他账户' });
    db.prepare('UPDATE devices SET user_id = ?, name = ?, bound_at = ? WHERE id = ?').run(req.user.sub, name || dev.name, now(), dev.id);
    return { ok: true };
  });

  app.get('/api/portal/points', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    return { list: db.prepare('SELECT * FROM points_logs WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.sub) };
  });

  app.post('/api/portal/signin', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
    const last = db.prepare("SELECT * FROM points_logs WHERE user_id = ? AND reason = '每日签到' ORDER BY id DESC LIMIT 1").get(req.user.sub);
    if (last && new Date(last.created_at).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)) {
      return reply.code(400).send({ error: '今天已经签到过了' });
    }
    const gain = Number(getSetting('user_points_signin', '10'));
    const balance = (user.points || 0) + gain;
    db.prepare('UPDATE users SET points = ? WHERE id = ?').run(balance, req.user.sub);
    db.prepare('INSERT INTO points_logs (user_id, change, balance, reason, created_at) VALUES (?,?,?,?,?)')
      .run(req.user.sub, gain, balance, '每日签到', now());
    return { balance, gain };
  });

  app.post('/api/portal/download/:id', async (req, reply) => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
    if (!p) return reply.code(404).send({ error: '产品不存在' });
    db.prepare('UPDATE products SET total_downloads = total_downloads + 1 WHERE id = ?').run(p.id);
    const date = new Date().toISOString().slice(0, 10);
    db.prepare('INSERT INTO stats_daily (date, downloads) VALUES (?,1) ON CONFLICT(date) DO UPDATE SET downloads = downloads + 1').run(date);
    return { url: p.download_url };
  });

  // 客户端授权校验（对外）
  app.post('/api/open/license/verify', async (req, reply) => {
    const { license_key, device_sn } = req.body || {};
    const lic = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(String(license_key || ''));
    if (!lic) return reply.code(404).send({ valid: false, reason: '授权不存在' });
    if (lic.status !== 'active') return { valid: false, reason: '授权已失效' };
    if (lic.end_at && new Date(lic.end_at).getTime() < Date.now()) return { valid: false, reason: '授权已过期' };
    if (device_sn) {
      const bound = db.prepare('SELECT * FROM license_devices WHERE license_id = ? AND device_sn = ?').get(lic.id, String(device_sn));
      if (!bound) {
        const count = db.prepare('SELECT COUNT(*) AS c FROM license_devices WHERE license_id = ?').get(lic.id).c;
        if (count >= lic.max_devices) return { valid: false, reason: '超出设备数量上限' };
        db.prepare('INSERT INTO license_devices (license_id, device_sn, device_name, bound_at) VALUES (?,?,?,?)')
          .run(lic.id, String(device_sn), '', now());
      }
    }
    const date = new Date().toISOString().slice(0, 10);
    db.prepare('INSERT INTO stats_daily (date, api_calls) VALUES (?,1) ON CONFLICT(date) DO UPDATE SET api_calls = api_calls + 1').run(date);
    db.prepare('INSERT INTO api_usage (user_id, api_key, endpoint, calls, date) VALUES (?,?,?,1,?)')
      .run(lic.user_id, String(license_key), 'license.verify', date);
    return { valid: true, product_id: lic.product_id, end_at: lic.end_at, max_devices: lic.max_devices };
  });

  /* ---------- 个人中心 · blcloud 板块 ---------- */
  app.get('/api/portal/blcloud/overview', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const user = bl.ensureFreeQuota(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub));
    const keys = db.prepare('SELECT * FROM blcloud_keys WHERE user_id = ? ORDER BY id DESC').all(req.user.sub);
    return {
      quota: bl.quotaState(user),
      cfg: bl.cfg(),
      keys: keys.map(bl.keyPayload),
      account: {
        status: user.tb_status || 'none',
      },
      ...bl.summary(req.user.sub, 14),
    };
  });

  app.get('/api/portal/blcloud/keys', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const keys = db.prepare('SELECT * FROM blcloud_keys WHERE user_id = ? ORDER BY id DESC').all(req.user.sub);
    return { list: keys.map(bl.keyPayload) };
  });

  app.post('/api/portal/blcloud/keys', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const b = req.body || {};
    const user = bl.ensureFreeQuota(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub));
    try {
      const created = bl.createKey(user.id, {
        name: b.name, quota: b.quota, mode: b.mode, scopes: b.scopes, days: b.days,
      });
      return { ok: true, secret: created.secret, key: bl.keyPayload(created.key), quota: bl.quotaState(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.post('/api/portal/blcloud/keys/:id', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM blcloud_keys WHERE id = ?').get(id);
    if (!row || row.user_id !== req.user.sub) return reply.code(404).send({ error: '密钥不存在' });
    const b = req.body || {};
    if (b.name !== undefined) db.prepare('UPDATE blcloud_keys SET key_name = ? WHERE id = ?').run(String(b.name).slice(0, 40), id);
    if (b.scopes !== undefined) db.prepare('UPDATE blcloud_keys SET scopes = ? WHERE id = ?').run(String(b.scopes).slice(0, 200), id);
    if (b.status !== undefined && ['active', 'revoked'].includes(b.status)) {
      db.prepare('UPDATE blcloud_keys SET status = ? WHERE id = ?').run(b.status, id);
    }
    if (b.quota !== undefined) {
      const add = Number(b.quota) || 0;
      if (add > 0) {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
        const remain = Math.max(0, (user.blcloud_quota || 0) - (user.blcloud_used || 0));
        if (add > remain) return reply.code(400).send({ error: `额度不足，账户剩余 ${remain} 次` });
      }
      db.prepare('UPDATE blcloud_keys SET quota = MAX(0, quota + ?) WHERE id = ?').run(add, id);
    }
    return { ok: true, key: bl.keyPayload(bl.getKey(id)) };
  });

  app.delete('/api/portal/blcloud/keys/:id', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM blcloud_keys WHERE id = ?').get(id);
    if (!row || row.user_id !== req.user.sub) return reply.code(404).send({ error: '密钥不存在' });
    db.prepare('DELETE FROM blcloud_keys WHERE id = ?').run(id);
    return { ok: true };
  });

  app.post('/api/portal/blcloud/keys/:id/reset', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM blcloud_keys WHERE id = ?').get(id);
    if (!row || row.user_id !== req.user.sub) return reply.code(404).send({ error: '密钥不存在' });
    const secret = 'blc_' + require('crypto').randomBytes(16).toString('hex');
    db.prepare('UPDATE blcloud_keys SET key_hash = ?, key_prefix = ?, used = 0, status = ? WHERE id = ?')
      .run(bl.hashKey(secret), secret.slice(0, 12) + '…', 'active', id);
    return { ok: true, secret, key: bl.keyPayload(bl.getKey(id)) };
  });

  app.get('/api/portal/blcloud/usage', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
    return { ok: true, ...bl.summary(req.user.sub, days) };
  });

  /* 积分兑换调用额度 */
  app.post('/api/portal/blcloud/exchange', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const points = Math.max(0, Math.floor(Number((req.body || {}).points) || 0));
    if (points <= 0) return reply.code(400).send({ error: '请输入要兑换的积分数量' });
    const c = bl.cfg();
    if (!c.perPoint) return reply.code(400).send({ error: '未开启积分兑换' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
    if ((user.points || 0) < points) return reply.code(400).send({ error: '积分不足' });
    const gain = points * c.perPoint;
    const balance = (user.points || 0) - points;
    db.prepare('UPDATE users SET points = ?, blcloud_quota = blcloud_quota + ? WHERE id = ?').run(balance, gain, req.user.sub);
    db.prepare('INSERT INTO points_logs (user_id, change, balance, reason, created_at) VALUES (?,?,?,?,?)')
      .run(req.user.sub, -points, balance, `积分兑换 blcloud 额度 +${gain} 次`, now());
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
    return { ok: true, gain, quota: bl.quotaState(fresh), points: fresh.points };
  });
};

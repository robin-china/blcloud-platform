const db = require('../db');
const { now, safeJson, genOrderNo, genCode } = require('../lib/util');
const { requireUser, signUser } = require('../lib/auth');
const { getSetting, getConfig, devMode } = require('../lib/config');
const { createPayment, markPaid } = require('../services/pay');
const wxpay = require('../services/wxpay');
const paydiag = require('../lib/paydiag');
const QRCode = require('qrcode');
const bl = require('../lib/blcloud');
const bindSvc = require('../lib/licensebind');
const plans = require('../lib/plans');
const commission = require('../lib/commission');
const reminders = require('../lib/reminders');

/**
 * 用户端自动补单的节流表：orderId -> 上次查单时间戳。
 * 微信的查单接口不该被无限刷，同一订单 60 秒内只查一次。
 */
const lastSync = new Map();
const SYNC_INTERVAL = 60 * 1000;

/**
 * 「我的订单」列表刷新时顺带给 pending 的微信订单查一次单。
 *
 * 回调一旦验签失败（配置刚修好前必然如此），微信只会重试有限次，
 * 之后用户已付款、订单却永远停在 pending。与其等管理员手工补单，
 * 不如让用户刷新页面时自己恢复 —— 这是丢单兜底的最后一道防线。
 * 查单失败一律静默：列表加载不能被支付侧的问题拖垮。
 */
async function autoSyncPendingOrders(userId) {
  try {
    const cfg = getConfig('wxpay');
    if (!cfg.enabled) return;
    const rows = db.prepare(
      `SELECT * FROM orders WHERE user_id = ? AND status = 'pending'
       AND IFNULL(channel, 'wxpay') = 'wxpay' ORDER BY id DESC LIMIT 5`
    ).all(userId);
    const cutoff = Date.now() - 60 * 1000;
    let budget = 3;
    for (const o of rows) {
      if (budget <= 0) break;
      const created = Date.parse(o.created_at || '');
      if (created && created > cutoff) continue; // 刚下单，还没来得及付款
      if (Date.now() - (lastSync.get(o.id) || 0) < SYNC_INTERVAL) continue;
      lastSync.set(o.id, Date.now());
      budget -= 1;
      try {
        const data = await wxpay.queryOrder(o.order_no);
        if (data.trade_state !== 'SUCCESS') continue;
        const paidAmount = Number(data.amount?.total || 0) / 100;
        const r = markPaid(data.out_trade_no, data.transaction_id, 'wxpay', JSON.stringify(data), paidAmount);
        if (r && r.mismatch) {
          paydiag.push('error', 'query', `自动补单发现金额不符：订单 ${o.order_no}，应收 ¥${r.expected}、实收 ¥${r.actual}，已拒发货`);
        } else {
          paydiag.push('ok', 'query', `自动补单成功：订单 ${o.order_no} 已标记为已支付并自动发货`);
        }
      } catch (e) {
        paydiag.push('warn', 'query', `自动补单查单失败：订单 ${o.order_no}，${e.message}`);
      }
    }
    // 防止表无限增长：只保留最近 500 条
    if (lastSync.size > 500) lastSync.clear();
  } catch { /* 兜底逻辑不能影响列表返回 */ }
}

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

  /**
   * 软件端点「用户中心」时，用一次性票据换网页登录态。
   *
   * 票据由开放接口 /auth/handoff 发出（软件端已登录才有），这里只负责兑换并作废。
   * 换失败时「不存在 / 已用过 / 已过期」给同一句提示 —— 区分开等于告诉别人
   * 哪个 code 存在过，白送一个试探入口。
   */
  app.post('/api/portal/handoff', async (req, reply) => {
    const code = String((req.body || {}).t || '').trim();
    if (!/^ho_[a-f0-9]{48}$/.test(code)) {
      return reply.code(400).send({ error: '链接无效或已过期，请在软件里重新打开', code: 'HANDOFF_INVALID' });
    }
    // 顺手清掉两天前的死票，表不会无限长
    db.prepare("DELETE FROM handoff_tickets WHERE created_at < ?").run(new Date(Date.now() - 2 * 86400000).toISOString());
    const row = db.prepare('SELECT * FROM handoff_tickets WHERE code = ?').get(code);
    if (!row || row.used) {
      return reply.code(400).send({ error: '链接无效或已过期，请在软件里重新打开', code: 'HANDOFF_INVALID' });
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return reply.code(400).send({ error: '链接已过期，请在软件里重新打开', code: 'HANDOFF_EXPIRED' });
    }
    db.prepare('UPDATE handoff_tickets SET used = 1 WHERE code = ?').run(code);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!user) return reply.code(404).send({ error: '用户不存在', code: 'USER_NOT_FOUND' });
    if (user.status && user.status !== 'active') {
      return reply.code(403).send({ error: '账号已被停用，请联系客服', code: 'USER_DISABLED' });
    }
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), user.id);
    return {
      token: signUser(user),
      user: {
        id: user.id, openid: user.openid, nickname: user.nickname, avatar: user.avatar,
        phone: user.phone || '', points: user.points || 0, balance: user.balance || 0,
      },
    };
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

  /**
   * 升级差价按「剩余可用时长」折算，避免用户刚买一个月却被要求补一整年差价。
   * 价格一律服务端算：前端只传 plan_id / ref_license_id，传 price 也一概不认。
   */
  function upgradePrice(cur, target, lic, proration) {
    if (target.billing !== 'period') return plans.round2(target.price);
    const diff = plans.round2(target.price - Number(cur?.price || 0));
    if (diff <= 0) return 0;
    if (!proration || !cur || !cur.period_days || !lic.end_at) return diff;
    const remain = Math.max(0, Date.parse(lic.end_at) - Date.now());
    const total = Number(cur.period_days) * 86400000;
    return Math.max(0.01, plans.round2(diff * Math.min(1, remain / total)));
  }

  app.post('/api/portal/orders', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const b = req.body || {};
    const kind = String(b.kind || 'purchase');
    if (!['purchase', 'upgrade', 'renew'].includes(kind)) {
      return reply.code(400).send({ error: '不支持的订单类型' });
    }
    const planId = b.plan_id ? Number(b.plan_id) : 0;
    let amount = 0;
    let detail = [];
    let refLicenseId = 0;
    let resolvedPlanId = 0;

    if (planId) {
      const plan = plans.get(planId);
      if (!plan || plan.status !== 'on') return reply.code(400).send({ error: '套餐档位不存在或已下架' });
      if (plan.billing === 'free') return reply.code(400).send({ error: '免费档无需下单' });
      resolvedPlanId = plan.id;
      const label = { purchase: '购买', upgrade: '升级', renew: '续费' }[kind];
      if (kind === 'purchase') {
        amount = plans.round2(plan.price);
      } else {
        refLicenseId = Number(b.ref_license_id) || 0;
        const lic = db.prepare('SELECT * FROM licenses WHERE id = ? AND user_id = ?').get(refLicenseId, req.user.sub);
        if (!lic) return reply.code(400).send({ error: '待升级/续费的授权不存在' });
        if (lic.status === 'revoked') return reply.code(400).send({ error: '授权已吊销，无法升级或续费' });
        const cur = plans.licensePlan(lic);
        if (kind === 'upgrade') {
          if (cur && Number(plan.tier) <= Number(cur.tier)) {
            return reply.code(400).send({ error: '只能升级到更高档位' });
          }
          amount = upgradePrice(cur, plan, lic, String(getSetting('upgrade_proration', '1')) === '1');
          if (amount <= 0) return reply.code(400).send({ error: '无需补差价，请联系客服调整' });
        } else {
          if (cur && Number(cur.id) !== Number(plan.id)) {
            return reply.code(400).send({ error: '续费档位与当前授权不一致，请先升级' });
          }
          amount = plans.round2(plan.price);
        }
      }
      detail = [{ product_id: 0, product_name: `${plan.name}（${label}）`, qty: 1,
        price: amount, plan_id: plan.id, kind }];
    } else {
      if (kind !== 'purchase') return reply.code(400).send({ error: '升级 / 续费必须指定套餐档位' });
      const items = Array.isArray(b.items) ? b.items : [];
      if (!items.length) return reply.code(400).send({ error: '购物车为空' });
      for (const it of items) {
        const p = db.prepare('SELECT * FROM products WHERE id = ? AND status = ?').get(Number(it.product_id), 'on');
        if (!p) return reply.code(400).send({ error: '包含不可购买的商品' });
        const qty = Math.max(Number(it.qty) || 1, 1);
        amount += p.price * qty;
        detail.push({ product_id: p.id, product_name: p.name, product_type: p.type, price: p.price, qty });
      }
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
    const usePoints = Number(b.use_points) || 0;
    const discount = Math.min(Math.floor((user.points || 0) / 100), Math.floor(amount * 100) / 100, usePoints);
    const orderNo = genOrderNo();
    const info = db.prepare(`INSERT INTO orders
      (order_no, user_id, amount, pay_amount, discount, channel, status, items, remark,
       kind, ref_license_id, plan_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(orderNo, req.user.sub, amount, Math.max(amount - discount, 0), discount,
        b.channel || '', 'pending', JSON.stringify(detail), b.remark || '',
        kind, refLicenseId || null, resolvedPlanId || null, now());
    if (discount > 0) {
      const balance = (user.points || 0) - discount * 100;
      db.prepare('UPDATE users SET points = ? WHERE id = ?').run(balance, req.user.sub);
      db.prepare('INSERT INTO points_logs (user_id, change, balance, reason, created_at) VALUES (?,?,?,?,?)')
        .run(req.user.sub, -discount * 100, balance, `订单 ${orderNo} 积分抵扣`, now());
    }
    return { id: info.lastInsertRowid, order_no: orderNo, amount,
      pay_amount: Math.max(amount - discount, 0), discount, kind };
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
    await autoSyncPendingOrders(req.user.sub);
    const list = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.sub);
    return { list: list.map((o) => ({ ...o, items: safeJson(o.items, []) })) };
  });

  app.get('/api/portal/licenses', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const list = db.prepare(`SELECT l.*, p.name AS product_name, p.type AS product_type, p.icon,
      pl.name AS plan_name, pl.tier AS plan_tier, pl.price AS plan_price,
      (SELECT COUNT(*) FROM license_devices d WHERE d.license_id = l.id) AS bound_devices
      FROM licenses l LEFT JOIN products p ON p.id = l.product_id
      LEFT JOIN plans pl ON pl.id = l.plan_id
      WHERE l.user_id = ? ORDER BY l.id DESC`).all(req.user.sub);
    return {
      list: list.map((l) => ({
        ...l,
        // 套餐授权的 product_id=0，LEFT JOIN 不到商品，用档位名兜底显示
        product_name: l.product_name || l.plan_name || '套餐授权',
        days_left: l.end_at ? Math.ceil((Date.parse(l.end_at) - Date.now()) / 86400000) : null,
      })),
    };
  });

  /* ---------------- 套餐档位 / 升级与续费 ---------------- */

  app.get('/api/portal/plans', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    return { list: plans.list(true) };
  });

  /** 某张授权可升级到的档位 + 续费报价，全部服务端算好给前端展示 */
  app.get('/api/portal/licenses/:id/options', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const lic = db.prepare('SELECT * FROM licenses WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.sub);
    if (!lic) return reply.code(404).send({ error: '授权不存在' });
    const cur = plans.licensePlan(lic);
    const all = plans.list(true);
    const upgrades = all.filter((p) => p.billing !== 'free' && (!cur || Number(p.tier) > Number(cur.tier)))
      .map((p) => ({ ...p, price: upgradePrice(cur, p, lic, String(getSetting('upgrade_proration', '1')) === '1') }));
    return {
      current: cur,
      renew: cur ? { plan_id: cur.id, plan_code: cur.code, name: cur.name, price: plans.round2(cur.price),
        period_days: cur.period_days } : null,
      upgrades,
    };
  });

  app.get('/api/portal/notices', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    return { list: reminders.listForUser(req.user.sub) };
  });

  /* ---------------- 代理商收益 / 提现 ---------------- */

  app.get('/api/portal/agent', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const me = db.prepare('SELECT id, agent_id, agent_status, agent_rate, agent_code FROM users WHERE id = ?').get(req.user.sub);
    let upline = null;
    if (me && me.agent_id) {
      const a = db.prepare('SELECT id, nickname, agent_code FROM users WHERE id = ?').get(me.agent_id);
      if (a) upline = { id: a.id, nickname: a.nickname, code: a.agent_code };
    }
    return {
      is_agent: !!(me && me.agent_status === 'active'),
      agent_code: me?.agent_code || '',
      agent_rate: me?.agent_rate || 0,
      upline,
      settle_days: commission.settleDays(),
      withdraw_min: commission.withdrawMin(),
    };
  });

  /** 用邀请码绑定归属。只在没有上级、且不是自己、且不是代理商本人时生效。 */
  app.post('/api/portal/agent/bind', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const code = String((req.body || {}).code || '').trim().toUpperCase();
    if (!code) return reply.code(400).send({ error: '请输入邀请码' });
    const agent = db.prepare("SELECT * FROM users WHERE UPPER(agent_code) = ? AND agent_status = 'active'").get(code);
    if (!agent) return reply.code(404).send({ error: '邀请码无效' });
    const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
    if (Number(agent.id) === Number(req.user.sub)) return reply.code(400).send({ error: '不能把自己设为上级' });
    if (me.agent_status === 'active') return reply.code(400).send({ error: '代理商账号不能绑定其他上级' });
    if (me.agent_id) return reply.code(400).send({ error: '已有归属代理商，如需变更请联系客服' });
    db.prepare('UPDATE users SET agent_id = ? WHERE id = ?').run(agent.id, req.user.sub);
    return { ok: true, agent: { id: agent.id, nickname: agent.nickname } };
  });

  app.get('/api/portal/earnings', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const isAgent = db.prepare("SELECT agent_status FROM users WHERE id = ?").get(req.user.sub);
    if (!isAgent || isAgent.agent_status !== 'active') {
      return { is_agent: false, summary: commission.summary(req.user.sub), list: [], withdrawals: [] };
    }
    return {
      is_agent: true,
      summary: commission.summary(req.user.sub),
      list: commission.listForAgent(req.user.sub),
      withdrawals: commission.listWithdrawalsForAgent(req.user.sub),
      settle_days: commission.settleDays(),
      withdraw_min: commission.withdrawMin(),
    };
  });

  app.post('/api/portal/withdrawals', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const me = db.prepare('SELECT agent_status FROM users WHERE id = ?').get(req.user.sub);
    if (!me || me.agent_status !== 'active') return reply.code(403).send({ error: '当前账号不是代理商' });
    const r = commission.requestWithdrawal(req.user.sub,
      (req.body || {}).pay_account || '', (req.body || {}).remark || '');
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ok: true, withdrawal: r.withdrawal };
  });

  app.get('/api/portal/withdrawals', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    return { list: commission.listWithdrawalsForAgent(req.user.sub) };
  });

  /* 线下买卡 / 渠道发卡：用户先登录，再把卡上的码贴进来。
     绑定那一刻起算有效期（印卡时不开始计时）。 */
  app.post('/api/portal/licenses/bind', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const g = bindSvc.guard(req.user.sub);
    if (!g.ok) return reply.code(429).send({ error: g.reason, code: g.code });
    const key = String((req.body || {}).license_key || '').trim().toUpperCase();
    if (!key) return reply.code(400).send({ error: '请输入授权码' });
    const lic = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(key);
    const res = bindSvc.bind(lic, req.user.sub, 'self');
    if (!res.ok) {
      bindSvc.noteFail(req.user.sub);
      return reply.code(400).send({ error: res.reason, code: res.code });
    }
    bindSvc.noteSuccess(req.user.sub);
    return {
      ok: true, already: !!res.already,
      license: {
        id: res.license.id, license_key: res.license.license_key,
        type: res.license.type, end_at: res.license.end_at,
      },
    };
  });

  /* 换电脑 / 重装系统后 machine_id 变了，旧机器还占着名额。
     让用户自己在「我的授权」里解绑，而不是每次都找客服。 */
  app.get('/api/portal/licenses/:id/devices', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const lic = db.prepare('SELECT * FROM licenses WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.sub);
    if (!lic) return reply.code(404).send({ error: '授权不存在' });
    const list = db.prepare('SELECT * FROM license_devices WHERE license_id = ? ORDER BY id DESC').all(lic.id);
    return { list, max_devices: lic.max_devices };
  });

  app.delete('/api/portal/licenses/:id/devices/:did', async (req, reply) => {
    if (!(await requireUser(req, reply))) return;
    const lic = db.prepare('SELECT * FROM licenses WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.sub);
    if (!lic) return reply.code(404).send({ error: '授权不存在' });
    const d = db.prepare('SELECT * FROM license_devices WHERE id = ? AND license_id = ?').get(Number(req.params.did), lic.id);
    if (!d) return reply.code(404).send({ error: '该设备未绑定此授权' });
    db.prepare('DELETE FROM license_devices WHERE id = ?').run(d.id);
    db.prepare('UPDATE client_sessions SET status = ? WHERE license_id = ? AND machine_id = ?')
      .run('revoked', lic.id, d.device_sn);
    return { ok: true, freed: 1 };
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

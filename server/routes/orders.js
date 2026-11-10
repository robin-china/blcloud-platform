const db = require('../db');
const { now, safeJson, genOrderNo } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');
const wxpay = require('../services/wxpay');
const tb = require('../services/tb');
const { addDays } = require('./licenses');
const { deliverOrder } = require('../services/deliver');
const { markPaid } = require('../services/pay');
const commission = require('../lib/commission');
const paydiag = require('../lib/paydiag');
const orderdel = require('../lib/orderdel');
const { logAdmin } = require('../lib/adminlog');

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
    // 已删除的未付款订单不进默认列表（否则「删了还在」等于没删），
    // 但仍可在后台按「已删除」筛出来核查，也不会被真删掉
    if (status === 'deleted') where.push('o.deleted_at IS NOT NULL');
    else if (status) { where.push('o.status = ? AND o.deleted_at IS NULL'); args.push(status); }
    else where.push('o.deleted_at IS NULL');
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

    // 幂等保护：已发放过的订单默认拒绝再次发货 —— deliverOrder 不是幂等的，
    // 重复调用会再发一张授权码 / 再充一次额度 / 再加一次销量，续费单还会
    // 在原有效期上再叠一年。确认重发必须显式带 force=1。
    let existing = [];
    try { existing = JSON.parse(order.deliver_result || '[]'); } catch { existing = []; }
    if (!Array.isArray(existing)) existing = [];
    const force = (req.body || {}).force === true || String((req.body || {}).force || '') === '1';
    if (existing.length && !force) {
      return reply.code(409).send({
        error: '该订单已发放过内容，重复发货会重复发码 / 重复加额度 / 叠加续期。确认要重发请带 force=1。',
        code: 'ALREADY_DELIVERED',
        delivered: existing,
      });
    }

    let delivered;
    try {
      delivered = deliverOrder(order);
    } catch (e) {
      // 升级/续费/套餐单有 8 处业务性 throw（档位被删、授权吊销/易主等）。
      // 以前直接 500，而前端按钮没有 catch —— 管理员看到的就是「点了没反应」。
      paydiag.push('error', 'deliver', `管理员手动发货失败：订单 ${order.order_no}，${e.message}`);
      return reply.code(400).send({ error: `发货失败：${e.message}` });
    }
    // 与自动发货一致：结果写回订单，管理员事后能核对到底发了什么
    db.prepare('UPDATE orders SET deliver_result = ? WHERE id = ?')
      .run(JSON.stringify(delivered || []), order.id);
    const summary = (delivered || []).length
      ? JSON.stringify(delivered)
      : '未发放任何东西（订单内商品可能已被删除，请核对）';
    paydiag.push('ok', 'deliver', `管理员手动发货：订单 ${order.order_no}，${summary}`);
    // 授权/发货操作必须留审计（同发放授权、批量发码的约定）
    logAdmin(req, '手动补发', `订单 ${order.order_no}：${(delivered || []).length} 项${force ? '（force 重发）' : ''}`);
    return { ok: true, delivered };
  });

  /**
   * 补单：回调丢了/失败过时，用微信的「查单」接口确认真实支付结果。
   * 微信的重试次数是有限的（约 24 小时内若干次），一旦耗尽就再也不会通知，
   * 那时候用户已付款、订单却永远是 pending —— 只能靠这里人为补齐。
   */
  app.post('/api/orders/:id/sync-pay', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
    if (!order) return reply.code(404).send({ error: '订单不存在' });
    if (order.status === 'paid') return { ok: true, status: 'paid', notice: '订单已是已支付' };
    if (order.channel && order.channel !== 'wxpay') {
      return reply.code(400).send({ error: `该订单支付渠道为 ${order.channel}，无法向微信查单` });
    }
    let data;
    try {
      data = await wxpay.queryOrder(order.order_no);
    } catch (e) {
      paydiag.push('error', 'query', `主动查单失败：订单 ${order.order_no}，${e.message}`);
      return reply.code(400).send({ error: `向微信查单失败：${e.message}` });
    }
    const states = { SUCCESS: '支付成功', REFUND: '已转入退款', NOTPAY: '未支付', CLOSED: '已关闭',
      REVOKED: '已撤销', PAYERROR: '支付失败' };
    if (data.trade_state !== 'SUCCESS') {
      paydiag.push('info', 'query', `主动查单：订单 ${order.order_no} 当前为 ${data.trade_state}（${states[data.trade_state] || data.trade_state}）`);
      return { ok: false, status: order.status, notice: `微信侧该订单当前状态：${states[data.trade_state] || data.trade_state}，未做改动` };
    }
    const paidAmount = Number(data.amount?.total || 0) / 100;
    const r = markPaid(data.out_trade_no, data.transaction_id, 'wxpay', JSON.stringify(data), paidAmount);
    if (r && r.mismatch) {
      paydiag.push('error', 'query', `主动查单发现金额不符：订单 ${order.order_no}，应收 ¥${r.expected}、实收 ¥${r.actual}，已拒发货`);
      return reply.code(400).send({ error: `金额不符：应收 ¥${r.expected}、实收 ¥${r.actual}，已拒绝发货` });
    }
    paydiag.push('ok', 'query', `主动查单补齐成功：订单 ${order.order_no} 已标记为已支付并自动发货`);
    return { ok: true, status: 'paid', notice: '微信侧确认已支付，订单已补齐并自动发货' };
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
    // 授权吊销必须同时踢掉客户端会话，否则名额释放了、老令牌还能继续用
    db.prepare(`UPDATE client_sessions SET status = 'revoked'
      WHERE license_id IN (SELECT id FROM licenses WHERE order_id = ?)`).run(order.id);
    db.prepare('UPDATE licenses SET status = ? WHERE order_id = ?').run('revoked', order.id);

    /**
     * 按 deliver_result 反向回收：发货发了什么，退款就要收什么。
     * 以前只吊销授权 —— 额度包的 API 额度还留在账户里继续用（付了钱退了款还
     * 白拿额度），积分抵扣也不退，属净资损。硬件设备涉及 TB 外部系统，
     * 机器可能已经发到用户手里，不自动删，标记后人工核对。
     */
    let quotaBack = 0;
    let devicesFlagged = 0;
    try {
      const delivered = JSON.parse(order.deliver_result || '[]');
      for (const c of Array.isArray(delivered) ? delivered : []) {
        if (c.type === 'api_quota') {
          const q = Number(c.quota) || 0;
          if (q > 0) {
            const u = db.prepare('SELECT blcloud_quota FROM users WHERE id = ?').get(order.user_id);
            const balance = Math.max(0, Number((u && u.blcloud_quota) || 0) - q);
            db.prepare('UPDATE users SET blcloud_quota = ? WHERE id = ?').run(balance, order.user_id);
            quotaBack += q;
          }
        } else if (c.type === 'device' && c.sn) {
          // 设备退款不自动删行：TB 侧设备与已发硬件由人工处理，这里打上标记
          const info = db.prepare(`UPDATE devices SET name = name || '（已退款，待收回）'
            WHERE sn = ? AND user_id = ? AND name NOT LIKE '%（已退款，待收回）%'`).run(c.sn, order.user_id);
          devicesFlagged += info.changes;
        }
      }
    } catch { /* deliver_result 解析失败不影响退款主流程 */ }

    // 抵扣的积分退回（与删除订单同一逻辑：钱退了，抵的积分不能白扣）
    const pointsBack = Math.round(Number(order.discount || 0) * 100);
    if (pointsBack > 0) {
      const u = db.prepare('SELECT points FROM users WHERE id = ?').get(order.user_id);
      if (u) {
        const balance = Number(u.points || 0) + pointsBack;
        db.prepare('UPDATE users SET points = ? WHERE id = ?').run(balance, order.user_id);
        db.prepare('INSERT INTO points_logs (user_id, change, balance, reason, created_at) VALUES (?,?,?,?,?)')
          .run(order.user_id, pointsBack, balance, `订单 ${order.order_no} 退款退回抵扣积分`, now());
      }
    }
    // 销量回退：卖出去又退了，total_sales 不能继续算
    try {
      for (const it of safeJson(order.items, [])) {
        if (it.product_id) {
          db.prepare('UPDATE products SET total_sales = MAX(0, total_sales - ?) WHERE id = ?')
            .run(Number(it.qty) || 1, it.product_id);
        }
      }
    } catch { /* items 解析失败忽略 */ }
    // 佣金冲正：付款→代理商提现→用户退款 这条链路不堵住就是净亏钱
    const reversed = commission.reverseForOrder(order.id);
    // 消费返的积分也要收回来（此前退款只改状态，积分白送）
    const gained = Math.floor(order.pay_amount);
    if (gained > 0) {
      const buyer = db.prepare('SELECT points FROM users WHERE id = ?').get(order.user_id);
      if (buyer) {
        const balance = Math.max(0, Number(buyer.points || 0) - gained);
        db.prepare('UPDATE users SET points = ? WHERE id = ?').run(balance, order.user_id);
        db.prepare('INSERT INTO points_logs (user_id, change, balance, reason, created_at) VALUES (?,?,?,?,?)')
          .run(order.user_id, -gained, balance, `订单 ${order.order_no} 退款收回积分`, now());
      }
    }
    logAdmin(req, '订单退款', `订单 ${order.order_no}，¥${order.pay_amount}`
      + `${quotaBack ? `，收回 API 额度 ${quotaBack} 次` : ''}`
      + `${pointsBack ? `，退回抵扣积分 ${pointsBack}` : ''}`
      + `${devicesFlagged ? `，标记待收回设备 ${devicesFlagged} 台` : ''}`);
    return { ok: true, reversed_commissions: reversed, quota_back: quotaBack, points_back: pointsBack, devices_flagged: devicesFlagged };
  });

  // 删除未付款订单（软删除，见 lib/orderdel.js）：只清列表，不销毁记录，
  // 万一用户已经拿到二维码后又付了钱，回调仍能命中并自动恢复
  app.delete('/api/orders/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
    if (!order) return reply.code(404).send({ error: '订单不存在' });
    const r = orderdel.softDeletePending(order, 'admin');
    if (r.error) return reply.code(400).send({ error: r.error });
    logAdmin(req, 'order.delete', `删除未付款订单 ${order.order_no}（用户 ${order.user_id}，¥${order.pay_amount}）`);
    return { ok: true, points_back: r.points_back };
  });

  // 删错了能恢复（软删除的好处，硬删就救不回来了）
  app.post('/api/orders/:id/restore', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
    if (!order) return reply.code(404).send({ error: '订单不存在' });
    if (!order.deleted_at) return { ok: true, already: true };
    db.prepare("UPDATE orders SET deleted_at = NULL, deleted_by = '' WHERE id = ?").run(order.id);
    logAdmin(req, 'order.restore', `恢复订单 ${order.order_no}（原删除来源：${order.deleted_by || '未知'}）`);
    return { ok: true };
  });

  // 批量清理：挂着的未付款订单多了以后，一条条点不现实
  app.post('/api/orders/purge-pending', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const days = Math.max(Number((req.body || {}).days) || 7, 1);
    const r = orderdel.purgeStalePending(days, 'admin');
    logAdmin(req, 'order.purge', `批量清理 ${r.days} 天前未付款订单：${r.count} 条`);
    return r;
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

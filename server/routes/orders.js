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
    // 与自动发货一致：结果写回订单，管理员事后能核对到底发了什么
    db.prepare('UPDATE orders SET deliver_result = ? WHERE id = ?')
      .run(JSON.stringify(delivered || []), order.id);
    paydiag.push('ok', 'deliver', `管理员手动发货：订单 ${order.order_no}，${
      (delivered || []).length ? JSON.stringify(delivered) : '未发放任何东西'}`);
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
    return { ok: true, reversed_commissions: reversed };
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

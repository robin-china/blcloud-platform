/**
 * 代理商佣金账本。
 *
 * 五条硬规则（都是踩过的坑 / 资金安全底线）：
 *  1) 计佣基数用 orders.pay_amount 实收，不用 amount 标价（积分抵扣部分不能计佣）
 *  2) markPaid 可能被回调与「向微信查单」各触发一次 → UNIQUE + INSERT OR IGNORE 兜底
 *  3) pending 过账期（默认 T+7）才转 settled 可提现 → 防止「付款→提现→退款」钱追不回
 *  4) 退款必须冲正；已提现后才退款的记负数 adjustment，从后续可提现里扣
 *  5) 代理商自己下单不计佣；归属在注册/绑定时确定，不随订单漂移
 */
const db = require('../db');
const { now } = require('./util');
const { getSetting } = require('./config');

const DAY = 86400000;

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }

function settleDays() {
  const n = Math.round(Number(getSetting('agent_settle_days', '7')) || 7);
  return Math.max(0, Math.min(n, 90));
}

function withdrawMin() {
  return round2(Math.max(0, Number(getSetting('agent_withdraw_min', '10')) || 10));
}

function genWithdrawalNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `WD${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

/** 支付成功后记账。必须在订单状态已变 paid 之后调用。 */
function accrueForOrder(order) {
  if (!order || order.status !== 'paid') return null;
  const buyer = db.prepare('SELECT id, agent_id FROM users WHERE id = ?').get(order.user_id);
  if (!buyer || !buyer.agent_id || Number(buyer.agent_id) === Number(order.user_id)) return null;
  const agent = db.prepare('SELECT id, agent_status, agent_rate, nickname FROM users WHERE id = ?').get(buyer.agent_id);
  if (!agent || agent.agent_status !== 'active') return null;
  const rate = round2(Math.max(0, Math.min(Number(agent.agent_rate) || 0, 1)));
  if (rate <= 0) return null;
  const base = round2(order.pay_amount);
  const amount = round2(base * rate);
  if (amount <= 0) return null;
  const ts = now();
  const info = db.prepare(`INSERT OR IGNORE INTO agent_commissions
    (order_id, order_no, agent_user_id, buyer_user_id, base_amount, rate, amount, kind,
     status, available_at, remark, created_at)
    VALUES (?,?,?,?,?,?,?,'commission','pending',?,?,?)`)
    .run(order.id, order.order_no, agent.id, order.user_id, base, rate, amount,
      new Date(Date.now() + settleDays() * DAY).toISOString(), `订单 ${order.order_no} 佣金`, ts);
  if (!info.changes) return null;
  return db.prepare('SELECT * FROM agent_commissions WHERE id = ?').get(info.lastInsertRowid);
}

/** 账期到期 → 可提现。查询收益/申请提现前都会先跑一次，不必依赖定时器。 */
function settleDue(agentUserId) {
  return db.prepare(`UPDATE agent_commissions SET status = 'settled'
    WHERE agent_user_id = ? AND kind = 'commission' AND status = 'pending' AND available_at <= ?`)
    .run(Number(agentUserId), now()).changes;
}

/** 退款冲正。已提现的另记一条负数 adjustment，避免账本凭空少钱。 */
function reverseForOrder(orderId) {
  const rows = db.prepare(`SELECT * FROM agent_commissions WHERE order_id = ? AND kind = 'commission'`).all(Number(orderId));
  let reversed = 0;
  for (const r of rows) {
    if (r.status === 'reversed') continue;
    db.prepare(`UPDATE agent_commissions SET status = 'reversed', remark = ? WHERE id = ?`)
      .run(`订单退款冲正（原状态 ${r.status}）`, r.id);
    reversed += 1;
    if (r.status === 'withdrawn') {
      db.prepare(`INSERT OR IGNORE INTO agent_commissions
        (order_id, order_no, agent_user_id, buyer_user_id, base_amount, rate, amount, kind,
         status, available_at, remark, created_at)
        VALUES (?,?,?,?,?,?,?,'adjustment','settled',?,?,?)`)
        .run(r.order_id, r.order_no, r.agent_user_id, r.buyer_user_id, r.base_amount, r.rate,
          -round2(r.amount), now(), `订单退款追回（已提现部分），从后续可提现中抵扣`, now());
    }
  }
  return reversed;
}

function summary(agentUserId) {
  settleDue(agentUserId);
  const rows = db.prepare(`SELECT kind, status, IFNULL(SUM(amount),0) AS s FROM agent_commissions
    WHERE agent_user_id = ? GROUP BY kind, status`).all(Number(agentUserId));
  const at = (kind, status) => round2((rows.find((r) => r.kind === kind && r.status === status) || {}).s || 0);
  const pending = at('commission', 'pending');
  // settled 里同时含未提现的佣金和负数 adjustment，二者相加才是真正可提现的净额
  const settledNet = round2(db.prepare(`SELECT IFNULL(SUM(amount),0) AS s FROM agent_commissions
    WHERE agent_user_id = ? AND status = 'settled'`).get(Number(agentUserId)).s || 0);
  const withdrawn = at('commission', 'withdrawn');
  const reversed = at('commission', 'reversed');
  const available = Math.max(0, settledNet);
  return {
    pending, settled: Math.max(0, settledNet), withdrawn, reversed,
    available, debt: Math.max(0, -settledNet), total: round2(pending + settledNet + withdrawn),
  };
}

function listForAgent(agentUserId, limit = 100) {
  return db.prepare(`SELECT c.*, u.nickname AS buyer_name, o.status AS order_status
    FROM agent_commissions c
    LEFT JOIN users u ON u.id = c.buyer_user_id
    LEFT JOIN orders o ON o.id = c.order_id
    WHERE c.agent_user_id = ? ORDER BY c.id DESC LIMIT ?`).all(Number(agentUserId), Math.min(Number(limit) || 100, 500));
}

/**
 * 申请提现。一期为「整笔全额提现」：不允许用户自己填金额去拆账，
 * 因为部分提现需要把某条佣金拆成两半，对账容易出错。
 * 管理员审核打款后 status 才变 paid。
 */
function requestWithdrawal(agentUserId, payAccount = '', remark = '') {
  const s = summary(agentUserId);
  const min = withdrawMin();
  if (s.available < min) {
    return { ok: false, error: `可提现余额 ¥${s.available.toFixed(2)} 未达到最低提现额 ¥${min.toFixed(2)}` };
  }
  const pending = db.prepare(`SELECT COUNT(*) AS c FROM withdrawals WHERE agent_user_id = ? AND status = 'pending'`)
    .get(Number(agentUserId)).c;
  if (pending) return { ok: false, error: '已有待审核的提现申请，请等待处理' };
  const no = genWithdrawalNo();
  const info = db.prepare(`INSERT INTO withdrawals
    (withdrawal_no, agent_user_id, amount, channel, status, pay_account, remark, created_at)
    VALUES (?,?,?,'manual','pending',?,?,?)`)
    .run(no, Number(agentUserId), s.available, String(payAccount || '').slice(0, 200),
      String(remark || '').slice(0, 300), now());
  // 把待提现的 settled 记录一次性锁定，防止同一笔佣金被两张提现单重复领取
  db.prepare(`UPDATE agent_commissions SET status = 'withdrawn', withdrawal_id = ?
    WHERE agent_user_id = ? AND status = 'settled'`).run(info.lastInsertRowid, Number(agentUserId));
  return { ok: true, withdrawal: db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(info.lastInsertRowid) };
}

/** 审核：通过=已打款；驳回要把锁定的佣金退回 settled，否则用户钱凭空消失。 */
function reviewWithdrawal(id, approve, by = 'admin', remark = '') {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(Number(id));
  if (!w) return { ok: false, error: '提现单不存在' };
  if (w.status !== 'pending') return { ok: false, error: '该提现单已处理' };
  const ts = now();
  if (approve) {
    db.prepare(`UPDATE withdrawals SET status = 'paid', reviewed_by = ?, reviewed_at = ?, paid_at = ?, remark = ? WHERE id = ?`)
      .run(by, ts, ts, String(remark || w.remark || ''), w.id);
  } else {
    db.prepare(`UPDATE withdrawals SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, remark = ? WHERE id = ?`)
      .run(by, ts, String(remark || '管理员驳回'), w.id);
    db.prepare(`UPDATE agent_commissions SET status = 'settled', withdrawal_id = NULL WHERE withdrawal_id = ?`)
      .run(w.id);
  }
  return { ok: true, withdrawal: db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(w.id) };
}

function listWithdrawalsForAgent(agentUserId, limit = 50) {
  return db.prepare('SELECT * FROM withdrawals WHERE agent_user_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(agentUserId), Math.min(Number(limit) || 50, 200));
}

module.exports = {
  accrueForOrder, settleDue, reverseForOrder, summary, listForAgent,
  requestWithdrawal, reviewWithdrawal, listWithdrawalsForAgent,
  settleDays, withdrawMin, round2,
};

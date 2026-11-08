/* 未付款订单的「删除」
 *
 * 只做软删除，绝不 DELETE 记录。原因很实际：支付二维码可能已经渲染给用户了，
 * 他过半小时才想起来扫码。记录真删掉，微信回调打回来找不到订单，
 * 钱进了商户号、用户却没有订单也没有货 —— 这种故障没法自愈。
 * 所以标记 deleted_at/deleted_by，列表过滤掉，等服务回调时由 markPaid 复活。
 *
 * 另外下单时用积分抵过现的，删除必须把积分退回，否则等于白扣用户积分。
 */
const db = require('../db');
const { now } = require('./util');

/**
 * @returns {{ok:true, points_back:number, already?:boolean} | {error:string}}
 */
function softDeletePending(order, by = 'user') {
  if (!order) return { error: '订单不存在' };
  if (order.deleted_at) return { ok: true, points_back: 0, already: true };
  if (order.status !== 'pending') {
    return { error: '只有未付款的订单可以删除，已支付订单请走退款' };
  }
  const back = Math.round(Number(order.discount || 0) * 100);
  const run = db.transaction(() => {
    if (back > 0) {
      const u = db.prepare('SELECT points FROM users WHERE id = ?').get(order.user_id);
      const balance = Number((u && u.points) || 0) + back;
      db.prepare('UPDATE users SET points = ? WHERE id = ?').run(balance, order.user_id);
      db.prepare('INSERT INTO points_logs (user_id, change, balance, reason, created_at) VALUES (?,?,?,?,?)')
        .run(order.user_id, back, balance, `删除订单 ${order.order_no}，退回抵扣积分`, now());
    }
    db.prepare('UPDATE orders SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now(), by, order.id);
  });
  run();
  return { ok: true, points_back: back };
}

/** 批量清理 N 天前仍未支付的订单，返回清理条数 */
function purgeStalePending(days = 7, by = 'admin') {
  const d = Math.max(Number(days) || 7, 1);
  // created_at 统一是 ISO 8601（lib/util.js 的 now()），可以直接用字符串比较
  const cutoff = new Date(Date.now() - d * 86400000).toISOString();
  const rows = db.prepare(
    `SELECT * FROM orders WHERE status = 'pending' AND deleted_at IS NULL AND created_at < ?`
  ).all(cutoff);
  let n = 0;
  for (const o of rows) {
    const r = softDeletePending(o, by);
    if (r.ok) n += 1;
  }
  return { count: n, days: d, cutoff };
}

module.exports = { softDeletePending, purgeStalePending };

/* 积分类操作的唯一入口（2026-11-13 模板市场）
 *
 * 之前积分的加减散落在 portal.js（签到）、pay/orders（订单抵扣）、blcloud（额度兑换）里，
 * 每处都自己写 UPDATE users + INSERT points_logs。模板市场要做「原子扣分 + 已购免重扣」，
 * 再把这套复制一份迟早出现「扣了分没发货」或「流水余额对不上」。
 *
 * 约定：
 *  - users.points 是唯一真相源，points_logs.balance 是每次变动后的快照；
 *  - 所有加减都走本模块，事务保证「改余额 + 记流水」同生共死；
 *  - 扣减用条件更新（WHERE points >= amount），并发时不会扣成负数；
 *  - 签到按北京时间自然日幂等，网页端 / 开放接口 / 以后任何入口共用一份判定。
 */
const db = require('../db');
const { now, chinaDay, chinaToday } = require('./util');
const { getSetting } = require('./config');

const SIGNIN_REASON = '每日签到';
const REGISTER_REASON = '新用户注册';
const REDEEM_REASON = '模板兑换';

function balance(userId) {
  const u = db.prepare('SELECT points FROM users WHERE id = ?').get(userId);
  return u ? Number(u.points || 0) : 0;
}

/** 加分/减分。返回值是变动后的余额；调用方若已在外层事务里，这里是 SAVEPOINT。 */
const apply = db.transaction((userId, delta, reason) => {
  const n = Math.trunc(Number(delta) || 0);
  if (!n) return balance(userId);
  const u = db.prepare('SELECT points FROM users WHERE id = ?').get(userId);
  if (!u) {
    const e = new Error('用户不存在');
    e.code = 'USER_NOT_FOUND';
    throw e;
  }
  const after = Number(u.points || 0) + n;
  if (after < 0) {
    const e = new Error('积分不足');
    e.code = 'INSUFFICIENT_CREDITS';
    throw e;
  }
  db.prepare('UPDATE users SET points = ? WHERE id = ?').run(after, userId);
  db.prepare('INSERT INTO points_logs (user_id, change, balance, reason, created_at) VALUES (?,?,?,?,?)')
    .run(userId, n, after, String(reason || ''), now());
  return after;
});

/** 条件扣减：并发下只有一个请求能扣成功，返回 null 表示余额不足。 */
const spend = db.transaction((userId, amount, reason) => {
  const n = Math.max(0, Math.trunc(Number(amount) || 0));
  const r = db.prepare('UPDATE users SET points = points - ? WHERE id = ? AND points >= ?').run(n, userId, n);
  if (!r.changes) return null;
  const after = balance(userId);
  db.prepare('INSERT INTO points_logs (user_id, change, balance, reason, created_at) VALUES (?,?,?,?,?)')
    .run(userId, -n, after, String(reason || ''), now());
  return after;
});

/** 每日签到（北京时间 00:00 日切，幂等）。 */
function signin(userId) {
  return db.transaction(() => {
    const last = db.prepare('SELECT created_at FROM points_logs WHERE user_id = ? AND reason = ? ORDER BY id DESC LIMIT 1')
      .get(userId, SIGNIN_REASON);
    const day = chinaToday();
    if (last && chinaDay(last.created_at) === day) {
      return { ok: false, already: true, code: 'ALREADY_SIGNED', gain: 0, balance: balance(userId), date: day };
    }
    const gain = Math.max(0, Math.trunc(Number(getSetting('user_points_signin', '10')) || 10));
    const after = apply(userId, gain, SIGNIN_REASON);
    return { ok: true, already: false, gain, balance: after, date: day };
  })();
}

function signedInToday(userId) {
  const last = db.prepare('SELECT created_at FROM points_logs WHERE user_id = ? AND reason = ? ORDER BY id DESC LIMIT 1')
    .get(userId, SIGNIN_REASON);
  return !!last && chinaDay(last.created_at) === chinaToday();
}

/**
 * 新用户注册赠送（默认 200，可在后台改 user_points_register）。
 * 只在「新建用户」那一刻发，历史用户不补发、不追溯 —— 模板市场尚未发售，
 * 没有需要回滚的存量积分口径。
 */
function registerBonus(userId) {
  const bonus = Math.max(0, Math.trunc(Number(getSetting('user_points_register', '200')) || 0));
  if (!bonus) return { gain: 0, balance: balance(userId) };
  return { gain: bonus, balance: apply(userId, bonus, REGISTER_REASON) };
}

module.exports = {
  balance, apply, spend, signin, signedInToday, registerBonus,
  SIGNIN_REASON, REGISTER_REASON, REDEEM_REASON,
};

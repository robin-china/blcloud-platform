/**
 * 卡密绑定：把「未分配的授权码」绑到某个账号上。
 *
 * 渠道先印卡、客户后注册的模式里，码发出去时还不知道是谁用；
 * 用户拿到码后登录、在「我的授权」里绑定，绑定那一刻才开始计时。
 */
const db = require('../db');
const { now } = require('./util');

const DAY = 86400000;

function addDays(days) {
  return new Date(Date.now() + Number(days) * DAY).toISOString();
}

/**
 * 绑定一张授权码到用户。
 * 已绑给别人的码一律回「授权码无效或已被使用」—— 不要告诉调用方
 * 「这张码存在但属于别人」，否则等于送了一个可枚举的探测接口。
 */
function bind(lic, userId, by = 'self') {
  if (!lic) return { ok: false, code: 'LICENSE_NOT_FOUND', reason: '授权码不存在或已失效' };
  if (lic.status === 'revoked') return { ok: false, code: 'LICENSE_REVOKED', reason: '该授权码已被作废' };
  if (lic.user_id && Number(lic.user_id) === Number(userId)) {
    return { ok: true, already: true, license: db.prepare('SELECT * FROM licenses WHERE id = ?').get(lic.id) };
  }
  if (lic.user_id && Number(lic.user_id) !== Number(userId)) {
    return { ok: false, code: 'LICENSE_TAKEN', reason: '授权码无效或已被使用' };
  }

  const ts = now();
  // 卡密池的码在印出来时还没开始计时：绑定这一刻才是 start_at
  const endAt = lic.type === 'permanent' ? null : addDays(Number(lic.duration_days) || 365);
  db.prepare(`UPDATE licenses SET user_id = ?, status = 'active', start_at = ?, end_at = ?,
    bound_at = ?, bound_by = ? WHERE id = ?`)
    .run(Number(userId), ts, endAt, ts, by, lic.id);
  return { ok: true, already: false, license: db.prepare('SELECT * FROM licenses WHERE id = ?').get(lic.id) };
}

/**
 * 自助绑定的防爆破：一张码 24 个十六进制字符（96 位），猜不中，
 * 但拿到部分码的用户会反复试。按用户计窗口，失败 10 次锁 10 分钟。
 */
const attempts = new Map();
const WINDOW = 10 * 60 * 1000;
const MAX_FAIL = 10;

function guard(userId) {
  const key = String(userId);
  const rec = attempts.get(key);
  const ts = Date.now();
  if (!rec || ts - rec.first > WINDOW) {
    attempts.set(key, { first: ts, count: 0 });
    return { ok: true };
  }
  if (rec.count >= MAX_FAIL) {
    return { ok: false, code: 'TOO_MANY_ATTEMPTS', reason: '尝试次数过多，请 10 分钟后再试' };
  }
  return { ok: true };
}

function noteFail(userId) {
  const key = String(userId);
  const rec = attempts.get(key) || { first: Date.now(), count: 0 };
  rec.count += 1;
  attempts.set(key, rec);
}

function noteSuccess(userId) {
  attempts.delete(String(userId));
}

module.exports = { bind, guard, noteFail, noteSuccess, addDays };

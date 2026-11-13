/* 个人 ID（对外展示用，替代 openid）
 *
 * 用户要求：不公开显示 openid，取其后几位转成 9 位数字作为个人 ID，避免重复即可。
 * 实现口径：
 *  - 取 openid 尾部 8 位 + 用户主键一起做 sha256，再映射到 100000000~999999999；
 *    首位恒为 1~9，不会出现前导零，长度恒 9 位。直接用 openid 尾段不行：
 *    微信 openid 含字母、长度不定，而且会把原始凭据片段暴露出去。
 *  - 同类用户同一份输入永远得到同一个 ID（重登/换设备不变）。
 *  - 冲突时换 attempt 重新派生；库里另有部分唯一索引兜底，绝不会发重号。
 *  - 老账号懒生成：首次被查询时才写入，不追溯改历史数据。
 */
const crypto = require('crypto');
const db = require('../db');

const MIN = 100000000;
const SPAN = 900000000;

function candidate(openid, id, attempt) {
  const tail = String(openid || '').slice(-8);
  const h = crypto.createHash('sha256').update(`${tail}|${id}|${attempt}`, 'utf8').digest();
  return String(MIN + (h.readUInt32BE(0) % SPAN));
}

/** 入参可以是 SELECT * 出来的整行，也可以只带 { id }。 */
function ensurePublicId(user) {
  const row = user && user.id ? user : null;
  if (!row) return '';
  if (row.public_id && /^\d{9}$/.test(String(row.public_id))) return String(row.public_id);
  const fresh = db.prepare('SELECT id, openid, public_id FROM users WHERE id = ?').get(row.id);
  if (!fresh) return '';
  if (fresh.public_id && /^\d{9}$/.test(String(fresh.public_id))) return String(fresh.public_id);
  for (let i = 0; i < 32; i += 1) {
    const c = candidate(fresh.openid, fresh.id, i);
    const clash = db.prepare('SELECT id FROM users WHERE public_id = ? AND id <> ?').get(c, fresh.id);
    if (clash) continue;
    try {
      const r = db.prepare("UPDATE users SET public_id = ? WHERE id = ? AND (public_id IS NULL OR public_id = '')")
        .run(c, fresh.id);
      if (r.changes) return c;
      const nowRow = db.prepare('SELECT public_id FROM users WHERE id = ?').get(fresh.id);
      if (nowRow && nowRow.public_id) return String(nowRow.public_id);
    } catch { /* 唯一索引竞争：换下一个候选 */ }
  }
  return '';
}

function isValid(value) {
  return /^\d{9}$/.test(String(value || ''));
}

module.exports = { ensurePublicId, candidate, isValid };

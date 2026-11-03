/**
 * 到期前站内提醒。
 *
 * 一期只做站内（用户中心「我的授权」顶部横幅 + /api/portal/notices），
 * 不接微信模板消息：模板 ID 需要另配，且委托代扣/自动续费本来也没开，
 * 提醒的目的是「让用户自己点一下续费」，不是替他扣钱。
 *
 * 去重靠 UNIQUE(license_id, days_left)：同一张授权同一档剩余天数只生成一次，
 * 每天扫不会把用户中心刷屏。
 */
const db = require('../db');
const { now } = require('./util');
const { getSetting } = require('./config');

const DAY = 86400000;

function daysList() {
  const raw = String(getSetting('renew_remind_days', '7,3,1') || '7,3,1');
  return raw.split(',').map((s) => Math.round(Number(s.trim())))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 365);
}

function scan() {
  const days = daysList();
  if (!days.length) return { scanned: 0, created: 0 };
  const rows = db.prepare(`SELECT id, user_id, end_at FROM licenses
    WHERE status = 'active' AND end_at IS NOT NULL AND end_at <> ''`).all();
  let created = 0;
  const ts = now();
  const stmt = db.prepare(`INSERT OR IGNORE INTO license_reminders
    (license_id, user_id, days_left, end_at, created_at) VALUES (?,?,?,?,?)`);
  for (const l of rows) {
    const end = Date.parse(l.end_at);
    if (!Number.isFinite(end)) continue;
    const left = Math.ceil((end - Date.now()) / DAY);
    if (!days.includes(left) || left <= 0) continue;
    const r = stmt.run(l.id, l.user_id, left, l.end_at, ts);
    if (r.changes) created += 1;
  }
  return { scanned: rows.length, created, days };
}

function listForUser(userId, limit = 20) {
  return db.prepare(`SELECT r.*, l.license_key, l.plan_code, l.status AS license_status,
    p.name AS plan_name
    FROM license_reminders r
    LEFT JOIN licenses l ON l.id = r.license_id
    LEFT JOIN plans p ON p.id = l.plan_id
    WHERE r.user_id = ? ORDER BY r.id DESC LIMIT ?`)
    .all(Number(userId), Math.min(Number(limit) || 20, 100));
}

function listAll(limit = 100) {
  return db.prepare(`SELECT r.*, u.nickname, u.phone, l.license_key, l.plan_code
    FROM license_reminders r
    LEFT JOIN users u ON u.id = r.user_id
    LEFT JOIN licenses l ON l.id = r.license_id
    ORDER BY r.id DESC LIMIT ?`).all(Math.min(Number(limit) || 100, 500));
}

module.exports = { scan, listForUser, listAll, daysList };

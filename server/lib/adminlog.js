/* 后台操作审计日志
 * 单独成模块：授权相关的吊销/删除/解绑在 routes/licenses.js 里，
 * 而 logAdmin 原本写死在 routes/admin.js 内部，导致授权侧一个操作都不留痕。
 * 客户来问「我的授权是谁删的」，查不到就等于没有。
 */
const db = require('../db');
const { now } = require('./util');

function logAdmin(req, action, detail = '') {
  try {
    db.prepare('INSERT INTO admin_logs (admin_id, admin_name, action, detail, created_at) VALUES (?,?,?,?,?)')
      .run(req.admin?.sub || 0, req.admin?.username || '', action, detail, now());
  } catch { /* 审计失败不能影响主流程 */ }
}

module.exports = { logAdmin };

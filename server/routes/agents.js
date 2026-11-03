/* 代理商管理（后台）
 * 一期：手动授权身份 + 名下用户归属 + 佣金账本 + 提现单人工审核。
 * 二期接「微信商家转账到零钱」时只需把 channel 从 manual 换成 wxpay_transfer。
 */
const crypto = require('crypto');
const db = require('../db');
const { now } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');
const { logAdmin } = require('../lib/adminlog');
const commission = require('../lib/commission');
const reminders = require('../lib/reminders');

function genAgentCode() {
  return 'AG' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

/** CSV 单元格：防 Excel 公式注入（= + - @ 开头补单引号） */
function cell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

module.exports = async function agentRoutes(app) {
  /* -------- 静态路径全部放在 /:id 之前，避免被参数路由抢走 -------- */

  app.get('/api/agents', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const list = db.prepare(`SELECT u.id, u.nickname, u.phone, u.openid, u.agent_status,
      u.agent_rate, u.agent_code, u.created_at,
      (SELECT COUNT(*) FROM users b WHERE b.agent_id = u.id) AS downline_count,
      (SELECT IFNULL(SUM(o.pay_amount),0) FROM orders o
        JOIN users b ON b.id = o.user_id WHERE b.agent_id = u.id AND o.status = 'paid') AS downline_paid
      FROM users u WHERE u.agent_status = 'active' ORDER BY u.id DESC`).all();
    return { list: list.map((a) => ({ ...a, summary: commission.summary(a.id) })) };
  });

  app.get('/api/agents/commissions', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const agentId = Number(req.query.agent_id || 0);
    const where = agentId ? 'WHERE c.agent_user_id = ?' : '';
    const args = agentId ? [agentId] : [];
    const list = db.prepare(`SELECT c.*, a.nickname AS agent_name, b.nickname AS buyer_name,
      o.status AS order_status, o.pay_amount
      FROM agent_commissions c
      LEFT JOIN users a ON a.id = c.agent_user_id
      LEFT JOIN users b ON b.id = c.buyer_user_id
      LEFT JOIN orders o ON o.id = c.order_id
      ${where} ORDER BY c.id DESC LIMIT 500`).all(...args);
    return { list };
  });

  app.get('/api/agents/withdrawals', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const status = String(req.query.status || '').trim();
    const where = status ? 'WHERE w.status = ?' : '';
    const args = status ? [status] : [];
    const list = db.prepare(`SELECT w.*, u.nickname, u.phone, u.agent_code
      FROM withdrawals w LEFT JOIN users u ON u.id = w.agent_user_id
      ${where} ORDER BY w.id DESC LIMIT 500`).all(...args);
    return { list };
  });

  app.get('/api/agents/withdrawals/export.csv', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const rows = db.prepare(`SELECT w.*, u.nickname, u.phone FROM withdrawals w
      LEFT JOIN users u ON u.id = w.agent_user_id ORDER BY w.id DESC`).all();
    const lines = ['提现单号,代理商,手机号,金额,渠道,状态,收款账号,申请时间,审核人,打款时间,备注'];
    for (const w of rows) {
      lines.push([w.withdrawal_no, w.nickname, w.phone, w.amount, w.channel, w.status,
        w.pay_account, w.created_at, w.reviewed_by, w.paid_at, w.remark].map(cell).join(','));
    }
    logAdmin(req, 'agent.export', `导出提现单 ${rows.length} 条`);
    return reply.type('text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="withdrawals.csv"')
      .send('\ufeff' + lines.join('\r\n'));
  });

  app.post('/api/agents/withdrawals/:id/review', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    const approve = b.approve === true || b.approve === 1 || b.approve === '1';
    const r = commission.reviewWithdrawal(req.params.id, approve,
      req.admin?.username || 'admin', String(b.remark || ''));
    if (!r.ok) return reply.code(400).send({ error: r.error });
    logAdmin(req, 'agent.withdraw.review', `提现单 ${r.withdrawal.withdrawal_no} ${approve ? '已打款' : '驳回'}`);
    return { ok: true, withdrawal: r.withdrawal };
  });

  app.get('/api/agents/reminders', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { list: reminders.listAll(), days: reminders.daysList() };
  });

  app.post('/api/agents/reminders/scan', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const r = reminders.scan();
    logAdmin(req, 'agent.remind.scan', `扫描到期授权 ${r.scanned} 张，新增提醒 ${r.created} 条`);
    return { ok: true, ...r };
  });

  /* -------- 代理商授权 / 名下用户 -------- */

  app.post('/api/agents/:id/authorize', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = Number(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    const rate = Math.max(0, Math.min(Number((req.body || {}).rate) || 0, 1));
    if (rate <= 0) return reply.code(400).send({ error: '佣金比例必须在 0~1 之间' });
    let code = String((req.body || {}).code || '').trim().toUpperCase() || user.agent_code || genAgentCode();
    const dup = db.prepare('SELECT id FROM users WHERE UPPER(agent_code) = ? AND id <> ?').get(code, id);
    if (dup) return reply.code(400).send({ error: `邀请码 ${code} 已被其他代理商使用` });
    db.prepare("UPDATE users SET agent_status = 'active', agent_rate = ?, agent_code = ? WHERE id = ?")
      .run(rate, code, id);
    logAdmin(req, 'agent.authorize', `授权用户 ${id} 为代理商，比例 ${rate}，邀请码 ${code}`);
    return { ok: true, agent_code: code, rate };
  });

  app.post('/api/agents/:id/revoke', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = Number(req.params.id);
    db.prepare("UPDATE users SET agent_status = 'paused' WHERE id = ?").run(id);
    logAdmin(req, 'agent.revoke', `暂停用户 ${id} 的代理商身份`);
    return { ok: true };
  });

  app.get('/api/agents/:id/downline', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = Number(req.params.id);
    const list = db.prepare(`SELECT u.id, u.nickname, u.phone, u.created_at,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS paid_orders,
      (SELECT IFNULL(SUM(pay_amount),0) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS paid_amount
      FROM users u WHERE u.agent_id = ? ORDER BY u.id DESC`).all(id);
    return { list };
  });

  app.post('/api/agents/:id/downline', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = Number(req.params.id);
    const buyerId = Number((req.body || {}).user_id || 0);
    const agent = db.prepare("SELECT * FROM users WHERE id = ? AND agent_status = 'active'").get(id);
    if (!agent) return reply.code(400).send({ error: '代理商不存在或未启用' });
    const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(buyerId);
    if (!buyer) return reply.code(404).send({ error: '用户不存在' });
    if (buyerId === id) return reply.code(400).send({ error: '不能把代理商本人设为名下用户' });
    if (buyer.agent_status === 'active') return reply.code(400).send({ error: '该用户本身是代理商' });
    db.prepare('UPDATE users SET agent_id = ? WHERE id = ?').run(id, buyerId);
    logAdmin(req, 'agent.downline.add', `把用户 ${buyerId} 划给代理商 ${id}`);
    return { ok: true };
  });

  app.delete('/api/agents/downline/:userId', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const userId = Number(req.params.userId);
    db.prepare('UPDATE users SET agent_id = 0 WHERE id = ?').run(userId);
    logAdmin(req, 'agent.downline.remove', `移除用户 ${userId} 的代理商归属`);
    return { ok: true };
  });
};

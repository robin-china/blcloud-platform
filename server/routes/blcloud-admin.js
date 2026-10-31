/* 管理端：blcloud 密钥、调用统计与额度管理 */
const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const bl = require('../lib/blcloud');

module.exports = async function blcloudAdminRoutes(app) {
  app.get('/api/admin/blcloud/stats', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
    return { ok: true, ...bl.platformStats(days) };
  });

  app.get('/api/admin/blcloud/keys', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(Math.max(Number(req.query.pageSize) || 20, 1), 100);
    const kw = String(req.query.q || '').trim();
    const userId = Number(req.query.user_id) || 0;
    const where = [];
    const args = [];
    if (userId) { where.push('k.user_id = ?'); args.push(userId); }
    if (kw) {
      where.push('(k.key_name LIKE ? OR k.key_prefix LIKE ? OR u.nickname LIKE ? OR u.openid LIKE ? OR u.phone LIKE ?)');
      args.push(`%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM blcloud_keys k LEFT JOIN users u ON u.id = k.user_id ${w}`).get(...args).c;
    const list = db.prepare(`SELECT k.*, u.nickname, u.openid FROM blcloud_keys k LEFT JOIN users u ON u.id = k.user_id
      ${w} ORDER BY k.id DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
    return { list: list.map(bl.keyPayload), total, page, pages: Math.ceil(total / size) || 1 };
  });

  app.post('/api/admin/blcloud/keys/:id/status', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = Number(req.params.id);
    const status = String((req.body || {}).status || '');
    if (!['active', 'revoked'].includes(status)) return reply.code(400).send({ error: '状态值非法' });
    db.prepare('UPDATE blcloud_keys SET status = ? WHERE id = ?').run(status, id);
    return { ok: true, key: bl.keyPayload(bl.getKey(id)) };
  });

  app.delete('/api/admin/blcloud/keys/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    db.prepare('DELETE FROM blcloud_keys WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });

  app.get('/api/admin/blcloud/usage', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(Math.max(Number(req.query.pageSize) || 30, 1), 200);
    const userId = Number(req.query.user_id) || 0;
    const date = String(req.query.date || '');
    const where = [];
    const args = [];
    if (userId) { where.push('x.user_id = ?'); args.push(userId); }
    if (date) { where.push('x.date = ?'); args.push(date); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM blcloud_usage x ${w}`).get(...args).c;
    const list = db.prepare(`SELECT x.*, u.nickname, u.openid, k.key_prefix FROM blcloud_usage x
      LEFT JOIN users u ON u.id = x.user_id LEFT JOIN blcloud_keys k ON k.id = x.key_id
      ${w} ORDER BY x.id DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
    return { list, total, page, pages: Math.ceil(total / size) || 1 };
  });

  /* 调整用户调用额度池 */
  app.post('/api/admin/blcloud/quota', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const { user_id, delta, reason } = req.body || {};
    const uid = Number(user_id) || 0;
    const d = Number(delta) || 0;
    if (!uid || !d) return reply.code(400).send({ error: '参数不完整' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    if (!user) return reply.code(404).send({ error: '用户不存在' });
    const q = bl.addQuota(uid, d, reason || `管理员调整额度 ${d > 0 ? '+' : ''}${d} 次`);
    return { ok: true, quota: q, user: { id: uid, nickname: user.nickname } };
  });

  app.get('/api/admin/blcloud/settings', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { ok: true, cfg: bl.cfg() };
  });

  app.post('/api/admin/blcloud/settings', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    return { ok: true, cfg: bl.saveCfg({
      enabled: b.enabled, freeQuota: b.freeQuota, perPoint: b.perPoint, dailyLimit: b.dailyLimit,
    }) };
  });
};

/* 数据留存维护接口
 *
 * 后台「数据留存」页全部走这里：
 *  - GET  /api/maintenance/retention          每张流水表：行数、最早一行、保留天数、下次会删多少
 *  - POST /api/maintenance/retention          改保留天数（0 = 不自动清）
 *  - POST /api/maintenance/retention/run      立刻按策略清一次（可只清指定表）
 *  - POST /api/maintenance/retention/clear    清空单表（强制先备份 + 输入确认词）
 *
 * 为什么要单独一页：之前只有「备份与恢复」里的「清空整表」，
 * 既不能按时间滚动清理，也看不到「这张表到底有多少行、最早一条是哪年的」。
 */
const retention = require('../lib/retention');
const { requireAdmin } = require('../lib/auth');
const { logAdmin } = require('../lib/adminlog');

module.exports = async function retentionRoutes(app) {
  app.get('/api/maintenance/retention', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { ...retention.overview(), last_run: retention.lastRun() };
  });

  app.post('/api/maintenance/retention', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    const patch = b.days && typeof b.days === 'object' ? b.days : null;
    if (!patch) return reply.code(400).send({ error: '缺少要修改的保留天数' });
    try {
      const days = retention.saveDays(patch);
      const names = Object.keys(patch)
        .map((k) => (retention.policyOf(k) || {}).name)
        .filter(Boolean)
        .join('、');
      logAdmin(req, 'retention.save', `${names}：${JSON.stringify(patch)}`);
      return { ok: true, days };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.post('/api/maintenance/retention/run', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    const keys = Array.isArray(b.keys) ? b.keys.map(String) : [];
    const res = retention.run(keys, { by: (req.admin && req.admin.username) || 'admin' });
    if (res.total) {
      const detail = Object.entries(res.deleted).map(([t, n]) => `${t} ${n}`).join('、');
      logAdmin(req, 'retention.run', `按策略清理 ${res.total} 行：${detail}`);
    }
    return { ok: true, ...res };
  });

  app.post('/api/maintenance/retention/clear', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    const key = String(b.key || '');
    const confirm = String(b.confirm || '').trim();
    if (confirm !== '清除' && confirm.toUpperCase() !== 'DELETE') {
      return reply.code(400).send({ error: '请输入「清除」二字确认' });
    }
    try {
      const res = retention.clearTable(key, { backup: b.backup !== false });
      logAdmin(req, 'retention.clear',
        `${res.name || key} 清空：删除 ${res.deleted}/${res.before || res.deleted} 行；清空前备份 ${res.backup || '（未备份）'}`);
      return res;
    } catch (e) {
      return reply.code(400).send({ error: `清空失败：${e.message}` });
    }
  });
};

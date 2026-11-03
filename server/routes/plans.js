/* 套餐档位管理（后台）
 * 运行时数据源是 plans 表；这里的 export/import 只是把配置存成可版本化的 JSON。
 */
const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const plans = require('../lib/plans');
const { logAdmin } = require('../lib/adminlog');

module.exports = async function planRoutes(app) {
  app.get('/api/plans', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { list: plans.list(false) };
  });

  // 静态路径要先于 /api/plans/:id 注册
  app.get('/api/plans/export', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const cfg = plans.exportConfig();
    logAdmin(req, 'plan.export', `导出 ${cfg.plans.length} 个档位`);
    return cfg;
  });

  app.post('/api/plans/import', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const cfg = (req.body || {}).config;
    if (cfg === undefined) return reply.code(400).send({ error: '缺少 config' });
    let parsed = cfg;
    if (typeof cfg === 'string') {
      try { parsed = JSON.parse(cfg); } catch (e) {
        return reply.code(400).send({ error: `JSON 解析失败：${e.message}` });
      }
    }
    const r = plans.importConfig(parsed);
    if (!r.ok) return reply.code(400).send({ error: r.errors.join('；'), ...r });
    logAdmin(req, 'plan.import', `导入档位：新增 ${r.created} / 更新 ${r.updated}`);
    return { ok: true, ...r, list: plans.list(false) };
  });

  app.get('/api/plans/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const p = plans.get(req.params.id);
    if (!p) return reply.code(404).send({ error: '档位不存在' });
    return { plan: p };
  });

  app.post('/api/plans', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const r = plans.insert(req.body || {});
    if (!r.ok) return reply.code(400).send({ error: r.errors.join('；') });
    logAdmin(req, 'plan.create', `新增档位 ${r.plan.code}（${r.plan.name}）`);
    return { ok: true, id: r.id, plan: r.plan };
  });

  app.post('/api/plans/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const r = plans.update(req.params.id, req.body || {});
    if (!r.ok) return reply.code(400).send({ error: r.errors.join('；') });
    logAdmin(req, 'plan.update', `修改档位 ${r.plan.code}：${JSON.stringify(req.body || {}).slice(0, 500)}`);
    return { ok: true, plan: r.plan };
  });

  app.delete('/api/plans/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const p = plans.get(req.params.id);
    if (!p) return reply.code(404).send({ error: '档位不存在' });
    const used = db.prepare('SELECT COUNT(*) AS c FROM licenses WHERE plan_id = ?').get(p.id).c;
    if (used > 0) {
      return reply.code(400).send({ error: `已有 ${used} 张授权引用该档位，不能删除；请改为下架` });
    }
    db.prepare('DELETE FROM plans WHERE id = ?').run(p.id);
    logAdmin(req, 'plan.delete', `删除档位 ${p.code}`);
    return { ok: true };
  });
};

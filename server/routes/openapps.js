/* 管理端：开放接入应用（软件端凭证）管理 */
const db = require('../db');
const { now, today, safeJson } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');
const { genAppKey, genAppSecret } = require('../lib/openauth');
const plans = require('../lib/plans');
const { logAdmin } = require('../lib/adminlog');

function shape(a) {
  const stats = db.prepare(`SELECT COUNT(*) AS sessions, SUM(CASE WHEN status='active' AND expires_at > ? THEN 1 ELSE 0 END) AS online
    FROM client_sessions WHERE app_id = ?`).get(now(), a.id);
  const calls = db.prepare('SELECT COALESCE(SUM(calls),0) AS c FROM api_usage WHERE api_key = ?').get(a.app_key).c;
  const product = a.product_id ? db.prepare('SELECT id, name, type FROM products WHERE id = ?').get(a.product_id) : null;
  return {
    ...a,
    app_secret_masked: a.app_secret ? `${a.app_secret.slice(0, 6)}****${a.app_secret.slice(-4)}` : '',
    feature_schema: safeJson(a.feature_schema, []),
    product_name: product ? product.name : '',
    session_count: stats.sessions || 0,
    online_count: stats.online || 0,
    api_calls: calls || 0,
  };
}

/** 解析并校验功能码表；错误返回 null + reply 已发送 */
function parseFeatureSchema(req, reply) {
  const b = req.body || {};
  if (b.feature_schema === undefined) return { keep: true };
  const r = plans.normalizeFeatureSchema(b.feature_schema);
  if (r.error) {
    reply.code(400).send({ error: r.error });
    return null;
  }
  return { value: r.value };
}

module.exports = async function openAppRoutes(app) {
  app.get('/api/open-apps', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const list = db.prepare('SELECT * FROM open_apps ORDER BY id DESC').all();
    return { list: list.map(shape) };
  });

  app.post('/api/open-apps', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return reply.code(400).send({ error: '应用名称必填' });
    const fs = parseFeatureSchema(req, reply);
    if (!fs) return;
    const appKey = genAppKey();
    const appSecret = genAppSecret();
    const info = db.prepare(`INSERT INTO open_apps (app_key, app_secret, name, product_id, status, offline_days, feature_schema, version, download_url, release_note, remark, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(appKey, appSecret, name, Number(b.product_id) || null, b.status || 'active',
        Number(b.offline_days) || 0, JSON.stringify(fs.keep ? [] : fs.value),
        String(b.version || ''), String(b.download_url || ''),
        String(b.release_note || ''), String(b.remark || ''), now());
    const row = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(info.lastInsertRowid);
    logAdmin(req, 'openapp.create', `新建应用 ${name}（app_key=${appKey}，功能码 ${(fs.keep ? [] : fs.value).length} 个）`);
    return { ...shape(row), app_key: row.app_key, app_secret: row.app_secret };
  });

  app.post('/api/open-apps/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    const row = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: '应用不存在' });
    const fs = parseFeatureSchema(req, reply);
    if (!fs) return;
    // 改功能码表只影响之后保存的档位：已售授权里的旧 token 不回改（客户端还认它），
    // 但从档位表单里删掉后就不能再配进新档位
    const schemaJson = fs.keep ? row.feature_schema : JSON.stringify(fs.value);
    db.prepare(`UPDATE open_apps SET name = ?, product_id = ?, status = ?, offline_days = ?, feature_schema = ?, version = ?, download_url = ?, release_note = ?, remark = ? WHERE id = ?`)
      .run(
        String(b.name || row.name),
        b.product_id === undefined ? row.product_id : (Number(b.product_id) || null),
        String(b.status || row.status),
        Number(b.offline_days ?? row.offline_days) || 0,
        schemaJson,
        String(b.version ?? row.version),
        String(b.download_url ?? row.download_url),
        String(b.release_note ?? row.release_note),
        String(b.remark ?? row.remark),
        row.id
      );
    if (!fs.keep && JSON.stringify(safeJson(schemaJson, [])) !== JSON.stringify(safeJson(row.feature_schema, []))) {
      logAdmin(req, 'openapp.feature_schema', `应用 ${row.name} 功能码表更新为 ${fs.value.length} 个 token`);
    }
    return { ok: true };
  });

  app.post('/api/open-apps/:id/reset-secret', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const row = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: '应用不存在' });
    const secret = genAppSecret();
    db.prepare('UPDATE open_apps SET app_secret = ? WHERE id = ?').run(secret, row.id);
    db.prepare('UPDATE client_sessions SET status = ? WHERE app_id = ?').run('revoked', row.id);
    return { app_secret: secret };
  });

  app.delete('/api/open-apps/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    db.prepare('DELETE FROM open_apps WHERE id = ?').run(Number(req.params.id));
    db.prepare('DELETE FROM client_sessions WHERE app_id = ?').run(Number(req.params.id));
    return { ok: true };
  });

  app.get('/api/open-apps/:id/sessions', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const list = db.prepare(`SELECT s.*, u.nickname, u.phone, l.license_key, p.name AS product_name
      FROM client_sessions s LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN licenses l ON l.id = s.license_id LEFT JOIN products p ON p.id = l.product_id
      WHERE s.app_id = ? ORDER BY s.last_seen_at DESC LIMIT 200`).all(Number(req.params.id));
    return { list };
  });

  app.post('/api/open-apps/sessions/:id/revoke', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    db.prepare('UPDATE client_sessions SET status = ? WHERE id = ?').run('revoked', Number(req.params.id));
    return { ok: true };
  });

  app.get('/api/open-stats/summary', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const apps = db.prepare('SELECT COUNT(*) AS c FROM open_apps').get().c;
    const online = db.prepare("SELECT COUNT(*) AS c FROM client_sessions WHERE status='active' AND expires_at > ?").get(now()).c;
    const todayCalls = db.prepare('SELECT COALESCE(api_calls,0) AS c FROM stats_daily WHERE date = ?').get(today()).c;
    const machines = db.prepare('SELECT COUNT(*) AS c FROM license_devices').get().c;
    return { apps, online_sessions: online, today_api_calls: todayCalls, bound_machines: machines };
  });
};

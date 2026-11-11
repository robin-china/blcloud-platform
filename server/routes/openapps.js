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
    const info = db.prepare(`INSERT INTO open_apps (app_key, app_secret, name, product_id, status, offline_days, feature_schema, version, download_url, release_note, remark, release_product, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(appKey, appSecret, name, Number(b.product_id) || null, b.status || 'active',
        Number(b.offline_days) || 0, JSON.stringify(fs.keep ? [] : fs.value),
        String(b.version || ''), String(b.download_url || ''),
        String(b.release_note || ''), String(b.remark || ''),
        String(b.release_product || ''), now());
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
    db.prepare(`UPDATE open_apps SET name = ?, product_id = ?, status = ?, offline_days = ?, feature_schema = ?, version = ?, download_url = ?, release_note = ?, remark = ?, release_product = ? WHERE id = ?`)
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
        String(b.release_product ?? row.release_product ?? ''),
        row.id
      );
    if (!fs.keep && JSON.stringify(safeJson(schemaJson, [])) !== JSON.stringify(safeJson(row.feature_schema, []))) {
      logAdmin(req, 'openapp.feature_schema', `应用 ${row.name} 功能码表更新为 ${fs.value.length} 个 token`);
    }
    return { ok: true };
  });

  /* 硬重置：旧值直接作废（不等双模窗口）。会同时踢掉所有用户会话，
   * 只在「密钥已泄露、必须立刻断」的时候用；日常换代走 rotate-secret。 */
  app.post('/api/open-apps/:id/reset-secret', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const row = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: '应用不存在' });
    const secret = genAppSecret();
    db.prepare("UPDATE open_apps SET app_secret = ?, app_secret_prev = '', secret_rotated_at = ? WHERE id = ?")
      .run(secret, now(), row.id);
    db.prepare('UPDATE client_sessions SET status = ? WHERE app_id = ?').run('revoked', row.id);
    logAdmin(req, 'openapp.reset_secret', `应用 ${row.name} 硬重置密钥（旧值立即作废，会话全部失效）`);
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

  /* 清理失效会话：status<>'active' 或已过期的行。
   * 会话表每次激活/登录都会新增一行，不清理的话「会话」抽屉里全是几年前的死记录，
   * 真正要看的那台在线机器反而翻不到。在线会话一律保留。 */
  app.post('/api/open-apps/:id/sessions/cleanup', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = Number(req.params.id);
    const row = db.prepare('SELECT name FROM open_apps WHERE id = ?').get(id);
    if (!row) return reply.code(404).send({ error: '应用不存在' });
    const info = db.prepare(`DELETE FROM client_sessions
      WHERE app_id = ? AND (status <> 'active' OR expires_at < ?)`).run(id, now());
    if (info.changes) logAdmin(req, 'openapp.cleanup_sessions', `${row.name}：清理失效会话 ${info.changes} 条`);
    return { ok: true, deleted: info.changes };
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

  /* ---------------- 双模鉴权：模式报表 + 密钥轮换 ---------------- */

  /**
   * 按天 × 鉴权模式统计。关旧 HMAC 通道前必须看这张表：
   * hmac_legacy 连续几天为 0，才说明老客户端已经换掉了内置密钥。
   */
  app.get('/api/open-apps/auth-modes', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const days = Math.min(90, Math.max(1, Number((req.query || {}).days) || 14));
    const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const rows = db.prepare(`SELECT substr(created_at,1,10) AS date, auth_mode, COUNT(*) AS calls,
        SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
      FROM open_auth_log WHERE created_at >= ?
      GROUP BY date, auth_mode ORDER BY date DESC`).all(`${since}T00:00:00.000Z`);
    const totals = {};
    for (const r of rows) totals[r.auth_mode] = (totals[r.auth_mode] || 0) + Number(r.calls || 0);
    return { days, rows, totals };
  });

  /**
   * 轮换密钥：新值立即生效，旧值进 app_secret_prev 继续放行（双模期）。
   * 不吊销已有用户令牌 —— 换的是应用级凭证，不该把所有在线用户踢下线。
   */
  app.post('/api/open-apps/:id/rotate-secret', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const row = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: '应用不存在' });
    const secret = genAppSecret();
    db.prepare(`UPDATE open_apps SET app_secret_prev = app_secret, app_secret = ?, secret_rotated_at = ?, legacy_hmac = 1
      WHERE id = ?`).run(secret, now(), row.id);
    logAdmin(req, 'openapp.rotate_secret', `应用 ${row.name} 轮换密钥（旧值保留，双模期）`);
    return {
      app_secret: secret,
      prev_kept: !!row.app_secret,
      hint: '旧密钥仍可用。等「鉴权模式」报表里 hmac_legacy 连续归零后，再关闭旧通道。',
    };
  });

  /** 关闭/重开旧密钥通道（legacy_hmac）。关闭后旧 secret 请求统一 401 APP_SECRET_RETIRED */
  app.post('/api/open-apps/:id/legacy', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const row = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: '应用不存在' });
    const enabled = (req.body || {}).enabled ? 1 : 0;
    db.prepare('UPDATE open_apps SET legacy_hmac = ? WHERE id = ?').run(enabled, row.id);
    logAdmin(req, 'openapp.legacy_hmac', `应用 ${row.name} ${enabled ? '开启' : '关闭'}旧密钥通道`);
    return { ok: true, legacy_hmac: enabled };
  });

  /** 公开模式开关（仅 x-app-key + 频控 + nonce）；关掉后新客户端必须走签名或令牌 */
  app.post('/api/open-apps/:id/public-auth', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const row = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: '应用不存在' });
    const enabled = (req.body || {}).enabled ? 1 : 0;
    db.prepare('UPDATE open_apps SET public_auth = ? WHERE id = ?').run(enabled, row.id);
    logAdmin(req, 'openapp.public_auth', `应用 ${row.name} ${enabled ? '开启' : '关闭'}公开模式`);
    return { ok: true, public_auth: enabled };
  });
};

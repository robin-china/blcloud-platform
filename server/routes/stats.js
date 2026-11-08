const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const { today, now } = require('../lib/util');
const { logAdmin } = require('../lib/adminlog');
const statsreset = require('../lib/statsreset');

module.exports = async function statsRoutes(app) {
  app.get('/api/stats/overview', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const t = today();
    const sum = db.prepare(`SELECT
      IFNULL(SUM(total_downloads),0) AS downloads,
      IFNULL(SUM(total_installs),0) AS installs,
      IFNULL(SUM(active_users),0) AS active_users,
      IFNULL(SUM(total_sales),0) AS sales
      FROM products`).get();
    const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const todayRow = db.prepare('SELECT * FROM stats_daily WHERE date = ?').get(t) || {};
    const revenue = db.prepare(`SELECT IFNULL(SUM(pay_amount),0) AS total, COUNT(*) AS count FROM orders WHERE status='paid'`).get();
    const pendingOrders = db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE status='pending'`).get().c;
    const pendingLicenses = db.prepare(`SELECT COUNT(*) AS c FROM licenses WHERE status='pending'`).get().c;
    const monthRevenue = db.prepare(`SELECT IFNULL(SUM(pay_amount),0) AS total FROM orders WHERE status='paid' AND created_at >= ?`)
      .get(new Date(Date.now() - 30 * 86400000).toISOString()).total;
    const apiCalls = db.prepare('SELECT IFNULL(SUM(calls),0) AS c FROM api_usage').get().c;
    const deviceOnline = db.prepare(`SELECT COUNT(*) AS c FROM devices WHERE status='online'`).get().c;
    const deviceTotal = db.prepare('SELECT COUNT(*) AS c FROM devices').get().c;
    return {
      products: sum,
      users,
      today: {
        downloads: todayRow.downloads || 0,
        installs: todayRow.installs || 0,
        active_users: todayRow.active_users || 0,
        new_users: todayRow.new_users || 0,
        revenue: todayRow.revenue || 0,
        api_calls: todayRow.api_calls || 0,
      },
      revenue: { total: revenue.total, count: revenue.count, month: monthRevenue },
      pendingOrders,
      pendingLicenses,
      apiCalls,
      devices: { online: deviceOnline, total: deviceTotal },
    };
  });

  app.get('/api/stats/trend', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const days = Math.min(Number(req.query.days) || 14, 90);
    const rows = db.prepare('SELECT * FROM stats_daily ORDER BY date DESC LIMIT ?').all(days);
    return { list: rows.reverse() };
  });

  /**
   * 应用接入概览：给仪表盘用的「软件端接入」指标。
   *
   * 指标口径（都在库里真实存在，不做任何估算）：
   *   接入应用   open_apps 总数 / 启用数
   *   在线客户端 client_sessions 里 status=active 且未过期；今日活跃按 last_seen_at 落在今天
   *   应用 API   api_usage（open.js 每次请求 track 一次，api_key 存的是 app_key）
   *   设备 API   blcloud_usage（用户用 API 密钥直连设备接口的调用明细）
   *   升级流水   app_update_log（check / success / fail）
   *
   * api_usage 的 date 与 util.today() 一样按 UTC 算，趋势直接按 date 归并即可，
   * 不要混入本地时区，否则东八区凌晨会对不上。
   */
  app.get('/api/stats/apps', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const days = Math.min(Number(req.query.days) || 14, 90);
    const t = today();
    const ts = now();

    const apps = db.prepare(`SELECT COUNT(*) AS total,
      IFNULL(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) AS active FROM open_apps`).get();

    const sess = db.prepare(`SELECT
      IFNULL(SUM(CASE WHEN status='active' AND expires_at > ? THEN 1 ELSE 0 END),0) AS online,
      COUNT(DISTINCT CASE WHEN status='active' AND expires_at > ? THEN user_id END) AS online_users,
      IFNULL(SUM(CASE WHEN date(last_seen_at) = ? THEN 1 ELSE 0 END),0) AS today_sessions,
      COUNT(DISTINCT CASE WHEN date(last_seen_at) = ? THEN user_id END) AS today_users
      FROM client_sessions`).get(ts, ts, t, t);

    const openToday = db.prepare('SELECT IFNULL(SUM(calls),0) AS c FROM api_usage WHERE date = ?').get(t).c;
    const openTotal = db.prepare('SELECT IFNULL(SUM(calls),0) AS c FROM api_usage').get().c;
    const devToday = db.prepare('SELECT COUNT(*) AS c FROM blcloud_usage WHERE date = ?').get(t).c;
    const devTotal = db.prepare('SELECT COUNT(*) AS c FROM blcloud_usage').get().c;
    const devFailToday = db.prepare('SELECT COUNT(*) AS c FROM blcloud_usage WHERE date = ? AND ok = 0').get(t).c;

    const updates = { check: 0, success: 0, fail: 0 };
    for (const r of db.prepare('SELECT action, COUNT(*) AS c FROM app_update_log WHERE date(created_at) = ? GROUP BY action').all(t)) {
      if (updates[r.action] !== undefined) updates[r.action] = r.c;
    }

    // 趋势：按天补齐，缺的天给 0，否则折线图会在空档处错位
    const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const openByDay = {};
    for (const r of db.prepare('SELECT date, IFNULL(SUM(calls),0) AS c FROM api_usage WHERE date >= ? GROUP BY date').all(since)) openByDay[r.date] = r.c;
    const devByDay = {};
    for (const r of db.prepare('SELECT date, COUNT(*) AS c FROM blcloud_usage WHERE date >= ? GROUP BY date').all(since)) devByDay[r.date] = r.c;
    const trend = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      trend.push({ date: d, open: openByDay[d] || 0, device: devByDay[d] || 0 });
    }

    const byApp = db.prepare(`SELECT a.id, a.name, a.status, a.version, a.app_key,
      (SELECT COUNT(*) FROM client_sessions s WHERE s.app_id = a.id AND s.status='active' AND s.expires_at > ?) AS online,
      (SELECT COUNT(DISTINCT s.user_id) FROM client_sessions s WHERE s.app_id = a.id) AS users,
      (SELECT COUNT(*) FROM licenses l WHERE l.app_id = a.id AND l.status = 'active') AS licenses,
      (SELECT IFNULL(SUM(u.calls),0) FROM api_usage u WHERE u.api_key = a.app_key) AS calls,
      (SELECT IFNULL(SUM(u.calls),0) FROM api_usage u WHERE u.api_key = a.app_key AND u.date = ?) AS calls_today
      FROM open_apps a
      ORDER BY online DESC, calls DESC, a.id DESC`).all(ts, t);

    return {
      apps: { total: apps.total || 0, active: apps.active || 0 },
      sessions: {
        online: sess.online || 0,
        online_users: sess.online_users || 0,
        today_sessions: sess.today_sessions || 0,
        today_users: sess.today_users || 0,
      },
      calls: {
        open_today: openToday,
        open_total: openTotal,
        device_today: devToday,
        device_total: devTotal,
        device_fail_today: devFailToday,
        total_today: openToday + devToday,
        total: openTotal + devTotal,
      },
      updates,
      trend,
      byApp,
    };
  });

  app.get('/api/stats/api-usage', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const days = Math.min(Number(req.query.days) || 14, 90);
    const byDay = db.prepare(`SELECT date, SUM(calls) AS calls FROM api_usage GROUP BY date ORDER BY date DESC LIMIT ?`).all(days);
    const byUser = db.prepare(`SELECT u.id, u.nickname, u.phone, IFNULL(SUM(a.calls),0) AS calls
      FROM api_usage a LEFT JOIN users u ON u.id = a.user_id GROUP BY a.user_id ORDER BY calls DESC LIMIT 10`).all();
    const byEndpoint = db.prepare(`SELECT endpoint, SUM(calls) AS calls FROM api_usage GROUP BY endpoint ORDER BY calls DESC LIMIT 10`).all();
    const keys = db.prepare(`SELECT k.*, u.nickname FROM api_keys k LEFT JOIN users u ON u.id=k.user_id ORDER BY k.id DESC LIMIT 50`).all();
    return { byDay: byDay.reverse(), byUser, byEndpoint, keys };
  });

  /**
   * 清零演示统计。
   * 下载/安装/活跃归 0；趋势曲线清空；销量默认按真实订单重算。
   * body: { real_sales: false } 时销量也一并归零（彻底要一张白纸的场景）。
   */
  app.post('/api/stats/reset', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const realSales = (req.body || {}).real_sales !== false;
    const r = statsreset.reset({ realSales, dropTrend: true });
    logAdmin(req, '清零演示统计', `下载 ${r.before.d} → ${r.after.d}，安装 ${r.before.i} → ${r.after.i}，`
      + `活跃 ${r.before.a} → ${r.after.a}，销量 ${r.before.s} → ${r.after.s}（重算 ${r.sales_rebuilt} 个商品，清趋势 ${r.trend_rows_removed} 行）`);
    return { ok: true, ...r };
  });

  app.post('/api/stats/track', async (req, reply) => {
    const b = req.body || {};
    const t = today();
    const field = b.event === 'install' ? 'installs' : b.event === 'download' ? 'downloads' : b.event === 'active' ? 'active_users' : 'api_calls';
    db.prepare(`INSERT INTO stats_daily (date, ${field}) VALUES (?,1)
      ON CONFLICT(date) DO UPDATE SET ${field} = ${field} + 1`).run(t);
    if (b.api_key) {
      const key = db.prepare('SELECT * FROM api_keys WHERE api_key = ?').get(String(b.api_key));
      if (key) {
        db.prepare('INSERT INTO api_usage (user_id, api_key, endpoint, calls, date) VALUES (?,?,?,?,?)')
          .run(key.user_id, key.api_key, String(b.endpoint || ''), 1, t);
        db.prepare('UPDATE api_keys SET used = used + 1 WHERE id = ?').run(key.id);
      }
    }
    return { ok: true };
  });
};

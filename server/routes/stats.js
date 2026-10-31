const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const { today } = require('../lib/util');

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

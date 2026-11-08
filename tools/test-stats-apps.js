/* 仪表盘「应用接入」指标自测
 * 覆盖：接入应用计数、在线/今日活跃去重、应用与设备 API 调用口径、
 *       设备失败数、升级流水按动作归类、趋势按天补齐、各应用排行、权限
 * 运行：node tools/test-stats-apps.js
 */
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-statsapps.db');
for (const s of ['', '-wal', '-shm']) fs.rmSync(DB_FILE + s, { force: true });
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.NODE_ENV = 'test';
process.env.BASE_PATH = 'platform';

const db = require('../server/db');
const { build } = require('../server');
const { today, now } = require('../server/lib/util');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 400) : '')); }
}
const B = '/platform';
const t = today();
const future = new Date(Date.now() + 3600 * 1000).toISOString();
const past = new Date(Date.now() - 3600 * 1000).toISOString();
const yesterday = new Date(Date.now() - 26 * 3600 * 1000).toISOString().slice(0, 10);

(async () => {
  const app = build();
  await app.ready();
  const token = (await app.inject({
    method: 'POST', url: `${B}/api/admin/login`, payload: { username: 'admin', password: 'admin123' },
  })).json().token;
  const H = { authorization: 'Bearer ' + token };

  console.log('\n[1] 权限');
  let r = await app.inject({ method: 'GET', url: `${B}/api/stats/apps` });
  check('未登录 401', r.statusCode === 401, r.statusCode);

  console.log('\n[2] 空库：全部为 0，不报错');
  r = await app.inject({ method: 'GET', url: `${B}/api/stats/apps?days=7`, headers: H });
  let d = r.json();
  check('200', r.statusCode === 200, r.statusCode);
  check('接入应用 0/0', d.apps.total === 0 && d.apps.active === 0, d.apps);
  check('在线 0', d.sessions.online === 0, d.sessions);
  check('调用全 0', d.calls.total === 0 && d.calls.total_today === 0, d.calls);
  check('趋势补齐 7 天', d.trend.length === 7, d.trend.length);
  check('趋势最后一天是今天', d.trend[6].date === t, d.trend[6]);
  check('各应用为空', d.byApp.length === 0, d.byApp);

  console.log('\n[3] 造数据：2 个接入应用（1 停用）+ 4 个客户端会话');
  const a1 = db.prepare(`INSERT INTO open_apps (app_key, app_secret, name, status, version, created_at)
    VALUES ('ak_app1', 'sec', 'LabelGo 桌面端', 'active', '1.0.21', ?)`).run(now()).lastInsertRowid;
  const a2 = db.prepare(`INSERT INTO open_apps (app_key, app_secret, name, status, version, created_at)
    VALUES ('ak_app2', 'sec', '老版本工具', 'disabled', '', ?)`).run(now()).lastInsertRowid;
  const sess = (appId, userId, status, expires, seen) => db.prepare(`INSERT INTO client_sessions
    (token, app_id, user_id, status, expires_at, last_seen_at, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(`tk_${Math.random().toString(36).slice(2)}`, appId, userId, status, expires, seen, now());
  sess(a1, 1, 'active', future, now());      // 在线 + 今日活跃
  sess(a1, 2, 'active', future, now());      // 在线 + 今日活跃
  sess(a1, 1, 'active', future, now());      // 同一用户第二台：在线 +2 台，用户数不重复计
  sess(a1, 3, 'active', past, yesterday + 'T03:00:00.000Z'); // 已过期 → 不算在线，也不算今日活跃
  sess(a2, 3, 'revoked', future, now());     // 已作废 → 不算在线

  console.log('\n[4] 在线与今日活跃口径');
  r = await app.inject({ method: 'GET', url: `${B}/api/stats/apps?days=7`, headers: H });
  d = r.json();
  check('接入应用 1/2', d.apps.active === 1 && d.apps.total === 2, d.apps);
  check('在线 3 台（含同用户多机）', d.sessions.online === 3, d.sessions);
  check('在线用户去重为 2 人', d.sessions.online_users === 2, d.sessions);
  // 今日活跃看「今天有没有活动」，不区分会话当前状态：
  // 用户上午用过后被解绑，今天依然算活跃过（否则活跃数会随解绑掉下来，违背直觉）
  check('今日活跃会话 4 台（含已解绑但今天用过）', d.sessions.today_sessions === 4, d.sessions);
  check('今日活跃用户 3 人', d.sessions.today_users === 3, d.sessions);

  console.log('\n[5] 调用口径：应用 API + 设备 API');
  const u = (appKey, calls, date) => db.prepare('INSERT INTO api_usage (user_id, api_key, endpoint, calls, date) VALUES (1,?,?,?,?)')
    .run(appKey, 'license.verify', calls, date);
  u('ak_app1', 30, t);
  u('ak_app1', 30, t);
  u('ak_app1', 100, yesterday);
  u('ak_app2', 5, t);
  const dev = (ok, date) => db.prepare(`INSERT INTO blcloud_usage (user_id, key_id, endpoint, path, method, cost, status, ok, ts, date)
    VALUES (1, 1, '/api/devices', '/api/devices', 'GET', 1, ?, ?, ?, ?)`).run(ok ? 200 : 500, ok ? 1 : 0, now(), date);
  dev(1, t); dev(1, t); dev(1, t); dev(0, t); dev(1, yesterday);

  r = await app.inject({ method: 'GET', url: `${B}/api/stats/apps?days=7`, headers: H });
  d = r.json();
  check('应用 API 今日 65', d.calls.open_today === 65, d.calls);
  check('应用 API 累计 165', d.calls.open_total === 165, d.calls);
  check('设备 API 今日 4', d.calls.device_today === 4, d.calls);
  check('设备 API 累计 5', d.calls.device_total === 5, d.calls);
  check('设备失败今日 1', d.calls.device_fail_today === 1, d.calls);
  check('今日合计 69', d.calls.total_today === 69, d.calls);
  check('累计合计 170', d.calls.total === 170, d.calls);
  const dToday = d.trend[d.trend.length - 1];
  check('趋势今日分线正确', dToday.open === 65 && dToday.device === 4, dToday);
  const dYest = d.trend.find((x) => x.date === yesterday);
  check('趋势昨日分线正确', !!dYest && dYest.open === 100 && dYest.device === 1, dYest);

  console.log('\n[6] 升级流水按动作归类');
  const upd = (action, date) => db.prepare(`INSERT INTO app_update_log
    (product, channel, platform, arch, machine, from_version, to_version, action, created_at)
    VALUES ('LabelGo','stable','win32','x64','m1','1.0.20','1.0.21',?,?)`).run(action, date);
  upd('check', now()); upd('check', now()); upd('success', now()); upd('fail', now() + ' ');
  upd('check', yesterday + 'T05:00:00.000Z');
  r = await app.inject({ method: 'GET', url: `${B}/api/stats/apps?days=7`, headers: H });
  d = r.json();
  check('今日检查 2 次（昨天的不算）', d.updates.check === 2, d.updates);
  check('今日成功 1 次', d.updates.success === 1, d.updates);
  check('今日失败 1 次', d.updates.fail === 1, d.updates);

  console.log('\n[7] 各应用排行');
  const row1 = d.byApp.find((x) => x.id === a1);
  const row2 = d.byApp.find((x) => x.id === a2);
  check('LabelGo 在线 3', row1 && row1.online === 3, row1);
  // 用户数按「这个应用累计接入过的用户」算（含已过期会话），不是当前在线去重
  check('LabelGo 累计用户 3', row1 && row1.users === 3, row1);
  check('LabelGo 累计调用 160', row1 && row1.calls === 160, row1);
  check('LabelGo 今日调用 60', row1 && row1.calls_today === 60, row1);
  check('停用应用排后面', d.byApp[0].id === a1, d.byApp.map((x) => x.id));
  check('停用应用调用单独统计', row2 && row2.calls === 5, row2);

  console.log('\n[8] days 上限收敛');
  r = await app.inject({ method: 'GET', url: `${B}/api/stats/apps?days=9999`, headers: H });
  check('days 被夹到 90', r.json().trend.length === 90, r.json().trend.length);

  await app.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

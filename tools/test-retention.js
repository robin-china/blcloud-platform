/* 数据留存 / 记录清理 / 产品维度清单 自测
 * 运行：node tools/test-retention.js
 *
 * 覆盖的是这次「记录只增不删」改造：
 *  - 流水表按保留天数滚动清理，在线会话不被动
 *  - 保留天数可改、非法值被拒
 *  - 单表清空（不备份模式，测试环境不产生大文件）
 *  - 升级记录按产品 / 按天清理
 *  - 后台接口：策略总览、保存天数、立即清理、清空确认词
 *  - 发布接口返回 product_meta，产品清单可登记未发布的产品线
 */
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-retention.db');
for (const s of ['', '-wal', '-shm']) fs.rmSync(DB_FILE + s, { force: true });
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.NODE_ENV = 'test';
const UPDATES = path.join(__dirname, '..', 'data', 'test-retention-updates');
fs.rmSync(UPDATES, { recursive: true, force: true });
fs.mkdirSync(UPDATES, { recursive: true });
process.env.UPDATES_DIR = UPDATES;
process.env.BASE_PATH = 'platform';

const { build } = require('../server');
const retention = require('../server/lib/retention');
const release = require('../server/lib/release');
const purge = require('../server/lib/purge');
const db = require('../server/db');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 400) : '')); }
}

const B = '/platform';
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
const future = () => new Date(Date.now() + 7 * 86400000).toISOString();

(async () => {
  const app = build();
  await app.ready();
  const token = (await app.inject({
    method: 'POST', url: `${B}/api/admin/login`, payload: { username: 'admin', password: 'admin123' },
  })).json().token;
  const H = { authorization: 'Bearer ' + token };

  console.log('\n[1] 留存策略定义');
  const ov = retention.overview();
  const byKey = (k) => ov.policies.find((p) => p.key === k) || {};
  ok('内置策略 ≥ 8 张表', ov.policies.length >= 8, ov.policies.length);
  ok('鉴权流水默认 30 天自动清', byKey('open_auth_log').days === 30 && byKey('open_auth_log').auto === true, byKey('open_auth_log'));
  ok('升级记录默认 180 天', byKey('app_update_log').days === 180, byKey('app_update_log').days);
  ok('会话表按会话特例处理', byKey('client_sessions').session === true);
  ok('机器台账不自动清', byKey('machine_ledger').auto === false);
  ok('后台操作日志不自动清', byKey('admin_logs').auto === false);

  console.log('\n[2] 会话：只清失效/过期，在线不动');
  const insSess = db.prepare(`INSERT INTO client_sessions
    (token, app_id, user_id, license_id, machine_id, status, expires_at, last_seen_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  insSess.run('t-live', 1, 1, 1, 'M-LIVE', 'active', future(), iso(1), iso(1));
  insSess.run('t-revoked', 1, 1, 1, 'M-REV', 'revoked', future(), iso(40), iso(40));
  insSess.run('t-expired', 1, 1, 1, 'M-EXP', 'active', iso(60), iso(60), iso(60));
  let r = retention.run(['client_sessions']);
  ok('删掉 2 条失效会话', r.deleted.client_sessions === 2, r.deleted);
  ok('在线会话保留', !!db.prepare("SELECT id FROM client_sessions WHERE token='t-live'").get());

  console.log('\n[3] 流水：按保留天数删旧行');
  const insAuth = db.prepare('INSERT INTO open_auth_log (path, method, auth_mode, app_key, ip, status, created_at) VALUES (?,?,?,?,?,?,?)');
  insAuth.run('/api/open/v1/a', 'GET', 'hmac_legacy', 'k1', '1.1.1.1', 200, iso(100));
  insAuth.run('/api/open/v1/a', 'GET', 'hmac', 'k1', '1.1.1.1', 200, iso(99));
  insAuth.run('/api/open/v1/a', 'GET', 'public', 'k1', '1.1.1.1', 200, iso(1));
  r = retention.run(['open_auth_log']);
  ok('删掉 2 条超期流水', r.deleted.open_auth_log === 2, r.deleted);
  ok('近期流水保留', db.prepare('SELECT COUNT(*) AS c FROM open_auth_log').get().c === 1);
  ok('overview 的 due 反映到期行数', retention.overview().policies.find((p) => p.key === 'open_auth_log').due === 0);

  console.log('\n[4] 保留天数可改，非法值被拒');
  retention.saveDays({ app_update_log: 7 });
  ok('已保存 7 天', retention.loadDays().app_update_log === 7);
  let threw = false;
  try { retention.saveDays({ app_update_log: -1 }); } catch { threw = true; }
  ok('负数被拒', threw);
  threw = false;
  try { retention.saveDays({ app_update_log: 99999 }); } catch { threw = true; }
  ok('超大值被拒', threw);

  const insUpd = db.prepare(`INSERT INTO app_update_log (product, channel, platform, arch, machine, from_version, to_version, action, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  insUpd.run('LabelGo', 'stable', 'win32', 'x64', 'M1', 'V1.0.1', 'V1.0.2', 'check', iso(30));
  insUpd.run('LabelGo', 'stable', 'win32', 'x64', 'M1', 'V1.0.2', 'V1.0.3', 'success', iso(1));
  r = retention.run(['app_update_log']);
  ok('按 7 天策略删掉 30 天前那条', r.deleted.app_update_log === 1, r.deleted);

  console.log('\n[5] 单表清空');
  db.prepare(`INSERT INTO machine_ledger (machine_code, license_id, last_seen_at) VALUES ('M9', 1, ?)`).run(iso(1));
  const cl = retention.clearTable('machine_ledger', { backup: false });
  ok('清空台账删除 1 行', cl.deleted === 1, cl);
  ok('清空后为 0', db.prepare('SELECT COUNT(*) AS c FROM machine_ledger').get().c === 0);

  console.log('\n[6] 升级记录按产品 / 按天清理');
  db.prepare('DELETE FROM app_update_log').run();
  insUpd.run('LabelGo', 'stable', 'win32', 'x64', 'M1', 'V1.0.1', 'V1.0.2', 'check', iso(5));
  insUpd.run('LabelGo', 'stable', 'win32', 'x64', 'M1', 'V1.0.2', 'V1.0.3', 'success', iso(0));
  insUpd.run('LabelGo-Offline', 'stable', 'win32', 'x64', 'M2', 'V1.0.1', 'V1.0.2', 'success', iso(0));
  let pu = release.purgeUpdates({ product: 'LabelGo', days: 2 });
  ok('只删 LabelGo 的 2 天前记录', pu.deleted === 1, pu);
  ok('离线产品记录不受影响', db.prepare("SELECT COUNT(*) AS c FROM app_update_log WHERE product='LabelGo-Offline'").get().c === 1);
  pu = release.purgeUpdates({ product: 'LabelGo' });
  ok('days=0 清空该产品全部记录', pu.deleted === 1, pu);
  ok('全局仍剩离线那条', db.prepare('SELECT COUNT(*) AS c FROM app_update_log').get().c === 1);

  console.log('\n[7] 后台接口');
  let res = await app.inject({ method: 'GET', url: `${B}/api/maintenance/retention`, headers: H });
  const body = res.json();
  ok('策略总览 200', res.statusCode === 200, res.body.slice(0, 200));
  ok('返回 policies 且带行数', Array.isArray(body.policies) && body.policies.every((p) => typeof p.rows === 'number'));
  ok('返回上次清理记录字段', body.last_run !== undefined);

  res = await app.inject({ method: 'POST', url: `${B}/api/maintenance/retention`, headers: H, payload: { days: { open_auth_log: 15 } } });
  ok('保存保留天数 200', res.statusCode === 200 && res.json().days.open_auth_log === 15, res.body.slice(0, 200));

  res = await app.inject({ method: 'POST', url: `${B}/api/maintenance/retention`, headers: H, payload: { days: { open_auth_log: -5 } } });
  ok('非法天数 400', res.statusCode === 400, res.body.slice(0, 200));

  res = await app.inject({ method: 'POST', url: `${B}/api/maintenance/retention/run`, headers: H, payload: { keys: ['open_auth_log'] } });
  ok('立即清理 200', res.statusCode === 200 && res.json().ok === true, res.body.slice(0, 200));

  res = await app.inject({ method: 'POST', url: `${B}/api/maintenance/retention/clear`, headers: H, payload: { key: 'open_auth_log', confirm: 'x' } });
  ok('清空缺确认词 400', res.statusCode === 400, res.body.slice(0, 200));

  res = await app.inject({ method: 'POST', url: `${B}/api/maintenance/retention/clear`, headers: H, payload: { key: 'nope', confirm: '清除' } });
  ok('未知表 400', res.statusCode === 400, res.body.slice(0, 200));

  console.log('\n[8] 产品维度：登记产品线 + 列表元信息');
  res = await app.inject({ method: 'POST', url: `${B}/api/releases/config`, headers: H, payload: { add_product: 'LabelGo-Offline' } });
  ok('登记新产品线 200', res.statusCode === 200, res.body.slice(0, 200));
  res = await app.inject({ method: 'GET', url: `${B}/api/releases`, headers: H });
  const rel = res.json();
  ok('产品清单含未发布的 LabelGo-Offline', (rel.products || []).includes('LabelGo-Offline'), rel.products);
  const offMeta = (rel.product_meta || []).find((p) => p.product === 'LabelGo-Offline') || {};
  ok('未发布产品 published=false', offMeta.published === false, offMeta);
  ok('每个产品都带 versions/latest/bytes', (rel.product_meta || []).every((p) => 'versions' in p && 'latest' in p && 'bytes' in p));

  console.log('\n[9] 升级记录清理接口');
  insUpd.run('LabelGo', 'stable', 'win32', 'x64', 'M3', 'V1.0.3', 'V1.0.4', 'check', iso(10));
  res = await app.inject({ method: 'POST', url: `${B}/api/releases/updates/purge`, headers: H, payload: { product: 'LabelGo', days: 3, confirm: 'no' } });
  ok('缺确认词 400', res.statusCode === 400, res.body.slice(0, 200));
  res = await app.inject({ method: 'POST', url: `${B}/api/releases/updates/purge`, headers: H, payload: { product: 'LabelGo', days: 3, confirm: '清除' } });
  ok('按产品清理 200', res.statusCode === 200 && res.json().deleted === 1, res.body.slice(0, 200));

  console.log('\n[10] 失效会话清理接口');
  // 干净库里没有开放应用，自己建一个（会话表要 app_id）
  db.prepare(`INSERT INTO open_apps (app_key, app_secret, name, status, created_at) VALUES (?,?,?,?,?)`)
    .run('ak-test', 'sk-test', '测试应用', 'active', iso(0));
  const appId = db.prepare('SELECT id FROM open_apps LIMIT 1').get();
  ok('存在一个开放应用', !!appId);
  if (appId) {
    insSess.run('t-revoked-2', appId.id, 1, 1, 'M-REV2', 'revoked', future(), iso(3), iso(3));
    res = await app.inject({ method: 'POST', url: `${B}/api/open-apps/${appId.id}/sessions/cleanup`, headers: H, payload: {} });
    ok('清理失效会话 200', res.statusCode === 200, res.body.slice(0, 200));
    ok('返回删除条数', typeof res.json().deleted === 'number');
  }

  console.log('\n[11] 清理分组的完整性');
  const pv = purge.preview();
  const flows = (pv.groups || []).find((g) => g.key === 'flows') || {};
  ok('存在「升级与鉴权流水」分组', !!flows.key);
  ok('分组含升级记录与鉴权流水', (flows.tables || []).some((t) => t.table === 'app_update_log')
    && (flows.tables || []).some((t) => t.table === 'open_auth_log'), flows.tables);
  ok('不留 ticket_seq（清掉会让客户端判为重放）', !JSON.stringify(purge.ORDER).includes('license_ticket_seq'));

  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  await app.close();
  fs.rmSync(UPDATES, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});

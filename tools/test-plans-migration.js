/* 旧库升级自测：生产库是上一版(0f0a55d)结构，启动时 db/index.js 必须能自动补齐列、
 * 重建 plans 表、建好索引，且不能中断启动（否则 Node 起不来 → Nginx 502）。
 *
 * 之前用「当前 schema 改回 code UNIQUE」造假旧库，漏掉了 licenses 表缺 app_id 这一环：
 * schema.sql 里的 CREATE INDEX ... ON licenses(app_id) 在 ensureColumn 之前执行，
 * 旧库会抛 "no such column: app_id"。这里改用真实上一版 schema 造库，并做反向验证。
 *
 * 运行：node tools/test-plans-migration.js
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-plans-migration.db');
const PROBE_FILE = path.join(__dirname, '..', 'data', 'test-plans-migration-probe.db');
const SCHEMA = path.join(__dirname, '..', 'server', 'db', 'schema.sql');
const TS = new Date().toISOString();
const VERIFY = process.argv.includes('--verify');
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
function clean(f) {
  for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(f + s, { force: true }); } catch { /* ignore */ } }
}
function legacySchema() {
  return execFileSync('git', ['show', '0f0a55d:server/db/schema.sql'],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

if (!VERIFY) {
  clean(DB_FILE);
  clean(PROBE_FILE);
  const old = legacySchema();

  // 反向验证：修复前「建表阶段就执行含索引的完整 schema」在真实旧库上必然失败。
  // 这样以后若有人把索引延后逻辑改回去，本测试会立刻变红。
  const probe = new Database(PROBE_FILE);
  probe.exec(old);
  let caught = '';
  try { probe.exec(fs.readFileSync(SCHEMA, 'utf8')); } catch (e) { caught = e.message; }
  probe.close();
  check('修复前：旧库直接跑完整 schema 会因缺列失败', /no such column: app_id/.test(caught), caught);
  clean(PROBE_FILE);

  const raw = new Database(DB_FILE);
  raw.exec(old);
  const stmt = raw.prepare(`INSERT INTO plans
    (app_id, code, name, tier, billing, price, period_days, online_required, offline_days,
     max_devices, seats, features, status, sort, remark, created_at, updated_at)
    VALUES (NULL,?,?,?,?,?,?,?,?,?,?,'[]','on',0,'',?,?)`);
  ['free', 'member', 'pro', 'enterprise', 'enterprise_dist'].forEach((code, i) => {
    stmt.run(code, '旧档位 ' + code, i * 10, i === 0 ? 'free' : 'period', i * 99,
      i === 0 ? 0 : 365, 1, 0, 1, 1, TS, TS);
  });
  raw.prepare("INSERT INTO users (openid, nickname, status, created_at) VALUES ('legacy-user','老用户','active',?)").run(TS);
  // 塞一条管理员，避免 seed() 往 data/admin-init-password.txt 写随机密码污染本地开发文件
  raw.prepare("INSERT INTO admins (username, password_hash, name, role, status, created_at) VALUES ('admin','x','x','super','active',?)").run(TS);
  raw.close();
}

process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.OFFLINE_KEY_PATH = path.join(__dirname, '..', 'data', 'test-plans-migration-key.json');

// 能走到这一行本身就说明「旧库完整加载」没抛异常
const db = require('../server/db');

console.log(VERIFY ? '\n[二次启动：幂等验证]' : '\n[首次启动：旧库自动迁移 + 列补齐 + 索引]');
const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='plans'").get().sql;
check('旧表列级 code UNIQUE 已移除', !/code\s+TEXT\s+UNIQUE/i.test(tableSql), tableSql);
const rows = db.prepare('SELECT code, app_id FROM plans ORDER BY id').all().filter((r) => r.code !== 'unique_probe');
check('原有档位数据完整保留', rows.length >= 5 && rows.some((r) => r.code === 'free')
  && rows.every((r) => r.app_id === null), rows);
check('其它表数据未受影响',
  db.prepare("SELECT nickname FROM users WHERE openid='legacy-user'").get()?.nickname === '老用户');

const cols = db.prepare('PRAGMA table_info(licenses)').all().map((c) => c.name);
check('新列（licenses.app_id）自动补齐', cols.includes('app_id'), cols);
const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
check('引用新列的索引在补列后成功建立', idx.includes('idx_licenses_app'), idx.filter((n) => n && n.startsWith('idx_')));
check('复合唯一索引已建立', idx.includes('idx_plans_app_code'));

const ins = (appId, code) => db.prepare(`INSERT INTO plans
  (app_id, code, name, created_at, updated_at) VALUES (?,?,?,?,?)`).run(appId, code, '唯一性探针', TS, TS);
if (!VERIFY) {
  ins(1, 'unique_probe');
  ins(2, 'unique_probe');
  let rejected = false;
  try { ins(1, 'unique_probe'); } catch (e) { rejected = true; }
  check('迁移后同 code 可跨产品重复', db.prepare("SELECT COUNT(*) AS c FROM plans WHERE code='unique_probe'").get().c === 2);
  check('迁移后同产品内 code 仍唯一', rejected);
  const r = spawnSync(process.execPath, [__filename, '--verify'], { encoding: 'utf8' });
  check('二次启动幂等（不重建、不丢数据）', r.status === 0 && !/\u2717/.test(r.stdout || ''),
    (r.stdout || r.stderr || '').slice(-500));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) process.exitCode = 1;

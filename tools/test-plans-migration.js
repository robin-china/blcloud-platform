/* 旧库 plans 表（code 全局 UNIQUE）→ 新版（按 app_id 复合唯一）的自动迁移自测
 * 运行：node tools/test-plans-migration.js
 * 生产库是上一轮部署的旧结构，启动时 db/index.js 会重建 plans 表，这条路径必须验证。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-plans-migration.db');
const SCHEMA = path.join(__dirname, '..', 'server', 'db', 'schema.sql');
const TS = new Date().toISOString();
const VERIFY = process.argv.includes('--verify');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

if (!VERIFY) {
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
  // 用当前 schema 造一个「上一版」的库：plans.code 改回列级 UNIQUE，且没有复合唯一索引
  const legacy = fs.readFileSync(SCHEMA, 'utf8')
    .replace('  code TEXT NOT NULL,\n  name TEXT NOT NULL,', '  code TEXT UNIQUE NOT NULL,\n  name TEXT NOT NULL,')
    .replace(/CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_app_code[^;]*;\s*/g, '');
  const raw = new Database(DB_FILE);
  raw.exec(legacy);
  const stmt = raw.prepare(`INSERT INTO plans
    (app_id, code, name, tier, billing, price, period_days, online_required, offline_days,
     max_devices, seats, features, status, sort, remark, created_at, updated_at)
    VALUES (NULL,?,?,?,?,?,?,?,?,?,?,'[]','on',0,'',?,?)`);
  ['free', 'member', 'pro', 'enterprise', 'enterprise_dist'].forEach((code, i) => {
    stmt.run(code, '旧档位 ' + code, i * 10, i === 0 ? 'free' : 'period', i * 99,
      i === 0 ? 0 : 365, 1, 0, 1, 1, TS, TS);
  });
  raw.prepare("INSERT INTO users (openid, nickname, status, created_at) VALUES ('legacy-user','老用户','active',?)").run(TS);
  raw.close();
}

process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.OFFLINE_KEY_PATH = path.join(__dirname, '..', 'data', 'test-plans-migration-key.json');
const db = require('../server/db');

console.log(VERIFY ? '\n[二次启动：幂等验证]' : '\n[首次启动：旧库自动迁移]');
const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='plans'").get().sql;
check('旧表列级 code UNIQUE 已移除', !/code\s+TEXT\s+UNIQUE/i.test(tableSql), tableSql);
const rows = db.prepare('SELECT code, app_id FROM plans ORDER BY id').all().filter((r) => r.code !== 'unique_probe');
check('原有档位数据完整保留', rows.length >= 5 && rows.some((r) => r.code === 'free')
  && rows.every((r) => r.app_id === null), rows);
check('其它表数据未受影响',
  db.prepare("SELECT nickname FROM users WHERE openid='legacy-user'").get()?.nickname === '老用户');
const cols = db.prepare('PRAGMA table_info(licenses)').all().map((c) => c.name);
check('新列（licenses.app_id）自动补齐', cols.includes('app_id'), cols);

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

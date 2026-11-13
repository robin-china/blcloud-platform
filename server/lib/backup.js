/* 账套备份 / 恢复 / 演示数据清理
 *
 * 目标场景：
 *  1. 日常留档 —— 一键把数据库 + 加密主密钥（+ 可选的上传文件）打成一个 zip 下载走；
 *  2. 被攻击 / 误操作后 —— 上传 zip 原地恢复，不重启进程，事务内完成，失败自动回滚；
 *  3. 换服务器重装 —— 用 tools/restore-backup.js 做文件级还原（含 .appsecret 与 uploads）。
 *
 * 两个关键点，踩过就不能省：
 *  - 快照必须用 VACUUM INTO 生成，不能直接 copy app.db。WAL 模式下主库文件里可能缺最近的事务，
 *    直接拷贝会丢数据。
 *  - data/.appsecret 是配置密文的 AES 主密钥，丢了等于所有加密配置作废（微信商户私钥、API v3 密钥…）。
 *    所以它必须进备份包，恢复时也要能识别「密钥不一致」而不是静默解不开。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { createZip, readZip } = require('./zip');
const { now } = require('./util');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
// 测试用临时库时不能往真实备份目录里写/删：允许环境变量改道
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const RESTORE_DIR = process.env.RESTORE_DIR || path.join(DATA_DIR, 'restore');
const SECRET_FILE = path.join(DATA_DIR, '.appsecret');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
// 模板市场的 .blls 是私有文件（不挂静态、只在兑换后经短链下发），
// 备份时必须与 uploads 一起带走 —— 只备份 app.db 会让所有已购模板「有记录没文件」。
const MARKET_DIR = process.env.MARKET_DIR
  ? path.resolve(process.env.MARKET_DIR)
  : path.join(DATA_DIR, 'market');

const FORMAT = 1;
const NAME_RE = /^[A-Za-z0-9._-]+\.zip$/;

/** 懒加载：db/index.js 启动时会 require 本模块，顶部直接 require('../db') 会形成循环依赖 */
function conn() {
  return require('../db');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function dbFile() {
  return process.env.DB_PATH || path.join(DATA_DIR, 'app.db');
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function appSecretBuf() {
  try {
    return fs.existsSync(SECRET_FILE) ? fs.readFileSync(SECRET_FILE) : null;
  } catch {
    return null;
  }
}

function tableCounts(d) {
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((r) => r.name);
  const counts = {};
  let rows = 0;
  for (const t of tables) {
    try {
      const c = d.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
      counts[t] = c;
      rows += c;
    } catch {
      counts[t] = -1;
    }
  }
  return { tables, counts, rows };
}

function uploadFiles(dir = UPLOAD_DIR) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (folder) => {
    for (const ent of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      const rel = path.relative(dir, full).replace(/\\/g, '/');
      const st = fs.statSync(full);
      out.push({ name: rel, size: st.size, mtime: st.mtimeMs, file: full });
    }
  };
  walk(dir);
  return out;
}

function pkgName(prefix = 'blcloud') {
  return `${prefix}-${stamp()}.zip`;
}

/**
 * 生成备份包
 * @param {{ uploads?: boolean, note?: string, prefix?: string }} opts
 * @returns {{ name, filePath, size, manifest }}
 */
function createPackage(opts = {}) {
  ensureDir(BACKUP_DIR);
  ensureDir(RESTORE_DIR);
  const d = conn();
  const tmp = path.join(RESTORE_DIR, `.snapshot-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.db`);
  try {
    d.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const dbBuf = fs.readFileSync(tmp);
    const secret = appSecretBuf();
    const { tables, counts, rows } = tableCounts(d);

    const entries = [{ name: 'app.db', data: dbBuf }];
    if (secret) entries.push({ name: '.appsecret', data: secret });

    let uploadsStat = { files: 0, bytes: 0, skipped: false };
    let marketStat = { files: 0, bytes: 0, skipped: false };
    if (opts.uploads) {
      const files = uploadFiles();
      const total = files.reduce((s, f) => s + f.size, 0);
      // 上限 200MB：再大就该走文件系统快照，塞进一个上传包只会把恢复流程拖死
      if (total > 200 * 1024 * 1024 || files.length > 5000) {
        uploadsStat.skipped = true;
      } else {
        for (const f of files) entries.push({ name: `uploads/${f.name}`, data: fs.readFileSync(f.file) });
        uploadsStat = { files: files.length, bytes: total, skipped: false };
      }
      // 私有模板文件紧跟上传文件一起打包（前缀 market/，绝不与 uploads/ 混）
      const mfiles = uploadFiles(MARKET_DIR).filter((f) => f.name.endsWith('.blls'));
      const mtotal = mfiles.reduce((s, f) => s + f.size, 0);
      if (total + mtotal > 200 * 1024 * 1024 || files.length + mfiles.length > 5000) {
        marketStat.skipped = true;
      } else {
        for (const f of mfiles) entries.push({ name: `market/${f.name}`, data: fs.readFileSync(f.file) });
        marketStat = { files: mfiles.length, bytes: mtotal, skipped: false };
      }
    }

    const manifest = {
      kind: 'blcloud-backup',
      format: FORMAT,
      created_at: now(),
      note: String(opts.note || ''),
      node: process.version,
      app_version: (() => { try { return require(path.join(ROOT, 'package.json')).version || ''; } catch { return ''; } })(),
      db: { file: 'app.db', bytes: dbBuf.length, sha256: sha256(dbBuf), rows, tables: counts },
      has_appsecret: !!secret,
      appsecret_sha256: secret ? sha256(secret) : '',
      uploads: uploadsStat,
      market: marketStat,
    };
    entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });

    const buf = createZip(entries);
    const name = pkgName(opts.prefix || 'blcloud');
    const filePath = path.join(BACKUP_DIR, name);
    fs.writeFileSync(filePath, buf, { mode: 0o600 });
    prune();
    return { name, filePath, size: buf.length, manifest };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** 每日自动留档：同一天已有一份就跳过 */
function autoSnapshot() {
  try {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const done = list().some((b) => b.name.includes(day) || b.manifest?.created_at?.slice(0, 10) === new Date().toISOString().slice(0, 10));
    if (done) return null;
    return createPackage({ note: '每日自动备份', prefix: 'auto' });
  } catch {
    return null;
  }
}

/** 保留最近 keep 份（默认 30），更早的自动删掉，避免磁盘被备份撑满 */
function prune(keep = 30) {
  try {
    const list0 = list();
    for (const b of list0.slice(keep)) fs.rmSync(b.filePath, { force: true });
  } catch { /* 清理失败不影响主流程 */ }
}

function readManifest(filePath) {
  try {
    const zip = readZip(fs.readFileSync(filePath));
    const raw = zip.get('manifest.json');
    return raw ? JSON.parse(raw.toString('utf8')) : null;
  } catch {
    return null;
  }
}

function list() {
  ensureDir(BACKUP_DIR);
  const out = [];
  for (const name of fs.readdirSync(BACKUP_DIR)) {
    if (!NAME_RE.test(name)) continue;
    const full = path.join(BACKUP_DIR, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({ name, filePath: full, size: st.size, mtime: st.mtimeMs, manifest: readManifest(full) });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function backupFile(name) {
  if (!NAME_RE.test(String(name || ''))) return null;
  const full = path.join(BACKUP_DIR, String(name));
  if (!fs.existsSync(full)) return null;
  return full;
}

function remove(name) {
  const full = backupFile(name);
  if (!full) return false;
  fs.rmSync(full, { force: true });
  return true;
}

/* ---------------- 恢复 ---------------- */

const REQUIRED_TABLES = ['admins', 'settings', 'users', 'orders', 'licenses'];

function validateDbFile(file) {
  const st = fs.statSync(file);
  if (st.size < 1024) throw new Error('备份内的数据库文件过小，可能已损坏');
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (head.toString('utf8', 0, 15) !== 'SQLite format 3') throw new Error('备份内的 app.db 不是有效的 SQLite 数据库');

  const probe = new Database(file, { readonly: true });
  try {
    const check = probe.prepare('PRAGMA integrity_check').get();
    const verdict = check ? Object.values(check)[0] : '';
    if (String(verdict).toLowerCase() !== 'ok') throw new Error(`数据库完整性校验未通过：${verdict}`);
    const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all().map((r) => r.name);
    const missing = REQUIRED_TABLES.filter((t) => !tables.includes(t));
    if (missing.length) throw new Error(`不是本系统的数据库（缺少表：${missing.join(', ')}）`);
    return { tables };
  } finally {
    probe.close();
  }
}

/**
 * 第一步：接收上传包并暂存（不改动线上数据），返回摘要给前端确认
 * @returns {{ token, manifest, tables, appsecret_mismatch }}
 */
function stage(buffer, sourceName = '') {
  ensureDir(RESTORE_DIR);
  let zip;
  try {
    zip = readZip(buffer);
  } catch (e) {
    throw new Error(`压缩包无法解析：${e.message}`);
  }
  const dbBuf = zip.get('app.db');
  if (!dbBuf) throw new Error('压缩包里没有 app.db，不是本站的账套备份');
  let manifest = null;
  const mf = zip.get('manifest.json');
  if (mf) {
    try { manifest = JSON.parse(mf.toString('utf8')); } catch { manifest = null; }
  }

  const token = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const target = path.join(RESTORE_DIR, `upload-${token}.db`);
  fs.writeFileSync(target, dbBuf, { mode: 0o600 });
  try {
    const { tables } = validateDbFile(target);
    if (manifest && manifest.db && manifest.db.sha256 && sha256(dbBuf) !== manifest.db.sha256) {
      throw new Error('数据库校验和不符，压缩包可能被篡改或损坏');
    }
    const local = appSecretBuf();
    const appsecretMismatch = !!(manifest && manifest.appsecret_sha256 && local
      && sha256(local) !== manifest.appsecret_sha256);
    return {
      token,
      source_name: String(sourceName || ''),
      size: buffer.length,
      manifest,
      tables,
      has_appsecret: zip.has('.appsecret'),
      has_uploads: [...zip.keys()].some((k) => k.startsWith('uploads/')),
      appsecret_mismatch: appsecretMismatch,
      staged_at: now(),
    };
  } catch (e) {
    fs.rmSync(target, { force: true });
    throw e;
  }
}

function stagedPath(token) {
  if (!/^[0-9]+-[a-f0-9]+$/.test(String(token || ''))) return '';
  const p = path.join(RESTORE_DIR, `upload-${token}.db`);
  return fs.existsSync(p) ? p : '';
}

function dropStaged(token) {
  const p = stagedPath(token);
  if (p) fs.rmSync(p, { force: true });
  return !!p;
}

/** 清掉 1 小时前的暂存文件：上次上传后没确认的包不该一直躺在磁盘上 */
function cleanStaged(maxAgeMs = 3600 * 1000) {
  if (!fs.existsSync(RESTORE_DIR)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(RESTORE_DIR)) {
    if (!/^upload-\d+-[a-f0-9]+\.db$/.test(name)) continue;
    const full = path.join(RESTORE_DIR, name);
    try {
      const st = fs.statSync(full);
      if (Date.now() - st.mtimeMs > maxAgeMs) { fs.rmSync(full, { force: true }); n += 1; }
    } catch { /* ignore */ }
  }
  return n;
}

function columnsOf(d, schema, table) {
  const prefix = schema ? `${schema}.` : '';
  try {
    const stmt = d.prepare(`SELECT * FROM ${prefix}"${table}" LIMIT 0`);
    return stmt.columns().map((c) => c.name);
  } catch {
    return [];
  }
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * 第二步：原地恢复（不重启进程）
 * 用 ATTACH + 单事务把备份库逐表覆盖到当前库：
 *  - 备份比当前版本旧时，缺的列自动忽略（新列走默认值），不会因列数不符报错
 *  - 任一步失败整体回滚，线上仍是恢复前的数据
 * 恢复前会自动生成一份 pre-restore 备份。
 */
function applyRestore(token) {
  const srcPath = stagedPath(token);
  if (!srcPath) throw new Error('暂存包不存在或已过期，请重新上传');
  const d = conn();
  const { tables: srcTables } = validateDbFile(srcPath);

  // 恢复前先留一份，误点也有退路
  const pre = createPackage({ note: '恢复前自动备份', prefix: 'pre-restore' });

  const mainTables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all().map((r) => r.name);
  const summary = {};
  let total = 0;

  d.exec('PRAGMA foreign_keys = OFF');
  d.exec(`ATTACH DATABASE '${srcPath.replace(/'/g, "''")}' AS src`);
  try {
    d.exec('BEGIN IMMEDIATE');
    try {
      for (const t of mainTables) {
        if (!srcTables.includes(t)) continue;
        const mainCols = columnsOf(d, 'main', t);
        const srcCols = columnsOf(d, 'src', t);
        const cols = mainCols.filter((c) => srcCols.includes(c));
        if (!cols.length) continue;
        const list = cols.map(quoteIdent).join(', ');
        d.prepare(`DELETE FROM main.${quoteIdent(t)}`).run();
        const info = d.prepare(
          `INSERT INTO main.${quoteIdent(t)} (${list}) SELECT ${list} FROM src.${quoteIdent(t)}`
        ).run();
        summary[t] = info.changes;
        total += info.changes;
      }
      d.exec('COMMIT');
    } catch (e) {
      try { d.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      throw e;
    }
  } finally {
    try { d.exec('DETACH DATABASE src'); } catch { /* ignore */ }
    d.exec('PRAGMA foreign_keys = ON');
  }

  dropStaged(token);
  return { tables: summary, rows: total, pre_backup: pre.name };
}

/** 恢复后的配置说明：主密钥不一致时加密配置解不开，必须让管理员知道 */
function secretNote(manifest) {
  const local = appSecretBuf();
  if (!manifest || !manifest.appsecret_sha256 || !local) return '';
  if (sha256(local) === manifest.appsecret_sha256) return '';
  return '备份包内的加密主密钥与本机不一致：微信商户私钥等加密配置将无法解密。'
    + '本机密钥保持不变；若确实要整机还原，请停服后执行 node tools/restore-backup.js <备份包> 并覆盖 .appsecret。';
}

function summary() {
  const d = conn();
  const { counts, rows } = tableCounts(d);
  let size = 0;
  try { size = fs.statSync(dbFile()).size; } catch { /* ignore */ }
  const backups = list();
  const uploads = uploadFiles();
  return {
    db_file: dbFile(),
    db_bytes: size,
    rows,
    tables: counts,
    backup_count: backups.length,
    last_backup: backups[0] ? { name: backups[0].name, mtime: backups[0].mtime, size: backups[0].size } : null,
    backup_dir: BACKUP_DIR,
    uploads: { files: uploads.length, bytes: uploads.reduce((s, f) => s + f.size, 0) },
    market: { files: uploadFiles(MARKET_DIR).filter((f) => f.name.endsWith('.blls')).length },
    has_appsecret: !!appSecretBuf(),
  };
}

module.exports = {
  DATA_DIR, BACKUP_DIR, RESTORE_DIR, SECRET_FILE, UPLOAD_DIR, MARKET_DIR,
  dbFile, createPackage, autoSnapshot, prune, list, backupFile, remove,
  stage, applyRestore, dropStaged, cleanStaged, stagedPath, validateDbFile,
  summary, secretNote, tableCounts, uploadFiles, sha256,
};

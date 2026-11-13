#!/usr/bin/env node
/* 整机还原：把账套备份包还原到本机（换服务器 / 被攻击后重建时用）
 *
 * 与后台「上传恢复」的区别：
 *  - 后台恢复是原地覆盖数据库行，运行中的进程不用停，但不动 .appsecret、不动上传文件；
 *  - 本脚本是文件级还原：app.db + .appsecret + uploads + market 一起落盘，等于回到备份那一刻的机器状态。
 *    market/ 是模板市场的私有 .blls 文件（不挂静态目录），漏掉它会出现「已购有记录但下不了文件」。
 *    所以**必须先停服务**（PM2: pm2 stop blcloud-admin），否则正在运行的进程会拿着被替换的库继续跑。
 *
 * 用法：
 *   node tools/restore-backup.js data/backups/blcloud-20261104-1200.zip --yes
 *   node tools/restore-backup.js <包> --db data/app.db --no-secret --yes
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { readZip } = require('../server/lib/zip');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

function usage(msg) {
  if (msg) console.error(`\n  ✗ ${msg}\n`);
  console.log(`
  用法: node tools/restore-backup.js <备份包.zip> [选项]

  选项:
    --db <path>     目标数据库（默认 data/app.db）
    --no-secret     不覆盖 data/.appsecret
    --no-uploads    不还原 data/uploads
    --no-market     不还原 data/market（模板市场私有 .blls）
    --yes           跳过确认（非交互环境必须加）

  注意: 执行前请先停服务（pm2 stop blcloud-admin），否则运行中的进程仍持有旧库句柄。
`);
  process.exit(msg ? 1 : 0);
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const args = process.argv.slice(2);
const zipArg = args.find((a) => !a.startsWith('--'));
if (!zipArg) usage('缺少备份包路径');
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null;
};
const dbTarget = path.resolve(String(opt('--db') && opt('--db') !== true ? opt('--db') : path.join(DATA_DIR, 'app.db')));
const withSecret = !args.includes('--no-secret');
const withUploads = !args.includes('--no-uploads');
const withMarket = !args.includes('--no-market');
const MARKET_DIR = process.env.MARKET_DIR ? path.resolve(process.env.MARKET_DIR) : path.join(DATA_DIR, 'market');
const yes = args.includes('--yes');

(async () => {
  const zipPath = path.resolve(zipArg);
  if (!fs.existsSync(zipPath)) usage(`备份包不存在: ${zipPath}`);

  console.log(`\n  备份包: ${zipPath}`);
  console.log(`  目标库: ${dbTarget}`);

  const zip = readZip(fs.readFileSync(zipPath));
  const dbBuf = zip.get('app.db');
  if (!dbBuf) usage('压缩包里没有 app.db，不是本站的账套备份');

  let manifest = null;
  if (zip.get('manifest.json')) {
    try { manifest = JSON.parse(zip.get('manifest.json').toString('utf8')); } catch { /* 忽略 */ }
  }
  if (manifest) {
    console.log(`  备份时间: ${manifest.created_at}${manifest.note ? `（${manifest.note}）` : ''}`);
    console.log(`  数据规模: ${manifest.db ? manifest.db.rows : '?'} 行`);
  }
  const uploadEntries = [...zip.keys()].filter((k) => k.startsWith('uploads/'));
  const marketEntries = [...zip.keys()].filter((k) => k.startsWith('market/') && k.endsWith('.blls'));
  console.log(`  包含: app.db${zip.has('.appsecret') ? ' + .appsecret' : ''}${uploadEntries.length ? ` + ${uploadEntries.length} 个上传文件` : ''}${marketEntries.length ? ` + ${marketEntries.length} 个模板文件` : ''}`);
  console.log('');

  // 先校验，别把坏包写进生产目录
  const tmp = path.join(DATA_DIR, `.restore-check-${Date.now()}.db`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(tmp, dbBuf);
  try {
    const probe = new Database(tmp, { readonly: true });
    try {
      const verdict = Object.values(probe.prepare('PRAGMA integrity_check').get())[0];
      if (String(verdict).toLowerCase() !== 'ok') throw new Error(`完整性校验未通过: ${verdict}`);
      const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      const missing = ['admins', 'settings', 'users'].filter((t) => !tables.includes(t));
      if (missing.length) throw new Error(`不是本系统的数据库（缺少 ${missing.join(', ')}）`);
    } finally { probe.close(); }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    console.error(`\n  ✗ 备份包不可用: ${e.message}\n`);
    process.exit(1);
  }

  if (!yes) {
    console.log('  即将覆盖现有数据。确认请重新加 --yes 执行。\n');
    fs.rmSync(tmp, { force: true });
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(dbTarget), { recursive: true });
  const bakDir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(bakDir, { recursive: true });
  const ts = stamp();

  // 备份现有库：能用 SQLite 打开就 VACUUM INTO（WAL 安全），打不开就直接复制文件
  if (fs.existsSync(dbTarget)) {
    const bak = path.join(bakDir, `pre-cli-restore-${ts}.db`);
    let done = false;
    try {
      const cur = new Database(dbTarget, { readonly: true });
      try { cur.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`); done = true; } finally { cur.close(); }
    } catch { /* 落到文件复制 */ }
    if (!done) fs.copyFileSync(dbTarget, bak);
    console.log(`  ✓ 已备份现有库: ${path.relative(ROOT, bak)}`);
  }

  // 替换数据库：先清 WAL/SHM，否则新库会被旧 WAL 覆盖回去
  for (const s of ['-wal', '-shm']) fs.rmSync(dbTarget + s, { force: true });
  fs.copyFileSync(tmp, dbTarget);
  fs.rmSync(tmp, { force: true });
  console.log(`  ✓ 数据库已还原`);

  const secret = zip.get('.appsecret');
  if (withSecret && secret) {
    const secFile = path.join(DATA_DIR, '.appsecret');
    if (fs.existsSync(secFile)) {
      const bak = `${secFile}.bak-${ts}`;
      fs.copyFileSync(secFile, bak);
      console.log(`  ✓ 旧主密钥已另存: ${path.relative(ROOT, bak)}`);
    }
    fs.writeFileSync(secFile, secret, { mode: 0o600 });
    console.log('  ✓ 加密主密钥已还原（微信商户私钥等配置可正常解密）');
  } else if (withSecret && !secret) {
    console.log('  ! 备份包里没有 .appsecret，保留本机密钥；若来源是另一台机器，加密配置将无法解密');
  }

  if (withUploads && uploadEntries.length) {
    const dir = path.join(DATA_DIR, 'uploads');
    let n = 0;
    for (const name of uploadEntries) {
      const rel = name.slice('uploads/'.length);
      if (!rel || rel.includes('..')) continue;
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, zip.get(name));
      n += 1;
    }
    console.log(`  ✓ 上传文件已还原: ${n} 个`);
  }

  if (withMarket && marketEntries.length) {
    let n = 0;
    for (const name of marketEntries) {
      const rel = name.slice('market/'.length);
      // 只接受纯文件名：私有目录里不该出现子路径，也不能被备份包写出去
      if (!rel || rel.includes('/') || rel.includes('\\') || rel.includes('..')) continue;
      fs.mkdirSync(MARKET_DIR, { recursive: true });
      fs.writeFileSync(path.join(MARKET_DIR, rel), zip.get(name), { mode: 0o600 });
      n += 1;
    }
    console.log(`  ✓ 模板市场私有文件已还原: ${n} 个`);
  }

  console.log('\n  完成。启动服务：pm2 start blcloud-admin && pm2 logs blcloud-admin\n');
})();

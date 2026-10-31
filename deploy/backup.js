/* 数据库热备份（WAL 安全）+ 密钥/上传文件打包
 * 用法：node deploy/backup.js [输出目录]
 * 建议：crontab 每天 03:10 执行
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = process.argv[2] || path.join(ROOT, 'data', 'backups');
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 14);

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

fs.mkdirSync(OUT, { recursive: true });
const stamp = ts();
const tmp = path.join(OUT, `.db-${stamp}.tmp`);

// 1) 用 SQLite 官方 backup API，WAL 模式下也能拿到一致快照
const src = new Database(path.join(DATA, 'app.db'), { readonly: true });
src.backup(tmp)
  .then(() => {
    src.close();

    // 2) 同目录下打包密钥 + 上传文件
    const stage = path.join(OUT, `.stage-${stamp}`);
    fs.mkdirSync(stage, { recursive: true });
    fs.copyFileSync(tmp, path.join(stage, 'app.db'));
    for (const f of ['.appsecret', 'admin-init-password.txt']) {
      const p = path.join(DATA, f);
      if (fs.existsSync(p)) fs.copyFileSync(p, path.join(stage, f));
    }
    if (fs.existsSync(path.join(DATA, 'uploads'))) {
      fs.cpSync(path.join(DATA, 'uploads'), path.join(stage, 'uploads'), { recursive: true });
    }

    const tar = path.join(OUT, `blcloud-${stamp}.tar.gz`);
    const dir = path.join(OUT, `blcloud-${stamp}`);
    let finalPath = dir;
    // 优先打 tar.gz；不可用（如部分 Windows 环境）时降级为目录快照
    try {
      execSync(`tar -czf "${tar}" -C "${stage}" .`, { stdio: 'pipe' });
      if (fs.existsSync(tar) && fs.statSync(tar).size > 0) {
        fs.rmSync(stage, { recursive: true, force: true });
        finalPath = tar;
      }
    } catch { /* 走降级 */ }
    if (finalPath === dir) {
      fs.rmSync(tar, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(stage, dir);
    }
    fs.rmSync(tmp, { force: true });

    // 3) 清理过期备份
    const cutoff = Date.now() - KEEP_DAYS * 86400_000;
    for (const f of fs.readdirSync(OUT)) {
      if (!f.startsWith('blcloud-')) continue;
      if (fs.statSync(path.join(OUT, f)).mtimeMs < cutoff) fs.rmSync(path.join(OUT, f), { recursive: true, force: true });
    }
    const size = fs.statSync(finalPath).size / 1024;
    console.log(`[backup] ok -> ${finalPath}  (${size.toFixed(0)} KB)`);
  })
  .catch((e) => {
    console.error('[backup] 失败:', e.message);
    fs.rmSync(tmp, { force: true });
    process.exit(1);
  });

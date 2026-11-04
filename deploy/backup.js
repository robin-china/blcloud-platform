#!/usr/bin/env node
/* 命令行热备份（crontab 用）
 *
 * 与后台「系统维护 → 备份与恢复 → 立即备份」走同一套实现（server/lib/backup.js），
 * 产出同样的 .zip 账套包：app.db（VACUUM 快照）+ .appsecret + manifest.json（+ 可选 uploads）。
 * 好处：cron 生成的包能直接在后台列表里看到、一键恢复，不用维护两套格式和目录。
 *
 * 用法：
 *   node deploy/backup.js                      # 写入 data/backups，含上传文件
 *   BACKUP_UPLOADS=0 node deploy/backup.js     # 不含上传文件（包更小）
 *   BACKUP_KEEP=14 node deploy/backup.js       # 只保留最近 14 份（默认 30）
 */
const path = require('path');

const backup = require('../server/lib/backup');

const keep = Number(process.env.BACKUP_KEEP || 30);
const uploads = process.env.BACKUP_UPLOADS !== '0';

try {
  const pkg = backup.createPackage({ uploads, note: 'cron 自动备份' });
  backup.prune(keep);
  console.log(`[${new Date().toISOString()}] ${pkg.name}  ${Math.round(pkg.size / 1024)} KB  ${pkg.manifest.db.rows} 行`
    + (uploads ? `  uploads:${pkg.manifest.uploads.files}` : ''));
  if (pkg.manifest.uploads.skipped) console.log('  提示：上传文件超过 200MB，已跳过（数据库已完整备份）');
  console.log(`  目录：${backup.BACKUP_DIR}  保留最近 ${keep} 份`);
} catch (e) {
  console.error(`[${new Date().toISOString()}] 备份失败: ${e.message}`);
  process.exit(1);
}

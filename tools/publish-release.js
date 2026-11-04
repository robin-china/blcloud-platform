#!/usr/bin/env node
/* 命令行发布客户端更新包（服务器上直接 scp 大文件后跑这个，或本地构建完直接发）
 *
 * 用法：
 *   node tools/publish-release.js --file dist/LabelGo-1.0.21-full.zip --version 1.0.21 \
 *     --changelog-file dist/CHANGELOG.txt --min-version 1.0.0
 *
 *   # 只补增量包（该版本已发过全量包）
 *   node tools/publish-release.js --version 1.0.21 --delta dist/LabelGo-1.0.21-from-1.0.20.pkg --from 1.0.20
 *
 *   # 站点地址（写进 latest.json 的绝对路径）默认取环境变量 / 后台设置
 *   --site https://www.bliot.cn/platform
 *
 * 全程不碰网络：文件在本地落盘、算 sha256、写库、重建 latest.json。
 * 服务器上的 nginx 直接 alias 出去，客户端下载不经过 Node。
 */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const eq = key.indexOf('=');
    if (eq >= 0) { out[key.slice(0, eq)] = key.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    i += 1;
  }
  return out;
}

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

(async () => {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || a.h) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*/, ''));
    return;
  }

  const release = require('../server/lib/release');

  const product = String(a.product || 'LabelGo');
  const version = String(a.version || '').trim();
  if (!release.validVersion(version)) die(`--version 必填且格式如 1.0.21（当前：${version || '空'}）`);

  const channel = String(a.channel || 'stable');
  const platform = String(a.platform || 'win32');
  const arch = String(a.arch || 'x64');
  const from = String(a.from || '');
  const fullFile = a.file ? path.resolve(String(a.file)) : '';
  const deltaFile = a.delta ? path.resolve(String(a.delta)) : '';

  if (!fullFile && !deltaFile) die('至少给一个包：--file 全量 / --delta 增量');
  if (fullFile && !fs.existsSync(fullFile)) die(`全量包不存在：${fullFile}`);
  if (deltaFile && !fs.existsSync(deltaFile)) die(`增量包不存在：${deltaFile}`);
  if (deltaFile && !from) die('--delta 必须配 --from（例如 --from 1.0.20）');

  const exist = release.list({ product, channel, platform, arch }).find((r) => r.version === version);
  if (!fullFile && !(exist && exist.full_sha256)) {
    die('该版本还没有全量包，先发布全量包再补增量');
  }

  let changelog = a.changelog ? String(a.changelog) : (exist ? exist.changelog : '');
  if (a['changelog-file']) {
    const f = path.resolve(String(a['changelog-file']));
    if (!fs.existsSync(f)) die(`更新说明文件不存在：${f}`);
    changelog = fs.readFileSync(f, 'utf8');
  }

  const patch = {
    product,
    version,
    channel,
    platform,
    arch,
    mandatory: a.mandatory === true || a.mandatory === '1' || a.mandatory === 'true',
    min_version: String(a['min-version'] || a.min_version || ''),
    changelog,
    rollout: a.rollout === undefined ? (exist ? exist.rollout : 100) : Math.max(0, Math.min(100, Number(a.rollout) || 0)),
    enabled: !(a.disabled === true || a.disabled === '1'),
  };
  if (patch.min_version && !release.validVersion(patch.min_version)) die(`--min-version 格式不对：${patch.min_version}`);
  if (patch.min_version && release.cmpVersion(patch.min_version, version) > 0) die('--min-version 不能高于发布版本');

  const base = release.siteBase(a.site ? String(a.site) : '');
  if (!base) {
    console.warn('  ! 没有站点地址（--site / release_site_url），latest.json 里会是相对 /updates/... 的地址');
  }

  const log = [];
  let rec;

  if (fullFile) {
    const rel = release.relFor(product, version, 'full');
    const tmp = release.tmpRel(path.extname(fullFile).toLowerCase());
    const info = await release.storeUpload(fs.createReadStream(fullFile), tmp);
    release.moveFile(tmp, rel);
    rec = release.saveRecord({
      ...patch,
      full_path: rel,
      full_sha256: info.sha256,
      full_size: info.size,
      full_url: String(a['full-url'] || ''),
      delta: exist ? exist.delta : [],
      published_at: new Date().toISOString(),
    });
    log.push(`全量包 ${rel}（${(info.size / 1024 / 1024).toFixed(2)} MB，sha256 ${info.sha256.slice(0, 12)}…）`);
  } else {
    rec = release.saveRecord({ ...patch, delta: exist ? exist.delta : [] });
  }

  if (deltaFile) {
    const rel = release.relFor(product, version, 'delta', from);
    const tmp = release.tmpRel('.pkg');
    const info = await release.storeUpload(fs.createReadStream(deltaFile), tmp);
    release.moveFile(tmp, rel);
    rec = release.attachDelta(rec.id, { from, path: rel, sha256: info.sha256, size: info.size });
    log.push(`增量包 ${rel}（from ${from}，${(info.size / 1024).toFixed(0)} KB）`);
  }

  const latest = release.writeLatest(base);
  console.log(`\n  ✓ 已发布 ${product} ${version}（${channel}/${platform}/${arch}）`);
  for (const l of log) console.log(`    - ${l}`);
  console.log(`    latest.json → ${latest.latest || '（无）'}${base ? '  ' + (latest.full ? latest.full.url : '') : ''}`);
  console.log(`\n  验证：\n    curl -s "${base || 'http://127.0.0.1:3000'}/api/open/v1/app/version?product=${encodeURIComponent(product)}&version=${encodeURIComponent(a.check || '0.0.0')}&platform=${platform}&arch=${arch}"\n`);
})().catch((e) => die(e.message));

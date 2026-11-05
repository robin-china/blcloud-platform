/* 桌面客户端更新包（LabelGo 等 Electron 端）
 *
 * 与 ThingsBoard OTA / 固件包没有任何关系：
 *   - 包是普通文件，落在 data/updates/<版本>/ 下，由 nginx（或 @fastify/static）直出；
 *   - 清单实时查 app_release 表，按 machine 哈希做灰度；
 *   - 下载接口不鉴权（包本身有 sha256，客户端下载后强校验）。
 *
 * 之所以不把包塞进设备属性：TB 的属性/遥测是给传感器数值用的，几十 MB 的二进制
 * 走 MQTT 会把网关打爆，而且客户端还得先登录 TB 才能拿到包，多一层失败可能。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const db = require('../db');
const { now } = require('./util');
const { getSetting } = require('./config');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const ROOT = process.env.UPDATES_DIR
  ? path.resolve(process.env.UPDATES_DIR)
  : path.join(DATA_DIR, 'updates');

/** 版本号：1.0.21 / 1.0.21-beta.2 / v1.2 */
const VERSION_RE = /^v?\d+(\.\d+){0,3}(-[0-9A-Za-z][0-9A-Za-z.\-]*)?$/;
/** 允许当包发布的扩展名：全部按 octet-stream 下发，但目录里绝不能出现可执行脚本 */
const PKG_EXT = ['.zip', '.pkg', '.exe', '.msi', '.dmg', '.7z', '.tar', '.gz', '.diff', '.bin'];

function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true });
}
ensureRoot();

function validVersion(v) {
  return VERSION_RE.test(String(v || '').trim());
}

function parseVersion(v) {
  const s = String(v || '').trim().replace(/^v/i, '');
  const [core, pre = ''] = s.split('-');
  const nums = core.split('.').map((n) => {
    const x = parseInt(n, 10);
    return Number.isFinite(x) ? x : 0;
  });
  while (nums.length < 4) nums.push(0);
  return { nums, pre };
}

/** semver 风格比较：返回 1 / 0 / -1；正式版高于同号预发布版 */
function cmpVersion(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 4; i += 1) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

/** 产品名进文件名/路径前先收敛字符集，避免 `../` 这类东西进到磁盘 */
function safeToken(s, fallback = '') {
  const v = String(s || '').trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+/, '');
  return v || fallback;
}

/** 相对 updates 根目录的路径 → 绝对路径；越界直接抛错 */
function absPath(rel) {
  const p = path.resolve(ROOT, String(rel || ''));
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) throw new Error('非法文件路径');
  return p;
}

function pkgName(product, version, kind, from) {
  const p = safeToken(product, 'app');
  const v = safeToken(version);
  if (kind === 'delta') return `${p}-${v}-from-${safeToken(from)}.pkg`;
  return `${p}-${v}-full.zip`;
}

function relFor(product, version, kind, from) {
  return `${safeToken(version)}/${pkgName(product, version, kind, from)}`;
}

function fileUrl(baseUrl, p) {
  const s = String(p || '');
  if (/^https?:\/\//i.test(s)) return s;
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const rel = s.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  return `${base}/updates/${rel}`;
}

/** 流式落盘并同时算 sha256/size：50MB 的包不能整进内存 */
async function storeUpload(fileStream, relPath) {
  const dest = absPath(relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const hash = crypto.createHash('sha256');
  let size = 0;
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  try {
    await pipeline(fileStream, tap, fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return { sha256: hash.digest('hex'), size };
}

function storeBuffer(buf, relPath) {
  const dest = absPath(relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
}

/** 上传时字段可能排在文件后面，先落临时名，等元数据齐了再改名到正式位置 */
function moveFile(fromRel, toRel) {
  const from = absPath(fromRel);
  const to = absPath(toRel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return toRel;
}

function tmpRel(ext) {
  return `.tmp/${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
}

function sha256File(relPath) {
  const file = absPath(relPath);
  if (!fs.existsSync(file)) return null;
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  let size = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      hash.update(buf.subarray(0, n));
      size += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest('hex'), size };
}

function parseDelta(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function rowToRecord(r) {
  if (!r) return null;
  return {
    ...r,
    delta: parseDelta(r.delta_json),
    mandatory: !!Number(r.mandatory),
    enabled: !!Number(r.enabled),
    rollout: Number(r.rollout == null ? 100 : r.rollout),
  };
}

/* ---------------- 发布 ---------------- */

/**
 * 新建或更新一条版本记录。
 * 同 (product, channel, platform, arch, version) 视为同一条：重发即替换包与说明。
 * full/delta 由调用方先落盘，这里只收算好的 sha256/size。
 */
function saveRecord(input) {
  const product = String(input.product || '').trim();
  const version = String(input.version || '').trim();
  if (!product) throw new Error('缺少 product');
  if (!validVersion(version)) throw new Error(`版本号格式不对：${version}`);
  const channel = String(input.channel || 'stable').trim() || 'stable';
  const platform = String(input.platform || 'win32').trim() || 'win32';
  const arch = String(input.arch || 'x64').trim() || 'x64';
  const t = now();

  const exist = db.prepare(
    'SELECT * FROM app_release WHERE product=? AND channel=? AND platform=? AND arch=? AND version=?'
  ).get(product, channel, platform, arch, version);

  const delta = input.delta === undefined
    ? (exist ? parseDelta(exist.delta_json) : [])
    : input.delta;

  const fields = {
    product, channel, platform, arch, version,
    full_path: input.full_path !== undefined ? input.full_path : (exist ? exist.full_path : ''),
    full_url: input.full_url !== undefined ? input.full_url : (exist ? exist.full_url : ''),
    full_sha256: input.full_sha256 !== undefined ? input.full_sha256 : (exist ? exist.full_sha256 : ''),
    full_size: input.full_size !== undefined ? Number(input.full_size) : (exist ? exist.full_size : 0),
    delta_json: JSON.stringify(delta || []),
    mandatory: input.mandatory !== undefined ? (input.mandatory ? 1 : 0) : (exist ? exist.mandatory : 0),
    min_version: input.min_version !== undefined ? String(input.min_version || '') : (exist ? exist.min_version : ''),
    changelog: input.changelog !== undefined ? String(input.changelog || '') : (exist ? exist.changelog : ''),
    rollout: input.rollout !== undefined ? Math.max(0, Math.min(100, Number(input.rollout) || 0)) : (exist ? exist.rollout : 100),
    published_at: input.published_at !== undefined
      ? input.published_at
      : (exist ? exist.published_at : t),
    enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : (exist ? exist.enabled : 1),
    updated_at: t,
  };

  if (exist) {
    db.prepare(`UPDATE app_release SET full_path=@full_path, full_url=@full_url, full_sha256=@full_sha256,
      full_size=@full_size, delta_json=@delta_json, mandatory=@mandatory, min_version=@min_version,
      changelog=@changelog, rollout=@rollout, published_at=@published_at, enabled=@enabled, updated_at=@updated_at
      WHERE id=@id`).run({ ...fields, id: exist.id });
    return rowToRecord(db.prepare('SELECT * FROM app_release WHERE id=?').get(exist.id));
  }

  const info = db.prepare(`INSERT INTO app_release
    (product, channel, platform, arch, version, full_path, full_url, full_sha256, full_size,
     delta_json, mandatory, min_version, changelog, rollout, published_at, enabled, created_at, updated_at)
    VALUES (@product,@channel,@platform,@arch,@version,@full_path,@full_url,@full_sha256,@full_size,
     @delta_json,@mandatory,@min_version,@changelog,@rollout,@published_at,@enabled,@created_at,@updated_at)`)
    .run({ ...fields, created_at: t });
  return rowToRecord(db.prepare('SELECT * FROM app_release WHERE id=?').get(info.lastInsertRowid));
}

/** 增量包挂到某个版本上（按 from 去重，重新上传即替换） */
function attachDelta(id, delta) {
  const row = db.prepare('SELECT * FROM app_release WHERE id=?').get(id);
  if (!row) throw new Error('版本记录不存在');
  const list = parseDelta(row.delta_json).filter((d) => String(d.from) !== String(delta.from));
  list.push(delta);
  db.prepare('UPDATE app_release SET delta_json=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(list), now(), id);
  return rowToRecord(db.prepare('SELECT * FROM app_release WHERE id=?').get(id));
}

function list({ product, channel, platform, arch } = {}) {
  const where = [];
  const args = [];
  if (product) { where.push('product=?'); args.push(product); }
  if (channel) { where.push('channel=?'); args.push(channel); }
  if (platform) { where.push('platform=?'); args.push(platform); }
  if (arch) { where.push('arch=?'); args.push(arch); }
  const sql = `SELECT * FROM app_release ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`;
  return db.prepare(sql).all(...args).map(rowToRecord);
}

function get(id) {
  return rowToRecord(db.prepare('SELECT * FROM app_release WHERE id=?').get(id));
}

/* ---------------- 灰度与挑选 ---------------- */

function inRollout(machine, version, rollout) {
  const p = Number(rollout == null ? 100 : rollout);
  if (p >= 100) return true;
  if (p <= 0) return false;
  // 没带 machine 就没法分桶。此时按「包含」处理，否则不带机器码的客户端永远收不到灰度包；
  // 想整体暂停请用 rollout=0 或 enabled=0，这两种情况上面已经拦掉。
  if (!machine) return true;
  const h = crypto.createHash('sha256').update(`${machine}|${version}`).digest();
  return h.readUInt32BE(0) % 100 < p;
}

function candidates({ product, channel, platform, arch }) {
  return db.prepare(`SELECT * FROM app_release
    WHERE product=? AND channel=? AND platform=? AND arch=? AND enabled=1 AND full_sha256<>''
    ORDER BY id DESC`)
    .all(product, channel, platform, arch)
    .map(rowToRecord)
    .sort((a, b) => cmpVersion(b.version, a.version));
}

/**
 * 挑出该给这台机器的版本。
 * 从高到低逐条判断灰度：高版本没命中就退到下一条，而不是直接判定「无更新」——
 * 否则 10% 灰度的 1.0.22 会把另外 90% 卡在 1.0.20，明明 1.0.21 是全量的。
 */
function pick(opts) {
  const { current = '', machine = '' } = opts;
  const list = candidates(opts);
  if (!current) return list.find((r) => inRollout(machine, r.version, r.rollout)) || null;
  for (const r of list) {
    if (cmpVersion(r.version, current) <= 0) continue;
    if (inRollout(machine, r.version, r.rollout)) return r;
  }
  return null;
}

function deltaOut(baseUrl, rec) {
  return (rec.delta || [])
    .filter((d) => d && d.from && (d.path || d.url))
    .map((d) => ({
      from: String(d.from),
      url: fileUrl(baseUrl, d.url || d.path),
      sha256: String(d.sha256 || '').toLowerCase(),
      size: Number(d.size || 0),
    }))
    .sort((a, b) => cmpVersion(b.from, a.from));
}

/**
 * 生成清单。baseUrl 由调用方按当前请求拼（换域名/换子路径都不用改库）。
 * 无更新时只回 { latest: 当前版本 }，不带 full/delta —— 客户端按 latest 比对即可。
 */
function manifest(opts, baseUrl) {
  const product = String(opts.product || '').trim();
  const channel = String(opts.channel || 'stable').trim() || 'stable';
  const platform = String(opts.platform || 'win32').trim() || 'win32';
  const arch = String(opts.arch || 'x64').trim() || 'x64';
  const current = String(opts.current || '').trim();
  const machine = String(opts.machine || '').trim();

  const rec = pick({ product, channel, platform, arch, current, machine });
  const head = {
    product, channel, platform, arch, server_time: now(),
    // 客户端升级后回调这个地址，后台才有「谁真的升了」的记录
    report_url: `${String(baseUrl || '').replace(/\/+$/, '')}/api/open/v1/app/update-report`,
  };

  if (!rec) {
    return {
      ...head,
      latest: current || '',
      current: current || '',
      update_available: false,
    };
  }

  const minVersion = String(rec.min_version || '0.0.0');
  const mandatory = rec.mandatory || (current ? cmpVersion(current, minVersion) < 0 : false);

  return {
    ...head,
    latest: rec.version,
    channel: rec.channel,
    mandatory,
    minVersion,
    changelog: rec.changelog || '',
    publishedAt: rec.published_at || '',
    full: {
      url: fileUrl(baseUrl, rec.full_url || rec.full_path),
      sha256: String(rec.full_sha256 || '').toLowerCase(),
      size: Number(rec.full_size || 0),
    },
    delta: deltaOut(baseUrl, rec),
    current: current || '',
    update_available: true,
    // 灰度命中的比例，排障时一眼看出「为什么这台机器拿到了 / 没拿到」
    rollout: rec.rollout,
  };
}

/* ---------------- latest.json 兜底清单 ---------------- */

/** 发布时的站点根地址：环境变量 > 后台设置 > 调用方传入 */
function siteBase(fallback = '') {
  const fromEnv = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const fromDb = String(getSetting('release_site_url', '') || '').trim();
  if (fromDb) return fromDb.replace(/\/+$/, '');
  return String(fallback || '').replace(/\/+$/, '');
}

function defaultTarget() {
  return {
    product: getSetting('release_default_product', 'LabelGo') || 'LabelGo',
    channel: getSetting('release_default_channel', 'stable') || 'stable',
    platform: 'win32',
    arch: 'x64',
  };
}

/** 原子写 JSON 到 updates 目录下（相对 ROOT） */
function writeJson(relPath, body) {
  const dest = path.join(ROOT, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
  fs.renameSync(tmp, dest);
}

/** 单个产品的兜底清单体；该产品没有任何启用版本时返回 null */
function latestBodyFor(product, base) {
  // 优先默认渠道/平台；该组合没发过版（比如纯 mac 产品）就取该产品下任意一条最高版
  let pool = candidates({ product, channel: 'stable', platform: 'win32', arch: 'x64' });
  if (!pool.length) {
    pool = db.prepare("SELECT * FROM app_release WHERE product=? AND enabled=1 AND full_sha256<>''")
      .all(product).map(rowToRecord)
      .sort((a, b) => cmpVersion(b.version, a.version));
  }
  const full = pool.filter((r) => r.rollout >= 100);
  const rec = (full[0] || pool[0] || null);
  if (!rec) return null;
  return {
    generated_at: now(),
    product,
    channel: rec.channel,
    platform: rec.platform,
    arch: rec.arch,
    latest: rec.version,
    mandatory: !!rec.mandatory,
    minVersion: rec.min_version || '0.0.0',
    changelog: rec.changelog || '',
    publishedAt: rec.published_at || '',
    full: {
      url: fileUrl(base, rec.full_url || rec.full_path),
      sha256: String(rec.full_sha256 || '').toLowerCase(),
      size: Number(rec.full_size || 0),
    },
    delta: deltaOut(base, rec),
  };
}

/** 最近一次 writeLatest 写了哪些文件（给后台回显/排障用） */
let lastWriteInfo = { files: [], at: '' };
function getLastWriteInfo() { return lastWriteInfo; }

/**
 * 重建兜底清单 —— 多产品各写一份：
 *   /updates/<产品>/latest.json   每个产品自己的兜底清单
 *   /updates/products.json        产品索引（有哪些产品、各自最新版、清单地址）
 *   /updates/latest.json          默认产品的清单（老客户端/文档兼容，结构不变）
 * 只能取「全量发布」的那一版：静态文件没法按机器分桶，写灰度版会坑到所有人。
 */
function writeLatest(baseUrl) {
  const tgt = defaultTarget();
  const base = siteBase(baseUrl);
  const products = db.prepare('SELECT DISTINCT product FROM app_release WHERE enabled=1 ORDER BY product')
    .all().map((r) => r.product);

  const bodies = {};
  const written = [];
  for (const p of products) {
    const body = latestBodyFor(p, base);
    if (!body) continue;
    const dir = safeToken(p, 'app');
    writeJson(`${dir}/latest.json`, body);
    written.push(`${dir}/latest.json`);
    bodies[p] = body;
  }

  writeJson('products.json', {
    generated_at: now(),
    products: products.filter((p) => bodies[p]).map((p) => ({
      product: p,
      latest: bodies[p].latest,
      channel: bodies[p].channel,
      platform: bodies[p].platform,
      manifest_url: fileUrl(base, `${safeToken(p, 'app')}/latest.json`),
    })),
  });
  written.push('products.json');

  // 根 latest.json 固定给默认产品：单产品时代的老客户端与文档都指向这个路径
  const rootBody = bodies[tgt.product] || {
    generated_at: now(),
    product: tgt.product,
    channel: tgt.channel,
    platform: tgt.platform,
    arch: tgt.arch,
    latest: '',
  };
  writeJson('latest.json', rootBody);
  written.push('latest.json');

  lastWriteInfo = { files: written, at: now() };
  return rootBody;
}

/* ---------------- 升级事件记录 ---------------- */

function clientMeta(req) {
  const ip = String((req && (req.ip || req.headers['x-forwarded-for'])) || '').split(',')[0].trim();
  const ua = String((req && req.headers && req.headers['user-agent']) || '').slice(0, 200);
  return { ip, ua };
}

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

/**
 * 记录一次「清单命中」：说明这台机器被告知有新版。
 * 客户端每次启动都轮询，同一台机器 10 分钟内对同一目标版本只留一条，
 * 否则列表会被同一台机器的重复请求刷屏。
 */
function logCheck(rec, opts, req) {
  if (!rec) return null;
  const meta = clientMeta(req);
  const machine = clip(opts.machine, 64);
  // 注意：这里传进来的是 manifest() 的结果，版本字段叫 latest（不是 version）
  const to = clip(rec.version || rec.latest, 32);
  if (!to) return null;
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const dup = db.prepare(`SELECT id FROM app_update_log
    WHERE product=? AND machine=? AND from_version=? AND to_version=? AND action='check' AND created_at>=?
    LIMIT 1`).get(rec.product, machine, clip(opts.current, 32), to, since);
  if (dup) return null;
  return insertUpdate({
    product: rec.product,
    channel: rec.channel,
    platform: rec.platform,
    arch: rec.arch,
    machine,
    from: clip(opts.current, 32),
    to,
    action: 'check',
    ip: meta.ip,
    ua: meta.ua,
    note: '',
  });
}

/** 客户端上报升级结果（成功/失败），也允许后台手工补录 */
function logUpdate(input) {
  return insertUpdate({
    product: clip(input.product, 64),
    channel: clip(input.channel, 16) || 'stable',
    platform: clip(input.platform, 16),
    arch: clip(input.arch, 16),
    machine: clip(input.machine, 64),
    from: clip(input.from, 32),
    to: clip(input.to, 32),
    action: input.action === 'fail' ? 'fail' : (input.action === 'check' ? 'check' : 'success'),
    ip: clip(input.ip, 64),
    ua: clip(input.ua, 200),
    note: clip(input.note, 300),
  });
}

function insertUpdate(e) {
  if (!e.product) throw new Error('缺少 product');
  const info = db.prepare(`INSERT INTO app_update_log
    (product, channel, platform, arch, machine, from_version, to_version, action, ip, user_agent, note, created_at)
    VALUES (@product,@channel,@platform,@arch,@machine,@from_version,@to_version,@action,@ip,@user_agent,@note,@created_at)`)
    .run({
      product: e.product,
      channel: e.channel || 'stable',
      platform: e.platform || '',
      arch: e.arch || '',
      machine: e.machine || '',
      from_version: e.from || '',
      to_version: e.to || '',
      action: e.action || 'check',
      ip: e.ip || '',
      user_agent: e.ua || '',
      note: e.note || '',
      created_at: now(),
    });
  return db.prepare('SELECT * FROM app_update_log WHERE id=?').get(info.lastInsertRowid);
}

/** 升级记录列表 + 汇总；machine 去重后的升级成功率一眼可见 */
function listUpdates({ product, action, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (product) { where.push('product=?'); args.push(product); }
  if (action) { where.push('action=?'); args.push(action); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const max = Math.max(1, Math.min(1000, Number(limit) || 200));
  const list = db.prepare(`SELECT * FROM app_update_log ${whereSql} ORDER BY id DESC LIMIT ${max}`).all(...args);

  const sumArgs = product ? [product] : [];
  const sumWhere = product ? 'WHERE product=?' : '';
  const counts = db.prepare(`SELECT action, COUNT(*) AS n FROM app_update_log ${sumWhere} GROUP BY action`)
    .all(...sumArgs).reduce((acc, r) => { acc[r.action] = r.n; return acc; }, {});
  const machines = db.prepare(`SELECT COUNT(DISTINCT machine) AS n FROM app_update_log ${sumWhere}${product ? ' AND' : ' WHERE'} machine<>''`)
    .get(...sumArgs).n;

  return {
    list,
    summary: {
      check: counts.check || 0,
      success: counts.success || 0,
      fail: counts.fail || 0,
      machines,
    },
  };
}

/* ---------------- 维护 ---------------- */

function verify(id) {
  const rec = get(id);
  if (!rec) return { ok: false, error: '版本记录不存在' };
  const full = rec.full_path ? sha256File(rec.full_path) : null;
  const deltas = (rec.delta || []).map((d) => {
    const got = d.path ? sha256File(d.path) : null;
    return {
      from: d.from,
      path: d.path,
      expected: d.sha256,
      actual: got ? got.sha256 : null,
      size: got ? got.size : null,
      size_expected: Number(d.size || 0),
      ok: !!got && got.sha256 === String(d.sha256).toLowerCase() && got.size === Number(d.size || 0),
    };
  });
  return {
    id: rec.id,
    version: rec.version,
    full: {
      path: rec.full_path,
      expected: rec.full_sha256,
      actual: full ? full.sha256 : null,
      size: full ? full.size : null,
      size_expected: Number(rec.full_size || 0),
      ok: !!full && full.sha256 === String(rec.full_sha256).toLowerCase() && full.size === Number(rec.full_size || 0),
    },
    delta: deltas,
    ok: !!full && full.sha256 === String(rec.full_sha256).toLowerCase()
      && full.size === Number(rec.full_size || 0) && deltas.every((d) => d.ok),
  };
}

function remove(id, { files = false } = {}) {
  const rec = get(id);
  if (!rec) return false;
  const paths = [rec.full_path, ...(rec.delta || []).map((d) => d.path)].filter(Boolean);
  db.prepare('DELETE FROM app_release WHERE id=?').run(id);
  if (files) {
    for (const p of paths) {
      try { fs.rmSync(absPath(p), { force: true }); } catch { /* 文件已不在就算了 */ }
    }
  }
  return true;
}

function update(id, patch) {
  const rec = get(id);
  if (!rec) return null;
  const next = {};
  for (const k of ['enabled', 'mandatory', 'min_version', 'changelog', 'rollout', 'full_url']) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  return saveRecord({ ...rec, ...next, delta: rec.delta });
}

module.exports = {
  ROOT,
  PKG_EXT,
  validVersion,
  cmpVersion,
  safeToken,
  pkgName,
  relFor,
  fileUrl,
  storeUpload,
  storeBuffer,
  moveFile,
  tmpRel,
  sha256File,
  saveRecord,
  attachDelta,
  list,
  get,
  pick,
  manifest,
  writeLatest,
  latestBodyFor,
  getLastWriteInfo,
  logCheck,
  logUpdate,
  listUpdates,
  siteBase,
  defaultTarget,
  verify,
  remove,
  update,
  absPath,
};

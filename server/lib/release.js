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
const manifestKey = require('./manifestkey');

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
function pick(opts, preList) {
  const { current = '', machine = '' } = opts;
  const list = preList || candidates(opts);
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

/** 发布时间统一成契约里的 ISO 8601 秒级 UTC（库里 now() 带毫秒，去掉不影响语义） */
function publishedAtOut(v) {
  return String(v || '').replace(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d{3}Z$/, '$1Z');
}

/**
 * 离线版产品不进自动升级流程：它们只挂全量包，由客户/实施手动安装。
 * 用设置项而不是代码常量，新增第三个离线产品不用改代码。
 */
function manualProducts() {
  return String(getSetting('release_manual_products', 'LabelGo-Offline') || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * 给清单加签名：canonical（键排序、紧凑、数组保序、UTF-8）后 Ed25519。
 * kid 放进被签内容，客户端可以按 kid 选择内嵌的公钥。
 */
function signManifest(body) {
  return manifestKey.signObject(body);
}

/**
 * 生成清单。baseUrl 由调用方按当前请求拼（换域名/换子路径都不用改库）。
 * 无更新时只回 { latest: 当前版本 }，不带 full/delta —— 客户端按 latest 比对即可。
 *
 * 2026-11-11：每次响应都用 Ed25519 现签（signature + kid）。
 * 不在发布时签一次静态文件 —— 清单里有 rollout / mandatory / server_time，
 * 静态签名会把「这台机器是否命中灰度」签成发布那一刻的样子，验签反而失真。
 */
function manifest(opts, baseUrl) {
  const product = String(opts.product || '').trim();
  const channel = String(opts.channel || 'stable').trim() || 'stable';
  const platform = String(opts.platform || 'win32').trim() || 'win32';
  const arch = String(opts.arch || 'x64').trim() || 'x64';
  const current = String(opts.current || '').trim();
  const machine = String(opts.machine || '').trim();

  // 先取一次列表：既用来挑版本，也用来判断「这个产品到底有没有发布过」。
  // 没有发布记录时绝不能回显 latest=当前版本 —— 那等于告诉客户端「已是最新」，
  // 而实际上这个产品一个包都没有（LabelGo-Offline 首发前踩过：客户端误以为
  // 拿到的是在线版最新清单）。
  const list = candidates({ product, channel, platform, arch });
  const rec = pick({ product, channel, platform, arch, current, machine }, list);
  const head = {
    product, channel, platform, arch, server_time: now(),
    // 客户端升级后回调这个地址，后台才有「谁真的升了」的记录
    report_url: `${String(baseUrl || '').replace(/\/+$/, '')}/api/open/v1/app/update-report`,
    // false = 该产品不进自动升级流程（离线版：只挂 full，客户手动装）
    auto_update: !manualProducts().includes(product),
  };

  if (!list.length) {
    return signManifest({
      ...head,
      latest: '',
      current: current || '',
      update_available: false,
      // 「没发布过」和「已是最新」必须能区分：前者客户端应提示「该产品暂无可用版本」，
      // 而不是安安静静什么都不做（离线产品还没发包时最容易误解）
      no_release: true,
    });
  }

  if (!rec) {
    return signManifest({
      ...head,
      latest: current || '',
      current: current || '',
      update_available: false,
      no_release: false,
    });
  }

  const minVersion = String(rec.min_version || '0.0.0');
  const mandatory = rec.mandatory || (current ? cmpVersion(current, minVersion) < 0 : false);

  return signManifest({
    ...head,
    latest: rec.version,
    channel: rec.channel,
    mandatory,
    minVersion,
    changelog: rec.changelog || '',
    publishedAt: publishedAtOut(rec.published_at),
    full: {
      url: fileUrl(baseUrl, rec.full_url || rec.full_path),
      sha256: String(rec.full_sha256 || '').toLowerCase(),
      size: Number(rec.full_size || 0),
    },
    delta: deltaOut(baseUrl, rec),
    current: current || '',
    update_available: true,
    no_release: false,
    // 灰度命中的比例，排障时一眼看出「为什么这台机器拿到了 / 没拿到」
    rollout: rec.rollout,
  });
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
    publishedAt: publishedAtOut(rec.published_at),
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
    // 静态兜底同样加签：只签动态响应会留一个「未验签也能装包」的入口
    const signed = signManifest({ ...body, auto_update: !manualProducts().includes(p) });
    const dir = safeToken(p, 'app');
    writeJson(`${dir}/latest.json`, signed);
    written.push(`${dir}/latest.json`);
    bodies[p] = signed;
  }

  writeJson('products.json', signManifest({
    generated_at: now(),
    // 离线产品可能还没发过包：显式列出不自动升级的产品，
    // 客户端才能区分「没这个产品」和「有这个产品但还没发包」
    manual_products: manualProducts(),
    products: products.filter((p) => bodies[p]).map((p) => ({
      product: p,
      latest: bodies[p].latest,
      channel: bodies[p].channel,
      platform: bodies[p].platform,
      auto_update: !manualProducts().includes(p),
      manifest_url: fileUrl(base, `${safeToken(p, 'app')}/latest.json`),
    })),
  }));
  written.push('products.json');

  // 根 latest.json 固定给默认产品：单产品时代的老客户端与文档都指向这个路径
  const rootBody = bodies[tgt.product] || signManifest({
    generated_at: now(),
    product: tgt.product,
    channel: tgt.channel,
    platform: tgt.platform,
    arch: tgt.arch,
    latest: '',
  });
  writeJson('latest.json', rootBody);
  written.push('latest.json');

  lastWriteInfo = { files: written, at: now() };
  return rootBody;
}

/** 读一份已生成的静态清单，判断有没有签名（读不到 / 解析失败都算缺） */
function hasSignature(rel) {
  try {
    const body = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    return !!(body && body.signature && body.kid);
  } catch {
    return false;
  }
}

/**
 * 找出「缺签名」的兜底清单。
 * 静态清单是发布那一刻顺手写的，加签这类改动上线后不会自动重生成 ——
 * 结果就是动态接口已验签、静态兜底还是老格式，留了一条不用验签就能装包的旁路。
 * fallbackBase 只在调用方明确知道站点地址时传（脚本/后台）；启动自愈不传，
 * 必须靠环境变量或后台设置，否则会把绝对下载地址写成相对路径。
 */
function staleManifests(fallbackBase = '') {
  const base = siteBase(fallbackBase);
  const need = [];
  const products = db.prepare('SELECT DISTINCT product FROM app_release WHERE enabled=1 ORDER BY product')
    .all().map((r) => r.product);
  for (const p of products) {
    const rel = `${safeToken(p, 'app')}/latest.json`;
    if (!hasSignature(rel)) need.push(rel);
  }
  if (products.length && !hasSignature('products.json')) need.push('products.json');
  if (products.length && !hasSignature('latest.json')) need.push('latest.json');
  return { base, files: need };
}

/** 启动自愈：静态清单缺签名就按库里现有记录重建一次（失败不影响启动） */
function rebuildIfStale() {
  const s = staleManifests();
  if (!s.files.length) return { rebuilt: false, files: [], reason: 'fresh' };
  if (!s.base) return { rebuilt: false, files: s.files, reason: 'no-base' };
  writeLatest(s.base);
  return { rebuilt: true, files: getLastWriteInfo().files, reason: 'stale' };
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

/* 客户端上报升级结果（成功/失败/回滚），也允许后台手工补录。
 *
 * 契约 v2（2026-11-10，与软件端 LabelGo 对齐后定稿）：
 *   - action 取值 success / fail / rollback（旧调用只传 fail/success 的行为不变）；
 *   - 新增细分：result_code（整数失败码）/ stage（失败阶段）/
 *     duration_ms / elevated / os_info / client_at；
 *   - 去重口径是「覆盖不累加」：同一台机器同一组 from→to 的结果上报只保留
 *     最新一条 —— 客户端上报失败会本地重试 7 天，回滚后重升还会再报，
 *     若累加，后台失败次数会被重试灌水，成功率统计就没意义了。
 *     machine 为空（老客户端没带）时退化为普通流水。
 */
function logUpdate(input) {
  const row = {
    product: clip(input.product, 64),
    channel: clip(input.channel, 16) || 'stable',
    platform: clip(input.platform, 16),
    arch: clip(input.arch, 16),
    machine: clip(input.machine, 64),
    from_version: clip(input.from, 32),
    to_version: clip(input.to, 32),
    action: ['fail', 'rollback'].includes(input.action) ? input.action
      : (input.action === 'check' ? 'check' : 'success'),
    ip: clip(input.ip, 64),
    user_agent: clip(input.ua, 200),
    note: clip(input.note, 300),
    result_code: Number.isFinite(Number(input.result_code)) ? Math.trunc(Number(input.result_code)) : 0,
    stage: clip(input.stage, 32),
    duration_ms: Math.max(0, Math.trunc(Number(input.duration_ms) || 0)),
    elevated: input.elevated ? 1 : 0,
    os_info: clip(input.os_info, 64),
    client_at: clip(input.client_at, 40),
  };
  if (!row.product) throw new Error('缺少 product');

  // 结果上报幂等（覆盖）：只对非 check 的结果生效；清单命中流水不受影响
  if (row.action !== 'check' && row.machine) {
    const dup = db.prepare(`SELECT id FROM app_update_log
      WHERE product=? AND machine=? AND from_version=? AND to_version=? AND action<>'check'
      ORDER BY id DESC LIMIT 1`).get(row.product, row.machine, row.from_version, row.to_version);
    if (dup) {
      db.prepare(`UPDATE app_update_log SET action=@action, ip=@ip, user_agent=@user_agent,
        note=@note, result_code=@result_code, stage=@stage, duration_ms=@duration_ms,
        elevated=@elevated, os_info=@os_info, client_at=@client_at, created_at=@created_at
        WHERE id=@id`).run({ ...row, id: dup.id, created_at: now() });
      return { row: db.prepare('SELECT * FROM app_update_log WHERE id=?').get(dup.id), deduped: true };
    }
  }

  const info = db.prepare(`INSERT INTO app_update_log
    (product, channel, platform, arch, machine, from_version, to_version, action, ip, user_agent, note,
     result_code, stage, duration_ms, elevated, os_info, client_at, created_at)
    VALUES (@product,@channel,@platform,@arch,@machine,@from_version,@to_version,@action,@ip,@user_agent,@note,
     @result_code,@stage,@duration_ms,@elevated,@os_info,@client_at,@created_at)`)
    .run({ ...row, created_at: now() });
  return { row: db.prepare('SELECT * FROM app_update_log WHERE id=?').get(info.lastInsertRowid), deduped: false };
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
      rollback: counts.rollback || 0,
      machines,
    },
  };
}

/**
 * 清理升级记录（按产品 / 按天数）。
 * days=0 表示清空该产品全部记录；只删流水，不动 app_release 与任何业务状态。
 */
function purgeUpdates({ product = '', days = 0 } = {}) {
  const where = [];
  const args = [];
  if (product) { where.push('product=?'); args.push(product); }
  if (days > 0) {
    where.push('created_at < ?');
    args.push(new Date(Date.now() - days * 86400000).toISOString());
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const before = db.prepare(`SELECT COUNT(*) AS c FROM app_update_log ${whereSql}`).get(...args).c;
  let deleted = 0;
  for (let i = 0; i < 400; i += 1) {
    const info = db.prepare(`DELETE FROM app_update_log WHERE id IN (
      SELECT id FROM app_update_log ${whereSql} LIMIT 5000)`).run(...args);
    deleted += info.changes;
    if (info.changes < 5000) break;
  }
  return { product: product || '', days, before, deleted };
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
  signManifest,
  verifyManifest: (body) => manifestKey.verifyObject(body),
  manualProducts,
  writeLatest,
  staleManifests,
  rebuildIfStale,
  hasSignature,
  latestBodyFor,
  getLastWriteInfo,
  logCheck,
  logUpdate,
  listUpdates,
  purgeUpdates,
  siteBase,
  defaultTarget,
  verify,
  remove,
  update,
  absPath,
};

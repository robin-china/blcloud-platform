/* 模板市场业务层（2026-11-13）
 *
 * 两条硬边界，改代码前先看：
 *  1) 模板文件（.blls）只存 data/market/ 私有目录，**这个目录不挂任何静态映射**，
 *     也不放进 Nginx 直出的 uploads/。对外接口永不返回文件路径或 downloadUrl 直链，
 *     只能由「兑换成功 → 签发 5 分钟一次性短链 → 后端读文件流」这一条路拿到文件。
 *  2) 积分只在服务端算，users.points 是唯一真相源。兑换是单事务：
 *     校验 → 条件扣分 → 记流水 → 写已购 → 发短链，任一步失败全回滚。
 *     客户端本地 credits.json 只是展示缓存，离线不得放行兑换（否则一定双花）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { now, safeJson } = require('./util');
const { getSetting, basePath } = require('./config');
const { getMasterKey } = require('./crypto');
const pointsLib = require('./points');

const ROOT = process.env.MARKET_DIR
  ? path.resolve(process.env.MARKET_DIR)
  : path.join(__dirname, '..', '..', 'data', 'market');
fs.mkdirSync(ROOT, { recursive: true });

/* 缩略图与私有 .blls 是两条完全不同的路：它是「要展示给客户端的图片」，
 * 必须落在 Nginx 直出的 data/uploads/。正因为公开，校验要比 .blls 严：
 * 文件头魔数（防把 HTML/SVG 改名成 .png 造成存储型 XSS）+ 大小上限 +
 * 服务端生成文件名（用户给的文件名绝不参与路径）+ 内容寻址去重。
 * MARKET_THUMB_DIR 只用于测试隔离，生产不设即与 server/index.js 的 UPLOAD_DIR 同目录。
 */
const THUMB_DIR = process.env.MARKET_THUMB_DIR
  ? path.resolve(process.env.MARKET_THUMB_DIR)
  : path.join(__dirname, '..', '..', 'data', 'uploads');
fs.mkdirSync(THUMB_DIR, { recursive: true });
const MAX_THUMB = 2 * 1024 * 1024;
const THUMB_EXT_OF_KIND = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp' };

const DEFAULT_LINK_TTL = 300; // 秒

function linkTtl() {
  const v = Math.trunc(Number(getSetting('market_link_ttl_seconds', String(DEFAULT_LINK_TTL))) || DEFAULT_LINK_TTL);
  return Math.min(3600, Math.max(30, v));
}

/* ---------------------------------------------------------------- 枚举字典 */

const DEFAULT_INDUSTRIES = ['制造业', '物流仓储', '零售电商', '食品餐饮', '医疗器械', '固定资产', '化工', '服饰', '其他'];
const DEFAULT_PAPER_TYPES = ['间隙纸', '黑标纸', '连续纸'];
// 2026-11-13 订正：还有 600dpi。这里是**服务端硬允许集**，字典只决定给客户端
// 下发哪几项，不允许运营/API 写出集外的值（否则客户端渲染与打印尺寸全乱）。
const DPI_ALLOWED = [203, 300, 600];
const DEFAULT_DPIS = [203, 300, 600];

function options() {
  const rows = db.prepare('SELECT * FROM market_options ORDER BY sort ASC, id ASC').all();
  const out = { industries: [], paper_types: [], size_presets: [], dpis: [] };
  for (const r of rows) {
    if (r.kind === 'industry') out.industries.push(r.value);
    else if (r.kind === 'paper_type') out.paper_types.push(r.value);
    else if (r.kind === 'dpi') {
      const n = Number(r.value);
      if (DPI_ALLOWED.includes(n)) out.dpis.push(n);
    } else if (r.kind === 'size_preset') {
      const p = safeJson(r.value, null);
      if (p && typeof p === 'object') out.size_presets.push({
        label: String(p.label || ''), widthMm: Number(p.widthMm) || 0, heightMm: Number(p.heightMm) || 0,
      });
    }
  }
  // 字典被运营清空时不给客户端下发空数组（会让客户端筛选栏整片消失）：
  // 回退到内置默认值，并在 meta 里标明来源，方便排障。
  if (!out.industries.length) out.industries = [...DEFAULT_INDUSTRIES];
  if (!out.paper_types.length) out.paper_types = [...DEFAULT_PAPER_TYPES];
  if (!out.dpis.length) out.dpis = [...DEFAULT_DPIS];
  return out;
}

function meta() {
  const o = options();
  return {
    industries: o.industries,
    paperTypes: o.paper_types,
    sizePresets: o.size_presets,
    dpis: o.dpis,
    sorts: ['downloads_desc', 'newest', 'price_asc', 'price_desc'],
    defaultSort: 'downloads_desc',
    defaultLimit: 50,
    signinGain: Math.trunc(Number(getSetting('user_points_signin', '10')) || 10),
    registerBonus: Math.trunc(Number(getSetting('user_points_register', '200')) || 0),
    linkTtlSeconds: linkTtl(),
    serverTime: now(),
    timezone: 'Asia/Shanghai',
  };
}

/** 全量覆盖字典（后台页一次提交三张清单）。返回各清单条数。 */
function saveOptions(body) {
  const clean = (v, max) => (Array.isArray(v) ? v : [])
    .map((x) => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, max);
  const industries = [...new Set(clean(body.industries, 100))].map((s) => s.slice(0, 40));
  const paperTypes = [...new Set(clean(body.paperTypes, 40))].map((s) => s.slice(0, 40));
  const presets = (Array.isArray(body.sizePresets) ? body.sizePresets : []).slice(0, 60)
    .map((p) => ({
      label: String((p && p.label) || '').trim().slice(0, 40),
      widthMm: Math.max(0, Number((p && (p.widthMm ?? p.width_mm)) || 0)),
      heightMm: Math.max(0, Number((p && (p.heightMm ?? p.height_mm)) || 0)),
    }))
    .filter((p) => p.label && p.widthMm > 0 && p.heightMm > 0);
  // 老版本后台页不传 dpis → 保留原有配置；一次都没有则回落到三项全开，
  // 免得「保存行业」顺手把 600dpi 弄没了。
  const rawDpis = Array.isArray(body.dpis) ? body.dpis.map(Number).filter((n) => DPI_ALLOWED.includes(n)) : null;
  const dpis = rawDpis === null
    ? (options().dpis || DEFAULT_DPIS)
    : ([...new Set(rawDpis)].length ? [...new Set(rawDpis)].sort((a, b) => a - b) : [...DEFAULT_DPIS]);
  const t = now();
  const ins = db.prepare('INSERT OR IGNORE INTO market_options (kind, value, sort, created_at) VALUES (?,?,?,?)');
  db.transaction(() => {
    db.prepare('DELETE FROM market_options').run();
    industries.forEach((v, i) => ins.run('industry', v, i * 10, t));
    paperTypes.forEach((v, i) => ins.run('paper_type', v, i * 10, t));
    presets.forEach((v, i) => ins.run('size_preset', JSON.stringify(v), i * 10, t));
    dpis.forEach((v, i) => ins.run('dpi', String(v), i * 10, t));
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run('market_options_seeded', '1', t);
  })();
  return { industries: industries.length, paperTypes: paperTypes.length, sizePresets: presets.length, dpis };
}

/* ---------------------------------------------------------------- 模板输出 */

/** 对外字段：camelCase，且刻意不含 fileUrl / file_path —— 清单 §3.2/§3.3 的硬要求。 */
function publicTemplate(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    industry: r.industry || '',
    description: r.description || '',
    tags: safeJson(r.tags, []),
    widthMm: Number(r.width_mm) || 0,
    heightMm: Number(r.height_mm) || 0,
    paperType: r.paper_type || '',
    dpi: Number(r.dpi) || 203,
    columns: Number(r.columns) || 1,
    price: Number(r.price) || 0,
    author: r.author || '',
    thumbnailUrl: r.thumbnail_url || '',
    fileSha256: r.file_sha256 || '',
    fileSize: Number(r.file_size) || 0,
    version: Number(r.version) || 1,
    status: r.status,
    downloads: Number(r.downloads) || 0,
    createdAt: Date.parse(r.created_at) || 0,
    updatedAt: Date.parse(r.updated_at) || 0,
  };
}

/** 后台用：额外带文件路径信息（仅管理员可见），但仍不生成任何可访问 URL。 */
function adminTemplate(r) {
  if (!r) return null;
  return {
    ...publicTemplate(r),
    hasFile: !!r.file_path,
    fileName: r.file_path || '',
    filePath: r.file_path || '',
    source: r.source || 'admin',
    externalId: r.external_id || '',
    apiKeyId: Number(r.api_key_id) || 0,
  };
}

const SORTS = {
  downloads_desc: { col: 'downloads', dir: 'DESC' },
  newest: { col: 'created_at', dir: 'DESC' },
  price_asc: { col: 'price', dir: 'ASC' },
  price_desc: { col: 'price', dir: 'DESC' },
};

function fingerprint(args) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([
      args.industry, args.paperType, args.widthMm, args.heightMm,
      String(args.q || '').toLowerCase(), !!args.mine, Number(args.userId) || 0,
    ]))
    .digest('hex').slice(0, 16);
}

function cursorMac(b64) {
  return crypto.createHmac('sha256', getMasterKey()).update('market-cursor:' + b64).digest('base64url').slice(0, 22);
}

function encodeCursor(obj) {
  const b64 = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return `${b64}.${cursorMac(b64)}`;
}

function decodeCursor(raw, sort, fp) {
  const parts = String(raw || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expect = cursorMac(parts[0]);
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let o;
  try { o = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
  if (!o || o.s !== sort || o.f !== fp) return null; // 换排序/换筛选后旧游标一律作废
  if (!(typeof o.i === 'string') || !(typeof o.k === 'string' || typeof o.k === 'number')) return null;
  return o;
}

/**
 * 游标分页：ORDER BY (sortKey, id) + WHERE (sortKey,id) 严格大于/小于上一页末条。
 * id 一律 ASC 作第二排序键，避免「排序键相同」时漏项/重复。
 * 游标带排序与筛选指纹的 MAC，客户端改筛选后拿旧游标会被拒绝（回 400），
 * 而不是悄悄返回错页。
 */
function list(args) {
  const sort = SORTS[args.sort] ? args.sort : 'downloads_desc';
  const def = SORTS[sort];
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(args.limit) || 50)));
  const fp = fingerprint(args);
  let cur = null;
  if (args.cursor) {
    cur = decodeCursor(args.cursor, sort, fp);
    if (!cur) return { error: '游标无效或与筛选条件不匹配，请从第一页重新拉取', code: 'CURSOR_INVALID', status: 400 };
  }

  const where = ["status = 'on'"];
  const p = {};
  if (args.industry) { where.push('industry = @industry'); p.industry = String(args.industry).slice(0, 40); }
  if (args.paperType) { where.push('paper_type = @paperType'); p.paperType = String(args.paperType).slice(0, 40); }
  if (args.widthMm !== undefined && args.widthMm !== '' && args.widthMm !== null) {
    where.push('width_mm = @widthMm'); p.widthMm = Number(args.widthMm);
  }
  if (args.heightMm !== undefined && args.heightMm !== '' && args.heightMm !== null) {
    where.push('height_mm = @heightMm'); p.heightMm = Number(args.heightMm);
  }
  if (args.q) {
    // instr 比 LIKE 省事：不用转义 % _，也不会被通配符改变语义
    where.push('(instr(lower(name), lower(@q)) > 0 OR instr(lower(description), lower(@q)) > 0 OR instr(lower(tags), lower(@q)) > 0)');
    p.q = String(args.q).slice(0, 80);
  }
  if (args.mine) {
    where.push('id IN (SELECT template_id FROM market_purchases WHERE user_id = @userId)');
    p.userId = Number(args.userId) || 0;
  }
  if (cur) {
    where.push(`(${def.col} ${def.dir === 'DESC' ? '<' : '>'} @k OR (${def.col} = @k AND id > @i))`);
    p.k = cur.k;
    p.i = cur.i;
  }
  const sql = `SELECT * FROM market_templates WHERE ${where.join(' AND ')}
    ORDER BY ${def.col} ${def.dir}, id ASC LIMIT ${limit + 1}`;
  const rows = db.prepare(sql).all(p);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const keyOf = (r) => (def.col === 'created_at' ? r.created_at : Number(r[def.col]) || 0);
  return {
    items: page.map(publicTemplate),
    nextCursor: hasMore && last ? encodeCursor({ s: sort, f: fp, k: keyOf(last), i: last.id }) : null,
    hasMore,
    sort,
    limit,
  };
}

function detail(id) {
  const r = db.prepare("SELECT * FROM market_templates WHERE id = ? AND status = 'on'").get(String(id || ''));
  if (!r) return { error: '模板不存在或已下架', code: 'TEMPLATE_NOT_FOUND', status: 404 };
  return { item: publicTemplate(r) };
}

function ownedIds(userId) {
  return db.prepare('SELECT template_id FROM market_purchases WHERE user_id = ? ORDER BY purchased_at DESC, id DESC')
    .all(Number(userId) || 0).map((r) => r.template_id);
}

/* ---------------------------------------------------------------- 短链 */

function signLink(payloadB64) {
  return crypto.createHmac('sha256', getMasterKey()).update('market-link:' + payloadB64).digest('base64url');
}

function issueLink(tpl, userId, machineCode) {
  const jti = crypto.randomBytes(12).toString('base64url');
  const ttl = linkTtl();
  const expMs = Date.now() + ttl * 1000;
  const expiresAt = new Date(expMs).toISOString();
  db.prepare(`INSERT INTO market_download_links (jti, template_id, user_id, machine_code, expires_at, used_at, created_at)
    VALUES (?,?,?,?,?,'',?)`).run(jti, tpl.id, Number(userId) || 0, String(machineCode || ''), expiresAt, now());
  // 下载量 = 成功签发下载凭证的次数；已购重复下载也累加（2026-11-13 用户拍板）。
  // 按 downloads 排序时这个键会变，翻页可能有轻微抖动，属于已知取舍。
  db.prepare('UPDATE market_templates SET downloads = downloads + 1 WHERE id = ?').run(tpl.id);
  const payload = Buffer.from(JSON.stringify({ j: jti, t: tpl.id, u: Number(userId) || 0, m: String(machineCode || ''), e: expMs }), 'utf8')
    .toString('base64url');
  return { token: `${payload}.${signLink(payload)}`, jti, expiresIn: ttl, expiresAt };
}

function verifyLink(raw) {
  const parts = String(raw || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { code: 'LINK_INVALID', status: 400 };
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(signLink(parts[0]));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { code: 'LINK_INVALID', status: 400 };
  let p;
  try { p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return { code: 'LINK_INVALID', status: 400 }; }
  if (!p || !p.j || !p.t || !p.u || !Number(p.e)) return { code: 'LINK_INVALID', status: 400 };
  if (Number(p.e) < Date.now()) return { code: 'LINK_EXPIRED', status: 410 };
  const row = db.prepare('SELECT * FROM market_download_links WHERE jti = ?').get(p.j);
  if (!row) return { code: 'LINK_NOT_FOUND', status: 404 };
  if (row.used_at) return { code: 'LINK_USED', status: 410 };
  if (new Date(row.expires_at).getTime() < Date.now()) return { code: 'LINK_EXPIRED', status: 410 };
  if (row.template_id !== p.t || Number(row.user_id) !== Number(p.u) || String(row.machine_code) !== String(p.m || '')) {
    return { code: 'LINK_INVALID', status: 400 };
  }
  return { ok: true, row: { ...row, payload: p } };
}

/** 抢占式消费：并发请求里只有一个能把 used_at 从空写上有值。 */
function consumeLink(jti) {
  return db.prepare("UPDATE market_download_links SET used_at = ? WHERE jti = ? AND used_at = ''").run(now(), jti).changes === 1;
}

function fileAbs(tpl) {
  const name = String((tpl && tpl.file_path) || '');
  // 只允许纯文件名，防目录穿越（后台上传生成的名字形如 tpl_mkt_xxx.blls）
  if (!name || name !== path.basename(name) || /[\\/]/.test(name)) return '';
  return path.join(ROOT, name);
}

/* ---------------------------------------------------------------- 兑换 */

/**
 * 兑换：单事务。已购直接重签一张新短链，不扣分。
 * 返回 { ok:true, ... } 或 { status, code, error }，由路由决定 HTTP 状态。
 */
function redeem({ userId, machineCode, templateId }) {
  return db.transaction(() => {
    const tpl = db.prepare('SELECT * FROM market_templates WHERE id = ?').get(String(templateId || ''));
    if (!tpl) return { status: 404, code: 'TEMPLATE_NOT_FOUND', error: '模板不存在' };
    if (tpl.status !== 'on') return { status: 403, code: 'TEMPLATE_OFFLINE', error: '模板已下架' };
    if (!fileAbs(tpl) || !fs.existsSync(fileAbs(tpl))) {
      // 先查文件再扣分：后台传错文件/换服务器漏迁目录时，不能出现「扣了分没发货」
      return { status: 409, code: 'TEMPLATE_FILE_MISSING', error: '模板文件暂不可用，请联系客服' };
    }
    const owned = db.prepare('SELECT * FROM market_purchases WHERE user_id = ? AND template_id = ?')
      .get(Number(userId), tpl.id);
    const price = Math.max(0, Math.trunc(Number(tpl.price) || 0));
    let orderId;
    let balance;
    let already = false;
    if (owned) {
      orderId = owned.order_id;
      balance = pointsLib.balance(userId);
      already = true;
    } else {
      // 条件扣分：并发两个请求时第二个 changes=0，不会扣成负数
      if (price > 0) {
        balance = pointsLib.spend(userId, price, `${pointsLib.REDEEM_REASON}：${tpl.name}`);
        if (balance === null) return { status: 402, code: 'INSUFFICIENT_CREDITS', error: '积分不足', balance: pointsLib.balance(userId) };
      } else {
        balance = pointsLib.balance(userId);
      }
      orderId = `MT${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      db.prepare(`INSERT INTO market_purchases (user_id, template_id, order_id, machine_code, price, purchased_at)
        VALUES (?,?,?,?,?,?)`).run(Number(userId), tpl.id, orderId, String(machineCode || ''), price, now());
    }
    const link = issueLink(tpl, userId, machineCode);
    return {
      ok: true, already, orderId, balance,
      name: tpl.name,
      fileSha256: tpl.file_sha256 || '',
      fileSize: Number(tpl.file_size) || 0,
      version: Number(tpl.version) || 1,
      price,
      token: link.token,
      expiresIn: link.expiresIn,
      expiresAt: link.expiresAt,
    };
  })();
}

/* ---------------------------------------------------------------- 后台 CRUD */

const TEXT_FIELDS = ['name', 'industry', 'description', 'paper_type', 'author', 'thumbnail_url'];
const NUM_FIELDS = ['width_mm', 'height_mm', 'dpi', 'columns', 'price', 'version'];

function normalize(body, base = {}) {
  const out = {};
  for (const f of TEXT_FIELDS) {
    if (body[f] !== undefined) {
      out[f] = String(body[f] == null ? '' : body[f]).trim()
        .slice(0, f === 'description' ? 500 : f === 'thumbnail_url' ? 300 : 200);
    }
  }
  for (const f of NUM_FIELDS) {
    if (body[f] !== undefined) out[f] = Math.max(0, Math.trunc(Number(body[f]) || 0));
  }
  if (body.tags !== undefined) {
    const arr = Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(/[,，\s]+/);
    out.tags = JSON.stringify([...new Set(arr.map((x) => String(x).trim()).filter(Boolean))].slice(0, 20).map((s) => s.slice(0, 30)));
  }
  if (body.status !== undefined) out.status = body.status === 'off' ? 'off' : 'on';
  if (base.id && !out.name) out.name = base.name; // name 必填，编辑时不许清空
  return out;
}

/**
 * strictDict 只给 API 上架通道用：机器批量灌数据时，行业/纸型写成字典外的值
 * 会让客户端筛选栏出现「永远筛不出东西」的幽灵选项。后台人工通道保持宽松，
 * 运营改了字典后老模板还能保存（否则历史数据一律编辑不了）。
 */
function validate(data, { strictDict = false } = {}) {
  if (!data.name) return '模板名不能为空';
  if (data.price !== undefined && !Number.isFinite(Number(data.price))) return '积分价格必须是数字';
  if (data.dpi !== undefined && !DPI_ALLOWED.includes(Number(data.dpi))) {
    return `dpi 只支持 ${DPI_ALLOWED.join(' / ')}`;
  }
  if (strictDict) {
    const o = options();
    if (data.industry && !o.industries.includes(data.industry)) {
      return `industry「${data.industry}」不在字典中，请先到「LabelGo模板字典」添加`;
    }
    if (data.paper_type && !o.paper_types.includes(data.paper_type)) {
      return `paperType「${data.paper_type}」不在字典中，请先到「LabelGo模板字典」添加`;
    }
  }
  return '';
}

function createTemplate(body) {
  const data = normalize(body || {});
  const bad = validate(data);
  if (bad) return { error: bad, code: 'PARAM_INVALID' };
  const id = `tpl_mkt_${crypto.randomBytes(7).toString('hex')}`;
  const t = now();
  const row = {
    id, name: data.name || '',
    industry: data.industry || '', description: data.description || '', tags: data.tags || '[]',
    width_mm: data.width_mm || 0, height_mm: data.height_mm || 0,
    paper_type: data.paper_type || '', dpi: data.dpi || 203, columns: data.columns || 1,
    price: data.price || 0, author: data.author || '', thumbnail_url: data.thumbnail_url || '',
    status: data.status || 'on', version: 1, downloads: 0,
    file_path: '', file_sha256: '', file_size: 0, created_at: t, updated_at: t,
  };
  db.prepare(`INSERT INTO market_templates
    (id,name,industry,description,tags,width_mm,height_mm,paper_type,dpi,columns,price,author,
     thumbnail_url,status,version,downloads,file_path,file_sha256,file_size,created_at,updated_at)
    VALUES (@id,@name,@industry,@description,@tags,@width_mm,@height_mm,@paper_type,@dpi,@columns,
     @price,@author,@thumbnail_url,@status,@version,@downloads,@file_path,@file_sha256,@file_size,
     @created_at,@updated_at)`).run(row);
  return { row };
}

function updateTemplate(id, body) {
  const old = db.prepare('SELECT * FROM market_templates WHERE id = ?').get(String(id || ''));
  if (!old) return { error: '模板不存在', code: 'TEMPLATE_NOT_FOUND' };
  const data = normalize(body || {}, old);
  const bad = validate(data);
  if (bad) return { error: bad, code: 'PARAM_INVALID' };
  const keys = Object.keys(data);
  const sets = keys.map((k) => `${k} = @${k}`);
  // 每次编辑都推进 version：客户端可据此判断本地缓存的模板元信息是否过时
  sets.push('version = version + 1', 'updated_at = @updated_at');
  const params = { ...data, updated_at: now(), id: old.id };
  db.prepare(`UPDATE market_templates SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return { row: db.prepare('SELECT * FROM market_templates WHERE id = ?').get(old.id) };
}

/** 覆盖 .blls：先写 tmp 再 rename，避免上传中断留下半个文件被签出去。 */
function replaceFile(id, filename, buffer) {
  const tpl = db.prepare('SELECT * FROM market_templates WHERE id = ?').get(String(id || ''));
  if (!tpl) return { error: '模板不存在', code: 'TEMPLATE_NOT_FOUND' };
  if (path.extname(String(filename || '')).toLowerCase() !== '.blls') {
    return { error: '模板文件必须是 .blls', code: 'FILE_TYPE_INVALID' };
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (!buf.length) return { error: '文件为空', code: 'FILE_EMPTY' };
  if (buf.length > 64 * 1024 * 1024) return { error: '文件超过 64MB', code: 'FILE_TOO_LARGE' };
  const name = `${tpl.id}.blls`;
  const tmp = path.join(ROOT, `.${name}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, path.join(ROOT, name));
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  db.prepare('UPDATE market_templates SET file_path = ?, file_sha256 = ?, file_size = ?, version = version + 1, updated_at = ? WHERE id = ?')
    .run(name, sha, buf.length, now(), tpl.id);
  // 旧文件若因为历史原因用了别的名字，顺手清掉
  if (tpl.file_path && tpl.file_path !== name && tpl.file_path === path.basename(tpl.file_path)) {
    try { fs.rmSync(path.join(ROOT, tpl.file_path), { force: true }); } catch { /* ignore */ }
  }
  return { fileSha256: sha, fileSize: buf.length, fileName: name };
}

function deleteTemplate(id) {
  const tpl = db.prepare('SELECT * FROM market_templates WHERE id = ?').get(String(id || ''));
  if (!tpl) return { error: '模板不存在', code: 'TEMPLATE_NOT_FOUND' };
  const bought = db.prepare('SELECT COUNT(*) AS c FROM market_purchases WHERE template_id = ?').get(tpl.id).c;
  if (bought) return { error: `已有 ${bought} 位用户兑换，不能删除；请改为「下架」`, code: 'TEMPLATE_HAS_PURCHASES' };
  db.prepare('DELETE FROM market_templates WHERE id = ?').run(tpl.id);
  const f = fileAbs(tpl);
  if (f) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  return { ok: true };
}

function stats() {
  const t = db.prepare("SELECT COUNT(*) AS c, SUM(CASE WHEN status='on' THEN 1 ELSE 0 END) AS on_c, COALESCE(SUM(downloads),0) AS dl FROM market_templates").get();
  const p = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(price),0) AS pts FROM market_purchases').get();
  const l = db.prepare('SELECT COUNT(*) AS c FROM market_download_links').get();
  const pending = db.prepare("SELECT COUNT(*) AS c FROM market_templates WHERE source='api' AND status='off'").get();
  return {
    templates: t.c, online: t.on_c || 0, downloads: t.dl,
    purchases: p.c, pointsSpent: p.pts, links: l.c,
    apiPending: pending.c,
  };
}

function recentPurchases(limit = 50) {
  return db.prepare(`SELECT p.*, t.name AS template_name, u.nickname AS user_name
    FROM market_purchases p
    LEFT JOIN market_templates t ON t.id = p.template_id
    LEFT JOIN users u ON u.id = p.user_id
    ORDER BY p.id DESC LIMIT ?`).all(Math.min(200, Math.max(1, Number(limit) || 50)));
}

function adminList(q = '') {
  const sql = q
    ? 'SELECT * FROM market_templates WHERE instr(lower(name), lower(?)) > 0 OR instr(lower(id), lower(?)) > 0 ORDER BY created_at DESC, id DESC LIMIT 300'
    : 'SELECT * FROM market_templates ORDER BY created_at DESC, id DESC LIMIT 300';
  const rows = q ? db.prepare(sql).all(q, q) : db.prepare(sql).all();
  return rows.map(adminTemplate);
}

/* ---------------------------------------------------------------- API 上架 */
/*
 * 为什么不用现成的后台 CRUD：
 *  - 管理员 JWT 12h 过期、等于全后台权限、不能单独吊销、审计只能记到人；
 *  - 没有幂等键，脚本超时重试会重复建模板；
 *  - 没有来源/审核概念，第三方拿到凭据就能直接对外上架；
 *  - 不校验字典，批量灌入会污染客户端筛选栏。
 * 这条通道的边界：独立密钥（hash 入库）+ external_id 幂等 + 默认待审 +
 * 字典强校验 + 文件 sha256 比对 + 调用日志。删除/下架仍只在后台，脚本碰不到。
 */
const MAX_BLLS = 64 * 1024 * 1024;

function apiKeyHash(raw) {
  return crypto.createHash('sha256').update(String(raw || ''), 'utf8').digest('hex');
}

function genApiKey() {
  return 'mkt_' + crypto.randomBytes(24).toString('base64url');
}

function createApiKey({ name, autoPublish = 0, createdBy = '' }) {
  const raw = genApiKey();
  const t = now();
  const r = db.prepare(`INSERT INTO market_api_keys
    (name, key_prefix, key_hash, auto_publish, status, last_used_at, created_by, created_at)
    VALUES (?,?,?,?,'active','',?,?)`)
    .run(String(name || '未命名密钥').trim().slice(0, 60), raw.slice(0, 12), apiKeyHash(raw),
      autoPublish ? 1 : 0, String(createdBy || ''), t);
  return {
    id: Number(r.lastInsertRowid), name: String(name || '未命名密钥'),
    keyPrefix: raw.slice(0, 12), plainKey: raw, autoPublish: autoPublish ? 1 : 0,
  };
}

/** 明文只在创建时返回一次；这里只按 hash 查。状态由路由判断，好区分「无效」与「已停用」。 */
function findApiKey(raw) {
  if (!raw) return null;
  return db.prepare('SELECT * FROM market_api_keys WHERE key_hash = ?').get(apiKeyHash(raw)) || null;
}

function listApiKeys() {
  return db.prepare(`SELECT k.id, k.name, k.key_prefix, k.auto_publish, k.status, k.last_used_at,
      k.created_by, k.created_at,
      (SELECT COUNT(*) FROM market_templates t WHERE t.api_key_id = k.id) AS templates
    FROM market_api_keys k ORDER BY k.id DESC`).all();
}

function setApiKey(id, patch) {
  const old = db.prepare('SELECT * FROM market_api_keys WHERE id = ?').get(Number(id) || 0);
  if (!old) return null;
  const name = patch.name !== undefined ? String(patch.name).trim().slice(0, 60) : old.name;
  const status = patch.status !== undefined ? (patch.status === 'active' ? 'active' : 'disabled') : old.status;
  const autoPublish = patch.autoPublish !== undefined ? (patch.autoPublish ? 1 : 0) : old.auto_publish;
  db.prepare('UPDATE market_api_keys SET name = ?, status = ?, auto_publish = ? WHERE id = ?')
    .run(name || old.name, status, autoPublish, old.id);
  return db.prepare('SELECT * FROM market_api_keys WHERE id = ?').get(old.id);
}

function deleteApiKey(id) {
  return db.prepare('DELETE FROM market_api_keys WHERE id = ?').run(Number(id) || 0).changes === 1;
}

function touchApiKey(id) {
  db.prepare('UPDATE market_api_keys SET last_used_at = ? WHERE id = ?').run(now(), Number(id) || 0);
}

function logApiCall({ keyId = 0, action = '', externalId = '', templateId = '', statusCode = 0, code = '', ip = '', detail = '' }) {
  try {
    db.prepare(`INSERT INTO market_api_logs
      (key_id, action, external_id, template_id, status_code, code, ip, detail, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      Number(keyId) || 0, String(action).slice(0, 40), String(externalId).slice(0, 120),
      String(templateId).slice(0, 80), Number(statusCode) || 0, String(code).slice(0, 60),
      String(ip).slice(0, 64), String(detail).slice(0, 300), now());
  } catch { /* 审计失败不影响主流程 */ }
}

function recentApiLogs(limit = 50) {
  return db.prepare(`SELECT l.*, k.name AS key_name, k.key_prefix
    FROM market_api_logs l LEFT JOIN market_api_keys k ON k.id = l.key_id
    ORDER BY l.id DESC LIMIT ?`).all(Math.min(200, Math.max(1, Number(limit) || 50)));
}

/** API 通道的响应：刻意不含 file_path / fileUrl / downloadUrl。
 *  thumbnailUrl 是公开图片地址（客户端本来就要展示），不属于模板文件路径。 */
function apiTemplate(r) {
  if (!r) return null;
  return {
    id: r.id,
    externalId: r.external_id || '',
    name: r.name,
    status: r.status,
    source: 'api',
    version: Number(r.version) || 1,
    thumbnailUrl: r.thumbnail_url || '',
    fileSha256: r.file_sha256 || '',
    fileSize: Number(r.file_size) || 0,
    hasFile: !!r.file_path,
    createdAt: Date.parse(r.created_at) || 0,
    updatedAt: Date.parse(r.updated_at) || 0,
  };
}

function apiTemplateByExternal(key, externalId) {
  const r = db.prepare("SELECT * FROM market_templates WHERE source='api' AND api_key_id=? AND external_id=?")
    .get(Number(key.id) || 0, String(externalId || ''));
  return apiTemplate(r);
}

/** 把对外 camelCase 契约转成库里 snake_case，只带调用方真正传了的字段。 */
function toSnake(body) {
  const pick = (a, b) => (body[a] !== undefined ? body[a] : body[b]);
  return {
    name: body.name,
    industry: body.industry,
    description: body.description,
    paper_type: pick('paperType', 'paper_type'),
    width_mm: pick('widthMm', 'width_mm'),
    height_mm: pick('heightMm', 'height_mm'),
    dpi: body.dpi,
    columns: body.columns,
    price: body.price,
    author: body.author,
    thumbnail_url: pick('thumbnailUrl', 'thumbnail_url'),
    tags: body.tags,
  };
}

/* ---------------------------- 缩略图（API 上架通道专用） ---------------------------- */

/** 只认真正的图片文件头；扩展名和内容类型都不可信。 */
function sniffImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return '';
}

/** 把声明的文件名归一到允许集；返回 '' 表示不允许或没传。 */
function thumbExtOf(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase().replace(/^\./, '');
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg';
  if (ext === 'png' || ext === 'gif' || ext === 'webp') return ext;
  return '';
}

/**
 * 内容寻址落盘：文件名 = mkt-<内容 sha256 前 20 位>.<实际类型>。
 * 同一张图全局只存一份，重跑幂等或不同模板用同一张封面都不重复写盘；
 * 用户给的文件名完全不参与路径，杜绝 ../ 穿越与覆盖已有上传。
 */
function storeThumbnail(buf, declaredSha) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { error: '缩略图为空', code: 'THUMB_EMPTY' };
  if (buf.length > MAX_THUMB) return { error: '缩略图超过 2MB', code: 'THUMB_TOO_LARGE' };
  const kind = sniffImage(buf);
  if (!kind) {
    return { error: '缩略图不是合法图片（仅支持 png / jpg / webp / gif；SVG、HTML 一律拒收）', code: 'THUMB_TYPE_INVALID' };
  }
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (declaredSha && String(declaredSha).toLowerCase() !== sha) {
    return { error: '缩略图 sha256 与声明不一致', code: 'THUMB_SHA_MISMATCH' };
  }
  const name = `mkt-${sha.slice(0, 20)}.${THUMB_EXT_OF_KIND[kind]}`;
  const target = path.join(THUMB_DIR, name);
  if (!fs.existsSync(target)) {
    // 先写 tmp 再 rename：不要让半张图被 Nginx 直出
    const tmp = path.join(THUMB_DIR, `.${name}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target);
  }
  return { url: `${basePath()}/uploads/${name}`, sha, name };
}

/** 一步式：thumbnailBase64（可带 data:image/...;base64, 前缀）。 */
function decodeThumbnail(body) {
  const raw = body.thumbnailBase64 !== undefined ? body.thumbnailBase64 : body.thumbnail_base64;
  if (raw === undefined || raw === null || raw === '') return { buf: null, provided: false };
  const s = String(raw);
  const m = /^data:image\/([a-z0-9.+-]+);base64,/i.exec(s);
  const payload = m ? s.slice(m[0].length) : s;
  let buf;
  try { buf = Buffer.from(String(payload).replace(/\s+/g, ''), 'base64'); }
  catch { return { error: 'thumbnailBase64 不是合法 base64', code: 'THUMB_INVALID' }; }
  if (!buf.length) return { error: '缩略图为空', code: 'THUMB_EMPTY' };
  if (buf.length > MAX_THUMB) return { error: '缩略图超过 2MB', code: 'THUMB_TOO_LARGE' };
  const kind = sniffImage(buf);
  if (!kind) {
    return { error: '缩略图不是合法图片（仅支持 png / jpg / webp / gif；SVG、HTML 一律拒收）', code: 'THUMB_TYPE_INVALID' };
  }
  // 声明类型（data URI 的 mime 或 thumbnailFilename）必须和文件头一致，
  // 否则「叫 .png 的 SVG」这类混搭会绕过粗心的客户端渲染。
  const declared = m ? thumbExtOf('x.' + m[1].toLowerCase()) : thumbExtOf(body.thumbnailFilename || body.thumbnail_filename);
  if (declared && declared !== THUMB_EXT_OF_KIND[kind]) {
    return { error: `缩略图声明类型「${declared}」与实际内容「${THUMB_EXT_OF_KIND[kind]}」不一致`, code: 'THUMB_TYPE_INVALID' };
  }
  return { buf, provided: true, sha: crypto.createHash('sha256').update(buf).digest('hex') };
}

/** 保留字符串通道给已有 CDN 图片；但拒绝 javascript:/data:/http: 与协议相对 URL。 */
function checkThumbnailUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { url: '' };
  const bad = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https:\/\//i.test(s);
  if (bad || s.startsWith('//') || (!/^https:\/\//i.test(s) && !s.startsWith('/'))) {
    return { error: 'thumbnailUrl 只接受 https:// 绝对地址或站内 / 开头的路径', code: 'THUMB_URL_INVALID' };
  }
  return { url: s.slice(0, 300) };
}

function decodeBlls(body) {
  if (body.fileBase64 === undefined && !body.file) return { buf: null };
  const raw = String(body.fileBase64 || '').replace(/^data:[^,]+,/, '');
  if (!raw) return { error: 'fileBase64 为空', code: 'FILE_REQUIRED' };
  let buf;
  try { buf = Buffer.from(raw, 'base64'); } catch { return { error: 'fileBase64 不是合法 base64', code: 'FILE_INVALID' }; }
  if (!buf.length) return { error: '文件为空', code: 'FILE_EMPTY' };
  if (buf.length > MAX_BLLS) return { error: '文件超过 64MB', code: 'FILE_TOO_LARGE' };
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (body.fileSha256 && String(body.fileSha256).toLowerCase() !== sha) {
    return { error: '文件 sha256 与声明不一致，可能是传输损坏', code: 'FILE_SHA_MISMATCH' };
  }
  return { buf, sha };
}

/**
 * 上架（创建或幂等更新）。
 * 幂等：同 (key, externalId) 重复提交不新建；内容没变时 no-op，version 也不动。
 * 安全：已存在模板的 status 一律保留 —— 运营人工下架后，脚本重跑不能偷偷推上线。
 */
function publishTemplate({ key, body }) {
  const externalId = String(body.externalId || body.external_id || '').trim().slice(0, 120);
  if (!externalId) return { status: 400, code: 'EXTERNAL_ID_REQUIRED', error: 'externalId 必填，它同时是幂等键' };
  const data = normalize(toSnake(body));
  const bad = validate(data, { strictDict: true });
  if (bad) return { status: 400, code: 'PARAM_INVALID', error: bad };
  if (!(data.width_mm > 0) || !(data.height_mm > 0)) {
    return { status: 400, code: 'PARAM_INVALID', error: 'widthMm / heightMm 必须大于 0（客户端按精确尺寸筛选）' };
  }
  const file = decodeBlls(body);
  if (file.error) return { status: 400, code: file.code, error: file.error };
  const thumb = decodeThumbnail(body);
  if (thumb.error) return { status: 400, code: thumb.code, error: thumb.error };
  // 缩略图单独走「增量」语义：一个缩略图字段都没带时保留旧值。否则脚本
  // 「两步式传完封面 → 重跑一次元数据」会把刚传的图清空。
  // 显式传 thumbnailUrl:'' 才是清空。
  const thumbProvided = thumb.provided
    || body.thumbnailUrl !== undefined || body.thumbnail_url !== undefined;
  let thumbUrl = '';
  if (thumb.provided) {
    const stored = storeThumbnail(thumb.buf, body.thumbnailSha256 || body.thumbnail_sha256);
    if (stored.error) return { status: 400, code: stored.code, error: stored.error };
    thumbUrl = stored.url;
  } else if (thumbProvided) {
    const checked = checkThumbnailUrl(body.thumbnailUrl !== undefined ? body.thumbnailUrl : body.thumbnail_url);
    if (checked.error) return { status: 400, code: checked.code, error: checked.error };
    thumbUrl = checked.url;
  }

  const existing = db.prepare("SELECT * FROM market_templates WHERE source='api' AND api_key_id=? AND external_id=?")
    .get(Number(key.id) || 0, externalId);
  const desired = {
    name: data.name || '', industry: data.industry || '', description: data.description || '',
    paper_type: data.paper_type || '', width_mm: data.width_mm || 0, height_mm: data.height_mm || 0,
    dpi: data.dpi || 203, columns: data.columns || 1, price: data.price || 0,
    author: data.author || '',
    thumbnail_url: thumbProvided ? thumbUrl : (existing ? existing.thumbnail_url || '' : ''),
    tags: data.tags || '[]',
  };
  const metaKeys = Object.keys(desired);
  const metaChanged = !existing || metaKeys.some((k) => String(existing[k] ?? '') !== String(desired[k]));
  const fileChanged = !!file.buf && (!existing || existing.file_sha256 !== file.sha);
  if (existing && !metaChanged && !fileChanged) {
    return { ok: true, created: false, changed: false, item: apiTemplate(existing), externalId };
  }

  const tagsArr = safeJson(desired.tags, []);
  try {
    const result = db.transaction(() => {
      let row;
      let created = false;
      if (!existing) {
        const r = createTemplate({ ...desired, tags: tagsArr, status: key.auto_publish ? 'on' : 'off' });
        if (r.error) throw Object.assign(new Error(r.error), { code: r.code });
        row = r.row;
        created = true;
        db.prepare("UPDATE market_templates SET source='api', external_id=?, api_key_id=? WHERE id=?")
          .run(externalId, Number(key.id) || 0, row.id);
        row = db.prepare('SELECT * FROM market_templates WHERE id = ?').get(row.id);
      } else if (metaChanged) {
        const r = updateTemplate(existing.id, { ...desired, tags: tagsArr, status: existing.status });
        if (r.error) throw Object.assign(new Error(r.error), { code: r.code });
        row = r.row;
      } else {
        row = existing;
      }
      if (fileChanged) {
        const r = replaceFile(row.id, 'template.blls', file.buf);
        if (r.error) throw Object.assign(new Error(r.error), { code: r.code });
        row = db.prepare('SELECT * FROM market_templates WHERE id = ?').get(row.id);
      }
      return { row, created };
    })();
    return {
      ok: true, created: result.created, changed: true,
      item: apiTemplate(result.row), externalId,
      // 明确告诉调用方「这次是待审还是已对外」，别让它自己猜 status
      needsReview: result.created && !key.auto_publish,
    };
  } catch (e) {
    return { status: 400, code: e.code || 'PUBLISH_FAILED', error: e.message || '上架失败' };
  }
}

/** 两步式上传大文件：只允许改本密钥自己建的模板，跨密钥直接 403。 */
function apiReplaceFile({ key, id, filename, buffer, declaredSha }) {
  const tpl = db.prepare('SELECT * FROM market_templates WHERE id = ?').get(String(id || ''));
  if (!tpl) return { status: 404, code: 'TEMPLATE_NOT_FOUND', error: '模板不存在' };
  if (tpl.source !== 'api' || Number(tpl.api_key_id) !== Number(key.id)) {
    return { status: 403, code: 'TEMPLATE_FORBIDDEN', error: '该模板不属于当前 API 密钥' };
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (!buf.length) return { status: 400, code: 'FILE_EMPTY', error: '文件为空' };
  if (buf.length > MAX_BLLS) return { status: 400, code: 'FILE_TOO_LARGE', error: '文件超过 64MB' };
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (declaredSha && String(declaredSha).toLowerCase() !== sha) {
    return { status: 400, code: 'FILE_SHA_MISMATCH', error: '文件 sha256 与声明不一致' };
  }
  const r = replaceFile(tpl.id, filename, buf);
  if (r.error) return { status: 400, code: r.code, error: r.error };
  return { ok: true, item: apiTemplate(db.prepare('SELECT * FROM market_templates WHERE id = ?').get(tpl.id)) };
}

/** 两步式上传缩略图：与 /file 同口径的归属校验，但走公开图片的安全规则。 */
function apiReplaceThumbnail({ key, id, filename, buffer, declaredSha }) {
  const tpl = db.prepare('SELECT * FROM market_templates WHERE id = ?').get(String(id || ''));
  if (!tpl) return { status: 404, code: 'TEMPLATE_NOT_FOUND', error: '模板不存在' };
  if (tpl.source !== 'api' || Number(tpl.api_key_id) !== Number(key.id)) {
    return { status: 403, code: 'TEMPLATE_FORBIDDEN', error: '该模板不属于当前 API 密钥' };
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (!buf.length) return { status: 400, code: 'THUMB_EMPTY', error: '缩略图为空' };
  if (buf.length > MAX_THUMB) return { status: 400, code: 'THUMB_TOO_LARGE', error: '缩略图超过 2MB' };
  const kind = sniffImage(buf);
  if (!kind) {
    return { status: 400, code: 'THUMB_TYPE_INVALID', error: '缩略图不是合法图片（仅支持 png / jpg / webp / gif）' };
  }
  const declared = thumbExtOf(filename);
  if (!declared || declared !== THUMB_EXT_OF_KIND[kind]) {
    return { status: 400, code: 'THUMB_TYPE_INVALID', error: `缩略图扩展名与实际内容不符：${declared || '未知'} ≠ ${THUMB_EXT_OF_KIND[kind]}` };
  }
  const stored = storeThumbnail(buf, declaredSha);
  if (stored.error) return { status: 400, code: stored.code, error: stored.error };
  db.prepare('UPDATE market_templates SET thumbnail_url = ?, version = version + 1, updated_at = ? WHERE id = ?')
    .run(stored.url, now(), tpl.id);
  return {
    ok: true, thumbnailUrl: stored.url,
    item: apiTemplate(db.prepare('SELECT * FROM market_templates WHERE id = ?').get(tpl.id)),
  };
}

module.exports = {
  ROOT, fileAbs, linkTtl,
  options, meta, saveOptions, DPI_ALLOWED,
  publicTemplate, adminTemplate, list, detail, ownedIds,
  redeem, verifyLink, consumeLink,
  createTemplate, updateTemplate, replaceFile, deleteTemplate,
  stats, recentPurchases, adminList,
  // API 上架
  createApiKey, findApiKey, listApiKeys, setApiKey, deleteApiKey, touchApiKey,
  logApiCall, recentApiLogs, apiTemplate, apiTemplateByExternal, publishTemplate,
  apiReplaceFile, apiReplaceThumbnail, storeThumbnail, sniffImage, thumbExtOf,
  // 测试用
  encodeCursor, decodeCursor, SORTS,
};

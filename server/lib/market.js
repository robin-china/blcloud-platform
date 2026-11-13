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
const { getSetting } = require('./config');
const { getMasterKey } = require('./crypto');
const pointsLib = require('./points');

const ROOT = process.env.MARKET_DIR
  ? path.resolve(process.env.MARKET_DIR)
  : path.join(__dirname, '..', '..', 'data', 'market');
fs.mkdirSync(ROOT, { recursive: true });

const DEFAULT_LINK_TTL = 300; // 秒

function linkTtl() {
  const v = Math.trunc(Number(getSetting('market_link_ttl_seconds', String(DEFAULT_LINK_TTL))) || DEFAULT_LINK_TTL);
  return Math.min(3600, Math.max(30, v));
}

/* ---------------------------------------------------------------- 枚举字典 */

const DEFAULT_INDUSTRIES = ['制造业', '物流仓储', '零售电商', '食品餐饮', '医疗器械', '固定资产', '化工', '服饰', '其他'];
const DEFAULT_PAPER_TYPES = ['间隙纸', '黑标纸', '连续纸'];

function options() {
  const rows = db.prepare('SELECT * FROM market_options ORDER BY sort ASC, id ASC').all();
  const out = { industries: [], paper_types: [], size_presets: [] };
  for (const r of rows) {
    if (r.kind === 'industry') out.industries.push(r.value);
    else if (r.kind === 'paper_type') out.paper_types.push(r.value);
    else if (r.kind === 'size_preset') {
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
  return out;
}

function meta() {
  const o = options();
  return {
    industries: o.industries,
    paperTypes: o.paper_types,
    sizePresets: o.size_presets,
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
  const t = now();
  const ins = db.prepare('INSERT OR IGNORE INTO market_options (kind, value, sort, created_at) VALUES (?,?,?,?)');
  db.transaction(() => {
    db.prepare('DELETE FROM market_options').run();
    industries.forEach((v, i) => ins.run('industry', v, i * 10, t));
    paperTypes.forEach((v, i) => ins.run('paper_type', v, i * 10, t));
    presets.forEach((v, i) => ins.run('size_preset', JSON.stringify(v), i * 10, t));
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run('market_options_seeded', '1', t);
  })();
  return { industries: industries.length, paperTypes: paperTypes.length, sizePresets: presets.length };
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
    if (body[f] !== undefined) out[f] = String(body[f] == null ? '' : body[f]).trim().slice(0, f === 'description' ? 500 : 200);
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

function validate(data) {
  if (!data.name) return '模板名不能为空';
  if (data.price !== undefined && !Number.isFinite(Number(data.price))) return '积分价格必须是数字';
  if (data.dpi !== undefined && ![203, 300].includes(Number(data.dpi))) return 'dpi 只支持 203 / 300';
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
  return {
    templates: t.c, online: t.on_c || 0, downloads: t.dl,
    purchases: p.c, pointsSpent: p.pts, links: l.c,
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

module.exports = {
  ROOT, fileAbs, linkTtl,
  options, meta, saveOptions,
  publicTemplate, adminTemplate, list, detail, ownedIds,
  redeem, verifyLink, consumeLink,
  createTemplate, updateTemplate, replaceFile, deleteTemplate,
  stats, recentPurchases, adminList,
  // 测试用
  encodeCursor, decodeCursor, SORTS,
};

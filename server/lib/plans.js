/**
 * 套餐档位公共逻辑。
 *
 * 单独成模块是为了避开循环依赖：deliver.js / open.js / portal.js / wechat.js
 * / routes/plans.js 都要读档位，谁都不该去 require 另一个路由文件。
 * 运行时唯一数据源是 plans 表；JSON 只用于导入导出，不参与请求链路。
 *
 * 多产品模型：
 *   products(上架软件商品) ← open_apps.product_id → open_apps.id ← plans.app_id
 *   licenses.app_id / licenses.plan_id 决定这张授权能在哪个软件里激活。
 * app_id 为 NULL 的档位是「通用模板」，只用于复制到具体产品；老数据也是 NULL，
 * 一律按「不限应用」兼容，不能突然把历史用户锁在门外。
 */
const db = require('../db');
const { now, safeJson, genLicenseKey } = require('./util');

const DAY = 86400000;
const BILLING = new Set(['free', 'once', 'period']);

const PLAN_SELECT = `SELECT p.*, a.name AS app_name, a.app_key AS app_key,
  a.product_id AS product_id, pr.name AS product_name, pr.icon AS product_icon
  FROM plans p LEFT JOIN open_apps a ON a.id = p.app_id
  LEFT JOIN products pr ON pr.id = a.product_id`;

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function addDays(days, from = Date.now()) {
  return new Date(from + Number(days || 0) * DAY).toISOString();
}

function shape(row) {
  if (!row) return null;
  return { ...row, features: safeJson(row.features, []) };
}

/** 后台管理用：列全部档位。传 appId 则只列该产品（不回退模板）。 */
function list(onlyActive = false, appId = undefined) {
  const where = [];
  const args = [];
  if (onlyActive) where.push("p.status = 'on'");
  if (appId !== undefined && appId !== null && appId !== '') {
    where.push('p.app_id = ?');
    args.push(Number(appId));
  }
  const sql = `${PLAN_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY IFNULL(p.app_id, 0) ASC, p.tier ASC, p.sort DESC, p.id ASC`;
  return db.prepare(sql).all(...args).map(shape);
}

/**
 * 业务用：取某软件产品可使用的档位。
 * 产品还没配专属档位时回退到通用模板，保证刚接入的产品 / 老应用不会一条档位都查不到。
 * 授权码本身还有 licenses.app_id 兜底，所以「共用模板档位」不等于「码能跨产品通用」。
 */
function listForApp(appId, onlyActive = true) {
  const id = Number(appId) || 0;
  if (id) {
    const own = list(onlyActive, id);
    if (own.length) return own;
  }
  return listTemplates(onlyActive);
}

function listTemplates(onlyActive = false) {
  return db.prepare(`${PLAN_SELECT} WHERE p.app_id IS NULL
    ${onlyActive ? "AND p.status = 'on'" : ''}
    ORDER BY p.tier ASC, p.sort DESC, p.id ASC`).all().map(shape);
}

function get(id) {
  return shape(db.prepare(`${PLAN_SELECT} WHERE p.id = ?`).get(Number(id)));
}

/**
 * 按 code 查档位。带 appId 时优先该产品专属档位，再回退通用模板；
 * 老代码 byCode('free') 仍能查到模板档位，不会破坏历史授权。
 */
function byCode(code, appId = undefined) {
  const c = String(code || '');
  if (appId) {
    const p = shape(db.prepare(`${PLAN_SELECT} WHERE p.app_id = ? AND p.code = ?`).get(Number(appId), c));
    if (p) return p;
  }
  const tpl = shape(db.prepare(`${PLAN_SELECT} WHERE p.app_id IS NULL AND p.code = ?`).get(c));
  if (tpl) return tpl;
  return shape(db.prepare(`${PLAN_SELECT} WHERE p.code = ? ORDER BY (p.app_id IS NULL) DESC, p.id ASC LIMIT 1`).get(c));
}

/** 校验并归一化一条档位。导入与后台表单共用同一套规则。 */
function validate(input, { partial = false } = {}) {
  const b = input || {};
  const errors = [];
  const v = {};
  const need = (k, fallback) => {
    if (b[k] === undefined || b[k] === null || b[k] === '') {
      if (partial) return undefined;
      v[k] = fallback;
      return fallback;
    }
    return b[k];
  };

  const code = need('code', '');
  if (code !== undefined) {
    v.code = String(code).trim().toLowerCase();
    if (!/^[a-z0-9_]{2,32}$/.test(v.code)) errors.push(`code「${v.code}」只允许 2-32 位小写字母/数字/下划线`);
  }
  const name = need('name', '');
  if (name !== undefined) {
    v.name = String(name).trim();
    if (!v.name) errors.push('档位名称不能为空');
  }
  if (b.tier !== undefined || !partial) v.tier = Math.max(0, Math.round(Number(b.tier) || 0));
  const billing = need('billing', 'period');
  if (billing !== undefined) {
    v.billing = String(billing);
    if (!BILLING.has(v.billing)) errors.push(`billing「${v.billing}」必须是 free / once / period`);
  }
  if (b.price !== undefined || !partial) v.price = round2(Math.max(0, Number(b.price) || 0));
  if (b.original_price !== undefined || !partial) v.original_price = round2(Math.max(0, Number(b.original_price) || 0));
  if (b.period_days !== undefined || !partial) v.period_days = Math.max(0, Math.round(Number(b.period_days) || 0));
  if (b.online_required !== undefined || !partial) v.online_required = b.online_required === false || b.online_required === 0 ? 0 : 1;
  if (b.offline_days !== undefined || !partial) v.offline_days = Math.max(0, Math.round(Number(b.offline_days) || 0));
  if (b.max_devices !== undefined || !partial) v.max_devices = Math.max(1, Math.round(Number(b.max_devices) || 1));
  if (b.seats !== undefined || !partial) v.seats = Math.max(1, Math.round(Number(b.seats) || 1));
  if (b.sort !== undefined || !partial) v.sort = Math.round(Number(b.sort) || 0);
  if (b.status !== undefined || !partial) v.status = b.status === 'off' ? 'off' : 'on';
  if (b.app_id !== undefined || !partial) v.app_id = b.app_id ? Number(b.app_id) || null : null;
  if (b.remark !== undefined || !partial) v.remark = String(b.remark || '');
  if (b.features !== undefined || !partial) {
    let f = b.features;
    if (typeof f === 'string') f = f.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(f)) errors.push('features 必须是数组或每行一条的文本');
    else v.features = JSON.stringify(f.map(String));
  }

  if (v.billing === 'free' && v.price > 0) errors.push('免费档价格必须为 0');
  if (v.billing === 'period' && v.period_days < 1) errors.push('周期档 period_days 至少 1 天');
  if (v.billing !== 'period' && v.period_days > 0) v.period_days = 0;
  if (v.online_required === 1 && v.offline_days > 7) {
    errors.push('要求联网的档位 offline_days 不能超过 7 天（长期离线请用「允许离线」档位）');
  }
  // 档位必须挂在真实存在的应用上，否则下单和激活会指向一个不存在的产品
  if (v.app_id) {
    const a = db.prepare('SELECT id FROM open_apps WHERE id = ?').get(v.app_id);
    if (!a) errors.push(`所属软件产品不存在（app_id=${v.app_id}）`);
  }
  return { ok: errors.length === 0, errors, value: v };
}

/** 同一 code 在不同产品下允许重复；NULL 模板用 IFNULL 归一成 0 参与唯一性比较。 */
function findInScope(code, appId) {
  return db.prepare('SELECT id FROM plans WHERE code = ? AND IFNULL(app_id,0) = IFNULL(?,0)')
    .get(String(code || ''), appId || null);
}

function insert(input, by = 'admin') {
  const r = validate(input);
  if (!r.ok) return r;
  const v = r.value;
  if (findInScope(v.code, v.app_id)) {
    return { ok: false, errors: [`档位 code「${v.code}」在该软件产品下已存在`] };
  }
  const info = db.prepare(`INSERT INTO plans
    (app_id, code, name, tier, billing, price, original_price, period_days, online_required,
     offline_days, max_devices, seats, features, status, sort, remark, created_at, updated_at)
    VALUES (@app_id,@code,@name,@tier,@billing,@price,@original_price,@period_days,@online_required,
      @offline_days,@max_devices,@seats,@features,@status,@sort,@remark,@t,@t)`)
    .run({ ...v, t: now() });
  return { ok: true, id: info.lastInsertRowid, plan: get(info.lastInsertRowid), by };
}

function update(id, input) {
  const cur = get(id);
  if (!cur) return { ok: false, errors: ['档位不存在'] };
  const merged = { ...cur, ...input };
  const r = validate(merged);
  if (!r.ok) return r;
  const v = r.value;
  const dup = db.prepare('SELECT id FROM plans WHERE code = ? AND IFNULL(app_id,0) = IFNULL(?,0) AND id <> ?')
    .get(v.code, v.app_id, Number(id));
  if (dup) return { ok: false, errors: [`档位 code「${v.code}」在该软件产品下已存在`] };
  db.prepare(`UPDATE plans SET app_id=@app_id, code=@code, name=@name, tier=@tier, billing=@billing,
    price=@price, original_price=@original_price, period_days=@period_days,
    online_required=@online_required, offline_days=@offline_days, max_devices=@max_devices,
    seats=@seats, features=@features, status=@status, sort=@sort, remark=@remark, updated_at=@t
    WHERE id=@id`)
    .run({ ...v, id: Number(id), t: now() });
  return { ok: true, plan: get(id) };
}

/** 后台下拉：软件端应用 + 其绑定的上架商品 + 已配档位数 */
function listApps() {
  return db.prepare(`SELECT a.id, a.name, a.app_key, a.status, a.product_id,
    p.name AS product_name, p.type AS product_type,
    (SELECT COUNT(*) FROM plans pl WHERE pl.app_id = a.id) AS plan_count
    FROM open_apps a LEFT JOIN products p ON p.id = a.product_id
    ORDER BY a.id DESC`).all();
}

/**
 * 把通用模板档位复制一份到指定产品。
 * 管理员新上架软件时不必把五档重填一遍；已存在的 code 跳过，不覆盖已调好的价格。
 */
function copyTemplateToApp(appId) {
  const id = Number(appId) || 0;
  if (!id) return { ok: false, errors: ['请指定软件产品'] };
  const app = db.prepare('SELECT id FROM open_apps WHERE id = ?').get(id);
  if (!app) return { ok: false, errors: ['软件产品不存在'] };
  let created = 0;
  let skipped = 0;
  for (const t of listTemplates(false)) {
    if (findInScope(t.code, id)) { skipped += 1; continue; }
    const { id: _id, app_id: _appId, app_name: _an, app_key: _ak, product_id: _pid,
      product_name: _pn, product_icon: _pi, created_at: _ca, updated_at: _ua, ...input } = t;
    const res = insert({ ...input, app_id: id });
    if (!res.ok) return { ok: false, errors: res.errors };
    created += 1;
  }
  return { ok: true, created, skipped };
}

/** 导出为可纳入版本管理的配置。不含 id / created_at 等运行时字段。 */
function exportConfig(appId = undefined) {
  const rows = appId ? list(false, appId) : list(false);
  const app = appId ? db.prepare('SELECT id, name, app_key FROM open_apps WHERE id = ?').get(Number(appId)) : null;
  return {
    schema: 1,
    exported_at: now(),
    // 用 app_key 定位而不是 id：换库 / 重建后 id 会变，app_key 是稳定标识
    app: app ? { app_key: app.app_key, name: app.name } : null,
    upgrade: { allow_downgrade: false, proration: 'remaining_days' },
    plans: rows.map((p) => ({
      app_id: p.app_id || null,
      app_key: p.app_key || null,
      code: p.code, name: p.name, tier: p.tier, billing: p.billing,
      price: p.price, original_price: p.original_price, period_days: p.period_days,
      online_required: p.online_required, offline_days: p.offline_days,
      max_devices: p.max_devices, seats: p.seats, features: p.features,
      status: p.status, sort: p.sort, remark: p.remark || '',
    })),
  };
}

function appIdByKey(key) {
  if (!key) return null;
  const a = db.prepare('SELECT id FROM open_apps WHERE app_key = ?').get(String(key));
  return a ? a.id : null;
}

/**
 * 导入：按 (app_id, code) 新增/更新，不删除配置里没出现的档位。
 * 删档位很危险（已售授权还引用着它），必须由管理员在表单里显式操作。
 */
function importConfig(cfg) {
  const arr = Array.isArray(cfg) ? cfg : (cfg && Array.isArray(cfg.plans) ? cfg.plans : null);
  if (!arr) return { ok: false, errors: ['配置格式错误：需要 { plans: [...] } 或直接是数组'] };
  const errors = [];
  const scope = cfg && !Array.isArray(cfg) ? cfg : {};
  const scopeKey = (scope.app && scope.app.app_key) || null;
  // 导入时若显式指定目标产品（cfg.app / cfg.app_id），整份配置都落到该产品：
  // 这样「导出通用模板 → 选产品导入」就是复制一套档位，而不是又写回通用模板。
  const forceId = scope.app_id ? Number(scope.app_id) : appIdByKey(scopeKey);
  let created = 0;
  let updated = 0;
  for (let i = 0; i < arr.length; i++) {
    const item = { ...arr[i] };
    if (forceId) {
      item.app_id = forceId;
      delete item.app_key;
    } else if (item.app_key && !item.app_id) {
      const id = appIdByKey(item.app_key);
      if (!id) { errors.push(`第 ${i + 1} 档：app_key「${item.app_key}」在本系统不存在`); continue; }
      item.app_id = id;
      delete item.app_key;
    }
    const r = validate(item);
    if (!r.ok) { errors.push(`第 ${i + 1} 档：${r.errors.join('；')}`); continue; }
    const exists = findInScope(r.value.code, r.value.app_id);
    const res = exists ? update(exists.id, r.value) : insert(r.value);
    if (!res.ok) errors.push(`第 ${i + 1} 档：${(res.errors || []).join('；')}`);
    else if (exists) updated += 1;
    else created += 1;
  }
  return { ok: errors.length === 0, errors, created, updated };
}

/**
 * 取一张授权对应的档位。老数据没有 plan_id/plan_code 时按 license.type 兜底，
 * 避免历史授权在升级到套餐体系后突然查不到权益。
 */
function licensePlan(lic) {
  if (!lic) return null;
  if (lic.plan_id) {
    const p = get(lic.plan_id);
    if (p) return p;
  }
  if (lic.plan_code) {
    const p = byCode(lic.plan_code, lic.app_id);
    if (p) return p;
  }
  // 历史商品授权 / 卡密池码没有档位，不能擅自当成免费档：
  // 它们的离线宽限要继续走 open_apps.offline_days（后台「离线宽限」）。
  return null;
}

/**
 * 这张授权能不能在指定软件产品里激活。
 * 三层校验：授权自身归属、档位归属、老商品授权按 product_id 匹配。
 * app_id 为 NULL 一律视为「不限应用」，兼容升级前发出的老码。
 */
function licenseMatchesApp(lic, appRow) {
  if (!lic || !appRow) return true;
  if (lic.app_id && Number(lic.app_id) !== Number(appRow.id)) return false;
  const p = licensePlan(lic);
  if (p && p.app_id && Number(p.app_id) !== Number(appRow.id)) return false;
  if (appRow.product_id && Number(lic.product_id) > 0 && Number(lic.product_id) !== Number(appRow.product_id)) return false;
  return true;
}

/** 客户端可见的权益描述（会进离线票据，必须短且稳定） */
function licenseEntitlement(lic) {
  const p = licensePlan(lic);
  if (!p) return {
    plan_code: String(lic.plan_code || lic.type || ''), features: [], seats: 1, offline_days: 0,
    app_id: lic.app_id || null,
  };
  return {
    plan_code: p.code,
    plan_name: p.name,
    tier: p.tier,
    features: p.features,
    seats: p.seats,
    offline_days: p.offline_days,
    online_required: p.online_required,
    app_id: p.app_id || lic.app_id || null,
    product_id: p.product_id || null,
    product_name: p.product_name || '',
  };
}

function freePlanFor(appId) {
  if (appId) {
    const own = db.prepare("SELECT * FROM plans WHERE app_id = ? AND billing = 'free' AND status = 'on' ORDER BY tier ASC, id ASC LIMIT 1")
      .get(Number(appId));
    if (own) return own;
  }
  return db.prepare("SELECT * FROM plans WHERE app_id IS NULL AND billing = 'free' AND status = 'on' ORDER BY tier ASC, id ASC LIMIT 1").get();
}

/**
 * 给新用户发一张免费档授权码。
 *
 * 为什么要发码：/api/open/v1/auth/activate 强制要 license_key，
 * 免费用户若没有授权码根本登不进软件端；与其给扫码登录开特例分支，
 * 不如让所有档位走同一套 activate / verify / heartbeat / ticket 链路。
 *
 * appId 为空 = 注册兜底，沿用老行为（用户一张授权都没有才发「不限应用」码，老客户端可用）。
 * appId 有值 = 该软件产品专属码，按 (user_id, app_id) 幂等；老通用码不阻止补发，
 * 这样「我的空间」里每个产品都能有自己独立、可单独升级的授权。
 */
function ensureFreeLicense(userId, appId = null) {
  const free = freePlanFor(appId);
  if (!free) return null;
  const uid = Number(userId);
  if (appId) {
    const exists = db.prepare('SELECT id FROM licenses WHERE user_id = ? AND app_id = ?').get(uid, Number(appId));
    if (exists) return null;
  } else {
    const count = db.prepare('SELECT COUNT(*) AS c FROM licenses WHERE user_id = ?').get(uid).c;
    if (count > 0) return null;
  }
  const ts = now();
  const key = genLicenseKey();
  // product_id 用 0 表示「套餐授权，不绑定具体商品」：schema 里这一列是 NOT NULL，
  // 不能传 NULL；同时 activate 的商品匹配只对 product_id > 0 的老商品授权生效。
  db.prepare(`INSERT INTO licenses
    (license_key, user_id, app_id, product_id, type, max_devices, start_at, end_at, status,
     plan_id, plan_code, remark, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(key, uid, appId ? Number(appId) : null, 0, 'permanent', Number(free.max_devices) || 1,
      ts, null, 'active', free.id, free.code,
      appId ? '按软件产品自动发放免费版' : '注册自动发放免费版', ts);
  return key;
}

module.exports = {
  list, listForApp, listTemplates, listApps, get, byCode, shape, validate,
  insert, update, copyTemplateToApp, importConfig, exportConfig,
  licensePlan, licenseMatchesApp, licenseEntitlement, ensureFreeLicense, freePlanFor,
  addDays, round2,
};

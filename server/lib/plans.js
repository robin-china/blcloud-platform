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
const crypto = require('crypto');
const { now, safeJson, genLicenseKey } = require('./util');

const DAY = 86400000;
const BILLING = new Set(['free', 'once', 'period']);
// 功能码（能力 token）格式：labelgo.concat / basic.view 这类点分小写标识
const TOKEN_RE = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/;

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
  return { ...row, features: safeJson(row.features, []), limits: safeJson(row.limits, {}) };
}

/* ---------------- 功能码白名单 / 数量配额 ---------------- */

/** 某应用登记的功能码表（在「开放接入」维护）。空数组 = 未登记，暂不强校验。 */
function featureSchema(appId) {
  if (!appId) return [];
  const a = db.prepare('SELECT feature_schema FROM open_apps WHERE id = ?').get(Number(appId));
  if (!a) return [];
  const arr = safeJson(a.feature_schema, []);
  const out = [];
  for (const x of Array.isArray(arr) ? arr : []) {
    const item = typeof x === 'string' ? { token: x, label: '' } : x;
    if (item && TOKEN_RE.test(String(item.token || ''))) {
      out.push({ token: String(item.token), label: String(item.label || '').slice(0, 60) });
    }
  }
  return out;
}

/**
 * 归一化功能码表输入：接受 [{token,label}]、JSON 字符串、或每行 `token = 名称` 的文本。
 * 供开放接入表单与导入共用；token 未知格式直接报错，不给「拼错字符静默吞掉」的机会。
 */
function normalizeFeatureSchema(input) {
  if (input === undefined || input === null || input === '') return { value: [] };
  let arr = input;
  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return { value: [] };
    if (s.startsWith('[')) {
      try { arr = JSON.parse(s); } catch { return { error: '功能码表不是合法 JSON 数组' }; }
    } else {
      arr = [];
      for (const line of s.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const i = t.indexOf('=');
        arr.push(i > 0 ? { token: t.slice(0, i).trim(), label: t.slice(i + 1).trim() } : { token: t, label: '' });
      }
    }
  }
  if (!Array.isArray(arr)) return { error: '功能码表必须是数组，或每行「token = 名称」' };
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const item = typeof x === 'string' ? { token: x, label: '' } : (x || {});
    const tok = String(item.token || '').trim().toLowerCase();
    if (!tok) continue;
    if (!TOKEN_RE.test(tok)) {
      return { error: `功能码「${tok}」格式不对：小写字母/数字/下划线点分段（如 labelgo.concat）` };
    }
    if (seen.has(tok)) return { error: `功能码「${tok}」重复登记` };
    seen.add(tok);
    out.push({ token: tok, label: String(item.label || '').slice(0, 60) });
  }
  return { value: out };
}

/**
 * 归一化数量配额：接受对象、JSON 字符串、或每行 `key = 数值` 的文本。
 * 值必须是 ≥0 的数字 —— 配额是给客户端做上限判断的，出现字符串就是配置事故。
 */
function normalizeLimits(input) {
  if (input === undefined || input === null || input === '') return { value: {} };
  let obj = input;
  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return { value: {} };
    if (s.startsWith('{')) {
      try { obj = JSON.parse(s); } catch { return { error: 'limits 不是合法 JSON 对象' }; }
    } else {
      obj = {};
      for (const line of s.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const i = t.indexOf('=');
        if (i <= 0) return { error: `limits 行「${t}」格式不对，应为 key = 数值` };
        obj[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      }
    }
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) return { error: 'limits 必须是 key = 数值 结构' };
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = String(k).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.\-]{0,63}$/.test(key)) {
      return { error: `limits 键「${k}」只允许字母/数字/./_/-（≤64 位）` };
    }
    const num = Number(v);
    if (!Number.isFinite(num) || num < 0) return { error: `limits「${key}」的值必须是 ≥0 的数字` };
    out[key] = num;
  }
  return { value: out };
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

/** 发码表单用：某上架商品绑定的接入应用自己的档位（不回退通用模板，避免发错产品） */
function listForProduct(productId, onlyActive = true) {
  const app = db.prepare('SELECT id FROM open_apps WHERE product_id = ? ORDER BY id DESC LIMIT 1')
    .get(Number(productId) || 0);
  return app ? list(onlyActive, app.id) : [];
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
    if (typeof f === 'string') {
      const s = f.trim();
      // update() 会把库里的归一化结果（JSON 字符串）merge 回来再校验一次，
      // 这里必须能认出 JSON 数组形式，否则会被当成「一整行 token」
      if (s.startsWith('[')) {
        try { f = JSON.parse(s); } catch { f = null; }
      } else {
        f = f.split('\n').map((x) => x.trim()).filter(Boolean);
      }
    }
    if (!Array.isArray(f)) errors.push('features 必须是数组或每行一条的文本');
    else {
      const toks = f.map((s) => String(s).trim()).filter(Boolean);
      for (const t of toks) {
        if (!TOKEN_RE.test(t)) {
          errors.push(`功能码「${t}」格式不对：小写字母/数字/下划线点分段（如 labelgo.concat）`);
        }
      }
      // 功能码白名单：登记过功能码表的应用，只接受已登记 token。
      // 之前是自由文本，写错一个字符不报错、客户端静默少一个功能，只能发版补救。
      if (v.app_id) {
        const schema = featureSchema(v.app_id);
        if (schema.length) {
          const known = new Set(schema.map((s) => s.token));
          const unknown = toks.filter((t) => !known.has(t));
          if (unknown.length) {
            errors.push(`未登记的功能码：${unknown.join('、')}（先到「开放接入」登记该应用的功能码表）`);
          }
        }
      }
      v.features = JSON.stringify(toks);
    }
  }
  if (b.limits !== undefined || !partial) {
    const r = normalizeLimits(b.limits === undefined ? {} : b.limits);
    if (r.error) errors.push(r.error);
    else v.limits = JSON.stringify(r.value);
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
     offline_days, max_devices, seats, features, limits, status, sort, remark, created_at, updated_at)
    VALUES (@app_id,@code,@name,@tier,@billing,@price,@original_price,@period_days,@online_required,
      @offline_days,@max_devices,@seats,@features,@limits,@status,@sort,@remark,@t,@t)`)
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
    seats=@seats, features=@features, limits=@limits, status=@status, sort=@sort, remark=@remark, updated_at=@t
    WHERE id=@id`)
    .run({ ...v, id: Number(id), t: now() });
  return { ok: true, plan: get(id) };
}

/** 后台下拉：软件端应用 + 其绑定的上架商品 + 已配档位数 + 功能码表（套餐表单勾选用） */
function listApps() {
  return db.prepare(`SELECT a.id, a.name, a.app_key, a.status, a.product_id, a.feature_schema,
    p.name AS product_name, p.type AS product_type,
    (SELECT COUNT(*) FROM plans pl WHERE pl.app_id = a.id) AS plan_count
    FROM open_apps a LEFT JOIN products p ON p.id = a.product_id
    ORDER BY a.id DESC`).all().map((a) => ({ ...a, feature_schema: safeJson(a.feature_schema, []) }));
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
  // 模板里是 IoT 语义的占位 token（basic.view / sync.cloud…）；
  // 产品登记了自己的功能码表后，占位 token 会被白名单拦下 —— 复制时按词表过滤，
  // 落到产品上的 features 默认为空集，由管理员按产品实际权益勾选。
  const schema = featureSchema(id);
  const known = schema.length ? new Set(schema.map((s) => s.token)) : null;
  for (const t of listTemplates(false)) {
    if (findInScope(t.code, id)) { skipped += 1; continue; }
    const { id: _id, app_id: _appId, app_name: _an, app_key: _ak, product_id: _pid,
      product_name: _pn, product_icon: _pi, created_at: _ca, updated_at: _ua, ...input } = t;
    if (known) input.features = (t.features || []).filter((f) => known.has(f));
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
      max_devices: p.max_devices, seats: p.seats, features: p.features, limits: p.limits,
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
    plan_code: String(lic.plan_code || lic.type || ''), features: [], limits: {}, seats: 1, offline_days: 0,
    app_id: lic.app_id || null,
  };
  return {
    plan_code: p.code,
    plan_name: p.name,
    tier: p.tier,
    features: p.features,
    limits: p.limits || {},
    seats: p.seats,
    offline_days: p.offline_days,
    online_required: p.online_required,
    app_id: p.app_id || lic.app_id || null,
    product_id: p.product_id || null,
    product_name: p.product_name || '',
  };
}

/**
 * 权益版本号：对「客户端真正会消费的字段」做内容哈希。
 * 心跳时客户端带上上次拿到的版本，服务端比对即可告知「权益变了」，不用整包 diff。
 * 字段集变了（新增权益维度）没关系 —— 内容一变版本就变，客户端最多多刷一次。
 */
function entitlementVersion(lic) {
  const ent = licenseEntitlement(lic);
  const src = JSON.stringify({
    plan_code: ent.plan_code, tier: Number(ent.tier) || 0,
    features: ent.features || [], limits: ent.limits || {},
    seats: ent.seats, offline_days: ent.offline_days,
    online_required: ent.online_required === undefined ? null : ent.online_required,
    max_devices: lic ? Number(lic.max_devices) || 1 : 1,
    end_at: lic && lic.end_at ? lic.end_at : null,
    downgraded_from: lic ? String(lic.downgraded_from || '') : '',
  });
  return crypto.createHash('sha1').update(src).digest('hex').slice(0, 12);
}

/**
 * 到期降级：套餐订阅过期的瞬间，把这张授权落到该应用的 free 档（同一个码、同一批机器）。
 *
 * 客户端的实际行为是「过期就静默走 freeStatus()」，界面上只剩一个「免费版」，
 * 用户只会觉得功能丢了去打客服。服务端明确降级并记 downgraded_from 后，
 * verify / heartbeat / licenses 返回里就能说清「订阅到期，已降级为免费版」。
 *
 * 边界：
 *  - 无档位的历史商品/卡密授权不动：它们的「过期」就是过期，没有可降的档。
 *  - 机器数不缩水：已绑定的机器继续可用，避免降级瞬间把在线设备踢下线。
 *  - 没配 free 档的应用不降（宁可见「已过期」也不能编一个不存在的档）。
 */
function settleExpiry(lic) {
  if (!lic || lic.status !== 'active') return lic;
  if (!Number(lic.user_id)) return lic; // 卡密池未绑定的码
  if (!lic.end_at || Date.parse(lic.end_at) >= Date.now()) return lic;
  const cur = licensePlan(lic);
  if (!cur) return lic;
  const refetch = () => db.prepare('SELECT * FROM licenses WHERE id = ?').get(lic.id);
  if (cur.billing === 'free') {
    // 免费档本不该有到期时间（历史数据/配置失误）；直接清掉，别把免费用户锁在门外
    db.prepare('UPDATE licenses SET end_at = NULL WHERE id = ?').run(lic.id);
    return refetch();
  }
  const free = freePlanFor(lic.app_id || cur.app_id);
  if (!free) return lic;
  db.prepare(`UPDATE licenses SET plan_id = ?, plan_code = ?, end_at = NULL, type = 'permanent',
    downgraded_from = ?, downgraded_at = ? WHERE id = ?`)
    .run(free.id, free.code, cur.code, now(), lic.id);
  return refetch();
}

/** 这张授权现在是否可用（激活/登录/心跳语义）：已激活 + 未过期 */
function isLicenseLive(lic) {
  if (!lic || lic.status !== 'active') return false;
  if (!Number(lic.user_id)) return false;
  if (lic.end_at && Date.parse(lic.end_at) < Date.now()) return false;
  return true;
}

/**
 * 用户在某软件产品下可用的授权，按 tier 高 → end_at 晚（永久最晚）→ id 大 排序。
 * 读到过期订阅会顺带降级（settleExpiry），保证排序前状态已收敛。
 */
function usableLicenses(userId, appRow) {
  const uid = Number(userId) || 0;
  const rows = db.prepare('SELECT * FROM licenses WHERE user_id = ? AND status <> ? ORDER BY id DESC')
    .all(uid, 'revoked');
  const out = [];
  for (let lic of rows) {
    if (appRow && !licenseMatchesApp(lic, appRow)) continue;
    lic = settleExpiry(lic);
    out.push({ lic, ent: licenseEntitlement(lic) });
  }
  out.sort((a, b) => {
    const ta = Number(a.ent.tier) || 0;
    const tb = Number(b.ent.tier) || 0;
    if (ta !== tb) return tb - ta;
    const ea = a.lic.end_at ? Date.parse(a.lic.end_at) : Infinity;
    const eb = b.lic.end_at ? Date.parse(b.lic.end_at) : Infinity;
    if (ea !== eb) return eb - ea;
    return Number(b.lic.id) - Number(a.lic.id);
  });
  return out;
}

/** 用户在某软件产品下的「当前生效」授权：排序最高的那张可用码。 */
function bestLicenseForApp(userId, appRow) {
  const hit = usableLicenses(userId, appRow).find((x) => isLicenseLive(x.lic));
  return hit ? hit.lic : null;
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
  list, listForApp, listForProduct, listTemplates, listApps, get, byCode, shape, validate,
  insert, update, copyTemplateToApp, importConfig, exportConfig,
  licensePlan, licenseMatchesApp, licenseEntitlement, ensureFreeLicense, freePlanFor,
  addDays, round2,
  featureSchema, normalizeFeatureSchema, normalizeLimits,
  entitlementVersion, settleExpiry, isLicenseLive, usableLicenses, bestLicenseForApp,
};

/**
 * 套餐档位公共逻辑。
 *
 * 单独成模块是为了避开循环依赖：deliver.js / open.js / portal.js / wechat.js
 * / routes/plans.js 都要读档位，谁都不该去 require 另一个路由文件。
 * 运行时唯一数据源是 plans 表；JSON 只用于导入导出，不参与请求链路。
 */
const db = require('../db');
const { now, safeJson, genLicenseKey } = require('./util');

const DAY = 86400000;
const BILLING = new Set(['free', 'once', 'period']);

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

function list(onlyActive = false) {
  const sql = onlyActive
    ? 'SELECT * FROM plans WHERE status = ? ORDER BY tier ASC, sort DESC, id ASC'
    : 'SELECT * FROM plans ORDER BY tier ASC, sort DESC, id ASC';
  return (onlyActive ? db.prepare(sql).all('on') : db.prepare(sql).all()).map(shape);
}

function get(id) {
  return shape(db.prepare('SELECT * FROM plans WHERE id = ?').get(Number(id)));
}

function byCode(code) {
  return shape(db.prepare('SELECT * FROM plans WHERE code = ?').get(String(code || '')));
}

/**
 * 校验并归一化一条档位。
 * 导入与后台表单共用同一套规则，避免「表单能存、导入却存进脏数据」。
 */
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
  if (b.tier !== undefined || !partial) {
    v.tier = Math.max(0, Math.round(Number(b.tier) || 0));
  }
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
    // 在线档允许几天断网宽限（出差/断网场景），但不能长到变成事实上的离线版；
    // 需要长期离线请用 online_required=0 的企业档。
    errors.push('要求联网的档位 offline_days 不能超过 7 天（长期离线请用「允许离线」档位）');
  }
  return { ok: errors.length === 0, errors, value: v };
}

function insert(input, by = 'admin') {
  const r = validate(input);
  if (!r.ok) return r;
  const v = r.value;
  const dup = db.prepare('SELECT id FROM plans WHERE code = ?').get(v.code);
  if (dup) return { ok: false, errors: [`档位 code「${v.code}」已存在`] };
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
  const dup = db.prepare('SELECT id FROM plans WHERE code = ? AND id <> ?').get(v.code, Number(id));
  if (dup) return { ok: false, errors: [`档位 code「${v.code}」已存在`] };
  db.prepare(`UPDATE plans SET app_id=@app_id, code=@code, name=@name, tier=@tier, billing=@billing,
    price=@price, original_price=@original_price, period_days=@period_days,
    online_required=@online_required, offline_days=@offline_days, max_devices=@max_devices,
    seats=@seats, features=@features, status=@status, sort=@sort, remark=@remark, updated_at=@t
    WHERE id=@id`)
    .run({ ...v, id: Number(id), t: now() });
  return { ok: true, plan: get(id) };
}

/** 导出为可纳入版本管理的配置。注意：不含 id / created_at 等运行时字段。 */
function exportConfig() {
  return {
    schema: 1,
    exported_at: now(),
    upgrade: { allow_downgrade: false, proration: 'remaining_days' },
    plans: list(false).map((p) => ({
      code: p.code, name: p.name, tier: p.tier, billing: p.billing,
      price: p.price, original_price: p.original_price, period_days: p.period_days,
      online_required: p.online_required, offline_days: p.offline_days,
      max_devices: p.max_devices, seats: p.seats, features: p.features,
      status: p.status, sort: p.sort, remark: p.remark || '',
    })),
  };
}

/**
 * 导入：只做「按 code 新增/更新」，不删除配置里没出现的档位。
 * 删档位是很危险的动作（已售授权还引用着它），必须由管理员在表单里显式操作。
 */
function importConfig(cfg) {
  const arr = Array.isArray(cfg) ? cfg : (cfg && Array.isArray(cfg.plans) ? cfg.plans : null);
  if (!arr) return { ok: false, errors: ['配置格式错误：需要 { plans: [...] } 或直接是数组'] };
  const errors = [];
  let created = 0;
  let updated = 0;
  for (let i = 0; i < arr.length; i++) {
    const r = validate(arr[i]);
    if (!r.ok) { errors.push(`第 ${i + 1} 档：${r.errors.join('；')}`); continue; }
    const exists = byCode(r.value.code);
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
    const p = byCode(lic.plan_code);
    if (p) return p;
  }
  // 历史商品授权 / 卡密池码没有档位，不能擅自当成免费档：
  // 它们的离线宽限要继续走 open_apps.offline_days（后台「离线宽限」），
  // 否则老客户升级到套餐体系后会被无声降成「必须联网」。
  return null;
}

/** 客户端可见的权益描述（会进离线票据，必须短且稳定） */
function licenseEntitlement(lic) {
  const p = licensePlan(lic);
  if (!p) return { plan_code: String(lic.plan_code || lic.type || ''), features: [], seats: 1, offline_days: 0 };
  return {
    plan_code: p.code,
    plan_name: p.name,
    tier: p.tier,
    features: p.features,
    seats: p.seats,
    offline_days: p.offline_days,
    online_required: p.online_required,
  };
}

/**
 * 注册时给新用户发一张免费档授权码。
 *
 * 为什么要发码：/api/open/v1/auth/activate 强制要 license_key，
 * 免费用户若没有授权码根本登不进软件端；与其给扫码登录开特例分支，
 * 不如让所有档位走同一套 activate / verify / heartbeat / ticket 链路。
 * 幂等：该用户已有任何授权（含付费）就不再发，避免列表里多出一张没用的码。
 */
function ensureFreeLicense(userId) {
  const free = db.prepare("SELECT * FROM plans WHERE billing = 'free' AND status = 'on' ORDER BY tier ASC LIMIT 1").get();
  if (!free) return null;
  const count = db.prepare('SELECT COUNT(*) AS c FROM licenses WHERE user_id = ?').get(Number(userId)).c;
  if (count > 0) return null;
  const ts = now();
  const key = genLicenseKey();
  // product_id 用 0 表示「套餐授权，不绑定具体商品」：schema 里这一列是 NOT NULL，
  // 不能传 NULL；同时 activate 的商品匹配只对 product_id > 0 的老商品授权生效。
  db.prepare(`INSERT INTO licenses
    (license_key, user_id, product_id, type, max_devices, start_at, end_at, status,
     plan_id, plan_code, remark, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(key, Number(userId), 0, 'permanent', Number(free.max_devices) || 1,
      ts, null, 'active', free.id, free.code, '注册自动发放免费版', ts);
  return key;
}

module.exports = {
  list, get, byCode, shape, validate, insert, update, importConfig, exportConfig,
  licensePlan, licenseEntitlement, ensureFreeLicense, addDays, round2,
};

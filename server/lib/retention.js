/* 数据留存（滚动清理）
 *
 * 解决的问题：`open_auth_log` 每请求一行、`app_update_log` 每次清单命中一行、
 * `client_sessions` 每次激活一行 —— 这些表如果只增不删，跑一年就是把 SQLite 拖死
 * （查询变慢、备份包变大、VACUUM 也越来越久），而界面上又只有「清空整表」一条路。
 *
 * 所以分成两层：
 *  1) 自动留存：每张流水表给一个「保留天数」，每天按时间删除更早的行；
 *     在线会话（active 且未过期）永远不删，只清失效/过期很久的。
 *  2) 手动维护：后台可以改保留天数、立刻按策略跑一次、或者单表清空（先自动备份）。
 *
 * 设计边界（很重要，别越界）：
 *  - 只处理「流水类」表。订单、支付、授权、积分、佣金、设备是**账本**，
 *    自动删等于毁账，一律不给自动策略（只能手动清空，且强制先备份）。
 *  - 台账/审计类（machine_ledger、admin_logs）默认不自动清，只在页面上提示行数，
 *    由管理员自己决定。
 *  - 每条 DELETE 都带时间条件与 LIMIT 循环，避免一次锁库太久。
 */
const { now } = require('./util');

const DAY = 86400000;

/**
 * 保留策略表。
 *  ts      : 用来判断「多老」的时间列
 *  days    : 默认保留天数（后台可改，存 settings.retention_days）
 *  auto    : 是否参与每日自动清理
 *  session : 会话表特例 —— 只删「已失效/已过期」的行，在线会话不动
 *  why     : 写给管理员看的一句话（为什么是这个默认值）
 */
const POLICIES = [
  {
    key: 'open_auth_log', table: 'open_auth_log', ts: 'created_at', days: 30, auto: true,
    name: '开放接口鉴权流水',
    desc: '每次带身份的开放接口调用一行，双模期判断「旧密钥是否归零」全靠它',
    why: '30 天足够覆盖一次「关旧密钥」的观察窗口；再久只是占地方',
  },
  {
    key: 'app_update_log', table: 'app_update_log', ts: 'created_at', days: 180, auto: true,
    name: '客户端升级记录',
    desc: '清单命中、升级成功/失败/回滚回执；同一机器同一目标版本只留最新一条',
    why: '半年够查「某台机器最后升到哪个版本」，再长也没人看',
  },
  {
    key: 'client_sessions', table: 'client_sessions', ts: 'last_seen_at', days: 30, auto: true, session: true,
    name: '软件端登录会话',
    desc: '客户端每次激活/登录一行；只清已失效或已过期超过保留期的会话',
    why: '在线会话永不删；失效会话留 30 天供排障「是不是被踢下来了」',
  },
  {
    key: 'login_attempts', table: 'login_attempts', ts: 'created_at', days: 30, auto: true,
    name: '后台登录尝试',
    desc: '登录成功/失败记录，用于爆破锁定',
    why: '锁定只看最近几分钟，30 天足够事后追查',
  },
  {
    key: 'wechat_sessions', table: 'wechat_sessions', ts: 'created_at', days: 7, auto: true,
    name: '微信扫码会话',
    desc: '扫码登录场景（scene），过期即作废',
    why: '扫码有效期只有几分钟，留 7 天只为查「扫了但没登上」',
  },
  {
    key: 'sms_codes', table: 'sms_codes', ts: 'expires_at', days: 7, auto: true,
    name: '短信验证码',
    desc: '手机号验证码（含已用/已过期）',
    why: '验证码本身 5 分钟过期，留 7 天够查发送记录',
  },
  {
    key: 'handoff_tickets', table: 'handoff_tickets', ts: 'created_at', days: 3, auto: true,
    name: '免登一次性票据',
    desc: '软件端 → 浏览器免登的 code，用一次即作废',
    why: '本来就 5 分钟有效，3 天纯属给排障留样本',
  },
  {
    key: 'api_nonces', table: 'api_nonces', ts: 'created_at', days: 1, auto: true,
    name: 'HMAC 防重放 nonce',
    desc: '签名请求的 nonce，窗口 5 分钟，过窗即无意义',
    why: '唯一的判断依据是签名窗口，留 1 天已经很宽松',
  },
  {
    key: 'machine_ledger', table: 'machine_ledger', ts: 'last_seen_at', days: 0, auto: false,
    name: '机器台账',
    desc: '机器码 ↔ 客户 ↔ 授权 ↔ 构建/版本的对照表',
    why: '业务台账，不自动清；要归档请手动清空（会先备份）',
  },
  {
    key: 'admin_logs', table: 'admin_logs', ts: 'created_at', days: 0, auto: false,
    name: '后台操作日志',
    desc: '谁在什么时候改了什么（退款、发码、清理都在这）',
    why: '审计凭证，默认永不清；合规有要求时再手动按时间清',
  },
];

const SETTING_KEY = 'retention_days';

function conn() {
  return require('../db');
}

function policyOf(key) {
  return POLICIES.find((p) => p.key === key || p.table === key) || null;
}

function loadDays() {
  const { getSetting } = require('./config');
  let raw = {};
  try { raw = JSON.parse(getSetting(SETTING_KEY, '{}') || '{}'); } catch { raw = {}; }
  const out = {};
  for (const p of POLICIES) {
    const v = Number(raw[p.key]);
    out[p.key] = Number.isFinite(v) && v >= 0 ? v : p.days;
  }
  return out;
}

function saveDays(patch) {
  const { setSetting } = require('./config');
  const cur = loadDays();
  for (const [k, v] of Object.entries(patch || {})) {
    const p = policyOf(k);
    if (!p) continue;
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0 || n > 3650) throw new Error(`${p.name} 的保留天数需在 0–3650 之间（0 = 不自动清）`);
    cur[p.key] = n;
  }
  setSetting(SETTING_KEY, JSON.stringify(cur));
  return cur;
}

function cutoffIso(days) {
  return new Date(Date.now() - days * DAY).toISOString();
}

/** 单表计数 + 最早时间（老库可能没这张表，一律兜底 0） */
function statOf(d, p) {
  const out = { rows: 0, oldest: '', expired: 0 };
  try {
    out.rows = d.prepare(`SELECT COUNT(*) AS c FROM "${p.table}"`).get().c;
  } catch { return out; }
  try {
    out.oldest = d.prepare(`SELECT MIN("${p.ts}") AS t FROM "${p.table}"`).get().t || '';
  } catch { /* 没有时间列就留空 */ }
  if (p.session) {
    try {
      out.expired = d.prepare(`SELECT COUNT(*) AS c FROM client_sessions
        WHERE status <> 'active' OR expires_at < ?`).get(now()).c;
    } catch { /* ignore */ }
  }
  return out;
}

/** 后台页总览：每张表的行数、最早一行、当前保留天数、是否自动 */
function overview() {
  const d = conn();
  const days = loadDays();
  const policies = POLICIES.map((p) => {
    const st = statOf(d, p);
    const day = days[p.key];
    return {
      key: p.key, table: p.table, name: p.name, desc: p.desc, why: p.why,
      auto: !!p.auto, session: !!p.session,
      days: day,
      default_days: p.days,
      rows: st.rows,
      oldest: st.oldest,
      expired: st.expired,
      // 按当前策略「下次会删掉多少」：让管理员点之前心里有数
      due: dueOf(d, p, day),
    };
  });
  const total = policies.reduce((s, p) => s + p.rows, 0);
  return {
    policies,
    total_rows: total,
    auto_rows: policies.filter((p) => p.auto).reduce((s, p) => s + p.rows, 0),
  };
}

/** 按天数算「这次会删多少行」，不真删 */
function dueOf(d, p, days) {
  if (!p.auto || !Number(days)) return 0;
  const cut = cutoffIso(days);
  try {
    if (p.session) {
      return d.prepare(`SELECT COUNT(*) AS c FROM client_sessions
        WHERE (status <> 'active' OR expires_at < ?)
          AND COALESCE(NULLIF(last_seen_at,''), created_at) < ?`).get(now(), cut).c;
    }
    return d.prepare(`SELECT COUNT(*) AS c FROM "${p.table}" WHERE "${p.ts}" <> '' AND "${p.ts}" < ?`).get(cut).c;
  } catch { return 0; }
}

/**
 * 按策略删一张表。分块删（每次 5000 行）避免长时间持锁。
 * @returns {number} 删除行数
 */
function pruneOne(p, days) {
  const d = conn();
  const cut = cutoffIso(days);
  let total = 0;
  for (let i = 0; i < 400; i += 1) {
    let info;
    if (p.session) {
      info = d.prepare(`DELETE FROM client_sessions WHERE id IN (
        SELECT id FROM client_sessions
        WHERE (status <> 'active' OR expires_at < ?)
          AND COALESCE(NULLIF(last_seen_at,''), created_at) < ?
        LIMIT 5000)`).run(now(), cut);
    } else {
      info = d.prepare(`DELETE FROM "${p.table}" WHERE rowid IN (
        SELECT rowid FROM "${p.table}" WHERE "${p.ts}" <> '' AND "${p.ts}" < ? LIMIT 5000)`).run(cut);
    }
    total += info.changes;
    if (info.changes < 5000) break;
  }
  return total;
}

/**
 * 跑一次清理。
 * @param {string[]} [keys] 指定表（默认所有 auto 策略）
 * @param {{ by?: string }} [opts]
 */
function run(keys, opts = {}) {
  const d = conn();
  const days = loadDays();
  const targets = (keys && keys.length ? keys.map(policyOf).filter(Boolean) : POLICIES.filter((p) => p.auto));
  const deleted = {};
  let total = 0;
  for (const p of targets) {
    const day = days[p.key];
    if (!p.auto || !Number(day)) continue;
    try {
      const n = pruneOne(p, day);
      if (n) { deleted[p.table] = n; total += n; }
    } catch (e) {
      deleted[p.table] = 0;
    }
  }
  const res = { at: now(), by: opts.by || 'system', days, deleted, total };
  if (total) {
    try { d.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'retention_last_run'").run(JSON.stringify(res), now()); } catch { /* ignore */ }
  }
  return res;
}

/** 清空单表（先备份）。仅用于台账/审计这类不自动清理的表，或确需归零的流水 */
function clearTable(key, opts = {}) {
  const d = conn();
  const p = policyOf(key);
  if (!p) throw new Error('未知的数据表');
  let rows = 0;
  try { rows = d.prepare(`SELECT COUNT(*) AS c FROM "${p.table}"`).get().c; } catch { rows = 0; }
  if (!rows) return { ok: true, table: p.table, deleted: 0, backup: '' };

  let pkg = null;
  if (opts.backup !== false) {
    const backup = require('./backup');
    pkg = backup.createPackage({ note: `清空前自动备份（${p.name}）`, prefix: 'pre-clear' });
  }
  const info = d.prepare(`DELETE FROM "${p.table}"`).run();
  try { d.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(p.table); } catch { /* 无自增 */ }
  try { d.exec('VACUUM'); } catch { /* 磁盘紧张时可能失败 */ }
  return { ok: true, table: p.table, name: p.name, deleted: info.changes, before: rows, backup: pkg ? pkg.name : '' };
}

/** 上次清理结果（页面展示用） */
function lastRun() {
  const { getSetting } = require('./config');
  try { return JSON.parse(getSetting('retention_last_run', '{}') || '{}'); } catch { return {}; }
}

module.exports = { POLICIES, policyOf, loadDays, saveDays, overview, run, clearTable, lastRun, cutoffIso };

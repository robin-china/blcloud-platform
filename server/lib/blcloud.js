/* blcloud 密钥与额度：用户凭密钥访问设备 API，按次计费 */
const crypto = require('crypto');
const db = require('../db');
const { now, today } = require('./util');
const { getSetting, setSetting } = require('./config');

const KEY_PREFIX = 'blc_';

function cfg() {
  return {
    enabled: getSetting('blcloud_enabled', '1') !== '0',
    freeQuota: Number(getSetting('blcloud_free_quota', '10000')) || 0,
    perPoint: Number(getSetting('blcloud_credits_per_point', '100')) || 0,
    dailyLimit: Number(getSetting('blcloud_daily_limit', '0')) || 0,
  };
}

function saveCfg(patch) {
  if (patch.enabled !== undefined) setSetting('blcloud_enabled', patch.enabled ? '1' : '0');
  if (patch.freeQuota !== undefined) setSetting('blcloud_free_quota', String(Math.max(0, Number(patch.freeQuota) || 0)));
  if (patch.perPoint !== undefined) setSetting('blcloud_credits_per_point', String(Math.max(0, Number(patch.perPoint) || 0)));
  if (patch.dailyLimit !== undefined) setSetting('blcloud_daily_limit', String(Math.max(0, Number(patch.dailyLimit) || 0)));
  return cfg();
}

function hashKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function newKey() {
  return KEY_PREFIX + crypto.randomBytes(16).toString('hex');
}

/** 创建密钥，返回 { secret, key } —— secret 仅此一次明文返回 */
function createKey(userId, opts = {}) {
  const c = cfg();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('用户不存在');
  const quota = Math.max(0, Number(opts.quota) || 0);
  const remaining = Math.max(0, (user.blcloud_quota || 0) - (user.blcloud_used || 0));
  if (quota > remaining) {
    throw new Error(`额度不足：账户剩余 ${remaining} 次，无法分配 ${quota} 次`);
  }
  const secret = newKey();
  const info = db.prepare(`INSERT INTO blcloud_keys
    (user_id, key_name, key_prefix, key_hash, mode, scopes, quota, used, status, expires_at, created_at)
    VALUES (?,?,?,?,?,?,?,0,'active',?,?)`).run(
    userId,
    String(opts.name || '默认密钥').slice(0, 40),
    secret.slice(0, 12) + '…',
    hashKey(secret),
    opts.mode === 'direct' ? 'direct' : 'proxy',
    String(opts.scopes || 'device.read,device.write').slice(0, 200),
    quota,
    (opts.days ? new Date(Date.now() + Number(opts.days) * 86400000).toISOString() : ''),
    now()
  );
  return { secret, key: getKey(info.lastInsertRowid), freeQuota: c.freeQuota };
}

function getKey(id) {
  return db.prepare(`SELECT k.*, u.nickname, u.openid
    FROM blcloud_keys k LEFT JOIN users u ON u.id = k.user_id WHERE k.id = ?`).get(id);
}

function keyPayload(k) {
  if (!k) return null;
  return {
    id: k.id,
    user_id: k.user_id,
    name: k.key_name,
    prefix: k.key_prefix,
    mode: k.mode,
    scopes: k.scopes,
    quota: k.quota,
    used: k.used,
    remaining: k.quota > 0 ? Math.max(0, k.quota - k.used) : null,
    status: k.status,
    last_ip: k.last_ip,
    last_used_at: k.last_used_at,
    expires_at: k.expires_at,
    created_at: k.created_at,
    nickname: k.nickname || '',
    openid: k.openid || '',
  };
}

/** 校验密钥字符串，返回 { key, user } 或 null */
function resolveKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const row = db.prepare('SELECT * FROM blcloud_keys WHERE key_hash = ?').get(hashKey(s));
  if (!row) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  return { key: row, user };
}

/** 首次使用时发放免费额度 */
function ensureFreeQuota(user) {
  const c = cfg();
  if (!c.freeQuota) return user;
  if ((user.blcloud_quota || 0) > 0) return user;
  db.prepare('UPDATE users SET blcloud_quota = ? WHERE id = ?').run(c.freeQuota, user.id);
  return { ...user, blcloud_quota: c.freeQuota };
}

function quotaState(user) {
  const total = Number(user.blcloud_quota || 0);
  const used = Number(user.blcloud_used || 0);
  return { total, used, remaining: Math.max(0, total - used) };
}

/** 调用前检查额度 */
function check(user, keyRow, cost = 1) {
  if (!cfg().enabled) return { ok: false, code: 'BLCLOUD_DISABLED', reason: 'blcloud 接口已停用' };
  if (!user || user.status !== 'active') return { ok: false, code: 'USER_DISABLED', reason: '账户不可用' };
  if (!keyRow || keyRow.status !== 'active') return { ok: false, code: 'KEY_INVALID', reason: '密钥已停用' };
  if (keyRow.expires_at && new Date(keyRow.expires_at).getTime() < Date.now()) {
    return { ok: false, code: 'KEY_EXPIRED', reason: '密钥已过期' };
  }
  const q = quotaState(user);
  if (q.remaining < cost) return { ok: false, code: 'QUOTA_EXHAUSTED', reason: '账户调用额度不足' };
  if (keyRow.quota > 0 && keyRow.quota - keyRow.used < cost) {
    return { ok: false, code: 'KEY_QUOTA_EXCEEDED', reason: '该密钥分配额度已用完' };
  }
  const limit = cfg().dailyLimit;
  if (limit > 0) {
    const todayUsed = db.prepare('SELECT COALESCE(SUM(cost),0) AS c FROM blcloud_usage WHERE user_id = ? AND date = ?')
      .get(user.id, today()).c;
    if (todayUsed + cost > limit) {
      return { ok: false, code: 'DAILY_LIMIT', reason: `已达每日调用上限 ${limit} 次` };
    }
  }
  return { ok: true };
}

/** 记账：扣额度 + 写明细 */
function consume(user, keyRow, info = {}) {
  const cost = Math.max(1, Number(info.cost) || 1);
  const ts = now();
  const date = today();
  db.prepare('UPDATE users SET blcloud_used = blcloud_used + ? WHERE id = ?').run(cost, user.id);
  db.prepare('UPDATE blcloud_keys SET used = used + ?, last_ip = ?, last_used_at = ? WHERE id = ?')
    .run(cost, String(info.ip || ''), ts, keyRow.id);
  db.prepare(`INSERT INTO blcloud_usage (user_id, key_id, endpoint, path, method, cost, status, ok, message, ts, date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    user.id, keyRow.id, String(info.endpoint || ''), String(info.path || '').slice(0, 300),
    String(info.method || 'GET'), cost, Number(info.status || 200), info.ok === false ? 0 : 1,
    String(info.message || '').slice(0, 200), ts, date
  );
  db.prepare('INSERT INTO stats_daily (date, api_calls) VALUES (?,?) ON CONFLICT(date) DO UPDATE SET api_calls = api_calls + ?')
    .run(date, cost, cost);
  return cost;
}

/** 拒绝请求也要记账（失败不扣额度则记 cost=0，但仍留痕） */
function reject(user, keyRow, info = {}) {
  const ts = now();
  db.prepare(`INSERT INTO blcloud_usage (user_id, key_id, endpoint, path, method, cost, status, ok, message, ts, date)
    VALUES (?,?,?,?,?,0,?,0,?,?,?)`).run(
    user?.id || 0, keyRow?.id || null, String(info.endpoint || ''), String(info.path || '').slice(0, 300),
    String(info.method || 'GET'), Number(info.status || 402), String(info.message || '').slice(0, 200), ts, today()
  );
}

/** 调整账户额度池（delta 可正可负） */
function addQuota(userId, delta, reason = '') {
  const d = Number(delta) || 0;
  if (!d) return quotaState(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
  db.prepare('UPDATE users SET blcloud_quota = MAX(0, blcloud_quota + ?) WHERE id = ?').run(d, userId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (reason) {
    db.prepare('INSERT INTO points_logs (user_id, change, balance, reason, created_at) VALUES (?,?,?,?,?)')
      .run(userId, 0, Number(user.points || 0), reason, now());
  }
  return quotaState(user);
}

/** 用户用量概览 */
function summary(userId, days = 14) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const q = quotaState(user || {});
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const daily = db.prepare(`SELECT date, SUM(cost) AS calls, SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) AS ok_calls,
      SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS fail_calls
    FROM blcloud_usage WHERE user_id = ? AND date >= ? GROUP BY date ORDER BY date`)
    .all(userId, since);
  const byEndpoint = db.prepare(`SELECT endpoint, SUM(cost) AS calls, MAX(ts) AS last
    FROM blcloud_usage WHERE user_id = ? GROUP BY endpoint ORDER BY calls DESC LIMIT 10`).all(userId);
  const todayCalls = db.prepare('SELECT COALESCE(SUM(cost),0) AS c FROM blcloud_usage WHERE user_id = ? AND date = ?')
    .get(userId, today()).c;
  const recent = db.prepare('SELECT * FROM blcloud_usage WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(userId);
  return { quota: q, daily, byEndpoint, todayCalls, recent, cfg: cfg() };
}

/** 平台总览（管理端） */
function platformStats(days = 14) {
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const keys = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
    SUM(quota) AS quota, SUM(used) AS used FROM blcloud_keys`).get();
  const calls = db.prepare(`SELECT COALESCE(SUM(cost),0) AS calls, COUNT(*) AS reqs,
    SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS fails FROM blcloud_usage`).get();
  const todayCalls = db.prepare('SELECT COALESCE(SUM(cost),0) AS c FROM blcloud_usage WHERE date = ?').get(today()).c;
  const daily = db.prepare(`SELECT date, SUM(cost) AS calls, COUNT(DISTINCT user_id) AS users
    FROM blcloud_usage WHERE date >= ? GROUP BY date ORDER BY date`).all(since);
  const topUsers = db.prepare(`SELECT u.id, u.nickname, u.openid, SUM(x.cost) AS calls
    FROM blcloud_usage x JOIN users u ON u.id = x.user_id GROUP BY x.user_id ORDER BY calls DESC LIMIT 10`).all();
  const topEndpoints = db.prepare(`SELECT endpoint, SUM(cost) AS calls, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS fails
    FROM blcloud_usage GROUP BY endpoint ORDER BY calls DESC LIMIT 10`).all();
  const quotaRank = db.prepare(`SELECT id, nickname, openid, blcloud_quota AS quota, blcloud_used AS used
    FROM users WHERE blcloud_quota > 0 ORDER BY blcloud_used DESC LIMIT 10`).all();
  return { keys, calls, todayCalls, daily, topUsers, topEndpoints, quotaRank, cfg: cfg() };
}

module.exports = {
  cfg, saveCfg, createKey, getKey, keyPayload, resolveKey, check, consume, reject,
  addQuota, quotaState, summary, platformStats, ensureFreeQuota, hashKey,
};

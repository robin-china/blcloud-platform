/* 软件端开放接口：应用凭证签名校验 + 客户端会话令牌 */
const crypto = require('crypto');
const db = require('../db');
const { now } = require('./util');

const ACCESS_TTL = 2 * 60 * 60 * 1000;        // access_token 2 小时
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000; // refresh_token 30 天
const SIGN_WINDOW = 5 * 60 * 1000;            // 签名有效期 5 分钟

function genAppKey() {
  return 'ak_' + crypto.randomBytes(12).toString('hex');
}

function genAppSecret() {
  return 'sk_' + crypto.randomBytes(24).toString('hex');
}

function genClientToken() {
  return 'ct_' + crypto.randomBytes(24).toString('hex');
}

/* ---------------- 应用级签名 ---------------- */

function buildSignPayload(appKey, method, path, timestamp, nonce, bodyRaw) {
  return [appKey, String(method || '').toUpperCase(), path, String(timestamp), String(nonce || ''), bodyRaw || ''].join('\n');
}

function sign(appSecret, appKey, method, path, timestamp, nonce, bodyRaw) {
  return crypto.createHmac('sha256', appSecret)
    .update(buildSignPayload(appKey, method, path, timestamp, nonce, bodyRaw))
    .digest('hex');
}

/* ---------------- nonce 防重放 ---------------- */

let lastPurge = 0;

function purgeNonces() {
  const t = Date.now();
  if (t - lastPurge < 60000) return;
  lastPurge = t;
  try {
    const before = new Date(t - SIGN_WINDOW - 60000).toISOString();
    db.prepare('DELETE FROM api_nonces WHERE created_at < ?').run(before);
  } catch { /* ignore */ }
}

/**
 * 公开模式频控（内存滑窗，单实例部署 —— SQLite 本来就只能单实例）。
 * 只挡「拿 app_key 裸打」的洪水，不做业务级限制：真正的业务闸门在
 * 授权码绑定/短信验证码那层，这里挡太狠会把正常客户端误伤。
 */
const rlBuckets = new Map();
function rateHit(key, limit, windowMs) {
  const t = Date.now();
  const b = rlBuckets.get(key);
  if (!b || t - b.start >= windowMs) {
    rlBuckets.set(key, { start: t, n: 1 });
    return true;
  }
  b.n += 1;
  if (rlBuckets.size > 20000) rlBuckets.clear(); // 防内存无限增长
  return b.n <= limit;
}


/** 记录 nonce，返回 false 表示该 nonce 已被使用过（重放） */
function consumeNonce(appKey, nonce) {
  if (!nonce) return true;
  purgeNonces();
  try {
    db.prepare('INSERT INTO api_nonces (app_key, nonce, created_at) VALUES (?,?,?)').run(appKey, nonce, now());
    return true;
  } catch {
    return false;
  }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * 校验客户端请求签名。
 * 请求头：X-App-Key / X-Timestamp / X-Nonce / X-Signature
 * 签名内容：appKey\nMETHOD\npath\ntimestamp\nnonce\nbodyRaw（body 为原始字符串）
 *
 * 双模期（2026-11-11）：app_secret 轮换后 app_secret_prev 仍可验签，
 * 但返回值里 mode=hmac_legacy，便于统计「旧客户端还剩多少」；
 * 后台关掉 legacy_hmac 后旧值立即失效并返回 APP_SECRET_RETIRED。
 */
function verifySignature(req) {
  const appKey = String(req.headers['x-app-key'] || '');
  const timestamp = String(req.headers['x-timestamp'] || '');
  const nonce = String(req.headers['x-nonce'] || '');
  const signature = String(req.headers['x-signature'] || '');
  if (!appKey || !timestamp || !signature) return { ok: false, error: '缺少应用签名头', code: 'APP_SIGN_INVALID' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SIGN_WINDOW) {
    return { ok: false, error: '签名已过期，请校准客户端时间', code: 'APP_SIGN_INVALID' };
  }
  const app = db.prepare('SELECT * FROM open_apps WHERE app_key = ?').get(appKey);
  if (!app) return { ok: false, error: 'app_key 不存在', code: 'APP_SIGN_INVALID' };
  if (app.status !== 'active') return { ok: false, error: '应用已停用', code: 'APP_DISABLED' };

  const bodyRaw = typeof req.body === 'string'
    ? req.body
    : (req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : '');
  // 签名覆盖完整请求行（含查询串），避免查询参数被篡改
  const path = String(req.url || '').split('#')[0];
  const candidates = [{ secret: app.app_secret, mode: 'hmac' }];
  if (app.app_secret_prev) candidates.push({ secret: app.app_secret_prev, mode: 'hmac_legacy' });

  let matched = null;
  for (const c of candidates) {
    const expect = crypto.createHmac('sha256', c.secret)
      .update(buildSignPayload(appKey, req.method, path, timestamp, nonce, bodyRaw))
      .digest('hex');
    if (safeEqual(expect, signature)) { matched = c; break; }
  }
  if (!matched) return { ok: false, error: '签名校验失败', code: 'APP_SIGN_INVALID' };
  if (matched.mode === 'hmac_legacy' && !Number(app.legacy_hmac)) {
    return { ok: false, error: '旧版应用密钥已停用，请升级客户端', code: 'APP_SECRET_RETIRED' };
  }
  // 验签通过后才登记 nonce，防止用无效签名消耗他人 nonce
  if (!consumeNonce(appKey, nonce)) return { ok: false, error: 'nonce 已使用，请求重复', code: 'APP_SIGN_INVALID' };
  return { ok: true, app, mode: matched.mode };
}

/* ---------------- 公开模式（不内置共享密钥） ---------------- */

/**
 * 新客户端不再内置 appSecret（源码/备份里出现过就等于公开），
 * 只带 x-app-key 表示「我是哪个应用」，安全边界交给：
 *   - 后端频控（每 IP / 每应用）
 *   - nonce 防重放（写操作必须带）
 *   - 真正吃资源的动作（激活/绑定/短信）自己的业务闸门
 * 这也是「密钥进客户端 = 没有密钥」的必然结果，不是偷懒。
 */
function verifyPublic(req) {
  const appKey = String(req.headers['x-app-key'] || '');
  if (!appKey) return { ok: false, error: '缺少 x-app-key', code: 'UNAUTHORIZED' };
  const app = db.prepare('SELECT * FROM open_apps WHERE app_key = ?').get(appKey);
  if (!app) return { ok: false, error: 'app_key 不存在', code: 'APP_SIGN_INVALID' };
  if (app.status !== 'active') return { ok: false, error: '应用已停用', code: 'APP_DISABLED' };
  if (!Number(app.public_auth)) {
    return { ok: false, error: '该应用未开启公开模式，请使用签名鉴权', code: 'PUBLIC_AUTH_DISABLED' };
  }
  const ip = String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (!rateHit(`open:ip:${ip}`, 300, 60000) || !rateHit(`open:app:${appKey}:${ip}`, 120, 60000)) {
    return { ok: false, error: '请求过于频繁，请稍后再试', code: 'RATE_LIMITED' };
  }
  const nonce = String(req.headers['x-nonce'] || '');
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase());
  if (write && !nonce) {
    return { ok: false, error: '公开模式写请求必须带 x-nonce', code: 'NONCE_REQUIRED' };
  }
  if (nonce && !consumeNonce(appKey, nonce)) {
    return { ok: false, error: 'nonce 已使用，请求重复', code: 'NONCE_REUSED' };
  }
  return { ok: true, app, mode: 'public' };
}

/**
 * 统一解析调用方身份（三选一，按可靠性降序）：
 *   1. 有效 Bearer 会话 → token
 *   2. 四件套签名（新/旧 secret）→ hmac / hmac_legacy
 *   3. 仅 x-app-key → public
 * 登录前的端点（激活/扫码/短信）三种都放行；已登录用户带过期令牌时
 * 会自动落到签名/公开模式，不会因为「令牌过期」连激活都做不了。
 */
function resolveApp(req) {
  const token = readClientToken(req);
  if (token) {
    const st = getSessionState(token);
    if (!st.code) {
      const app = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(st.session.app_id);
      if (app && app.status === 'active') {
        req.session = st.session;
        req.app = app;
        req.authMode = 'token';
        return { ok: true, app, mode: 'token', session: st.session };
      }
    }
  }
  if (String(req.headers['x-signature'] || '')) return verifySignature(req);
  if (String(req.headers['x-app-key'] || '')) return verifyPublic(req);
  return { ok: false, error: '缺少鉴权信息：请带签名四件套、Bearer 令牌或 x-app-key', code: 'UNAUTHORIZED' };
}


/* ---------------- 客户端会话 ---------------- */

function issueSession({ app, user, licenseId, machineId, deviceName, appVersion, ip }) {
  const token = genClientToken();
  const refreshToken = genClientToken();
  const t = now();
  db.prepare(`INSERT INTO client_sessions
    (token, refresh_token, app_id, user_id, license_id, machine_id, device_name, app_version, ip, status, expires_at, refresh_expires_at, last_seen_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    token, refreshToken, app.id, user.id, licenseId || null, machineId || '', deviceName || '',
    appVersion || '', ip || '', 'active',
    new Date(Date.now() + ACCESS_TTL).toISOString(),
    new Date(Date.now() + REFRESH_TTL).toISOString(), t, t
  );
  return {
    access_token: token,
    refresh_token: refreshToken,
    expires_in: Math.floor(ACCESS_TTL / 1000),
    refresh_expires_in: Math.floor(REFRESH_TTL / 1000),
  };
}

function readClientToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.query && req.query.access_token) return String(req.query.access_token);
  return '';
}

/**
 * 区分「没令牌」「被解绑/吊销」「过期」三种情况。
 * 客户端要能给出不同提示：单纯「令牌过期」让人以为登录一下就好，
 * 实际是被解绑了，重新登录也进不去 —— 必须说清楚。
 */
function getSessionState(token) {
  if (!token) return { session: null, code: 'UNAUTHORIZED' };
  const s = db.prepare('SELECT * FROM client_sessions WHERE token = ?').get(token);
  if (!s) return { session: null, code: 'UNAUTHORIZED' };
  if (s.status !== 'active') return { session: s, code: 'SESSION_REVOKED' };
  if (new Date(s.expires_at).getTime() < Date.now()) return { session: s, code: 'SESSION_EXPIRED' };
  return { session: s, code: '' };
}

function getSession(token) {
  const st = getSessionState(token);
  return st.code ? null : st.session;
}

function touchSession(s, ip) {
  db.prepare('UPDATE client_sessions SET last_seen_at = ?, ip = ? WHERE id = ?').run(now(), ip || s.ip || '', s.id);
}

async function requireClient(req, reply) {
  const st = getSessionState(readClientToken(req));
  if (st.code === 'SESSION_REVOKED') {
    reply.code(401).send({ error: '该机器已被解绑或授权已吊销，请重新激活', code: 'SESSION_REVOKED' });
    return null;
  }
  if (st.code) {
    reply.code(401).send({ error: '未授权或令牌已过期', code: 'UNAUTHORIZED' });
    return null;
  }
  const s = st.session;
  const app = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(s.app_id);
  if (!app || app.status !== 'active') {
    reply.code(401).send({ error: '应用已停用', code: 'APP_DISABLED' });
    return null;
  }
  req.session = s;
  req.app = app;
  req.authMode = 'token';
  return s;
}

function revokeSession(token) {
  db.prepare('UPDATE client_sessions SET status = ? WHERE token = ?').run('revoked', token);
}

module.exports = {
  genAppKey, genAppSecret, genClientToken,
  sign, verifySignature, verifyPublic, resolveApp, rateHit, buildSignPayload,
  issueSession, getSession, getSessionState, touchSession, requireClient, revokeSession, readClientToken,
  ACCESS_TTL, REFRESH_TTL, SIGN_WINDOW,
};

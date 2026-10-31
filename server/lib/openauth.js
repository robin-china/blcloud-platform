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
 * 签名内容：method\npath\ntimestamp\nnonce\nbodyRaw（body 为原始字符串）
 */
function verifySignature(req) {
  const appKey = String(req.headers['x-app-key'] || '');
  const timestamp = String(req.headers['x-timestamp'] || '');
  const nonce = String(req.headers['x-nonce'] || '');
  const signature = String(req.headers['x-signature'] || '');
  if (!appKey || !timestamp || !signature) return { ok: false, error: '缺少应用签名头' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SIGN_WINDOW) {
    return { ok: false, error: '签名已过期，请校准客户端时间' };
  }
  const app = db.prepare('SELECT * FROM open_apps WHERE app_key = ?').get(appKey);
  if (!app) return { ok: false, error: 'app_key 不存在' };
  if (app.status !== 'active') return { ok: false, error: '应用已停用' };

  const bodyRaw = typeof req.body === 'string'
    ? req.body
    : (req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : '');
  // 签名覆盖完整请求行（含查询串），避免查询参数被篡改
  const path = String(req.url || '').split('#')[0];
  const expect = crypto.createHmac('sha256', app.app_secret)
    .update(buildSignPayload(appKey, req.method, path, timestamp, nonce, bodyRaw))
    .digest('hex');
  if (!safeEqual(expect, signature)) return { ok: false, error: '签名校验失败' };
  // 验签通过后才登记 nonce，防止用无效签名消耗他人 nonce
  if (!consumeNonce(appKey, nonce)) return { ok: false, error: 'nonce 已使用，请求重复' };
  return { ok: true, app };
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

function getSession(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM client_sessions WHERE token = ?').get(token);
  if (!s) return null;
  if (s.status !== 'active') return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  return s;
}

function touchSession(s, ip) {
  db.prepare('UPDATE client_sessions SET last_seen_at = ?, ip = ? WHERE id = ?').run(now(), ip || s.ip || '', s.id);
}

async function requireClient(req, reply) {
  const s = getSession(readClientToken(req));
  if (!s) {
    reply.code(401).send({ error: '未授权或令牌已过期', code: 'UNAUTHORIZED' });
    return null;
  }
  const app = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(s.app_id);
  if (!app || app.status !== 'active') {
    reply.code(401).send({ error: '应用已停用', code: 'APP_DISABLED' });
    return null;
  }
  req.session = s;
  req.app = app;
  return s;
}

function revokeSession(token) {
  db.prepare('UPDATE client_sessions SET status = ? WHERE token = ?').run('revoked', token);
}

module.exports = {
  genAppKey, genAppSecret, genClientToken,
  sign, verifySignature, buildSignPayload,
  issueSession, getSession, touchSession, requireClient, revokeSession, readClientToken,
  ACCESS_TTL, REFRESH_TTL, SIGN_WINDOW,
};

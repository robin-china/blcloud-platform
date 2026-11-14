/* 后台登录安全：双维限流 / 一次性图形挑战 / PoW / TOTP / 恢复码。
 * 2026-11-14。零新依赖：验证码是自绘 SVG，TOTP 自实现 RFC6238。
 * 设计前提：验证码只是摩擦层，真正挡自动化的是服务端尝试次数上限 + 第二因素。
 */
const crypto = require('crypto');
const db = require('../db');
const { now, hashPassword, verifyPassword } = require('./util');
const { getSetting } = require('./config');
const { getMasterKey, encrypt, decrypt } = require('./crypto');
// 前后端共用同一份 PoW 算法，避免「前端算得出、服务端验不过」
const pow = require('../../public/assets/pow.js');

const CAPTCHA_TTL = 120;   // 秒
const TWOFA_TTL = 300;     // 秒
const CHALLENGE_RATE = 20; // 每 IP 每分钟可领挑战数
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/* ---------------------------------------------------------------- 基础工具 */

function clientIp(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 64);
}

function hmac(text) {
  return crypto.createHmac('sha256', getMasterKey()).update(String(text)).digest('hex');
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/** 直接写审计表：登录时还没有 req.admin，不能走 logAdmin(req)。 */
function audit(action, detail = '', adminId = 0, adminName = '') {
  try {
    db.prepare('INSERT INTO admin_logs (admin_id, admin_name, action, detail, created_at) VALUES (?,?,?,?,?)')
      .run(adminId, adminName, action, String(detail || '').slice(0, 500), now());
  } catch { /* 审计失败不能影响登录主流程 */ }
}

const buckets = new Map();
function rateHit(key, limit, windowMs) {
  const t = Date.now();
  const b = buckets.get(key);
  if (!b || t - b.start >= windowMs) {
    buckets.set(key, { start: t, n: 1 });
    return true;
  }
  b.n += 1;
  if (buckets.size > 20000) buckets.clear();
  return b.n <= limit;
}

/* ---------------------------------------------------------------- L0 闸门 */

/**
 * 双维锁定：同一账号（分布式撞库）或同一 IP（换用户名扫号）任一超限就拦。
 * 退避分级：5 次起锁 15 分钟，再犯 30 / 60 / 120 分钟，上限 24 小时。
 * 用 DB 计数而非内存：进程重启后锁定状态仍在。
 */
function guard(username, ip) {
  const u = String(username || '');
  const p = String(ip || '');
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const row = db.prepare(`SELECT COUNT(*) AS c, MAX(created_at) AS last FROM login_attempts
    WHERE (username = ? OR ip = ?) AND success = 0 AND created_at > ?`).get(u, p, since);
  const fails = Number(row.c) || 0;
  if (fails >= 5) {
    const tier = Math.floor((fails - 5) / 5);
    const minutes = Math.min(15 * Math.pow(2, tier), 1440);
    const until = new Date(row.last).getTime() + minutes * 60000;
    if (Date.now() < until) {
      return { blocked: true, retryAfterMinutes: Math.ceil((until - Date.now()) / 60000), fails };
    }
  }
  const limit = Math.max(5, Math.trunc(Number(getSetting('admin_login_ip_limit', '30')) || 30));
  const since15 = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const ipCount = Number(db.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND created_at > ?')
    .get(p, since15).c) || 0;
  if (ipCount >= limit) return { blocked: true, retryAfterMinutes: 15, fails, reason: 'ip', ipCount };
  return { blocked: false, fails, ipCount };
}

function recordAttempt(username, ip, success, extra = '') {
  try {
    db.prepare('INSERT INTO login_attempts (username, ip, success, created_at) VALUES (?,?,?,?)')
      .run(String(username || ''), String(ip || ''), success ? 1 : 0, now());
  } catch { /* ignore */ }
  audit(success ? '登录成功' : '登录失败', `账号=${String(username || '').slice(0, 64)} IP=${ip}${extra ? ' ' + extra : ''}`);
}

/** 成功登录只清失败记录，保留成功记录用于「异地登录」比对。 */
function clearFailures(username, ip) {
  try {
    db.prepare('DELETE FROM login_attempts WHERE username = ? AND success = 0').run(String(username || ''));
    db.prepare('DELETE FROM login_attempts WHERE ip = ? AND success = 0').run(String(ip || ''));
  } catch { /* ignore */ }
}

/** 用户名不存在时也跑一次 scrypt，消除「账号是否存在」的响应时间差。 */
const DUMMY_HASH = hashPassword('__blcloud_admin_dummy__');
function checkPassword(plain, admin) {
  const ok = verifyPassword(String(plain || ''), admin ? admin.password_hash : DUMMY_HASH);
  return !!admin && ok;
}

function lastLoginIp(adminId) {
  const row = db.prepare("SELECT ip FROM login_attempts WHERE success = 1 AND username = (SELECT username FROM admins WHERE id = ?) ORDER BY id DESC LIMIT 1").get(adminId);
  return row ? String(row.ip || '') : '';
}

/* ---------------------------------------------------------------- L1 图形挑战 */

/** 7 段数码管：字符全部由 <path> 画出，SVG 里没有 <text>，读 DOM 拿不到答案。 */
const SEGMENTS = {
  a: [4, 3, 16, 3], g: [4, 17, 16, 17], d: [4, 31, 16, 31],
  f: [3, 5, 3, 14], b: [17, 5, 17, 14],
  e: [3, 20, 3, 29], c: [17, 20, 17, 29],
};
const DIGITS = {
  0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg',
  5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
};

function renderCaptcha(answer) {
  const chars = String(answer).split('');
  const colors = ['#1f3a5f', '#2f5d50', '#5a3b6b', '#7a4030', '#2b4b6a'];
  let body = '<rect width="168" height="48" rx="6" fill="#f4f6f8"/>';
  // 干扰线先画，字符压在上面
  for (let i = 0; i < 10; i += 1) {
    const x1 = crypto.randomInt(0, 168); const y1 = crypto.randomInt(0, 48);
    const x2 = crypto.randomInt(0, 168); const y2 = crypto.randomInt(0, 48);
    body += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#c7d1dc" stroke-width="1" opacity="0.8"/>`;
  }
  for (let i = 0; i < 26; i += 1) {
    body += `<circle cx="${crypto.randomInt(0, 168)}" cy="${crypto.randomInt(0, 48)}" r="1" fill="#b9c6d3" opacity="0.7"/>`;
  }
  chars.forEach((ch, i) => {
    const color = colors[crypto.randomInt(0, colors.length)];
    const dx = 8 + i * 40 + crypto.randomInt(-2, 3);
    const dy = 6 + crypto.randomInt(-2, 3);
    const rot = crypto.randomInt(-9, 10);
    let g = `<g transform="translate(${dx},${dy}) rotate(${rot} 10 17)" stroke="${color}" stroke-width="2.6" stroke-linecap="round" fill="none">`;
    for (const s of DIGITS[ch] || '') {
      const [x1, y1, x2, y2] = SEGMENTS[s];
      g += `<path d="M${x1} ${y1}L${x2} ${y2}"/>`;
    }
    g += '</g>';
    body += g;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="168" height="48" viewBox="0 0 168 48" role="img">${body}</svg>`;
}

function captchaMode() {
  const m = String(getSetting('admin_captcha_mode', 'risk') || 'risk').trim();
  return ['off', 'risk', 'always'].includes(m) ? m : 'risk';
}

/** 条件触发：正常管理员不弹码，撞库者第二次失败起就要过挑战。 */
function captchaRequired(username, ip) {
  const mode = captchaMode();
  if (mode === 'off') return { required: false, mode };
  if (mode === 'always') return { required: true, mode };
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const fails = Number(db.prepare(`SELECT COUNT(*) AS c FROM login_attempts
    WHERE (username = ? OR ip = ?) AND success = 0 AND created_at > ?`)
    .get(String(username || ''), String(ip || ''), since).c) || 0;
  const limit = Math.max(5, Math.trunc(Number(getSetting('admin_login_ip_limit', '30')) || 30));
  const ipCount = Number(db.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND created_at > ?')
    .get(String(ip || ''), since).c) || 0;
  return { required: fails >= 2 || ipCount >= limit, mode, fails, ipCount };
}

function createChallenge({ ip, ua, purpose = 'captcha', adminId = 0 }) {
  const id = `ach_${crypto.randomBytes(16).toString('hex')}`;
  let answer = ''; let svg = ''; let answerHmac = ''; let powSeed = '';
  if (purpose === 'captcha') {
    answer = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    svg = renderCaptcha(answer);
    answerHmac = hmac(answer);
    powSeed = crypto.randomBytes(16).toString('hex');
  }
  const ttl = purpose === 'captcha' ? CAPTCHA_TTL : TWOFA_TTL;
  db.prepare(`INSERT INTO admin_challenges
    (id, purpose, answer_hmac, pow_seed, admin_id, ip, ua, expires_at, used_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,'',?)`).run(
    id, purpose, answerHmac, powSeed, adminId || 0, String(ip || ''), String(ua || '').slice(0, 200),
    new Date(Date.now() + ttl * 1000).toISOString(), now());
  return { id, svg, powSeed, difficulty: pow.DIFFICULTY, expiresIn: ttl };
}

/**
 * 一次性消费：先置 used_at 再校验答案，同一个挑战不可能被拿来试多个答案。
 * 返回 { ok, code }，code 用于前端决定「刷新验证码」还是「提示重输」。
 */
function consumeChallenge({ id, ip, purpose = 'captcha', answer = '', powNonce = '' }) {
  const row = db.prepare('SELECT * FROM admin_challenges WHERE id = ?').get(String(id || ''));
  if (!row || row.purpose !== purpose) return { ok: false, code: 'CHALLENGE_INVALID' };
  if (row.used_at) return { ok: false, code: 'CHALLENGE_USED' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, code: 'CHALLENGE_EXPIRED' };
  if (String(row.ip || '') !== String(ip || '')) return { ok: false, code: 'CHALLENGE_IP_MISMATCH' };
  const claimed = db.prepare("UPDATE admin_challenges SET used_at = ? WHERE id = ? AND used_at = ''").run(now(), row.id);
  if (claimed.changes !== 1) return { ok: false, code: 'CHALLENGE_USED' };
  if (purpose === 'captcha') {
    const a = Buffer.from(hmac(String(answer || '').trim()), 'hex');
    const b = Buffer.from(String(row.answer_hmac || ''), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, code: 'CAPTCHA_WRONG' };
    if (!pow.verify(row.pow_seed, powNonce, pow.DIFFICULTY)) return { ok: false, code: 'POW_INVALID' };
  }
  return { ok: true, row };
}

/* ---------------------------------------------------------------- L2 TOTP */

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0; let value = 0; const out = [];
  for (const c of String(str).toUpperCase().replace(/=+$/, '')) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function totpCode(secret, step) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(0, 0);
  buf.writeUInt32BE(step >>> 0, 4);
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = mac[19] & 0x0f;
  return String((mac.readUInt32BE(off) & 0x7fffffff) % 1000000).padStart(6, '0');
}

/** ±1 步容差（30 秒），允许手机与服务器轻微时钟偏差。 */
function verifyTotp(secret, code) {
  if (!/^\d{6}$/.test(String(code || ''))) return false;
  const step = Math.floor(Date.now() / 30000);
  for (const s of [step - 1, step, step + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(totpCode(secret, s)), Buffer.from(String(code)))) return true;
  }
  return false;
}

function otpauthUri(username, secret) {
  const label = encodeURIComponent(`blcloud-admin:${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=blcloud&algorithm=SHA1&digits=6&period=30`;
}

function readSecret(admin) {
  return decrypt(admin.totp_secret || '');
}

function issueRecoveryCodes(adminId, count = 10) {
  db.prepare('DELETE FROM admin_recovery_codes WHERE admin_id = ?').run(adminId);
  const plain = [];
  const ins = db.prepare('INSERT INTO admin_recovery_codes (admin_id, code_hash, used_at, created_at) VALUES (?,?,\'\',?)');
  for (let i = 0; i < count; i += 1) {
    const code = crypto.randomBytes(5).toString('hex').toUpperCase();
    plain.push(code);
    ins.run(adminId, sha256(code), now());
  }
  return plain;
}

function useRecoveryCode(adminId, code) {
  const row = db.prepare("SELECT * FROM admin_recovery_codes WHERE admin_id = ? AND code_hash = ? AND used_at = ''")
    .get(adminId, sha256(String(code || '').toUpperCase().trim()));
  if (!row) return false;
  return db.prepare("UPDATE admin_recovery_codes SET used_at = ? WHERE id = ? AND used_at = ''")
    .run(now(), row.id).changes === 1;
}

function recoveryLeft(adminId) {
  return Number(db.prepare("SELECT COUNT(*) AS c FROM admin_recovery_codes WHERE admin_id = ? AND used_at = ''")
    .get(adminId).c) || 0;
}

module.exports = {
  clientIp, hmac, sha256, audit, rateHit,
  guard, recordAttempt, clearFailures, checkPassword, lastLoginIp,
  captchaMode, captchaRequired, createChallenge, consumeChallenge, renderCaptcha,
  CAPTCHA_TTL, TWOFA_TTL, CHALLENGE_RATE,
  newTotpSecret, totpCode, verifyTotp, otpauthUri, readSecret,
  issueRecoveryCodes, useRecoveryCode, recoveryLeft,
  encryptSecret: encrypt,
};

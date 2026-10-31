const crypto = require('crypto');

function now() {
  return new Date().toISOString();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(plain, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split(':');
    if (scheme !== 'scrypt') return false;
    const test = crypto.scryptSync(String(plain), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
  } catch {
    return false;
  }
}

function genOrderNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `NO${stamp}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function genLicenseKey() {
  const block = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `LIC-${block()}${block()}-${block()}${block()}-${block()}${block()}`;
}

function genApiKey() {
  return `ak_${crypto.randomBytes(16).toString('hex')}`;
}

function genScene() {
  return crypto.randomBytes(8).toString('hex');
}

function genCode(len = 6) {
  return String(crypto.randomInt(0, Math.pow(10, len))).padStart(len, '0');
}

function randomPassword(len = 14) {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(0, chars.length)];
  return out;
}

function pick(row, keys) {
  if (!row) return row;
  const out = {};
  for (const k of keys) if (k in row) out[k] = row[k];
  return out;
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text || '');
  } catch {
    return fallback;
  }
}

module.exports = {
  now, today, hashPassword, verifyPassword, genOrderNo, genLicenseKey,
  genApiKey, genScene, genCode, pick, safeJson, randomPassword,
};

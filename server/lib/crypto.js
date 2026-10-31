const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SECRET_FILE = path.join(DATA_DIR, '.appsecret');

let masterKey = null;

function getMasterKey() {
  if (masterKey) return masterKey;
  let raw;
  if (fs.existsSync(SECRET_FILE)) {
    raw = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } else {
    raw = crypto.randomBytes(32).toString('hex');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SECRET_FILE, raw, { mode: 0o600 });
  }
  masterKey = crypto.scryptSync(raw, 'app-config-v1', 32);
  return masterKey;
}

// 敏感配置以 enc: 前缀存储
function encrypt(plain) {
  if (plain === '' || plain == null) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

function decrypt(stored) {
  if (!stored) return '';
  if (!String(stored).startsWith('enc:')) return String(stored);
  try {
    const [, ivB, tagB, dataB] = String(stored).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function mask(stored) {
  if (!stored) return '';
  const plain = decrypt(stored);
  if (!plain) return '';
  if (plain.length <= 8) return '*'.repeat(plain.length);
  return `${plain.slice(0, 4)}${'*'.repeat(Math.min(12, plain.length - 8))}${plain.slice(-4)}`;
}

module.exports = { encrypt, decrypt, mask, getMasterKey };

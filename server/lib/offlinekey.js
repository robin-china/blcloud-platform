/**
 * 离线授权票据的签名密钥（Ed25519）。
 *
 * 为什么不是 HMAC：HMAC 要靠「同一把密钥」验证，而客户端里必然带着验证方式，
 * 密钥一旦进了客户端就等于公开，随便就能伪造一张永久票据。
 * 非对称签名只有私钥能签，客户端只拿公钥验签 —— 公钥泄露无所谓。
 *
 * 私钥落盘在 data/offline-signing-key.json（0600）。这个文件丢了不影响登录，
 * 只会让已发出的离线票据全部验不过（客户端会退化成联网校验），
 * 所以备份 data 目录时它和 .appsecret 一起备。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const KEY_FILE = process.env.OFFLINE_KEY_PATH || path.join(DATA_DIR, 'offline-signing-key.json');

let cache = null;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function kidOf(pubPem) {
  const der = crypto.createPublicKey(pubPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

function load() {
  if (cache) return cache;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  } catch { raw = null; }
  if (!raw || !raw.private_key || !raw.public_key) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    raw = {
      alg: 'Ed25519',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      public_key: publicKey.export({ type: 'spki', format: 'pem' }),
      created_at: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
      fs.writeFileSync(KEY_FILE, JSON.stringify(raw, null, 2), { mode: 0o600 });
    } catch (e) {
      console.error('[offline-key] 写入失败（重启后旧票据将全部失效）：', e.message);
    }
  }
  cache = {
    privateKey: crypto.createPrivateKey(raw.private_key),
    publicKey: raw.public_key,
    kid: kidOf(raw.public_key),
  };
  return cache;
}

/** 规范化 JSON：键排序后序列化，避免客户端与服务端字段顺序不同导致验签失败 */
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/**
 * 生成票据：`v1.<payload_b64url>.<sig_b64url>`
 * 客户端拿三段拼回去验签即可，不需要任何额外格式知识。
 */
function issue(payload) {
  const { privateKey, publicKey, kid } = load();
  const body = b64url(Buffer.from(canonical(payload), 'utf8'));
  const sig = crypto.sign(null, Buffer.from(body, 'utf8'), privateKey);
  return {
    ticket: `v1.${body}.${b64url(sig)}`,
    alg: 'Ed25519',
    kid,
    payload,
    public_key: publicKey,
  };
}

/** 验签（服务端自测 / 排障用；客户端按文档自行实现同一逻辑） */
function verify(ticket, publicKeyPem) {
  const s = String(ticket || '');
  const parts = s.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, code: 'TICKET_FORMAT' };
  const pem = publicKeyPem || load().publicKey;
  const body = parts[1];
  const sig = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  try {
    const ok = crypto.verify(null, Buffer.from(body, 'utf8'), crypto.createPublicKey(pem), sig);
    if (!ok) return { ok: false, code: 'TICKET_SIGNATURE_INVALID' };
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return { ok: true, payload };
  } catch (e) {
    return { ok: false, code: 'TICKET_SIGNATURE_INVALID', error: e.message };
  }
}

function publicKey() {
  const { publicKey: pem, kid } = load();
  return { alg: 'Ed25519', kid, public_key: pem };
}

module.exports = { issue, verify, publicKey, canonical, kid: () => load().kid, KEY_FILE };

/**
 * 通用 Ed25519 签名密钥仓（清单签名 / 权益快照签名共用）。
 *
 * 为什么每类签名各用一把独立密钥：
 *  - 清单公钥要内嵌进安装包，是最容易被逆出来的那一把；
 *  - 权益公钥决定「客户端认为你有什么功能」，价值更高；
 *  - 离线票据（lib/offlinekey.js）已经有自己的一把。
 * 复用同一把密钥 = 任何一把泄露都能连带伪造另外两类内容，所以必须分开。
 *
 * 私钥落盘在 data/<file>（0600），与 .appsecret 一起备份；
 * 丢了只是「已发出的签名全部验不过」，重新生成 + 重发客户端公钥即可。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

/** 与 offlinekey.canonical 完全一致的规范化：键排序、紧凑、数组保序、UTF-8 */
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

function sha256(s) {
  return crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}

function createKeyStore({ file, kidPrefix, envVar }) {
  const KEY_FILE = (envVar && process.env[envVar]) || path.join(DATA_DIR, file);
  let cache = null;

  function load() {
    if (cache) return cache;
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    } catch { raw = null; }
    if (!raw || !raw.private_key || !raw.public_key) {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
      const created = new Date();
      raw = {
        alg: 'Ed25519',
        // kid 形如 manifest-2026-11 / ent-2026-11：跟着密钥生成月份走，
        // 轮换后客户端能按 kid 同时认新旧两把公钥
        kid: `${kidPrefix}-${created.toISOString().slice(0, 7)}`,
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        public_key: publicKey.export({ type: 'spki', format: 'pem' }),
        created_at: created.toISOString(),
      };
      try {
        fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
        fs.writeFileSync(KEY_FILE, JSON.stringify(raw, null, 2), { mode: 0o600 });
      } catch (e) {
        console.error(`[signkey:${kidPrefix}] 写入失败（重启后旧签名将全部失效）：`, e.message);
      }
    }
    cache = {
      privateKey: crypto.createPrivateKey(raw.private_key),
      publicKey: raw.public_key,
      kid: raw.kid || `${kidPrefix}-${String(raw.created_at || '').slice(0, 7)}`,
      created_at: raw.created_at || '',
    };
    return cache;
  }

  /**
   * 对对象签名：先剔除签名字段，再把 kid 放进被签内容（防止换 kid 混淆），
   * 最后对 canonical 的字节串做 Ed25519。
   * 返回新对象，不改原对象 —— 调用方可能还要拿原对象做别的事。
   */
  function signObject(obj, sigField = 'signature', kidField = 'kid') {
    const { privateKey, kid } = load();
    const body = {};
    for (const k of Object.keys(obj || {})) {
      if (k === sigField || k === kidField) continue;
      body[k] = obj[k];
    }
    body[kidField] = kid;
    const canon = canonical(body);
    const sig = crypto.sign(null, Buffer.from(canon, 'utf8'), privateKey);
    body[sigField] = sig.toString('base64');
    return body;
  }

  /** 验签（服务端自测 / 排障用）；返回 { ok, canonical, sha256 } */
  function verifyObject(obj, sigField = 'signature', kidField = 'kid', publicKeyPem) {
    const src = obj || {};
    const sigB64 = String(src[sigField] || '');
    if (!sigB64) return { ok: false, code: 'SIGNATURE_MISSING' };
    const body = {};
    for (const k of Object.keys(src)) {
      if (k === sigField) continue;
      body[k] = src[k];
    }
    const canon = canonical(body);
    try {
      const ok = crypto.verify(
        null,
        Buffer.from(canon, 'utf8'),
        crypto.createPublicKey(publicKeyPem || load().publicKey),
        Buffer.from(sigB64, 'base64')
      );
      return { ok, canonical: canon, sha256: sha256(canon), kid: String(src[kidField] || '') };
    } catch (e) {
      return { ok: false, code: 'SIGNATURE_INVALID', error: e.message, canonical: canon, sha256: sha256(canon) };
    }
  }

  /** 签一段原始文本（票据类用） */
  function signText(text) {
    const { privateKey } = load();
    return crypto.sign(null, Buffer.from(String(text), 'utf8'), privateKey).toString('base64');
  }

  function info() {
    const k = load();
    return { alg: 'Ed25519', kid: k.kid, public_key: k.publicKey, created_at: k.created_at };
  }

  return {
    kid: () => load().kid,
    publicKey: () => load().publicKey,
    info,
    signObject,
    verifyObject,
    signText,
    canonical,
    sha256,
    KEY_FILE,
  };
}

module.exports = { createKeyStore, canonical, sha256 };

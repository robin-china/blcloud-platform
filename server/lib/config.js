const db = require('../db');
const { now, safeJson } = require('./util');
const { encrypt, decrypt, mask } = require('./crypto');

const SENSITIVE = {
  wechat: ['appsecret', 'token', 'aes_key'],
  // 注意：微信支付公钥（pub_key）与平台证书是公开信息，只用来验签，不加密。
  // 一旦加密就受「留空表示不修改」约束，管理员将无法清掉填错的公钥，会把自己锁死在错误模式上。
  wxpay: ['api_v3_key', 'private_key', 'mch_cert_serial'],
  alipay: ['private_key', 'alipay_public_key'],
  tb: ['password'],
  sms: ['secret'],
};

const DEFAULTS = {
  wechat: {
    enabled: 0, appid: '', appsecret: '', token: '', aes_key: '',
    verify_type: 'simulate', qr_mode: 'ticket',
  },
  wxpay: {
    enabled: 0, mchid: '', appid: '', api_v3_key: '', mch_cert_serial: '',
    private_key: '', notify_url: '', trade_type: 'NATIVE',
    // 微信支付公钥模式（2024 年起新商户无法下载平台证书，必须改用公钥验签）
    pub_key_id: '', pub_key: '', platform_cert: '',
  },
  alipay: {
    enabled: 0, appid: '', private_key: '', alipay_public_key: '',
    notify_url: '', gateway: 'https://openapi.alipay.com/gateway.do', sandbox: 0,
  },
  tb: {
    enabled: 0, base_url: '', username: '', password: '',
    email_suffix: '@blcloud.cn', default_customer: '', device_profile: '',
  },
  sms: {
    enabled: 0, vendor: 'simulate', access_key: '', secret: '', sign_name: '', template_code: '',
  },
};

/**
 * 部署基础路径。用于把整套系统挂在子路径下，例如：
 *   BASE_PATH=platform  →  管理后台 /platform/admin/，接口 /platform/api/...
 * 不设置（或设为 /）时为根路径部署，行为与之前完全一致。
 * 注意：前后端必须一致，前端由页面 URL 自动推断，无需额外配置。
 */
function basePath() {
  const p = String(process.env.BASE_PATH || '').trim();
  if (!p || p === '/') return '';
  return '/' + p.replace(/^\/+|\/+$/g, '');
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
  ).run(key, String(value), now());
}

/**
 * 演示/联调后门总开关。
 * 显式设置 dev_simulate=1/0 优先；未设置时，仅非生产环境（NODE_ENV!=production）允许。
 * 生产部署请设 NODE_ENV=production，或在后台「用户与支付规则」中显式关闭。
 */
function devMode() {
  const v = getSetting('dev_simulate', '');
  if (v === '1') return true;
  if (v === '0') return false;
  return process.env.NODE_ENV !== 'production';
}

function allSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function getConfig(name) {
  const raw = getSetting(`cfg.${name}`, '');
  const stored = safeJson(raw, {});
  const base = { ...(DEFAULTS[name] || {}) };
  const out = { ...base, ...stored };
  for (const f of SENSITIVE[name] || []) {
    out[f] = decrypt(out[f] || '');
  }
  return out;
}

function setConfig(name, patch) {
  const cur = getConfig(name);
  const next = { ...cur, ...patch };
  const toStore = { ...next };
  // 敏感字段传空表示不修改，保留原值
  for (const f of SENSITIVE[name] || []) {
    toStore[f] = encrypt(next[f] ? next[f] : (cur[f] || ''));
  }
  setSetting(`cfg.${name}`, JSON.stringify(toStore));
  return getConfig(name);
}

function getConfigMasked(name) {
  const cfg = getConfig(name);
  const out = { ...cfg };
  for (const f of SENSITIVE[name] || []) {
    if (out[f]) out[f] = mask(encrypt(out[f]));
  }
  return out;
}

module.exports = { basePath, getSetting, setSetting, allSettings, getConfig, setConfig, getConfigMasked, devMode, SENSITIVE, DEFAULTS };

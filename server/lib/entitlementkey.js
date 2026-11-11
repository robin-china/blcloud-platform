/**
 * 权益快照签名密钥（kid 形如 ent-2026-11）。
 * 与清单签名、离线票据签名三把密钥互相独立：任意一把泄露都不该牵连另外两类内容。
 */
const { createKeyStore } = require('./signkey');

module.exports = createKeyStore({
  file: 'entitlement-signing-key.json',
  kidPrefix: 'ent',
  envVar: 'ENTITLEMENT_KEY_PATH',
});

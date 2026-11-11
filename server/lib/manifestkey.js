/** 更新清单签名密钥（kid 形如 manifest-2026-11，公钥交付客户端内嵌） */
const { createKeyStore } = require('./signkey');

module.exports = createKeyStore({
  file: 'manifest-signing-key.json',
  kidPrefix: 'manifest',
  envVar: 'MANIFEST_KEY_PATH',
});

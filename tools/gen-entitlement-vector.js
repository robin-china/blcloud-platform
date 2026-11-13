#!/usr/bin/env node
/**
 * 权益快照签名 golden vector 生成器（跨端对齐用，不进生产链路）。
 *
 * 目的：给软件端一份「可复现」的样本 —— 同一份 entitlement、同一把测试私钥，
 * 服务端算出的 canonical UTF-8 字节串、sha256、Ed25519 签名都固定不变。
 * 客户端用向量里的公钥验签 + 比对 canonical/sha256，就能确认两端实现一致。
 *
 * 关键口径（与 server/lib/signkey.js signObject 完全一致）：
 *   signed = { ...entitlement（剔除 signature 与可选 kid）, kid: <entitlement_kid> }
 *   即「kid 参与签名」，canonical = 键字典序 + 紧凑 + 数组保序 + UTF-8。
 *   响应里的 entitlement_sig 是该对象里 signature 字段的 base64。
 *
 * 用法：node tools/gen-entitlement-vector.js
 * 注意：向量用的是**测试密钥**（kid=ent-vector-1），不是生产的 ent-2026-11，
 *       只用于校验 canonical/验签逻辑，禁止内嵌进客户端。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VECTOR_PRIVATE_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIJ67NONI2weT8np4t5wU3Hrit+HVXU+fWsgHpD66ufRN
-----END PRIVATE KEY-----
`;
const VECTOR_PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAyemrhERAFnZWBedF3vTr5kGBgdD5Q6g1nJK04W08gB8=
-----END PUBLIC KEY-----
`;
const VECTOR_KID = 'ent-vector-1';

// 让 entitlementkey 用向量密钥而不是生产密钥
const KEY_FILE = path.join(__dirname, '..', 'data', '.ent-vector-key.json');
fs.writeFileSync(KEY_FILE, JSON.stringify({
  alg: 'Ed25519',
  kid: VECTOR_KID,
  private_key: VECTOR_PRIVATE_PEM,
  public_key: VECTOR_PUBLIC_PEM,
  created_at: '2026-11-12T00:00:00.000Z',
  note: 'golden vector 专用测试密钥，禁止用于生产',
}, null, 2));
process.env.ENTITLEMENT_KEY_PATH = KEY_FILE;

const entitlementKey = require('../server/lib/entitlementkey');

/** 独立实现一遍 canonical，交叉校验不是「自己验自己」 */
function canonicalRef(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalRef).join(',') + ']';
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalRef(obj[k])).join(',') + '}';
}

function vector(name, ent) {
  const signed = entitlementKey.signObject(ent);
  // 客户端拿到的是：entitlement 对象 + entitlement_sig + entitlement_kid
  const signedBody = {};
  for (const k of Object.keys(signed)) if (k !== 'signature') signedBody[k] = signed[k];
  const canonical = canonicalRef(signedBody);
  const refCanonical = entitlementKey.canonical(signedBody);
  if (canonical !== refCanonical) throw new Error('canonical 实现不一致：' + name);
  const sha256 = crypto.createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
  const ok = crypto.verify(
    null,
    Buffer.from(canonical, 'utf8'),
    crypto.createPublicKey(VECTOR_PUBLIC_PEM),
    Buffer.from(signed.signature, 'base64')
  );
  return {
    name,
    entitlement: ent,
    entitlement_kid: signed.kid,
    entitlement_sig: signed.signature,
    signed_object: signedBody,
    canonical_utf8: canonical,
    canonical_sha256: sha256,
    verify_with_vector_pubkey: ok,
  };
}

// A：在线付费档（3+2 的 online-standard 示例），字段形状 = plans.licenseEntitlement(p)
const entA = {
  plan_code: 'member',
  plan_name: '在线会员版',
  plan_display_name: '在线会员版',
  billing: 'yearly',
  is_free: false,
  tier: 10,
  features: ['labelgo.basic', 'labelgo.library', 'labelgo.excel'],
  limits: { 'labelgo.library': 30, 'labelgo.excel_rows': 100 },
  seats: 1,
  offline_days: 3,
  online_required: 1,
  app_id: 3,
  product_id: 0,
  product_name: '在线会员版',
};

// B：历史商品授权 / 卡密池码（无档位）—— features 空数组、limits 空对象，最容易踩 canonical 坑
const entB = {
  plan_code: 'legacy',
  plan_name: '标准授权',
  billing: 'once',
  is_free: false,
  tier: 0,
  features: [],
  limits: {},
  seats: 1,
  offline_days: 0,
  online_required: 0,
  app_id: null,
  product_id: 12,
  product_name: '',
};

const out = {
  generated_at: new Date().toISOString(),
  alg: 'Ed25519',
  kid: VECTOR_KID,
  public_key: VECTOR_PUBLIC_PEM,
  signed_input: 'entitlement 对象剔除 signature/kid 后注入 kid（kid 参与签名）',
  signing_rule: 'canonical = 键字典序排序 + 紧凑分隔符 + 数组保序 + UTF-8；signature = base64(Ed25519(canonical))',
  vectors: [vector('A_online_standard', entA), vector('B_legacy_no_plan', entB)],
};

fs.unlinkSync(KEY_FILE);
console.log(JSON.stringify(out, null, 2));

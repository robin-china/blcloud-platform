/* 更新清单签名：canonical 黄金向量 + 动态/静态清单验签（Ed25519）
 *
 * 契约见 docs/客户端更新包接入.md §1.1。客户端要按同一份 canonical 规则实现，
 * 所以这里把「固定样本 → canonical 长度 + sha256」钉死：两边算出来不一样就是规则没对齐。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-manifest-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.MANIFEST_KEY_PATH = path.join(TMP, 'manifest-key.json');
process.env.ENTITLEMENT_KEY_PATH = path.join(TMP, 'ent-key.json');
process.env.UPDATES_DIR = path.join(TMP, 'updates');
process.env.NODE_ENV = 'test';

const { canonical, sha256 } = require('../server/lib/signkey');
const manifestKey = require('../server/lib/manifestkey');
const entitlementKey = require('../server/lib/entitlementkey');
const db = require('../server/db');
const release = require('../server/lib/release');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`); }
}

/* ---------------- 1. 黄金向量 ---------------- */
// 固定样本：字段集合就是客户端实际会收到的那份清单（不含 signature，含 kid）
const SAMPLE = {
  kid: 'manifest-2026-11',
  product: 'LabelGo',
  channel: 'stable',
  platform: 'win32',
  arch: 'x64',
  latest: '1.0.50',
  mandatory: false,
  minVersion: '1.0.0',
  current: '1.0.49',
  update_available: true,
  auto_update: true,
  server_time: '2026-11-11T00:00:00.000Z',
  report_url: 'https://www.bliot.cn/platform/api/open/v1/app/update-report',
  full: {
    url: 'https://www.bliot.cn/platform/updates/LabelGo/1.0.50/LabelGo-1.0.50-full.zip',
    sha256: 'a'.repeat(64),
    size: 34567890,
  },
  delta: [{
    from: '1.0.49',
    url: 'https://www.bliot.cn/platform/updates/LabelGo/1.0.50/LabelGo-1.0.49-to-1.0.50.diff.zip',
    sha256: 'b'.repeat(64),
    size: 1400000,
  }],
  rollout: 100,
  changelog: '修复若干问题',
};

const canon = canonical(SAMPLE);
ok('黄金向量 canonical 长度 779 B', Buffer.byteLength(canon, 'utf8') === 779, `${Buffer.byteLength(canon, 'utf8')}`);
ok('黄金向量 sha256 与文档一致',
  sha256(canon) === 'a6c9f696b03e2dc048bb4a0cf1f29d92babfcdcff56f205981a2184d256ebe26',
  sha256(canon));

// 键顺序无关：客户端 JSON.parse 后顺序变了也必须算出同一串
const reordered = {};
for (const k of Object.keys(SAMPLE).sort().reverse()) reordered[k] = SAMPLE[k];
ok('键顺序不影响 canonical', canonical(reordered) === canon);

// 数组顺序必须保留（delta 数组乱序 = 另一个签名）
const twoDeltas = { ...SAMPLE, delta: [...SAMPLE.delta, { ...SAMPLE.delta[0], from: '1.0.48' }] };
const shuffled = { ...twoDeltas, delta: [...twoDeltas.delta].reverse() };
ok('数组保序（乱序后 canonical 变化）', canonical(shuffled) !== canonical(twoDeltas));

// undefined 字段被忽略；null 参与签名
ok('undefined 不参与签名', canonical({ a: 1, b: undefined }) === '{"a":1}');
ok('null 参与签名', canonical({ a: null }) === '{"a":null}');

/* ---------------- 2. 密钥与签名 ---------------- */
const info = manifestKey.info();
ok('清单密钥为 Ed25519', info.alg === 'Ed25519');
ok('kid 形如 manifest-YYYY-MM', /^manifest-\d{4}-\d{2}$/.test(info.kid), info.kid);

const signed = manifestKey.signObject(SAMPLE);
ok('签名后带 signature/kid', !!signed.signature && signed.kid === 'manifest-2026-11');
ok('签名内容是 base64', Buffer.from(signed.signature, 'base64').length === 64);
ok('自身验签通过', manifestKey.verifyObject(signed).ok);

const tampered = { ...signed, latest: '9.9.9' };
ok('改版本号后验签失败', !manifestKey.verifyObject(tampered).ok);

// 换 kid 也必须失败：kid 在签名内容里
const kidSwap = { ...signed, kid: 'manifest-2020-01' };
ok('换 kid 后验签失败', !manifestKey.verifyObject(kidSwap).ok);

// 三把密钥互不复用
ok('清单与权益密钥不同', manifestKey.publicKey() !== entitlementKey.publicKey());
ok('权益 kid 前缀不同', entitlementKey.info().kid.startsWith('ent-'));

/* ---------------- 3. 动态清单（带 release 记录） ---------------- */
const ts = new Date().toISOString();
db.prepare(`INSERT INTO app_release
  (product, channel, platform, arch, version, full_path, full_url, full_sha256, full_size, delta_json, mandatory, min_version, changelog, rollout, published_at, enabled, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  'LabelGo', 'stable', 'win32', 'x64', '1.0.51',
  '1.0.51/LabelGo-1.0.51-full.zip', '', crypto.createHash('sha256').update('pkg').digest('hex'),
  1234, JSON.stringify([{ from: '1.0.50', path: '1.0.51/LabelGo-1.0.50-to-1.0.51.diff.zip', sha256: 'c'.repeat(64), size: 100 }]),
  0, '1.0.0', '测试版本', 100, ts, 1, ts, ts
);

const m = release.manifest({ product: 'LabelGo', current: '1.0.50' }, 'https://example.com');
ok('动态清单有更新', m.update_available === true && m.latest === '1.0.51');
ok('动态清单带 signature/kid', !!m.signature && /^manifest-/.test(m.kid));
ok('动态清单验签通过', release.verifyManifest(m).ok);
ok('清单保留既有字段（latest/full/delta/minVersion/rollout/report_url）',
  !!m.full && Array.isArray(m.delta) && m.minVersion === '1.0.0' && m.rollout === 100 && !!m.report_url);
ok('动态清单 auto_update 默认 true', m.auto_update === true);

const noUpdate = release.manifest({ product: 'LabelGo', current: '1.0.51' }, 'https://example.com');
ok('无更新响应也签名', !noUpdate.update_available && release.verifyManifest(noUpdate).ok);

/* ---------------- 4. 静态兜底清单 ---------------- */
release.writeLatest('https://example.com');
const latestFile = path.join(process.env.UPDATES_DIR, 'LabelGo', 'latest.json');
ok('写出 <产品>/latest.json', fs.existsSync(latestFile));
const latestBody = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
ok('静态 latest.json 带签名且验签通过', !!latestBody.signature && release.verifyManifest(latestBody).ok);

const productsFile = path.join(process.env.UPDATES_DIR, 'products.json');
const productsBody = JSON.parse(fs.readFileSync(productsFile, 'utf8'));
ok('products.json 也加签', !!productsBody.signature && release.verifyManifest(productsBody).ok);

const rootFile = path.join(process.env.UPDATES_DIR, 'latest.json');
const rootBody = JSON.parse(fs.readFileSync(rootFile, 'utf8'));
ok('根 latest.json 也加签', !!rootBody.signature && release.verifyManifest(rootBody).ok);

/* ---------------- 5. 离线产品不进自动升级 ---------------- */
const off = release.manifest({ product: 'LabelGo-Offline', current: '1.0.50' }, 'https://example.com');
ok('LabelGo-Offline 默认 auto_update=false', off.auto_update === false);
ok('离线产品清单照样签名', release.verifyManifest(off).ok);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;

/* 开放接口双模鉴权（P0-1）+ 换票 seq/epoch（P0-6）+ 权益签名 —— 集成测试
 *
 * 覆盖：
 *  - 公开模式（仅 x-app-key + nonce）、HMAC 新旧密钥并存、关旧通道、关公开模式
 *  - auth_mode 落表（双模期判断「旧 HMAC 归零」的依据）
 *  - 激活 → 换票：seq 递增、机器码不匹配、停票生效、票验签
 *  - license.entitlement_sig 验签
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-open-auth-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.MANIFEST_KEY_PATH = path.join(TMP, 'manifest-key.json');
process.env.ENTITLEMENT_KEY_PATH = path.join(TMP, 'ent-key.json');
process.env.OFFLINE_KEY_PATH = path.join(TMP, 'offline-key.json');
process.env.UPDATES_DIR = path.join(TMP, 'updates');
process.env.NODE_ENV = 'test';

const { build } = require('../server/index');
const db = require('../server/db');
const { genAppKey, genAppSecret, sign } = require('../server/lib/openauth');
const offlineKey = require('../server/lib/offlinekey');
const entitlementKey = require('../server/lib/entitlementkey');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`); }
}

let nonceSeq = 0;
function hmac(appRow, secret, method, url, body) {
  const ts = String(Date.now());
  const nonce = `n${++nonceSeq}${Math.random().toString(36).slice(2, 8)}`;
  // 空对象必须签空串：服务端 verifySignature 对空 body 取 ''（与客户端约定一致）
  const raw = body && Object.keys(body).length ? JSON.stringify(body) : '';
  return {
    'x-app-key': appRow.app_key,
    'x-timestamp': ts,
    'x-nonce': nonce,
    'x-signature': sign(secret, appRow.app_key, method, url, ts, nonce, raw),
    'content-type': 'application/json',
  };
}
function pub(appRow, useNonce = true) {
  const h = { 'x-app-key': appRow.app_key, 'content-type': 'application/json' };
  if (useNonce) h['x-nonce'] = `p${++nonceSeq}${Math.random().toString(36).slice(2, 8)}`;
  return h;
}

(async () => {
  const ts = new Date().toISOString();
  const appKey = genAppKey();
  const secret = genAppSecret();
  db.prepare(`INSERT INTO open_apps (app_key, app_secret, name, status, offline_days, feature_schema, version, download_url, release_note, remark, release_product, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(appKey, secret, 'LabelGo 测试应用', 'active', 7, '[]', '1.0.50', '', '', '', 'LabelGo', ts);
  let appRow = db.prepare('SELECT * FROM open_apps WHERE app_key = ?').get(appKey);

  const productId = db.prepare(`INSERT INTO products (type, name, subtitle, description, category, price, original_price, icon, images, features, version, download_url, file_size, stock, is_official, status, sort, sku, created_at, updated_at)
    VALUES ('software','LabelGo 标准版','','','',0,0,'','[]','[]','1.0.50','','',0,1,'on',0,'online-standard',?,?)`)
    .run(ts, ts).lastInsertRowid;
  const userId = db.prepare(`INSERT INTO users (openid, nickname, status, created_at, last_login_at) VALUES (?,?,?,?,?)`)
    .run('test_openid_1', '测试用户', 'active', ts, ts).lastInsertRowid;
  const licKey = 'LIC-TESTAAAA-BBBBBBBB-CCCCCCCC';
  const licId = db.prepare(`INSERT INTO licenses (license_key, user_id, app_id, product_id, type, max_devices, start_at, end_at, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(licKey, userId, appRow.id, productId, 'subscription', 2, ts, new Date(Date.now() + 30 * 86400000).toISOString(), 'active', ts).lastInsertRowid;

  const app = build();
  await app.ready();

  /* ---------------- 1. 公开模式 ---------------- */
  let r = await app.inject({ method: 'POST', url: '/api/open/v1/auth/qrcode', headers: pub(appRow), payload: {} });
  ok('公开模式：仅 x-app-key + nonce 可用', r.statusCode === 200, `${r.statusCode} ${r.body.slice(0, 120)}`);

  r = await app.inject({ method: 'POST', url: '/api/open/v1/auth/qrcode', headers: pub(appRow, false), payload: {} });
  ok('公开模式：写请求缺 nonce 被拒', r.statusCode === 401 && JSON.parse(r.body).code === 'NONCE_REQUIRED', r.body.slice(0, 120));

  r = await app.inject({ method: 'POST', url: '/api/open/v1/auth/qrcode', headers: { 'content-type': 'application/json' }, payload: {} });
  ok('无任何鉴权信息 → 401 UNAUTHORIZED', r.statusCode === 401 && JSON.parse(r.body).code === 'UNAUTHORIZED');

  /* ---------------- 2. HMAC 现有密钥 ---------------- */
  r = await app.inject({ method: 'POST', url: '/api/open/v1/auth/qrcode', headers: hmac(appRow, secret, 'POST', '/api/open/v1/auth/qrcode'), payload: {} });
  ok('HMAC 当前密钥可用', r.statusCode === 200, `${r.statusCode} ${r.body.slice(0, 120)}`);

  /* ---------------- 3. 轮换：旧值并存 ---------------- */
  const oldSecret = secret;
  const newSecret = genAppSecret();
  db.prepare('UPDATE open_apps SET app_secret_prev = ?, app_secret = ?, legacy_hmac = 1 WHERE id = ?')
    .run(oldSecret, newSecret, appRow.id);
  appRow = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(appRow.id);

  r = await app.inject({ method: 'POST', url: '/api/open/v1/auth/qrcode', headers: hmac(appRow, newSecret, 'POST', '/api/open/v1/auth/qrcode'), payload: {} });
  ok('轮换后新密钥可用', r.statusCode === 200);
  r = await app.inject({ method: 'POST', url: '/api/open/v1/auth/qrcode', headers: hmac(appRow, oldSecret, 'POST', '/api/open/v1/auth/qrcode'), payload: {} });
  ok('双模期旧密钥仍可用', r.statusCode === 200, `${r.statusCode}`);

  /* ---------------- 4. 关旧通道 / 关公开模式 ---------------- */
  db.prepare('UPDATE open_apps SET legacy_hmac = 0 WHERE id = ?').run(appRow.id);
  appRow = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(appRow.id);
  r = await app.inject({ method: 'POST', url: '/api/open/v1/auth/qrcode', headers: hmac(appRow, oldSecret, 'POST', '/api/open/v1/auth/qrcode'), payload: {} });
  ok('关闭旧通道后旧密钥 401 APP_SECRET_RETIRED', r.statusCode === 401 && JSON.parse(r.body).code === 'APP_SECRET_RETIRED', r.body.slice(0, 120));
  r = await app.inject({ method: 'POST', url: '/api/open/v1/auth/qrcode', headers: hmac(appRow, newSecret, 'POST', '/api/open/v1/auth/qrcode'), payload: {} });
  ok('关闭旧通道后新密钥不受影响', r.statusCode === 200);

  db.prepare('UPDATE open_apps SET public_auth = 0 WHERE id = ?').run(appRow.id);
  appRow = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(appRow.id);
  r = await app.inject({ method: 'POST', url: '/api/open/v1/auth/qrcode', headers: pub(appRow), payload: {} });
  ok('关闭公开模式后 401 PUBLIC_AUTH_DISABLED', r.statusCode === 401 && JSON.parse(r.body).code === 'PUBLIC_AUTH_DISABLED', r.body.slice(0, 120));
  db.prepare('UPDATE open_apps SET public_auth = 1 WHERE id = ?').run(appRow.id);
  appRow = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(appRow.id);

  /* ---------------- 5. auth_mode 流水 ---------------- */
  const modes = db.prepare('SELECT auth_mode, COUNT(*) AS c FROM open_auth_log GROUP BY auth_mode').all();
  const modeMap = Object.fromEntries(modes.map((m) => [m.auth_mode, m.c]));
  ok('auth_mode 记录 public', (modeMap.public || 0) >= 1, JSON.stringify(modeMap));
  ok('auth_mode 记录 hmac', (modeMap.hmac || 0) >= 1);
  ok('auth_mode 记录 hmac_legacy', (modeMap.hmac_legacy || 0) >= 1);

  /* ---------------- 6. 激活（公开模式）+ 权益签名 ---------------- */
  const MACHINE = 'MACHINE-TEST-0001';
  const body = { license_key: licKey, machine_code: MACHINE, version: '1.0.50', build_hash: 'abc123' };
  r = await app.inject({ method: 'POST', url: '/api/open/v1/auth/activate', headers: pub(appRow), payload: body });
  ok('公开模式可激活（带 machine_code）', r.statusCode === 200, `${r.statusCode} ${r.body.slice(0, 160)}`);
  const act = JSON.parse(r.body);
  ok('激活返回 access_token', !!act.access_token);
  ok('license 带 entitlement_sig/kid', !!act.license.entitlement_sig && /^ent-/.test(act.license.entitlement_kid || ''));
  const entVerify = entitlementKey.verifyObject({
    ...act.license.entitlement,
    signature: act.license.entitlement_sig,
    kid: act.license.entitlement_kid,
  });
  ok('权益快照验签通过', entVerify.ok, entVerify.code || '');
  ok('license 带 sku（权益维度）', act.license.sku === 'online-standard', act.license.sku);

  const token = act.access_token;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  /* ---------------- 7. 换票 seq / 机器绑定 ---------------- */
  r = await app.inject({ method: 'POST', url: '/api/open/v1/license/ticket', headers: auth, payload: { machine_code: MACHINE, build_hash: 'abc123', version: '1.0.50' } });
  ok('换票成功', r.statusCode === 200, `${r.statusCode} ${r.body.slice(0, 160)}`);
  let t1 = JSON.parse(r.body);
  ok('票 payload 带 seq=1', t1.payload.seq === 1 && t1.seq === 1, String(t1.seq));
  ok('票 payload 带 epoch=1', t1.payload.epoch === 1);
  ok('票绑定 machine_code / build_hash', t1.payload.machine_code === MACHINE && t1.payload.build_hash === 'abc123');
  ok('票验签通过', offlineKey.verify(t1.ticket).ok);
  ok('换票同时下发 entitlement_sig', !!t1.entitlement_sig && !!t1.entitlement_kid);

  r = await app.inject({ method: 'POST', url: '/api/open/v1/license/ticket', headers: auth, payload: { machine_code: MACHINE } });
  const t2 = JSON.parse(r.body);
  ok('第二次换票 seq 递增到 2', t2.seq === 2, String(t2.seq));

  r = await app.inject({ method: 'POST', url: '/api/open/v1/license/ticket', headers: auth, payload: { machine_code: 'OTHER-MACHINE' } });
  ok('换机换票被拒 403 MACHINE_MISMATCH', r.statusCode === 403 && JSON.parse(r.body).code === 'MACHINE_MISMATCH', r.body.slice(0, 120));

  /* ---------------- 8. 停票 ---------------- */
  db.prepare('UPDATE license_ticket_seq SET stopped_at = ?, stop_reason = ?, epoch = epoch + 1 WHERE license_id = ? AND machine_code = ?')
    .run(new Date().toISOString(), '测试停票', licId, MACHINE);
  r = await app.inject({ method: 'POST', url: '/api/open/v1/license/ticket', headers: auth, payload: { machine_code: MACHINE } });
  ok('停票后换票被拒 403 TICKET_STOPPED', r.statusCode === 403 && JSON.parse(r.body).code === 'TICKET_STOPPED', r.body.slice(0, 120));
  const seqRow = db.prepare('SELECT * FROM license_ticket_seq WHERE license_id = ? AND machine_code = ?').get(licId, MACHINE);
  ok('停票后 epoch 已 +1（旧票整批失效）', seqRow.epoch === 2, String(seqRow.epoch));

  /* ---------------- 9. 台账 ---------------- */
  const ledger = db.prepare('SELECT * FROM machine_ledger WHERE machine_code = ?').all(MACHINE);
  ok('台账记录机器 ↔ 授权 ↔ 构建', ledger.length >= 1 && ledger.some((x) => x.license_id === licId));
  ok('台账带升级通道产品与 seq', ledger.some((x) => x.product === 'LabelGo' && x.seq >= 1), JSON.stringify(ledger[0] || {}));

  /* ---------------- 10. 清单签名与公钥 ---------------- */
  r = await app.inject({ method: 'GET', url: '/api/open/v1/app/version?product=LabelGo&version=1.0.49' });
  ok('清单接口不需要鉴权', r.statusCode === 200);
  const mf = JSON.parse(r.body);
  ok('清单带 signature/kid', !!mf.signature && /^manifest-/.test(mf.kid || ''));
  ok('清单验签通过', require('../server/lib/manifestkey').verifyObject(mf).ok);

  r = await app.inject({ method: 'GET', url: '/api/open/v1/app/keys', headers: pub(appRow) });
  ok('公钥接口一次给三把', r.statusCode === 200 && !!JSON.parse(r.body).manifest && !!JSON.parse(r.body).entitlement && !!JSON.parse(r.body).offline);

  // 公钥非机密，但仍要求带应用标识（防批量爬取）；缺 key 要有明确错误码，
  // 否则客户端会把「构建期忘带 x-app-key」当成密钥配错
  r = await app.inject({ method: 'GET', url: '/api/open/v1/app/keys' });
  ok('公钥接口裸请求 → 401 APP_KEY_REQUIRED', r.statusCode === 401 && JSON.parse(r.body).code === 'APP_KEY_REQUIRED', r.body);

  await app.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

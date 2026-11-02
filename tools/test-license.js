/* 软件授权全链路自测：node tools/test-license.js
 * 覆盖：批量发码 / 授权码格式 / 激活 / 解绑即失效 / 吊销即踢 / 用户自助解绑
 * 使用独立测试库 data/test-license.db，不影响正式数据
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-license.db');
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
}
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';

const { build } = require('../server');
const db = require('../server/db');
const { now } = require('../server/lib/util');
const { deliverOrder } = require('../server/services/deliver');

const KEY_RE = /^LIC-[0-9A-F]{8}-[0-9A-F]{8}-[0-9A-F]{8}$/;

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 220) : '')); }
}

function signReq(secret, appKey, method, fullPath, bodyObj) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(6).toString('hex');
  const raw = bodyObj && Object.keys(bodyObj).length ? JSON.stringify(bodyObj) : '';
  const sig = crypto.createHmac('sha256', secret)
    .update([appKey, method.toUpperCase(), fullPath, timestamp, nonce, raw].join('\n'))
    .digest('hex');
  const headers = { 'x-app-key': appKey, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-signature': sig };
  if (raw) headers['content-type'] = 'application/json';
  return { headers, body: raw || undefined };
}

async function newUser(app, openid) {
  const scene = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode', payload: {} })).json().scene;
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${scene}`, payload: { openid, nickname: openid } });
  return (await app.inject({ method: 'GET', url: `/api/wechat/qrcode/${scene}` })).json();
}

(async () => {
  const app = build();
  await app.ready();

  const adminToken = (await app.inject({
    method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' },
  })).json().token;
  const AH = { authorization: 'Bearer ' + adminToken };

  const product = db.prepare("SELECT * FROM products WHERE type = 'software' LIMIT 1").get();
  const serviceProduct = db.prepare("SELECT * FROM products WHERE type = 'service' LIMIT 1").get();
  const u1 = await newUser(app, 'lic-user-1-' + Math.random().toString(36).slice(2, 6));
  const u2 = await newUser(app, 'lic-user-2-' + Math.random().toString(36).slice(2, 6));
  const U1 = { authorization: 'Bearer ' + u1.token };
  const U2 = { authorization: 'Bearer ' + u2.token };

  /* ---------- 1. 开放应用：离线宽限必须下发 ---------- */
  console.log('\n客户端读到离线宽限');
  const appRes = await app.inject({
    method: 'POST', url: '/api/open-apps', headers: AH,
    payload: { name: '授权测试应用', product_id: product.id, version: '1.0.0', offline_days: 7 },
  });
  const created = appRes.json();
  const AK = created.app_key;
  const AS = created.app_secret;
  check('创建开放应用', !!AK && !!AS, created);

  const verReq = signReq(AS, AK, 'GET', '/api/open/v1/app/version');
  const ver = await app.inject({ method: 'GET', url: '/api/open/v1/app/version', headers: verReq.headers });
  check('/app/version 返回 offline_days=7', ver.json().offline_days === 7, ver.json());

  /* ---------- 2. 后台批量发码 ---------- */
  console.log('\n批量发放授权码');
  const batch = await app.inject({
    method: 'POST', url: '/api/licenses/batch', headers: AH,
    payload: { user_id: u1.user.id, product_id: product.id, count: 3, type: 'permanent', max_devices: 2, remark: '批量测试' },
  });
  const bj = batch.json();
  check('批量发码返回 3 个', bj.count === 3 && bj.license_keys.length === 3, bj);
  check('授权码格式统一 LIC-XXXXXXXX-XXXXXXXX-XXXXXXXX',
    bj.license_keys.every((k) => KEY_RE.test(k)), bj.license_keys);

  const inDb = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(bj.license_keys[0]);
  check('码已落库且归属正确',
    !!inDb && inDb.user_id === u1.user.id && inDb.product_id === product.id && inDb.max_devices === 2, inDb);
  check('批量发码的备注写进去了', inDb && inDb.remark === '批量测试', inDb && inDb.remark);

  const batch2 = await app.inject({
    method: 'POST', url: '/api/licenses/batch', headers: AH,
    payload: { user_id: u1.user.id, product_id: product.id, count: 0 },
  });
  check('数量 0 时至少发 1 个', batch2.json().count === 1, batch2.json());

  const dup = await app.inject({
    method: 'POST', url: '/api/licenses', headers: AH,
    payload: { user_id: u1.user.id, product_id: product.id, license_key: bj.license_keys[0] },
  });
  check('重复授权码被拒（400 而不是 500）', dup.statusCode === 400, dup.json());

  if (serviceProduct) {
    const svc = await app.inject({
      method: 'POST', url: '/api/licenses', headers: AH,
      payload: { user_id: u1.user.id, product_id: serviceProduct.id },
    });
    check('服务类商品不允许发授权码', svc.statusCode === 400, svc.json());
  }

  /* ---------- 3. 支付自动发码：格式与手工发放一致 ---------- */
  console.log('\n支付自动发码格式');
  const created2 = deliverOrder({ id: 900001, user_id: u1.user.id, order_no: 'TESTLIC' + Date.now(), items: JSON.stringify([{ product_id: product.id, qty: 1 }]) });
  const auto = created2.find((c) => c.type === 'license');
  check('支付发货生成了授权码', !!auto, created2);
  check('自动发放的码与 genLicenseKey 同格式', auto && KEY_RE.test(auto.license_key), auto);

  /* ---------- 4. 激活两台机器 ---------- */
  console.log('\n激活与机器名额');
  const key = bj.license_keys[0];
  const licId = inDb.id;

  async function activate(machineId) {
    const body = { license_key: key, machine_id: machineId, machine_name: 'PC-' + machineId, version: '1.0.0' };
    const s = signReq(AS, AK, 'POST', '/api/open/v1/auth/activate', body);
    return app.inject({ method: 'POST', url: '/api/open/v1/auth/activate', headers: s.headers, payload: body });
  }

  const a1 = await activate('MACHINE-A');
  const a2 = await activate('MACHINE-B');
  check('机器 A 激活成功', a1.statusCode === 200 && a1.json().valid === true, a1.json());
  check('机器 B 激活成功', a2.statusCode === 200 && a2.json().valid === true, a2.json());
  const tokenA = a1.json().access_token;
  const tokenB = a2.json().access_token;
  const HA = { authorization: 'Bearer ' + tokenA };
  const HB = { authorization: 'Bearer ' + tokenB };

  const a3 = await activate('MACHINE-C');
  check('超出 max_devices 返回 409 MACHINE_LIMIT',
    a3.statusCode === 409 && a3.json().code === 'MACHINE_LIMIT', a3.json());

  const hb1 = await app.inject({ method: 'POST', url: '/api/open/v1/license/heartbeat', headers: HB, payload: { version: '1.0.0' } });
  check('心跳正常时 valid=true', hb1.json().valid === true, hb1.json());

  /* ---------- 5. 后台解绑 → 该机器立刻失效 ---------- */
  console.log('\n解绑必须立刻失效（不能只清名单）');
  const devList = await app.inject({ method: 'GET', url: `/api/licenses/${licId}/devices`, headers: AH });
  check('后台能看到 2 台绑定机器', devList.json().list.length === 2, devList.json());
  const devA = devList.json().list.find((d) => d.device_sn === 'MACHINE-A');

  const unbindAdmin = await app.inject({ method: 'DELETE', url: `/api/license-devices/${devA.id}`, headers: AH });
  check('后台解绑成功', unbindAdmin.json().ok === true, unbindAdmin.json());

  const hbA = await app.inject({ method: 'POST', url: '/api/open/v1/license/heartbeat', headers: HA, payload: {} });
  check('被解绑机器的老令牌失效且原因明确',
    hbA.statusCode === 401 && hbA.json().code === 'SESSION_REVOKED', hbA.json());

  const hbB = await app.inject({ method: 'POST', url: '/api/open/v1/license/heartbeat', headers: HB, payload: {} });
  check('另一台机器不受影响', hbB.json().valid === true, hbB.json());

  /* ---------- 6. 用户端自助解绑 ---------- */
  console.log('\n用户自助解绑');
  const myLic = await app.inject({ method: 'GET', url: '/api/portal/licenses', headers: U1 });
  const myRow = myLic.json().list.find((l) => l.id === licId);
  check('用户端能看到绑定数量', myRow && myRow.bound_devices === 1, myRow);

  const myDev = await app.inject({ method: 'GET', url: `/api/portal/licenses/${licId}/devices`, headers: U1 });
  check('用户能看到自己的绑定机器', myDev.json().list.length === 1, myDev.json());

  const peek = await app.inject({ method: 'GET', url: `/api/portal/licenses/${licId}/devices`, headers: U2 });
  check('别人的授权看不到（404）', peek.statusCode === 404, peek.json());

  const devB = myDev.json().list[0];
  const steal = await app.inject({ method: 'DELETE', url: `/api/portal/licenses/${licId}/devices/${devB.id}`, headers: U2 });
  check('别人的机器解绑不了（404）', steal.statusCode === 404, steal.json());

  const selfUnbind = await app.inject({ method: 'DELETE', url: `/api/portal/licenses/${licId}/devices/${devB.id}`, headers: U1 });
  check('用户自助解绑成功', selfUnbind.json().ok === true, selfUnbind.json());

  const hbB2 = await app.inject({ method: 'POST', url: '/api/open/v1/license/heartbeat', headers: HB, payload: {} });
  check('自助解绑后老令牌也失效',
    hbB2.statusCode === 401 && hbB2.json().code === 'SESSION_REVOKED', hbB2.json());

  const reAct = await activate('MACHINE-C');
  check('释放名额后可换机器激活', reAct.statusCode === 200 && reAct.json().valid === true, reAct.json());

  /* ---------- 7. 吊销 → 立刻踢下线 ---------- */
  console.log('\n吊销即刻生效');
  const reToken = reAct.json().access_token;
  const HC = { authorization: 'Bearer ' + reToken };
  const beforeRevoke = await app.inject({ method: 'POST', url: '/api/open/v1/license/heartbeat', headers: HC, payload: {} });
  check('吊销前心跳正常', beforeRevoke.json().valid === true, beforeRevoke.json());

  await app.inject({ method: 'POST', url: `/api/licenses/${licId}/revoke`, headers: AH, payload: {} });
  const afterRevoke = await app.inject({ method: 'POST', url: '/api/open/v1/license/heartbeat', headers: HC, payload: {} });
  check('吊销后心跳立刻无效',
    afterRevoke.statusCode === 401 && afterRevoke.json().code === 'SESSION_REVOKED', afterRevoke.json());

  const sess = db.prepare("SELECT COUNT(*) AS c FROM client_sessions WHERE license_id = ? AND status = 'active'").get(licId);
  check('吊销同时作废客户端会话', sess.c === 0, sess);

  const audit = db.prepare("SELECT * FROM admin_logs WHERE action = '吊销授权' ORDER BY id DESC LIMIT 1").get();
  check('吊销写入后台审计日志', !!audit && audit.detail.includes(String(licId)), audit);
  const auditUnbind = db.prepare("SELECT * FROM admin_logs WHERE action = '解绑授权设备' ORDER BY id DESC LIMIT 1").get();
  check('解绑写入后台审计日志', !!auditUnbind && auditUnbind.detail.includes('MACHINE-A'), auditUnbind);

  const verifyAfter = await app.inject({
    method: 'POST', url: '/api/open/v1/license/verify',
    headers: { authorization: 'Bearer ' + reToken }, payload: {},
  });
  check('吊销后校验接口也拒绝且说明原因',
    verifyAfter.statusCode === 403 && verifyAfter.json().valid === false && verifyAfter.json().code === 'SESSION_REVOKED', verifyAfter.json());

  /* ---------- 8. 恢复授权后可再次校验 ---------- */
  await app.inject({ method: 'POST', url: `/api/licenses/${licId}/resume`, headers: AH, payload: {} });
  const vBody = { license_key: key, machine_id: 'MACHINE-C' };
  const vs = signReq(AS, AK, 'POST', '/api/open/v1/license/verify', vBody);
  const resumed = await app.inject({ method: 'POST', url: '/api/open/v1/license/verify', headers: vs.headers, payload: vBody });
  check('恢复后签名方式校验通过', resumed.json().valid === true, resumed.json());

  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  await app.close();
  try {
    for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
  } catch { /* 测试库残留不影响结论 */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});

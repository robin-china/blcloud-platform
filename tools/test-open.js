/* 软件端开放接口端到端自测：node tools/test-open.js
 * 使用独立测试库（data/test-open.db），不影响正式数据
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-open.db');
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
}
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';

const { build } = require('../server');
const db = require('../server/db');
const { now } = require('../server/lib/util');

function signReq(secret, appKey, method, path, bodyObj) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(6).toString('hex');
  const raw = bodyObj && Object.keys(bodyObj).length ? JSON.stringify(bodyObj) : '';
  const sig = crypto.createHmac('sha256', secret)
    .update([appKey, method.toUpperCase(), path, timestamp, nonce, raw].join('\n'))
    .digest('hex');
  const headers = { 'x-app-key': appKey, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-signature': sig };
  if (raw) headers['content-type'] = 'application/json';
  return { headers, body: raw || undefined };
}

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 200) : '')); }
}

(async () => {
  const app = build();
  await app.ready();

  // 0. 准备：管理员登录、造一个用户与授权
  const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' } });
  const adminToken = login.json().token;
  check('管理员登录', !!adminToken, login.json());

  const product = db.prepare("SELECT * FROM products WHERE type = 'software' LIMIT 1").get();
  check('存在软件产品', !!product);

  const openid = 'sdk' + Math.random().toString(36).slice(2, 8);
  const ui = db.prepare('INSERT INTO users (openid, nickname, avatar, phone, points, status, tb_username, tb_password, tb_status, created_at, last_login_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(openid, 'SDK测试用户', '', null, 0, 'active', `${openid}@tb.cn`, openid, 'active', now(), now());
  const uid = Number(ui.lastInsertRowid);

  const licKey = 'SDKTEST-' + Math.random().toString(36).slice(2, 10).toUpperCase();
  const li = db.prepare(`INSERT INTO licenses (license_key, user_id, product_id, type, max_devices, start_at, end_at, status, remark, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(licKey, uid, product.id, 'subscription', 2, now(), new Date(Date.now() + 30 * 86400000).toISOString(), 'active', 'SDK 自测', now());
  const lid = Number(li.lastInsertRowid);

  // 1. 创建开放应用
  const createApp = await app.inject({
    method: 'POST', url: '/api/open-apps',
    headers: { authorization: 'Bearer ' + adminToken },
    payload: { name: 'SDK 测试应用', product_id: product.id, version: '1.2.0' },
  });
  const created = createApp.json();
  check('创建开放应用', !!created.app_key && !!created.app_secret, created);
  const { app_key: AK, app_secret: AS } = created;

  // 2. 签名错误应被拒绝
  const badSign = await app.inject({
    method: 'POST', url: '/api/open/v1/auth/activate',
    headers: { 'x-app-key': AK, 'x-timestamp': String(Date.now()), 'x-nonce': 'n1', 'x-signature': 'deadbeef' },
    payload: { license_key: licKey, machine_id: 'MAC-001' },
  });
  check('错误签名被拒绝', badSign.statusCode === 401, badSign.json());

  // 3. 激活
  const actBody = { license_key: licKey, machine_id: 'MAC-001', machine_name: '测试电脑', version: '1.2.0' };
  const act = await app.inject({ method: 'POST', url: '/api/open/v1/auth/activate', ...signReq(AS, AK, 'POST', '/api/open/v1/auth/activate', actBody) });
  const actJson = act.json();
  check('激活成功', act.statusCode === 200 && actJson.valid === true, actJson);
  check('返回 access_token', !!actJson.access_token && !!actJson.refresh_token, Object.keys(actJson));
  check('返回授权信息', actJson.license && actJson.license.product_id === product.id, actJson.license);
  const token = actJson.access_token;
  const refresh = actJson.refresh_token;

  // 4. 同一台机器重复激活（应复用，不占名额）
  const act2 = await app.inject({ method: 'POST', url: '/api/open/v1/auth/activate', ...signReq(AS, AK, 'POST', '/api/open/v1/auth/activate', actBody) });
  check('同机器重复激活复用', act2.statusCode === 200 && act2.json().license.bound_devices === 1, act2.json().license);

  // 5. 第二台机器
  await app.inject({ method: 'POST', url: '/api/open/v1/auth/activate', ...signReq(AS, AK, 'POST', '/api/open/v1/auth/activate', { ...actBody, machine_id: 'MAC-002' }) });
  // 6. 第三台应超限
  const act3 = await app.inject({ method: 'POST', url: '/api/open/v1/auth/activate', ...signReq(AS, AK, 'POST', '/api/open/v1/auth/activate', { ...actBody, machine_id: 'MAC-003' }) });
  check('超出机器数被拒绝', act3.statusCode === 409 && act3.json().code === 'MACHINE_LIMIT', act3.json());

  // 7. 用户资料
  const prof = await app.inject({ method: 'GET', url: '/api/open/v1/user/profile', headers: { authorization: 'Bearer ' + token } });
  check('读取用户资料', prof.statusCode === 200 && prof.json().user.id === uid, prof.json());

  // 8. 我的授权
  const lics = await app.inject({ method: 'GET', url: '/api/open/v1/user/licenses', headers: { authorization: 'Bearer ' + token } });
  check('读取我的授权', lics.statusCode === 200 && lics.json().list.length >= 1, lics.json());

  // 9. 授权校验
  const verify = await app.inject({ method: 'POST', url: '/api/open/v1/license/verify', headers: { authorization: 'Bearer ' + token }, payload: {} });
  check('授权校验通过', verify.statusCode === 200 && verify.json().valid === true, verify.json());

  // 10. 未绑定机器校验失败
  const verify2 = await app.inject({ method: 'POST', url: '/api/open/v1/license/verify', headers: { authorization: 'Bearer ' + token }, payload: { machine_id: 'MAC-999' } });
  check('未绑定机器被拒绝', verify2.statusCode === 200 && verify2.json().valid === false && verify2.json().code === 'MACHINE_NOT_BOUND', verify2.json());

  // 11. 心跳
  const hb = await app.inject({ method: 'POST', url: '/api/open/v1/license/heartbeat', headers: { authorization: 'Bearer ' + token }, payload: { version: '1.2.0' } });
  check('心跳上报', hb.statusCode === 200 && hb.json().valid === true, hb.json());

  // 12. 硬件与设备凭据（账户名/密码为内部机制，不对外返回）
  const devs = await app.inject({ method: 'GET', url: '/api/open/v1/user/devices', headers: { authorization: 'Bearer ' + token } });
  check('读取硬件设备列表（不泄露内部账户）', devs.statusCode === 200 && !('username' in devs.json().tb) && !('password' in devs.json().tb), devs.json().tb);

  // 13. 版本检查
  const ver = await app.inject({ method: 'GET', url: '/api/open/v1/app/version', ...signReq(AS, AK, 'GET', '/api/open/v1/app/version', null) });
  check('版本检查', ver.statusCode === 200 && ver.json().version === '1.2.0', ver.json());

  // 14. 刷新令牌
  const rf = await app.inject({ method: 'POST', url: '/api/open/v1/auth/refresh', payload: { refresh_token: refresh } });
  check('刷新令牌', rf.statusCode === 200 && !!rf.json().access_token, rf.json());
  const newToken = rf.json().access_token;

  // 15. 旧令牌应失效
  const oldUse = await app.inject({ method: 'GET', url: '/api/open/v1/user/profile', headers: { authorization: 'Bearer ' + token } });
  check('旧令牌已失效', oldUse.statusCode === 401, oldUse.json());

  // 16. 新令牌可用
  const newUse = await app.inject({ method: 'GET', url: '/api/open/v1/user/profile', headers: { authorization: 'Bearer ' + newToken } });
  check('新令牌可用', newUse.statusCode === 200, newUse.json());

  // 17. 手机号登录（验证码接口返回 dev_code）
  const phone = '139' + String(Math.floor(Math.random() * 90000000) + 10000000).slice(0, 8);
  const smsBody = { phone };
  const sms = await app.inject({ method: 'POST', url: '/api/open/v1/auth/sms/send', ...signReq(AS, AK, 'POST', '/api/open/v1/auth/sms/send', smsBody) });
  check('发送验证码', sms.statusCode === 200 && !!sms.json().dev_code, sms.json());
  const code = sms.json().dev_code;
  const plBody = { phone, code, machine_id: 'MAC-PHONE' };
  const plogin = await app.inject({ method: 'POST', url: '/api/open/v1/auth/login/phone', ...signReq(AS, AK, 'POST', '/api/open/v1/auth/login/phone', plBody) });
  check('手机号登录（新用户自动建档）', plogin.statusCode === 200 && !!plogin.json().access_token, plogin.json());
  check('手机号登录不泄露内部物联账户', (() => {
    const raw = JSON.stringify(plogin.json());
    return !raw.includes('tb_username') && !raw.includes('tb_password');
  })(), plogin.json().user);

  // 18. 扫码登录
  const qrBody = {};
  const qr = await app.inject({ method: 'POST', url: '/api/open/v1/auth/qrcode', ...signReq(AS, AK, 'POST', '/api/open/v1/auth/qrcode', qrBody) });
  check('生成扫码场景', qr.statusCode === 200 && !!qr.json().scene, qr.json());
  const scene = qr.json().scene;
  await app.inject({ method: 'POST', url: '/api/wechat/simulate/' + scene, payload: { openid: 'scan' + Math.random().toString(36).slice(2, 6), nickname: '扫码用户' } });
  const poll = await app.inject({ method: 'GET', url: `/api/open/v1/auth/qrcode/${scene}?app_key=${AK}&machine_id=MAC-SCAN` });
  check('扫码轮询拿到令牌', poll.statusCode === 200 && poll.json().status === 'confirmed' && !!poll.json().access_token, poll.json());

  // 19. 解绑机器
  const unbind = await app.inject({ method: 'POST', url: '/api/open/v1/license/unbind', headers: { authorization: 'Bearer ' + newToken }, payload: { license_key: licKey, machine_id: 'MAC-002' } });
  check('解绑机器', unbind.statusCode === 200 && unbind.json().license.bound_devices === 1, unbind.json());

  // 20. 吊销授权后校验失败
  db.prepare('UPDATE licenses SET status = ? WHERE id = ?').run('revoked', lid);
  const vfBody = { license_key: licKey, machine_id: 'MAC-001' };
  const vf = await app.inject({ method: 'POST', url: '/api/open/v1/license/verify', ...signReq(AS, AK, 'POST', '/api/open/v1/license/verify', vfBody) });
  check('吊销后校验失败', vf.statusCode === 200 && vf.json().valid === false && vf.json().code === 'LICENSE_REVOKED', vf.json());

  // 21. 管理端统计
  const st = await app.inject({ method: 'GET', url: '/api/open-stats/summary', headers: { authorization: 'Bearer ' + adminToken } });
  check('开放接口统计', st.statusCode === 200 && st.json().apps >= 1, st.json());

  // 22. 会话列表
  const sess = await app.inject({ method: 'GET', url: `/api/open-apps/${created.id}/sessions`, headers: { authorization: 'Bearer ' + adminToken } });
  check('客户端会话列表', sess.statusCode === 200 && Array.isArray(sess.json().list), sess.json());

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  await app.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });

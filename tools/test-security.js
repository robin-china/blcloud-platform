/* 安全回归自测：验证已修复的高危项不再可被利用
 * 用法：node tools/test-security.js
 * 使用独立测试库 data/test-security.db，不影响正式数据
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-security.db');
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
}
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';

const { build } = require('../server');
const db = require('../server/db');
const { now, hashPassword } = require('../server/lib/util');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 220) : '')); }
}

function signReq(secret, appKey, method, fullPath, bodyObj, fixed) {
  const timestamp = String(Date.now());
  const nonce = (fixed && fixed.nonce) || crypto.randomBytes(6).toString('hex');
  const raw = bodyObj && Object.keys(bodyObj).length ? JSON.stringify(bodyObj) : '';
  const sig = crypto.createHmac('sha256', secret)
    .update([appKey, method.toUpperCase(), fullPath, timestamp, nonce, raw].join('\n'))
    .digest('hex');
  const headers = { 'x-app-key': appKey, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-signature': sig };
  if (raw) headers['content-type'] = 'application/json';
  return { headers, body: raw || undefined, nonce, timestamp };
}

async function newUser(app, openid) {
  const scene = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode', payload: {} })).json().scene;
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${scene}`, payload: { openid, nickname: openid } });
  const r = await app.inject({ method: 'GET', url: `/api/wechat/qrcode/${scene}` });
  return r.json();
}

(async () => {
  const app = build();
  await app.ready();

  // [3] 会把管理员密码改掉，这里用变量跟随，避免后续辅助函数登录失败静默失效
  let adminPwd = process.env.ADMIN_INIT_PASSWORD || 'admin123';
  const loginToken = async () =>
    (await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: adminPwd } })).json().token;
  const setCfg = async (name, patch) => {
    const t = await loginToken();
    return app.inject({ method: 'POST', url: `/api/settings/integration/${name}`, headers: { authorization: 'Bearer ' + t }, payload: patch });
  };
  const setSetting = async (key, value) => {
    const t = await loginToken();
    return app.inject({ method: 'POST', url: '/api/settings', headers: { authorization: 'Bearer ' + t }, payload: { [key]: value } });
  };

  const adminLogin = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' } });
  check('管理员登录可用', !!adminLogin.json().token, adminLogin.json());
  const adminToken = adminLogin.json().token;

  console.log('\n[1] 模拟支付后门');
  const u1 = await newUser(app, 'sec-u1');
  const u2 = await newUser(app, 'sec-u2');
  const H = (t) => ({ authorization: 'Bearer ' + t });

  let o = await app.inject({ method: 'POST', url: '/api/portal/orders', headers: H(u1.token), payload: { items: [{ product_id: 1, qty: 1 }] } });
  const orderNo = o.json().order_no;
  check('下单成功', !!orderNo, o.json());

  let r = await app.inject({ method: 'POST', url: `/api/pay/simulate/${orderNo}`, payload: {} });
  check('未开启模拟支付时拒绝（无需登录）', r.statusCode === 403, r.json());
  check('订单仍为待支付', db.prepare('SELECT status FROM orders WHERE order_no = ?').get(orderNo).status === 'pending');

  await setSetting('pay_simulate', '1');
  r = await app.inject({ method: 'POST', url: `/api/pay/simulate/${orderNo}`, headers: H(u2.token), payload: {} });
  check('开启后他人仍不能支付我的订单', r.statusCode === 403, r.json());

  r = await app.inject({ method: 'POST', url: `/api/pay/simulate/${orderNo}`, headers: H(u1.token), payload: {} });
  check('本人在开启后可完成模拟支付', r.statusCode === 200 && r.json().status === 'paid', r.json());
  await setSetting('pay_simulate', '0');

  console.log('\n[2] 扫码模拟登录后门');
  const scene = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode', payload: {} })).json().scene;
  await setCfg('wechat', { enabled: 1, appid: 'wx123', appsecret: 'secret123' });
  r = await app.inject({ method: 'POST', url: `/api/wechat/simulate/${scene}`, payload: { openid: 'victim-001' } });
  check('接入服务号后模拟登录被拒', r.statusCode === 403, r.json());
  await setCfg('wechat', { enabled: 0, appid: '', appsecret: '' });

  await setSetting('dev_simulate', '0');
  const scene2 = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode', payload: {} })).json().scene;
  r = await app.inject({ method: 'POST', url: `/api/wechat/simulate/${scene2}`, payload: { openid: 'victim-002' } });
  check('显式关闭演示模式后模拟登录被拒', r.statusCode === 403, r.json());

  r = await app.inject({ method: 'POST', url: '/api/portal/phone/code', headers: H(u1.token), payload: { phone: '13800138000' } });
  check('关闭演示模式后验证码不再明文返回', r.statusCode === 200 && !('devCode' in r.json()), r.json());
  await setSetting('dev_simulate', '1');

  console.log('\n[3] 管理员口令与爆破锁定');
  db.prepare('UPDATE admins SET password_hash = ? WHERE username = ?').run(hashPassword('admin123'), 'admin');
  let l = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' } });
  check('弱口令登录返回强制改密标记', l.json().must_change_password === true, l.json());

  for (let i = 0; i < 5; i++) {
    await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'lockme', password: 'wrong' + i } });
  }
  const locked = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'lockme', password: 'whatever' } });
  check('连续失败 5 次后锁定', locked.statusCode === 429, locked.json());

  db.prepare('DELETE FROM login_attempts').run();
  l = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' } });
  const t2 = l.json().token;
  r = await app.inject({ method: 'POST', url: '/api/admin/password', headers: H(t2), payload: { oldPassword: 'admin123', newPassword: '123' } });
  check('新密码少于 8 位被拒', r.statusCode === 400, r.json());
  r = await app.inject({ method: 'POST', url: '/api/admin/password', headers: H(t2), payload: { oldPassword: 'admin123', newPassword: 'Str0ngPassw0rd!' } });
  check('修改为强密码成功', r.statusCode === 200, r.json());
  adminPwd = 'Str0ngPassw0rd!';
  l = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'Str0ngPassw0rd!' } });
  check('改密后不再提示强制修改', l.json().must_change_password === false, l.json());

  console.log('\n[4] 接口签名加固');
  const created = (await app.inject({
    method: 'POST', url: '/api/open-apps', headers: H(adminToken), payload: { name: '安全测试应用', product_id: 1 },
  })).json();
  const appKey = created.app_key;
  const appSecret = created.app_secret;
  check('创建应用拿到密钥', !!appKey && !!appSecret);

  const verPath = '/api/open/v1/app/version';
  const s1 = signReq(appSecret, appKey, 'GET', verPath, null);
  r = await app.inject({ method: 'GET', url: verPath, headers: s1.headers });
  check('首次请求通过', r.statusCode === 200, r.json());

  const s2 = signReq(appSecret, appKey, 'GET', verPath, null, { nonce: s1.nonce });
  r = await app.inject({ method: 'GET', url: verPath, headers: s2.headers });
  check('相同 nonce 重放被拒', r.statusCode === 401 && r.json().code === 'APP_SIGN_INVALID', r.json());

  const s3 = signReq(appSecret, appKey, 'GET', verPath, null);
  r = await app.inject({ method: 'GET', url: verPath + '?foo=bar', headers: s3.headers });
  check('查询串被篡改后签名失效', r.statusCode === 401, r.json());

  console.log('\n[5] 支付回调金额比对');
  const { markPaid } = require('../server/services/pay');
  const o2 = (await app.inject({ method: 'POST', url: '/api/portal/orders', headers: H(u2.token), payload: { items: [{ product_id: 1, qty: 1 }] } })).json();
  const before = db.prepare('SELECT COUNT(*) c FROM licenses WHERE user_id = ?').get(u2.user.id).c;
  const res = markPaid(o2.order_no, 'TX001', 'alipay', '', 0.01);
  check('金额不符时拒绝发货', res && res.mismatch === true, res);
  check('金额不符时订单未置为已支付', db.prepare('SELECT status FROM orders WHERE order_no = ?').get(o2.order_no).status === 'pending');
  check('留存异常流水', db.prepare("SELECT COUNT(*) c FROM payments WHERE order_no = ? AND status = 'amount_mismatch'").get(o2.order_no).c === 1);
  check('未发放授权', db.prepare('SELECT COUNT(*) c FROM licenses WHERE user_id = ?').get(u2.user.id).c === before);

  const okRes = markPaid(o2.order_no, 'TX002', 'alipay', '', o2.pay_amount);
  check('金额一致时正常发货', okRes && okRes.mismatch === undefined, okRes);
  check('订单已支付', db.prepare('SELECT status FROM orders WHERE order_no = ?').get(o2.order_no).status === 'paid');

  console.log('\n[6] 未开通渠道不得降级为模拟支付');
  await setCfg('wxpay', { enabled: 0 });
  await setCfg('alipay', { enabled: 0 });
  await setSetting('pay_simulate', '0');

  const o3 = (await app.inject({ method: 'POST', url: '/api/portal/orders', headers: H(u2.token), payload: { items: [{ product_id: 1, qty: 1 }] } })).json();
  r = await app.inject({ method: 'POST', url: `/api/portal/orders/${o3.order_no}/pay`, headers: H(u2.token), payload: { channel: 'alipay' } });
  check('未开通的支付宝渠道返回错误', r.statusCode === 400, r.json());
  check('未返回模拟支付模式', !r.json() || r.json().mode !== 'simulate', r.json());

  r = await app.inject({ method: 'POST', url: `/api/portal/orders/${o3.order_no}/pay`, headers: H(u2.token), payload: { channel: 'wxpay' } });
  check('未开通的微信渠道返回错误', r.statusCode === 400, r.json());
  check('订单仍未支付', db.prepare('SELECT status FROM orders WHERE order_no = ?').get(o3.order_no).status === 'pending');

  const site = (await app.inject({ method: 'GET', url: '/api/portal/site' })).json();
  check('站点接口不暴露未开通渠道', Array.isArray(site.pay_channels) && site.pay_channels.length === 0, site.pay_channels);

  await setSetting('pay_simulate', '1');
  const site2 = (await app.inject({ method: 'GET', url: '/api/portal/site' })).json();
  check('显式开启模拟支付后渠道可见', (site2.pay_channels || []).includes('simulate'), site2.pay_channels);
  await setSetting('pay_simulate', '0');

  await app.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行异常:', e); process.exit(1); });

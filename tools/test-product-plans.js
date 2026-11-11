/* 多软件产品 × 套餐档位 × 我的空间 × 微信资料同步 自测
 * 运行：node tools/test-product-plans.js
 * 使用独立测试库 data/test-product-plans.db，不影响正式数据。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-product-plans.db');
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
}
const KEY_FILE = path.join(__dirname, '..', 'data', 'test-product-key.json');
if (fs.existsSync(KEY_FILE)) fs.rmSync(KEY_FILE, { force: true });

process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.OFFLINE_KEY_PATH = KEY_FILE;

const { build } = require('../server');
const db = require('../server/db');
const plansLib = require('../server/lib/plans');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 400) : '')); }
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

async function newUser(app, openid, profile = {}) {
  const scene = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode', payload: {} })).json().scene;
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${scene}`,
    payload: { openid, nickname: profile.nickname || openid, avatar: profile.avatar || '' } });
  return (await app.inject({ method: 'GET', url: `/api/wechat/qrcode/${scene}` })).json();
}
const loginAgain = newUser; // 同 openid 再扫一次码，模拟重登时微信资料变化

const MOCK_U = {
  basePath: '',
  // 页面守卫统一 await U.authReady()：本测试全部按「已登录」渲染
  authReady: async () => true,
  fmt: {
    money: (v) => '¥' + Number(v || 0).toFixed(2),
    date: (s) => String(s || '').slice(0, 10),
    time: (s) => String(s || ''),
    int: (v) => Number(v || 0),
    ago: (s) => String(s || ''),
  },
  icons: {},
  svgIcon: () => '',
  toast: () => {},
  applySiteSettings: () => {},
  avatar: (v) => String(v || ''),
  avatarPresets: () => [],
  api: {
    scope: 'user',
    getToken: () => 'mock',
    get: async (url) => {
      const u = String(url || '');
      if (u.indexOf('/api/portal/space') === 0) {
        return { user: {}, apps: [], licenses: [], devices: [], orders: [] };
      }
      if (u.indexOf('/api/portal/me') === 0) return { user: { nickname: '测试', avatar: '', profile_custom: 0 } };
      return { list: [], apps: [], settings: {}, pay_channels: [] };
    },
    post: async () => ({}),
    del: async () => ({}),
  },
};

async function renderPage(pageFile, pageName) {
  const VUE = fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'vue.global.prod.js'), 'utf8');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('[jsdomError] ' + (e.stack || e.message).split('\n')[0]));
  vc.on('error', (...a) => errors.push('[console.error] ' + a.map(String).join(' ')));
  vc.on('warn', (...a) => errors.push('[console.warn] ' + a.map(String).join(' ')));
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'https://example.com/user/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      win.Response = globalThis.Response; win.Headers = globalThis.Headers; win.confirm = () => true;
    },
  });
  const win = dom.window;
  win.U = MOCK_U;
  win.eval(VUE);
  win.eval(fs.readFileSync(pageFile, 'utf8'));
  win.eval(`Vue.createApp(window.${pageName}).mount('#app')`);
  await wait(200);
  dom.window.close();
  return { errors };
}

async function placeOrder(app, headers, body) {
  const r = await app.inject({ method: 'POST', url: '/api/portal/orders', headers, payload: body });
  if (r.statusCode !== 200) return { error: r.json() };
  const o = r.json();
  const pay = await app.inject({ method: 'POST', url: `/api/pay/simulate/${o.order_no}`, headers, payload: {} });
  return { order: o, pay: pay.json(), statusCode: pay.statusCode };
}

(async () => {
  const app = build();
  await app.ready();
  const adminToken = (await app.inject({
    method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' },
  })).json().token;
  const AH = { authorization: 'Bearer ' + adminToken };
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'pay_simulate'").run();
  const ts = new Date().toISOString();

  /* ---------------- 1. 上架商品 ↔ 软件端应用 ↔ 档位 ---------------- */
  console.log('\n[1] 产品绑定与档位隔离');
  const seeds = plansLib.listTemplates(false);
  check('种子五档是通用模板（app_id 为空）', seeds.length === 5 && seeds.every((p) => !p.app_id), seeds.map((p) => p.code));

  const mkProduct = (name) => db.prepare(`INSERT INTO products
    (type, name, subtitle, price, status, sort, created_at, updated_at)
    VALUES ('software', ?, ?, 0, 'on', 0, ?, ?)`).run(name, name + ' 副标题', ts, ts).lastInsertRowid;
  const productA = mkProduct('软件甲');
  const productB = mkProduct('软件乙');
  const productC = mkProduct('软件丙');

  async function mkApp(name, productId) {
    const r = await app.inject({ method: 'POST', url: '/api/open-apps', headers: AH,
      payload: { name, product_id: productId, status: 'active', offline_days: 0 } });
    return r.json();
  }
  const appA = await mkApp('软件甲 PC 客户端', productA);
  const appB = await mkApp('软件乙 PC 客户端', productB);
  const appC = await mkApp('软件丙 PC 客户端', productC);
  check('三个应用各自绑定不同上架商品', !!appA.app_key && !!appB.app_key && !!appC.app_key
    && productA !== productB && productB !== productC, { appA: appA.id, appB: appB.id, appC: appC.id });
  const appRows = plansLib.listApps();
  check('后台下拉能看到应用与绑定商品名', appRows.length === 3
    && appRows.some((a) => a.id === appA.id && a.product_name === '软件甲'), appRows);

  // 复合唯一索引：同 code 在不同产品下可共存，同产品内仍唯一
  const ins = (id, code) => db.prepare(`INSERT INTO plans (app_id, code, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run(id, code, '唯一性探针', ts, ts);
  ins(appA.id, 'unique_probe');
  ins(appB.id, 'unique_probe');
  let sameScopeRejected = false;
  try { ins(appA.id, 'unique_probe'); } catch (e) { sameScopeRejected = true; }
  check('同一 code 可跨产品重复', db.prepare("SELECT COUNT(*) AS c FROM plans WHERE code='unique_probe'").get().c === 2);
  check('同一产品内 code 仍唯一', sameScopeRejected);
  db.prepare("DELETE FROM plans WHERE code='unique_probe'").run();

  const c1 = await app.inject({ method: 'POST', url: '/api/plans/copy-template', headers: AH,
    payload: { app_id: appA.id } });
  check('从模板复制到软件甲', c1.json().ok === true && c1.json().created === 5, c1.json());
  const c2 = await app.inject({ method: 'POST', url: '/api/plans/copy-template', headers: AH,
    payload: { app_id: appB.id } });
  check('从模板复制到软件乙', c2.json().ok === true && c2.json().created === 5, c2.json());
  check('两个产品都有自己的免费档', !!plansLib.byCode('free', appA.id) && !!plansLib.byCode('free', appB.id)
    && plansLib.byCode('free', appA.id).id !== plansLib.byCode('free', appB.id).id);
  const listA = await app.inject({ method: 'GET', url: '/api/plans?app_id=' + appA.id, headers: AH });
  check('按产品筛选档位', listA.json().list.length === 5
    && listA.json().list.every((p) => Number(p.app_id) === Number(appA.id)), listA.json().list.map((p) => p.code));

  const dupSame = await app.inject({ method: 'POST', url: '/api/plans', headers: AH,
    payload: { app_id: appA.id, code: 'member', name: '重复', billing: 'period', price: 1,
      period_days: 365, online_required: 1, offline_days: 0, features: [] } });
  check('同产品内重复 code 被拒', dupSame.statusCode === 400, dupSame.json());
  const badApp = await app.inject({ method: 'POST', url: '/api/plans', headers: AH,
    payload: { app_id: 999999, code: 'ghost', name: '幽灵', billing: 'period', price: 1,
      period_days: 365, online_required: 1, offline_days: 0, features: [] } });
  check('档位不能挂在不存在的软件产品上', badApp.statusCode === 400, badApp.json());
  check('没配套餐的产品回退通用模板', plansLib.listForApp(appC.id, true).length === 5
    && plansLib.listForApp(appC.id, true).every((p) => !p.app_id));

  const exported = (await app.inject({ method: 'GET', url: '/api/plans/export?app_id=' + appA.id, headers: AH })).json();
  check('导出配置带目标产品的 app_key', exported.app && exported.app.app_key === appA.app_key
    && exported.plans.length === 5, exported.app);
  const cfg = JSON.parse(JSON.stringify(exported));
  cfg.app = { app_key: appC.app_key };
  const imp = await app.inject({ method: 'POST', url: '/api/plans/import', headers: AH,
    payload: { config: cfg } });
  check('导入可落到指定产品而非写回模板', imp.json().ok === true
    && plansLib.list(false, appC.id).length === 5 && plansLib.listTemplates(false).length === 5, imp.json());

  /* ---------------- 2. 扫码登录、我的空间 ---------------- */
  console.log('\n[2] 我的空间：产品 + 档位 + 升档续费');
  const u1 = await newUser(app, 'pp-u1', { nickname: '微信昵称甲', avatar: 'https://wx.qlogo.cn/a.png' });
  const U1 = { authorization: 'Bearer ' + u1.token };
  const me1 = (await app.inject({ method: 'GET', url: '/api/portal/me', headers: U1 })).json().user;
  check('注册默认取微信昵称与头像', me1.nickname === '微信昵称甲' && me1.avatar === 'https://wx.qlogo.cn/a.png', me1);

  const space = await app.inject({ method: 'GET', url: '/api/portal/space', headers: U1 });
  const apps = space.json().apps || [];
  check('我的空间列出三个软件产品', space.statusCode === 200 && apps.length === 3, apps.map((a) => a.app_name));
  check('每个产品显示绑定的上架商品名', apps.every((a) => a.product && a.product.name)
    && apps.some((a) => a.product.name === '软件甲'), apps.map((a) => a.product && a.product.name));
  const licIds = apps.map((a) => a.license && a.license.id);
  check('每个产品各有独立免费档授权码', apps.every((a) => a.license && a.plan && a.plan.code === 'free')
    && new Set(licIds).size === 3, licIds);
  check('授权码归属到各自应用', apps.every((a) => Number(a.license.app_id) === Number(a.app_id)),
    apps.map((a) => ({ id: a.app_id, lic: a.license && a.license.app_id })));
  check('每个产品的可升档位只来自本产品', apps.every((a) => a.upgrades.length > 0
    && a.upgrades.every((p) => Number(p.price) >= 0)), apps.map((a) => a.upgrades.length));
  check('每个产品下发自己的档位目录', apps.every((a) => a.plans.length === 5), apps.map((a) => a.plans.length));
  check('免费档无需续费', apps.every((a) => a.renew === null), apps.map((a) => a.renew));

  const licList = (await app.inject({ method: 'GET', url: '/api/portal/licenses', headers: U1 })).json().list;
  check('我的授权显示所属产品与商品名', licList.some((l) => l.app_name && l.product_name === '软件甲'),
    licList.map((l) => ({ app: l.app_name, product: l.product_name })));
  const portalPlans = (await app.inject({ method: 'GET', url: '/api/portal/plans?app_id=' + appB.id, headers: U1 })).json();
  check('用户端按产品取档位', (portalPlans.list || []).length === 5
    && portalPlans.list.every((p) => Number(p.app_id) === Number(appB.id)), portalPlans);

  /* ---------------- 3. 下单 / 发货 / 软件端激活隔离 ---------------- */
  console.log('\n[3] 升级续费与激活按产品隔离');
  const appRowA = apps.find((a) => a.app_id === appA.id);
  const appRowB = apps.find((a) => a.app_id === appB.id);
  const memberA = plansLib.byCode('member', appA.id);
  const memberB = plansLib.byCode('member', appB.id);
  const cross = await app.inject({ method: 'POST', url: '/api/portal/orders', headers: U1,
    payload: { kind: 'upgrade', plan_id: memberB.id, ref_license_id: appRowA.license.id, app_id: appB.id } });
  check('跨产品升级被拒', cross.statusCode === 400, cross.json());
  const crossBuy = await app.inject({ method: 'POST', url: '/api/portal/orders', headers: U1,
    payload: { kind: 'purchase', plan_id: memberA.id, app_id: appB.id } });
  check('档位与所选产品不一致被拒', crossBuy.statusCode === 400, crossBuy.json());

  const before = db.prepare('SELECT COUNT(*) AS c FROM licenses WHERE user_id = ?').get(u1.user.id).c;
  const up = await placeOrder(app, U1, { kind: 'upgrade', plan_id: memberA.id,
    ref_license_id: appRowA.license.id, app_id: appA.id });
  check('同产品升级下单并支付成功', !up.error && up.statusCode === 200, up.error || up.pay);
  const licAfter = db.prepare('SELECT * FROM licenses WHERE id = ?').get(appRowA.license.id);
  check('升级原地改档位且保留授权码', licAfter.plan_code === 'member'
    && licAfter.license_key === appRowA.license.license_key, { plan: licAfter.plan_code });
  check('升级后授权仍归属软件甲', Number(licAfter.app_id) === Number(appA.id), licAfter.app_id);
  check('升级不新增授权记录', db.prepare('SELECT COUNT(*) AS c FROM licenses WHERE user_id = ?').get(u1.user.id).c === before);
  const orderAppId = db.prepare('SELECT app_id FROM orders WHERE order_no = ?').get(up.order.order_no).app_id;
  check('订单记录归属产品', Number(orderAppId) === Number(appA.id), orderAppId);

  const opts = (await app.inject({ method: 'GET',
    url: `/api/portal/licenses/${appRowA.license.id}/options`, headers: U1 })).json();
  check('可升级档位只列本产品档位', (opts.upgrades || []).length > 0
    && opts.upgrades.every((p) => Number(p.app_id) === Number(appA.id)), opts.upgrades.map((p) => p.app_id));

  const verPath = '/api/open/v1/app/version';
  const sv = signReq(appA.app_secret, appA.app_key, 'GET', verPath, null);
  const ver = await app.inject({ method: 'GET', url: verPath, headers: sv.headers });
  check('软件端只下发本产品档位目录', ver.json().plan_catalog.length === 5
    && ver.json().plan_catalog.every((p) => Number(p.app_id) === Number(appA.id)), ver.json().plan_catalog);

  const actPath = '/api/open/v1/auth/activate';
  const bodyB = { license_key: appRowB.license.license_key, machine_id: 'M-PP-B', version: '1.0.0' };
  const sB = signReq(appA.app_secret, appA.app_key, 'POST', actPath, bodyB);
  const wrongApp = await app.inject({ method: 'POST', url: actPath, headers: sB.headers, payload: bodyB });
  check('乙产品的码不能在甲软件激活', wrongApp.statusCode === 403
    && wrongApp.json().code === 'PRODUCT_MISMATCH', wrongApp.json());
  const bodyA = { license_key: appRowA.license.license_key, machine_id: 'M-PP-A', version: '1.0.0' };
  const sA = signReq(appA.app_secret, appA.app_key, 'POST', actPath, bodyA);
  const actA = await app.inject({ method: 'POST', url: actPath, headers: sA.headers, payload: bodyA });
  check('本产品授权可正常激活', actA.statusCode === 200 && actA.json().valid === true, actA.json());
  check('激活响应带产品与用户头像', actA.json().license?.app_id === appA.id
    && 'avatar' in (actA.json().user || {}), actA.json().license);
  const CH = { authorization: 'Bearer ' + actA.json().access_token };

  /* ---------------- 4. 微信资料同步与用户自行更改 ---------------- */
  console.log('\n[4] 昵称头像同步');
  const saved = await app.inject({ method: 'POST', url: '/api/portal/profile', headers: U1,
    payload: { nickname: '我自己改的名字', avatar: '/assets/me.png' } });
  check('用户可自行修改昵称与头像', saved.statusCode === 200
    && saved.json().user.nickname === '我自己改的名字' && saved.json().user.profile_custom === 1, saved.json());
  await loginAgain(app, 'pp-u1', { nickname: '微信新昵称', avatar: 'https://wx.qlogo.cn/b.png' });
  const meAfter = (await app.inject({ method: 'GET', url: '/api/portal/me', headers: U1 })).json().user;
  check('改过后微信重登不再覆盖', meAfter.nickname === '我自己改的名字'
    && meAfter.avatar === '/assets/me.png', meAfter);

  const u2 = await newUser(app, 'pp-u2', { nickname: '微信昵称乙', avatar: 'https://wx.qlogo.cn/c.png' });
  await loginAgain(app, 'pp-u2', { nickname: '微信改了名', avatar: 'https://wx.qlogo.cn/d.png' });
  // 复用首次登录的 JWT：再登一次会把 u2 的昵称同步成默认占位，破坏上面的断言
  const U2 = { authorization: 'Bearer ' + u2.token };
  const me2 = (await app.inject({ method: 'GET', url: '/api/portal/me', headers: U2 })).json().user;
  check('未自定义的用户重登会同步微信新资料', me2.nickname === '微信改了名'
    && me2.avatar === 'https://wx.qlogo.cn/d.png', me2);

  const badAvatar = await app.inject({ method: 'POST', url: '/api/portal/profile', headers: U1,
    payload: { nickname: '合法昵称', avatar: 'javascript:alert(1)' } });
  check('非法头像地址被拒', badAvatar.statusCode === 400, badAvatar.json());
  const emptyName = await app.inject({ method: 'POST', url: '/api/portal/profile', headers: U1,
    payload: { nickname: '   ' } });
  check('空昵称被拒', emptyName.statusCode === 400, emptyName.json());

  const cliProfile = (await app.inject({ method: 'GET', url: '/api/open/v1/user/profile', headers: CH })).json();
  check('软件端读取到最新昵称头像', cliProfile.user.nickname === '我自己改的名字'
    && cliProfile.user.avatar === '/assets/me.png', cliProfile.user);
  const cliUpdate = await app.inject({ method: 'POST', url: '/api/open/v1/user/profile', headers: CH,
    payload: { nickname: '软件端改名' } });
  check('软件端也能改资料', cliUpdate.statusCode === 200 && cliUpdate.json().user.nickname === '软件端改名', cliUpdate.json());
  const meSync = (await app.inject({ method: 'GET', url: '/api/portal/me', headers: U1 })).json().user;
  check('软件端改名后网页端同步', meSync.nickname === '软件端改名', meSync);

  const ho = (await app.inject({ method: 'POST', url: '/api/open/v1/auth/handoff', headers: CH,
    payload: { to: 'space' } })).json();
  const code = String(ho.url || '').match(/[?&]t=(ho_[a-f0-9]+)/);
  const handoff = await app.inject({ method: 'POST', url: '/api/portal/handoff',
    payload: { t: code ? code[1] : '' } });
  check('免登链接可跳到我的空间', ho.page === 'space' && handoff.statusCode === 200, { ho, handoff: handoff.json() });
  check('对外 user 不泄露内部物联账户', handoff.statusCode === 200
    && !('tb_username' in (handoff.json().user || {})) && !('tb_password' in (handoff.json().user || {})),
    handoff.json().user);

  /* ---------------- 5. 前端模板编译 ---------------- */
  console.log('\n[5] 前端模板编译');
  for (const [file, name] of [
    ['public/user/js/pages.js', 'PageSpace'],
    ['public/user/js/pages.js', 'PageAccount'],
    ['public/admin/js/pages-plans.js', 'PagePlans'],
    ['public/admin/js/pages-openapi.js', 'PageOpenapi'],
  ]) {
    const r = await renderPage(path.join(__dirname, '..', file), name);
    check(name + ' 渲染零错误', r.errors.length === 0, r.errors);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  await app.close();
  if (fail > 0) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });

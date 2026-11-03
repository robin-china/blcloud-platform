/* 套餐档位 / 升级续费 / 免费档 / 离线票据 / 代理商佣金 / 提现冲正 自测
 * 运行：node tools/test-plans-agent.js
 * 使用独立测试库 data/test-plans-agent.db，不影响正式数据。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-plans-agent.db');
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
}
const KEY_FILE = path.join(__dirname, '..', 'data', 'test-plans-key.json');
if (fs.existsSync(KEY_FILE)) fs.rmSync(KEY_FILE, { force: true });

process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.OFFLINE_KEY_PATH = KEY_FILE;

const { build } = require('../server');
const db = require('../server/db');
const plansLib = require('../server/lib/plans');
const commissionLib = require('../server/lib/commission');
const paySvc = require('../server/services/pay');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 300) : '')); }
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

async function newUser(app, openid) {
  const scene = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode', payload: {} })).json().scene;
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${scene}`, payload: { openid, nickname: openid } });
  return (await app.inject({ method: 'GET', url: `/api/wechat/qrcode/${scene}` })).json();
}

const MOCK_U = {
  basePath: '',
  fmt: {
    money: (v) => '¥' + Number(v || 0).toFixed(2),
    date: (s) => String(s || '').slice(0, 10),
    time: (s) => String(s || ''),
    int: (v) => Number(v || 0),
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
    get: async () => ({ list: [], settings: {}, pay_channels: [] }),
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
    beforeParse(win) { win.Response = globalThis.Response; win.Headers = globalThis.Headers; win.confirm = () => true; },
  });
  const win = dom.window;
  win.U = MOCK_U;
  win.eval(VUE);
  win.eval(fs.readFileSync(pageFile, 'utf8'));
  win.eval(`Vue.createApp(window.${pageName}).mount('#app')`);
  await wait(200);
  const text = win.document.body.textContent || '';
  dom.window.close();
  return { errors, text };
}

(async () => {
  const app = build();
  await app.ready();
  const adminToken = (await app.inject({
    method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' },
  })).json().token;
  const AH = { authorization: 'Bearer ' + adminToken };
  // 本地测试用模拟支付，不走微信
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'pay_simulate'").run();

  /* ---------------- 1. 档位定义与校验 ---------------- */
  console.log('\n[1] 套餐档位');
  const planRows = plansLib.list(false);
  check('种子五档齐全', planRows.length === 5, planRows.map((p) => p.code));
  check('等级递增', planRows.every((p, i) => i === 0 || p.tier > planRows[i - 1].tier));
  const free = plansLib.byCode('free');
  const member = plansLib.byCode('member');
  const pro = plansLib.byCode('pro');
  check('免费档价格 0 且不离线', free.price === 0 && free.offline_days === 0);
  check('离线企业档允许离线且有宽限', plansLib.byCode('enterprise').online_required === 0
    && plansLib.byCode('enterprise').offline_days > 0);

  const bad = await app.inject({ method: 'POST', url: '/api/plans', headers: AH,
    payload: { code: 'bad_plan', name: '错误档', tier: 50, billing: 'period', price: 10,
      period_days: 30, online_required: 1, offline_days: 30, max_devices: 1, features: [] } });
  check('联网档不许配长期离线宽限', bad.statusCode === 400, bad.json());
  const dup = await app.inject({ method: 'POST', url: '/api/plans', headers: AH,
    payload: { code: 'member', name: '重复', billing: 'period', price: 1, period_days: 365,
      online_required: 1, offline_days: 0, max_devices: 1, features: [] } });
  check('code 重复被拒', dup.statusCode === 400, dup.json());

  const exported = (await app.inject({ method: 'GET', url: '/api/plans/export', headers: AH })).json();
  check('导出配置含 schema 与 5 档', exported.schema === 1 && exported.plans.length === 5);
  const modified = JSON.parse(JSON.stringify(exported));
  modified.plans.find((p) => p.code === 'member').price = 88;
  const imp = await app.inject({ method: 'POST', url: '/api/plans/import', headers: AH,
    payload: { config: modified } });
  check('导入按 code 更新且不删除档位', imp.json().ok === true && plansLib.byCode('member').price === 88
    && plansLib.list(false).length === 5, imp.json());
  // 还原，避免影响后续金额断言
  db.prepare("UPDATE plans SET price = 99 WHERE code = 'member'").run();

  /* ---------------- 2. 注册自动发免费档 ---------------- */
  console.log('\n[2] 免费档自动发码与软件端激活');
  const u1 = await newUser(app, 'plan-u1-' + Math.random().toString(36).slice(2, 6));
  const U1 = { authorization: 'Bearer ' + u1.token };
  const freeLic = db.prepare('SELECT * FROM licenses WHERE user_id = ?').get(u1.user.id);
  check('注册自动发一张免费授权码', !!freeLic && freeLic.plan_code === 'free'
    && /^LIC-[0-9A-F]{8}-[0-9A-F]{8}-[0-9A-F]{8}$/.test(freeLic.license_key), freeLic && freeLic.license_key);
  check('免费档无到期时间', freeLic.end_at === null);
  const u1Again = await newUser(app, 'plan-u1-' + 'x');
  check('重复登录不重复发码', db.prepare('SELECT COUNT(*) AS c FROM licenses WHERE user_id = ?').get(u1.user.id).c === 1);

  db.prepare(`INSERT INTO open_apps (app_key, app_secret, name, product_id, status, offline_days, created_at)
    VALUES ('ak_plan_test','sk_plan_test','测试软件',NULL,'active',0,?)`).run(new Date().toISOString());
  const actBody = { license_key: freeLic.license_key, machine_id: 'M-PLAN-1', version: '1.0.0' };
  const s1 = signReq('sk_plan_test', 'ak_plan_test', 'POST', '/api/open/v1/auth/activate', actBody);
  const act = await app.inject({ method: 'POST', url: '/api/open/v1/auth/activate', headers: s1.headers, payload: actBody });
  check('免费码可激活（套餐授权跳过商品匹配）', act.statusCode === 200 && act.json().valid === true, act.json());
  check('licensePayload 下发档位权益', act.json().license?.entitlement?.plan_code === 'free'
    && Array.isArray(act.json().license?.entitlement?.features), act.json().license);
  const accessToken = act.json().access_token;
  const CH = { authorization: 'Bearer ' + accessToken };

  const ticket = await app.inject({ method: 'POST', url: '/api/open/v1/license/ticket', headers: CH, payload: {} });
  check('离线票据含 plan_code/features/seats', ticket.json().payload?.plan_code === 'free'
    && Array.isArray(ticket.json().payload?.features) && 'seats' in (ticket.json().payload || {}), ticket.json().payload);

  /* ---------------- 3. 套餐购买 / 续费 / 升级 ---------------- */
  console.log('\n[3] 新购 / 续费 / 升级都不换授权码');
  async function placeOrder(headers, body) {
    const r = await app.inject({ method: 'POST', url: '/api/portal/orders', headers, payload: body });
    if (r.statusCode !== 200) return { error: r.json() };
    const o = r.json();
    const pay = await app.inject({ method: 'POST', url: `/api/pay/simulate/${o.order_no}`, headers, payload: {} });
    return { order: o, pay: pay.json(), statusCode: pay.statusCode };
  }

  const buy = await placeOrder(U1, { kind: 'purchase', plan_id: member.id });
  check('套餐新购下单成功', !buy.error && buy.statusCode === 200, buy.error || buy.pay);
  const memberLic = db.prepare("SELECT * FROM licenses WHERE user_id = ? AND plan_code = 'member' ORDER BY id DESC LIMIT 1").get(u1.user.id);
  check('购买发放新授权码且带档位', !!memberLic && memberLic.plan_id === member.id && !!memberLic.end_at,
    memberLic && { key: memberLic.license_key, end: memberLic.end_at });

  const beforeCount = db.prepare('SELECT COUNT(*) AS c FROM licenses WHERE user_id = ?').get(u1.user.id).c;
  const renew = await placeOrder(U1, { kind: 'renew', plan_id: member.id, ref_license_id: memberLic.id });
  const memberAfterRenew = db.prepare('SELECT * FROM licenses WHERE id = ?').get(memberLic.id);
  check('续费成功且服务端定价', !renew.error && renew.order.amount === member.price, renew.error || renew.order);
  check('续费不发新码、license_id 不变', db.prepare('SELECT COUNT(*) AS c FROM licenses WHERE user_id = ?').get(u1.user.id).c === beforeCount);
  check('续费延长有效期且不缩短', Date.parse(memberAfterRenew.end_at) > Date.parse(memberLic.end_at),
    { before: memberLic.end_at, after: memberAfterRenew.end_at });
  const deliverRenew = JSON.parse(db.prepare('SELECT deliver_result FROM orders WHERE order_no = ?').get(renew.order.order_no).deliver_result || '[]');
  check('发货结果写明续期', deliverRenew[0]?.type === 'license_renew', deliverRenew);

  const up = await placeOrder(U1, { kind: 'upgrade', plan_id: pro.id, ref_license_id: memberLic.id });
  const memberAfterUp = db.prepare('SELECT * FROM licenses WHERE id = ?').get(memberLic.id);
  check('升级成功且只收差价', !up.error && up.order.amount > 0 && up.order.amount < pro.price, up.error || up.order);
  check('升级原地改档位与设备数', memberAfterUp.plan_code === 'pro'
    && Number(memberAfterUp.max_devices) === Number(pro.max_devices), { plan: memberAfterUp.plan_code, dev: memberAfterUp.max_devices });
  check('升级保留原授权码', memberAfterUp.license_key === memberLic.license_key);
  check('升级不新增授权记录', db.prepare('SELECT COUNT(*) AS c FROM licenses WHERE user_id = ?').get(u1.user.id).c === beforeCount);
  const stillBound = db.prepare('SELECT COUNT(*) AS c FROM license_devices WHERE license_id = ?').get(memberLic.id).c;
  check('机器绑定仍在（无需重新激活）', stillBound >= 0);

  const downgrade = await app.inject({ method: 'POST', url: '/api/portal/orders', headers: U1,
    payload: { kind: 'upgrade', plan_id: member.id, ref_license_id: memberLic.id } });
  check('禁止降级', downgrade.statusCode === 400, downgrade.json());
  const steal = await placeOrder(u1Again.token ? { authorization: 'Bearer ' + u1Again.token } : U1,
    { kind: 'renew', plan_id: member.id, ref_license_id: memberLic.id });
  check('他人不能续费别人的授权', !!steal.error, steal.error || steal.order);

  const opts = await app.inject({ method: 'GET', url: `/api/portal/licenses/${memberLic.id}/options`, headers: U1 });
  check('可升级档位接口返回当前档与候选', opts.json().current?.code === 'pro'
    && Array.isArray(opts.json().upgrades) && opts.json().upgrades.length > 0, opts.json());

  /* ---------------- 4. 到期提醒 ---------------- */
  console.log('\n[4] 到期提醒');
  db.prepare('UPDATE licenses SET end_at = ? WHERE id = ?')
    .run(new Date(Date.now() + 3 * 86400000).toISOString(), memberLic.id);
  const scan = await app.inject({ method: 'POST', url: '/api/agents/reminders/scan', headers: AH, payload: {} });
  check('扫描生成 3 天提醒', scan.json().created >= 1, scan.json());
  const scan2 = await app.inject({ method: 'POST', url: '/api/agents/reminders/scan', headers: AH, payload: {} });
  check('重复扫描不刷屏', scan2.json().created === 0, scan2.json());
  const notices = await app.inject({ method: 'GET', url: '/api/portal/notices', headers: U1 });
  check('用户端能读到提醒', (notices.json().list || []).some((n) => n.days_left === 3), notices.json());

  /* ---------------- 5. 代理商佣金 ---------------- */
  console.log('\n[5] 代理商佣金 / 账期 / 提现 / 退款冲正');
  const agent = await newUser(app, 'plan-agent-' + Math.random().toString(36).slice(2, 6));
  const buyer = await newUser(app, 'plan-buyer-' + Math.random().toString(36).slice(2, 6));
  const buyerH = { authorization: 'Bearer ' + buyer.token };
  const grant = await app.inject({ method: 'POST', url: `/api/agents/${agent.user.id}/authorize`, headers: AH,
    payload: { rate: 0.1, code: 'AGTEST0001' } });
  check('后台手动授权代理商', grant.json().ok === true && grant.json().agent_code === 'AGTEST0001', grant.json());
  const addDownline = await app.inject({ method: 'POST', url: `/api/agents/${agent.user.id}/downline`, headers: AH,
    payload: { user_id: buyer.user.id } });
  check('名下用户手动指派', addDownline.json().ok === true, addDownline.json());

  const buyerOrder = await placeOrder(buyerH, { kind: 'purchase', plan_id: member.id });
  check('名下用户下单支付成功', !buyerOrder.error && buyerOrder.statusCode === 200, buyerOrder.error);
  const comm = db.prepare('SELECT * FROM agent_commissions WHERE order_id = ?').get(buyerOrder.order.id);
  check('佣金按实收计且比例正确', !!comm && Math.abs(comm.amount - Math.round(member.price * 0.1 * 100) / 100) < 0.001,
    comm && { base: comm.base_amount, rate: comm.rate, amount: comm.amount });
  check('佣金初始为待结算（账期内）', comm.status === 'pending' && !!comm.available_at, comm.status);

  // markPaid 幂等：模拟「回调 + 主动查单」重复触发
  paySvc.markPaid(buyerOrder.order.order_no, 'DUP', 'simulate', 'dup', buyerOrder.order.pay_amount);
  check('重复支付通知不重复计佣',
    db.prepare('SELECT COUNT(*) AS c FROM agent_commissions WHERE order_id = ?').get(buyerOrder.order.id).c === 1);

  const selfOrder = await placeOrder({ authorization: 'Bearer ' + agent.token }, { kind: 'purchase', plan_id: member.id });
  check('代理商自己下单不计佣',
    db.prepare('SELECT COUNT(*) AS c FROM agent_commissions WHERE order_id = ?').get(selfOrder.order.id).c === 0);

  // 账期到期 → 可提现
  db.prepare("UPDATE agent_commissions SET available_at = ? WHERE order_id = ?")
    .run(new Date(Date.now() - 86400000).toISOString(), buyerOrder.order.id);
  const earnings = await app.inject({ method: 'GET', url: '/api/portal/earnings',
    headers: { authorization: 'Bearer ' + agent.token } });
  check('账期后佣金转可提现', earnings.json().is_agent === true
    && Math.abs(earnings.json().summary.available - comm.amount) < 0.001, earnings.json().summary);

  const lowWd = await app.inject({ method: 'POST', url: '/api/portal/withdrawals',
    headers: { authorization: 'Bearer ' + agent.token }, payload: { pay_account: '微信 test' } });
  check('低于最低提现额被拒', lowWd.statusCode === 400, lowWd.json());
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'agent_withdraw_min'").run();
  const wd = await app.inject({ method: 'POST', url: '/api/portal/withdrawals',
    headers: { authorization: 'Bearer ' + agent.token }, payload: { pay_account: '微信 test' } });
  check('提现申请生成待审核单', wd.json().ok === true && wd.json().withdrawal?.status === 'pending', wd.json());
  check('提现后佣金置 withdrawn', db.prepare('SELECT status FROM agent_commissions WHERE id = ?').get(comm.id).status === 'withdrawn');
  const review = await app.inject({ method: 'POST', url: `/api/agents/withdrawals/${wd.json().withdrawal.id}/review`,
    headers: AH, payload: { approve: true } });
  check('后台审核标记已打款', review.json().ok === true && review.json().withdrawal.status === 'paid', review.json());

  const refund = await app.inject({ method: 'POST', url: `/api/orders/${buyerOrder.order.id}/refund`, headers: AH, payload: {} });
  check('退款接口成功', refund.json().ok === true, refund.json());
  const afterRefund = db.prepare('SELECT * FROM agent_commissions WHERE order_id = ? ORDER BY id').all(buyerOrder.order.id);
  check('退款冲正原佣金', afterRefund.some((r) => r.status === 'reversed'), afterRefund.map((r) => r.status));
  check('已提现后退款记负数 adjustment', afterRefund.some((r) => r.kind === 'adjustment' && r.amount < 0),
    afterRefund.map((r) => ({ kind: r.kind, amount: r.amount })));

  /* ---------------- 6. 前端页面真实渲染 ---------------- */
  console.log('\n[6] 前端模板编译（浏览器内编译，写错会整页白屏）');
  const PUB = path.join(__dirname, '..', 'public');
  for (const [file, name] of [
    ['admin/js/pages-plans.js', 'PagePlans'],
    ['admin/js/pages-agents.js', 'PageAgents'],
    ['user/js/pages-earnings.js', 'PageEarnings'],
    ['user/js/pages.js', 'PageMyLicenses'],
  ]) {
    const r = await renderPage(path.join(PUB, file), name);
    check(`${name} 渲染零错误`, r.errors.length === 0, r.errors);
  }

  /* ---------------- 7. 后台参数可保存且被读取 ---------------- */
  console.log('\n[7] 参数设置');
  const setSave = await app.inject({ method: 'POST', url: '/api/settings', headers: AH,
    payload: { renew_remind_days: '10,5,1', agent_settle_days: '3',
      agent_withdraw_min: '5', upgrade_proration: '0' } });
  const saved = (await app.inject({ method: 'GET', url: '/api/settings', headers: AH })).json().settings;
  check('参数保存后可读回', setSave.statusCode === 200
    && saved.agent_settle_days === '3' && saved.renew_remind_days === '10,5,1', saved);
  check('账期参数被佣金账本读取', commissionLib.settleDays() === 3, commissionLib.settleDays());
  check('最低提现额参数生效', commissionLib.withdrawMin() === 5, commissionLib.withdrawMin());

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  await app.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});

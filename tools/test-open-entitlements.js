/* 软件端权益链路 P0/P1 自测：app.id、扫码选码绑定、功能码白名单、到期降级、
 * limits、app_key 过滤 + effective、handoff app 参数、entitlement_version、通用码升级不固化。
 * 运行：node tools/test-open-entitlements.js
 * 使用独立测试库 data/test-open-entitlements.db，不影响正式数据。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-open-entitlements.db');
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
}
const KEY_FILE = path.join(__dirname, '..', 'data', 'test-entitlements-key.json');
if (fs.existsSync(KEY_FILE)) fs.rmSync(KEY_FILE, { force: true });

process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.OFFLINE_KEY_PATH = KEY_FILE;

const { build } = require('../server');
const db = require('../server/db');
const plansLib = require('../server/lib/plans');
const { genLicenseKey } = require('../server/lib/util');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 500) : '')); }
}
const ts = new Date().toISOString();

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

(async () => {
  const app = build();
  await app.ready();
  const adminToken = (await app.inject({
    method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' },
  })).json().token;
  const AH = { authorization: 'Bearer ' + adminToken };
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'pay_simulate'").run();

  /* ---------------- 0. 建产品 / 应用 / 功能码表 / 档位 ---------------- */
  console.log('\n[0] 应用与功能码表');
  const productId = db.prepare(`INSERT INTO products
    (type, name, subtitle, price, status, sort, created_at, updated_at)
    VALUES ('software', '标签打印软件', '副标题', 0, 'on', 0, ?, ?)`).run(ts, ts).lastInsertRowid;
  const SCHEMA_TEXT = [
    'labelgo.basic = 基础打印',
    'labelgo.library = 标签库',
    'labelgo.concat = 拼接排版',
    'labelgo.batch = 批量打印',
    'labelgo.excel = Excel 导入',
  ].join('\n');
  const appRow = (await app.inject({ method: 'POST', url: '/api/open-apps', headers: AH,
    payload: { name: '标签打印 PC 客户端', product_id: productId, status: 'active', offline_days: 3, feature_schema: SCHEMA_TEXT } })).json();
  check('创建应用可带功能码表', Array.isArray(appRow.feature_schema) && appRow.feature_schema.length === 5, appRow.feature_schema);
  check('功能码表带名称回显', appRow.feature_schema[0].token === 'labelgo.basic' && appRow.feature_schema[0].label === '基础打印');

  const badSchema = await app.inject({ method: 'POST', url: '/api/open-apps', headers: AH,
    payload: { name: '坏表应用', product_id: null, feature_schema: 'labelgo.!! = 非法' } });
  check('非法功能码格式直接 400', badSchema.statusCode === 400, badSchema.json());

  await app.inject({ method: 'POST', url: '/api/plans/copy-template', headers: AH, payload: { app_id: appRow.id } });
  const planList = (await app.inject({ method: 'GET', url: '/api/plans?app_id=' + appRow.id, headers: AH })).json().list;
  const member = planList.find((p) => p.code === 'member');
  const free = planList.find((p) => p.code === 'free');
  check('模板复制出该产品专属五档', planList.length === 5 && !!member && !!free);

  // 白名单：未知 token 保存被拒绝
  const bad = await app.inject({ method: 'POST', url: `/api/plans/${member.id}`, headers: AH,
    payload: { features: ['labelgo.basic', 'labelgo.typo'] } });
  check('档位功能码不在白名单内被拒绝（P0-3）', bad.statusCode === 400 && /未登记/.test(bad.json().error || ''), bad.json());

  // 已知 token + limits 保存成功
  const good = await app.inject({ method: 'POST', url: `/api/plans/${member.id}`, headers: AH,
    payload: { features: ['labelgo.basic', 'labelgo.library', 'labelgo.excel'],
      limits: 'labelgo.library = 30\nlabelgo.excel_rows = 100' } });
  const memberPlan = good.json().plan;
  check('白名单内 token 可保存', good.statusCode === 200 && memberPlan.features.length === 3, memberPlan);
  check('limits 解析为数值对象（P1-5）', memberPlan.limits && memberPlan.limits['labelgo.library'] === 30
    && memberPlan.limits['labelgo.excel_rows'] === 100, memberPlan.limits);

  const badLimit = await app.inject({ method: 'POST', url: `/api/plans/${member.id}`, headers: AH,
    payload: { limits: 'labelgo.library = 很多' } });
  check('limits 非数值被拒绝', badLimit.statusCode === 400, badLimit.json());

  /* ---------------- 1. app.version 下发 id 与 limits ---------------- */
  console.log('\n[1] app/version');
  const vr = await app.inject({ method: 'GET', url: '/api/open/v1/app/version',
    ...signReq(appRow.app_secret, appRow.app_key, 'GET', '/api/open/v1/app/version') });
  const vj = vr.json();
  check('返回 app.id / app_key（P0-1）', vj.id === appRow.id && vj.app_key === appRow.app_key, vj.id);
  const catMember = (vj.plan_catalog || []).find((p) => p.code === 'member');
  check('plan_catalog 带 limits', catMember && catMember.limits['labelgo.library'] === 30, catMember && catMember.limits);

  /* ---------------- 2. 扫码登录选码 + bindMachine ---------------- */
  console.log('\n[2] 扫码确认绑定最佳授权');
  // 造一个用户，并直接塞一张高档（member, tier 10）授权
  const scene = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode', payload: {} })).json().scene;
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${scene}`, payload: { openid: 'ent-user-1', nickname: '权益用户' } });
  const u1 = db.prepare('SELECT * FROM users WHERE openid = ?').get('ent-user-1');
  const memberKey = genLicenseKey();
  db.prepare(`INSERT INTO licenses
    (license_key, user_id, app_id, product_id, type, max_devices, start_at, end_at, status, plan_id, plan_code, remark, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(memberKey, u1.id, appRow.id, 0, 'subscription', 2, ts, null, 'active', member.id, 'member', '测试高档授权', ts);

  const oScene = (await app.inject({ method: 'POST', url: '/api/open/v1/auth/qrcode',
    ...signReq(appRow.app_secret, appRow.app_key, 'POST', '/api/open/v1/auth/qrcode', {}) })).json().scene;
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${oScene}`, payload: { openid: 'ent-user-1', nickname: '权益用户' } });
  const login = (await app.inject({ method: 'GET',
    url: `/api/open/v1/auth/qrcode/${oScene}?app_key=${appRow.app_key}&machine_id=PC-ENT-1&machine_name=测试机&version=1.0.0` })).json();
  check('扫码登录返回 token 与用户', login.status === 'confirmed' && !!login.access_token, login);
  check('登录即返回 license payload（P0-2）', login.license && login.license.license_key === memberKey, login.license && login.license.license_key);
  check('选中的是 tier 最高的那张', login.license.plan === 'member' && login.license.entitlement.tier === 10, login.license && login.license.plan);
  const sess = db.prepare('SELECT * FROM client_sessions WHERE token = ?').get(login.access_token);
  const boundDev = db.prepare('SELECT * FROM license_devices WHERE license_id = ? AND device_sn = ?').get(login.license.license_id, 'PC-ENT-1');
  check('登录顺手 bindMachine（P0-2）', !!boundDev && sess.license_id === login.license.license_id, { bound: !!boundDev, sess: sess.license_id });
  check('license payload 带权益版本号', typeof login.license.entitlement_version === 'string' && login.license.entitlement_version.length === 12);

  /* ---------------- 3. /user/licenses?app_key= 过滤 + effective ---------------- */
  console.log('\n[3] 授权列表过滤');
  const BH = { authorization: 'Bearer ' + login.access_token };
  const lj = (await app.inject({ method: 'GET', url: '/api/open/v1/user/licenses?app_key=' + appRow.app_key, headers: BH })).json();
  const eff = (lj.list || []).filter((l) => l.effective);
  check('按 app_key 过滤并标出 effective（P1-6）', lj.list.length >= 2 && eff.length === 1 && eff[0].license_key === memberKey,
    { n: lj.list && lj.list.length, eff: eff.map((l) => l.license_key) });
  check('非 effective 的免费码排在后面', lj.list[lj.list.length - 1].plan === 'free', lj.list.map((l) => l.plan));
  const allL = (await app.inject({ method: 'GET', url: '/api/open/v1/user/licenses', headers: BH })).json();
  check('不带 app_key 返回全量（兼容）', allL.list.length >= lj.list.length);

  /* ---------------- 4. 心跳 entitlement_version ---------------- */
  console.log('\n[4] 心跳权益版本');
  const hb = (await app.inject({ method: 'POST', url: '/api/open/v1/license/heartbeat', headers: BH,
    payload: { machine_id: 'PC-ENT-1', entitlement_version: 'deadbeef' } })).json();
  check('心跳带版本时能报 changed=true（P1-8）', hb.valid === true && hb.entitlement_changed === true, { c: hb.entitlement_changed, v: hb.entitlement_version });
  const hb2 = (await app.inject({ method: 'POST', url: '/api/open/v1/license/heartbeat', headers: BH,
    payload: { machine_id: 'PC-ENT-1', entitlement_version: hb.entitlement_version } })).json();
  check('版本一致时报 changed=false', hb2.entitlement_changed === false, hb2.entitlement_changed);
  const hb3 = (await app.inject({ method: 'POST', url: '/api/open/v1/license/heartbeat', headers: BH,
    payload: { machine_id: 'PC-ENT-1' } })).json();
  check('不报版本时为 null（客户端未实现也不受影响）', hb3.entitlement_changed === null, hb3.entitlement_changed);

  /* ---------------- 5. handoff to=space&app= ---------------- */
  console.log('\n[5] handoff 定位产品');
  const ho = (await app.inject({ method: 'POST', url: '/api/open/v1/auth/handoff', headers: BH,
    payload: { to: 'space', app: appRow.app_key } })).json();
  check('handoff 带 app 参数落地产品卡片（P1-7）', /#\/space\?app=/.test(ho.url) && ho.url.indexOf(appRow.app_key) > -1, ho.url);
  const ho2 = (await app.inject({ method: 'POST', url: '/api/open/v1/auth/handoff', headers: BH,
    payload: { to: 'space', app: 'ak_not_exist' } })).json();
  check('不存在的 app_key 不拼进 URL', /#\/space$/.test(ho2.url), ho2.url);

  /* ---------------- 6. 离线票据 limits / entitlement_version ---------------- */
  console.log('\n[6] 离线票据');
  const tk = (await app.inject({ method: 'POST', url: '/api/open/v1/license/ticket', headers: BH, payload: {} })).json();
  check('票据含 limits 与权益版本', tk.payload && tk.payload.limits && tk.payload.limits['labelgo.library'] === 30
    && typeof tk.payload.entitlement_version === 'string', tk.payload && tk.payload.limits);

  /* ---------------- 7. 到期降级 ---------------- */
  console.log('\n[7] 订阅到期明确降级');
  db.prepare('UPDATE licenses SET end_at = ? WHERE id = ?').run(new Date(Date.now() - 86400000).toISOString(), login.license.license_id);
  const vf = (await app.inject({ method: 'POST', url: '/api/open/v1/license/verify', ...signReq(appRow.app_secret, appRow.app_key, 'POST', '/api/open/v1/license/verify',
      { license_key: memberKey, machine_id: 'PC-ENT-1', version: '1.0.0' }) })).json();
  check('过期后 verify 仍 valid（降到 free 档，P0-4）', vf.valid === true, vf);
  check('降级信息 downgraded_from 下发', vf.license && vf.license.downgraded_from === 'member' && vf.license.entitlement.plan_code === 'free',
    vf.license && { from: vf.license.downgraded_from, plan: vf.license.entitlement.plan_code });
  const hbD = (await app.inject({ method: 'POST', url: '/api/open/v1/license/heartbeat', headers: BH,
    payload: { machine_id: 'PC-ENT-1', entitlement_version: hb.entitlement_version } })).json();
  check('心跳感知权益变化（changed=true）', hbD.valid === true && hbD.entitlement_changed === true
    && hbD.license.downgraded_from === 'member', hbD.entitlement_changed);
  const downRow = db.prepare('SELECT * FROM licenses WHERE id = ?').get(login.license.license_id);
  check('原码与机器绑定保留（不换码不踢机）', downRow.license_key === memberKey && downRow.end_at === null && !!downRow.downgraded_at
    && !!db.prepare('SELECT id FROM license_devices WHERE license_id = ? AND device_sn = ?').get(downRow.id, 'PC-ENT-1'),
    { end_at: downRow.end_at, dg: downRow.downgraded_at });

  // 无档位的历史授权：过期语义保持，不乱降
  const legacyKey = genLicenseKey();
  db.prepare(`INSERT INTO licenses (license_key, user_id, product_id, type, max_devices, start_at, end_at, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(legacyKey, u1.id, productId, 'permanent', 1, ts,
    new Date(Date.now() - 86400000).toISOString(), 'active', ts);
  const vfLegacy = (await app.inject({ method: 'POST', url: '/api/open/v1/license/verify', ...signReq(appRow.app_secret, appRow.app_key, 'POST', '/api/open/v1/license/verify',
      { license_key: legacyKey }) })).json();
  check('无档位历史授权过期仍是过期（不误降级）', vfLegacy.valid === false && vfLegacy.code === 'LICENSE_EXPIRED', vfLegacy);

  /* ---------------- 8. 通用码升级不固化 ---------------- */
  console.log('\n[8] 通用码升级转产品授权');
  const scene2 = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode', payload: {} })).json().scene;
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${scene2}`, payload: { openid: 'ent-user-2', nickname: '升级用户' } });
  const login2 = (await app.inject({ method: 'GET', url: `/api/wechat/qrcode/${scene2}` })).json();
  const u2 = db.prepare('SELECT * FROM users WHERE openid = ?').get('ent-user-2');
  plansLib.ensureFreeLicense(u2.id); // 注册兜底：发一张「不限应用」通用免费码
  const generic = db.prepare('SELECT * FROM licenses WHERE user_id = ? AND app_id IS NULL AND product_id = 0').get(u2.id);
  check('用户有一张通用免费码', !!generic, generic);
  db.prepare('INSERT INTO license_devices (license_id, device_sn, device_name, machine_id, app_id, bound_at) VALUES (?,?,?,?,?,?)')
    .run(generic.id, 'PC-GEN-1', '通用机', 'PC-GEN-1', null, ts);

  const PH = { authorization: 'Bearer ' + login2.token };
  const order = (await app.inject({ method: 'POST', url: '/api/portal/orders', headers: PH,
    payload: { kind: 'upgrade', plan_id: member.id, ref_license_id: generic.id, app_id: appRow.id } })).json();
  const pay = await app.inject({ method: 'POST', url: `/api/pay/simulate/${order.order_no}`, headers: PH, payload: {} });
  check('通用码升级订单支付成功', pay.statusCode === 200, pay.json());
  const genRow = db.prepare('SELECT * FROM licenses WHERE id = ?').get(generic.id);
  const upgraded = db.prepare('SELECT * FROM licenses WHERE user_id = ? AND app_id = ? AND plan_id = ?').get(u2.id, appRow.id, member.id);
  check('发的是新产品专属授权（P2-10 不固化）', !!upgraded && upgraded.license_key !== generic.license_key, upgraded && upgraded.license_key);
  check('原通用码保持通用免费（其他产品不受影响）', genRow.app_id === null && genRow.plan_id === generic.plan_id && genRow.license_key === generic.license_key,
    { app_id: genRow.app_id, plan: genRow.plan_code });
  check('机器绑定复制到新授权（免重新激活）',
    !!db.prepare('SELECT id FROM license_devices WHERE license_id = ? AND device_sn = ?').get(upgraded.id, 'PC-GEN-1'));
  const dr = JSON.parse(db.prepare('SELECT deliver_result FROM orders WHERE id = ?').get(order.id).deliver_result || '[]');
  check('发货结果说明转授权', dr[0] && dr[0].new_license === true && dr[0].from_license === generic.license_key, dr[0]);

  /* ---------------- 9. 我的空间：降级痕迹与选码口径 ---------------- */
  console.log('\n[9] 我的空间');
  const space = (await app.inject({ method: 'GET', url: '/api/portal/space', headers: PH })).json();
  const spApp = (space.apps || []).find((a) => a.app_id === appRow.id);
  check('空间按 tier 选当前生效授权', spApp && spApp.license && spApp.license.license_key === upgraded.license_key && spApp.plan.code === 'member',
    spApp && spApp.license && spApp.license.license_key);
  const scene1p = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode', payload: {} })).json().scene;
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${scene1p}`, payload: { openid: 'ent-user-1', nickname: '权益用户' } });
  const portalToken1 = (await app.inject({ method: 'GET', url: `/api/wechat/qrcode/${scene1p}` })).json().token;
  const space1 = (await app.inject({ method: 'GET', url: '/api/portal/space', headers: { authorization: 'Bearer ' + portalToken1 } })).json();
  const sp1 = (space1.apps || []).find((a) => a.app_id === appRow.id);
  check('已降级用户的空间带 downgraded_from', sp1 && sp1.license && sp1.license.downgraded_from === 'member' && sp1.plan.code === 'free',
    sp1 && sp1.license && sp1.license.downgraded_from);

  /* ---------------- 7. 手工发码按档位 ---------------- */
  console.log('\n[7] 手工发码按档位');
  const plist4 = (await app.inject({ method: 'GET', url: `/api/plans?product_id=${productId}`, headers: AH })).json().list;
  check('按产品查档位（发码表单联动）', plist4.some((p) => p.id === member.id), plist4.length);

  const scene4 = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode', payload: {} })).json().scene;
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${scene4}`, payload: { openid: 'ent-user-4', nickname: '手工发码用户' } });
  const u4 = db.prepare('SELECT * FROM users WHERE openid = ?').get('ent-user-4');

  const manual = (await app.inject({ method: 'POST', url: '/api/licenses', headers: AH,
    payload: { user_id: u4.id, product_id: productId, plan_id: member.id, type: 'permanent', days: 99, max_devices: 9 } })).json();
  const manualRow = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(manual.license_key);
  check('手工发码带档位：plan/plan_code/app_id 落库', manualRow && manualRow.plan_id === member.id
    && manualRow.plan_code === 'member' && manualRow.app_id === appRow.id, manualRow && [manualRow.plan_id, manualRow.app_id]);
  check('类型/天数/设备数取档位配置，手填被忽略', manualRow.type === 'subscription'
    && manualRow.duration_days === member.period_days && manualRow.max_devices === Number(member.max_devices),
    [manualRow.type, manualRow.duration_days, manualRow.max_devices]);

  const poolCard = (await app.inject({ method: 'POST', url: '/api/licenses', headers: AH,
    payload: { product_id: productId, plan_id: member.id, mode: 'pool' } })).json();
  const poolRow = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(poolCard.license_key);
  check('卡密池按档位印卡：未分配 + 绑定后起算时长', poolRow.status === 'unassigned' && poolRow.end_at === null
    && poolRow.duration_days === member.period_days && poolRow.plan_id === member.id, poolRow && [poolRow.status, poolRow.duration_days]);

  // 把池卡绑给用户：绑定那一刻按档位周期起算
  const bindRes = (await app.inject({ method: 'POST', url: `/api/licenses/${poolRow.id}/bind`, headers: AH,
    payload: { user_id: u4.id } })).json();
  const boundRow = db.prepare('SELECT * FROM licenses WHERE id = ?').get(poolRow.id);
  check('池卡绑定后 end_at = 绑定时刻 + 档位周期', bindRes.ok && boundRow.end_at !== null
    && Math.abs(new Date(boundRow.end_at) - (Date.now() + Number(member.period_days) * 86400000)) < 60000, boundRow.end_at);

  const otherProduct = db.prepare(`INSERT INTO products (type, name, subtitle, price, status, sort, created_at, updated_at)
    VALUES ('software', '别的软件', '', 0, 'on', 0, ?, ?)`).run(ts, ts).lastInsertRowid;
  const wrongProduct = await app.inject({ method: 'POST', url: '/api/licenses', headers: AH,
    payload: { user_id: u4.id, product_id: otherProduct, plan_id: member.id } });
  check('档位属于其他产品时发码被拒', wrongProduct.statusCode === 400, wrongProduct.json());

  const licList = (await app.inject({ method: 'GET', url: '/api/licenses?q=' + manual.license_key, headers: AH })).json();
  check('授权列表回显档位名', licList.list.length === 1 && licList.list[0].plan_name === member.name, licList.list[0] && licList.list[0].plan_name);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

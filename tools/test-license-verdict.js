/* LabelGo「在线授权 · 删码/降档响应契约」验收自测（2026-11-08）
 *
 * 软件方契约 6 条 + 验收：
 *  1. 删码/吊销/停用/到期 → valid:false + 标准 reason/code，客户端清快照降免费版
 *  2. 仍在但降免费档 → valid:true + 完整 license（entitlement.plan_name = 免费版，
 *     features/limits 按免费档），不能只给 license_key
 *  3. 账号一张授权都没有 → 200 + valid:true + license:null
 *  4. 任何响应都必须带 license 字段 —— 省略会被客户端当「老后台、无结论」沿用旧快照
 *  5. 心跳带 entitlement_version / entitlement_changed
 *  6. 部署故障用 5xx，别用 403（403 会把付费客户降成免费版）
 *  验收：删码 → 刷新授权显示免费版；不点刷新等一拍心跳也自动降；
 *        续费/重新激活原地升回
 *
 * 运行：node tools/test-license-verdict.js
 */
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-license-verdict.db');
for (const s of ['', '-wal', '-shm']) fs.rmSync(DB_FILE + s, { force: true });
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.NODE_ENV = 'test';

const { build } = require('../server');
const db = require('../server/db');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 500) : '')); }
}
const ts = new Date().toISOString();
const future = new Date(Date.now() + 30 * 86400000).toISOString();
const past = new Date(Date.now() - 86400000).toISOString();
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// 验收材料：软件方要求回传「刷新前后 + 续费恢复」的真实响应 body
let sampleValid = null, sampleDeleted = null, sampleFree = null, sampleRenewed = null;

let seq = 0;
function makeLicense(uid, appId, plan, extra = {}) {
  seq += 1;
  const key = `LIC-VERDICT-${String(seq).padStart(4, '0')}-TEST`;
  const info = db.prepare(`INSERT INTO licenses
    (license_key, user_id, app_id, product_id, plan_id, plan_code, type, max_devices, start_at, end_at, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(key, uid, appId, 0, plan ? plan.id : null, plan ? plan.code : '',
      extra.type || 'permanent', extra.max_devices || 3, extra.start_at || ts,
      extra.end_at === undefined ? null : extra.end_at, extra.status || 'active', ts);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO license_devices (license_id, device_sn, bound_at) VALUES (?,?,?)')
    .run(id, 'MAC-LABELGO-01', ts);
  return id;
}

function makeSession(uid, appId, licenseId) {
  const token = 'tok-' + Math.random().toString(36).slice(2);
  db.prepare(`INSERT INTO client_sessions
    (token, refresh_token, app_id, user_id, license_id, machine_id, status, expires_at, refresh_expires_at, created_at)
    VALUES (?,?,?,?,?,?,'active',?,?,?)`)
    .run(token, 'rt-' + token, appId, uid, licenseId, 'MAC-LABELGO-01', future, future, ts);
  return token;
}

(async () => {
  const app = build();
  await app.ready();
  const adminToken = (await app.inject({
    method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' },
  })).json().token;
  const AH = { authorization: 'Bearer ' + adminToken };

  // 建产品 / 应用 / 复制模板档位，让免费档和会员档有可验证的 features / limits
  const productId = db.prepare(`INSERT INTO products (type, name, subtitle, price, status, created_at, updated_at)
    VALUES ('software','LabelGo','标签打印',0,'on',?,?)`).run(ts, ts).lastInsertRowid;
  const appRow = (await app.inject({
    method: 'POST', url: '/api/open-apps', headers: AH,
    payload: {
      name: 'LabelGo 桌面端', product_id: productId, status: 'active', offline_days: 7,
      feature_schema: 'labelgo.basic = 基础打印\nlabelgo.library = 标签库\nlabelgo.batch = 批量打印\nlabelgo.excel = Excel 导入',
    },
  })).json();
  check('测试应用建好', !!appRow.id, appRow);
  await app.inject({ method: 'POST', url: '/api/plans/copy-template', headers: AH, payload: { app_id: appRow.id } });
  const planList = (await app.inject({ method: 'GET', url: '/api/plans?app_id=' + appRow.id, headers: AH })).json().list;
  const freePlan = planList.find((p) => p.code === 'free');
  const memberPlan = planList.find((p) => p.code === 'member');
  check('免费档/会员档都存在', !!freePlan && !!memberPlan, planList.map((p) => p.code));
  await app.inject({ method: 'POST', url: `/api/plans/${freePlan.id}`, headers: AH,
    payload: { features: ['labelgo.basic'], limits: 'labelgo.library = 5' } });
  await app.inject({ method: 'POST', url: `/api/plans/${memberPlan.id}`, headers: AH,
    payload: { features: ['labelgo.basic', 'labelgo.library', 'labelgo.batch', 'labelgo.excel'], limits: 'labelgo.library = 30' } });
  const freeCfg = (await app.inject({ method: 'GET', url: '/api/plans?app_id=' + appRow.id, headers: AH })).json().list.find((p) => p.code === 'free');
  check('免费档配额配成 5 个标签库', freeCfg.limits && Number(freeCfg.limits['labelgo.library']) === 5, freeCfg.limits);

  const uid = db.prepare("INSERT INTO users (openid, nickname, created_at) VALUES ('verdict-u','契约测试',?)").run(ts).lastInsertRowid;
  const H = (token) => ({ authorization: 'Bearer ' + token });
  const verify = (token) => app.inject({ method: 'POST', url: '/api/open/v1/license/verify', headers: H(token), payload: {} });
  const beat = (token, body = {}) => app.inject({ method: 'POST', url: '/api/open/v1/license/heartbeat', headers: H(token), payload: body });

  console.log('\n[1] 正常授权：响应必须是完整的 license + entitlement');
  const licId = makeLicense(uid, appRow.id, memberPlan);
  let token = makeSession(uid, appRow.id, licId);
  let r = await verify(token);
  let b = r.json();
  check('verify 200 + valid:true', r.statusCode === 200 && b.valid === true, [r.statusCode, b]);
  check('带 license 对象', b.license && !!b.license.license_key, b.license);
  check('带 entitlement（不是只给 license_key）', !!b.license.entitlement && !!b.entitlement, b.license);
  check('档位是会员档', b.license.entitlement.plan_code === 'member', b.license.entitlement);
  check('会员档配额 30', Number(b.license.entitlement.limits['labelgo.library']) === 30, b.license.entitlement.limits);
  check('带 entitlement_version', typeof b.entitlement_version === 'string' && b.entitlement_version.length > 0, b.entitlement_version);
  sampleValid = b;
  let hb = await beat(token, { entitlement_version: b.entitlement_version });
  check('心跳 200 + valid:true + 完整 license', hb.statusCode === 200 && hb.json().valid === true && !!hb.json().license, hb.json());
  check('心跳带 entitlement_changed=false（版本没变）', hb.json().entitlement_changed === false, hb.json().entitlement_changed);

  console.log('\n[2] 删码：verify 与心跳都给明确结论，且不省略 license 字段');
  const staleVersion = b.entitlement_version;
  db.prepare('DELETE FROM licenses WHERE id = ?').run(licId);
  r = await verify(token); b = r.json();
  check('verify 403 + valid:false', r.statusCode === 403 && b.valid === false, [r.statusCode, b]);
  check('reason / code 都是 LICENSE_NOT_FOUND', b.reason === 'LICENSE_NOT_FOUND' && b.code === 'LICENSE_NOT_FOUND', b);
  check('license 字段存在且为 null（关键：不能省略）', has(b, 'license') && b.license === null, b);
  check('entitlement_changed=true 让客户端立即清快照', b.entitlement_changed === true, b.entitlement_changed);
  check('中文提示仍在 message 里', /授权/.test(b.message || ''), b.message);
  sampleDeleted = b;
  hb = await beat(token, { entitlement_version: staleVersion }); hb = hb.json();
  check('心跳 200 + valid:false + license:null', hb.valid === false && has(hb, 'license') && hb.license === null, hb);
  check('心跳也带标准 code', hb.code === 'LICENSE_NOT_FOUND', hb);
  check('心跳也带 entitlement_changed', hb.entitlement_changed === true, hb.entitlement_changed);

  console.log('\n[3] 吊销 / 停用 / 到期：各自的标准码');
  const cases = [
    ['吊销', { status: 'revoked' }, 'LICENSE_REVOKED'],
    ['停用', { status: 'inactive' }, 'LICENSE_INACTIVE'],
    ['过期（无档位，不降级）', { status: 'active', end_at: past, type: 'subscription' }, 'LICENSE_EXPIRED'],
  ];
  for (const [label, extra, expected] of cases) {
    const id = makeLicense(uid, appRow.id, null, extra); // 无档位 → 不会被 settleExpiry 降级
    const t = makeSession(uid, appRow.id, id);
    const v = await verify(t);
    check(`${label} → ${expected}`, v.json().code === expected && v.json().valid === false && v.json().license === null, v.json());
    const h = (await beat(t)).json();
    check(`${label}心跳也给 ${expected}`, h.code === expected && has(h, 'license') && h.license === null, h);
    db.prepare('DELETE FROM licenses WHERE id = ?').run(id);
  }

  console.log('\n[4] 账号一张授权都没有 → 200 + valid:true + license:null');
  const emptyTok = makeSession(uid, appRow.id, null);
  r = await verify(emptyTok); b = r.json();
  check('verify 200 + valid:true', r.statusCode === 200 && b.valid === true, [r.statusCode, b]);
  check('license:null 而不是省略字段', has(b, 'license') && b.license === null, b);
  const hbEmpty = (await beat(emptyTok)).json();
  check('心跳同样 200 + valid:true + license:null', hbEmpty.valid === true && has(hbEmpty, 'license') && hbEmpty.license === null, hbEmpty);

  console.log('\n[5] 降免费档：仍是 valid:true，但 entitlement 必须完整写「免费版」');
  const expId = makeLicense(uid, appRow.id, memberPlan, { end_at: past, type: 'subscription' });
  const expTok = makeSession(uid, appRow.id, expId);
  r = await verify(expTok); b = r.json();
  check('订阅过期被收敛为 valid:true（同一个码降级，不是删码）', r.statusCode === 200 && b.valid === true, [r.statusCode, b]);
  check('仍返回完整 license 对象', !!b.license && !!b.license.license_key, b.license);
  check('entitlement.plan_name = 免费版', b.license.entitlement.plan_name === '免费版', b.license.entitlement);
  check('plan_code 落到 free', b.license.entitlement.plan_code === 'free', b.license.entitlement);
  check('features 按免费档下发', Array.isArray(b.license.entitlement.features) && b.license.entitlement.features.includes('labelgo.basic'), b.license.entitlement.features);
  check('limits 按免费档下发（标签库回到 5 个）', Number(b.license.entitlement.limits['labelgo.library']) === 5, b.license.entitlement.limits);
  check('带 is_free 标记', b.license.entitlement.is_free === true, b.license.entitlement);
  sampleFree = b;
  check('downgraded_from 记录原档位', b.license.downgraded_from === 'member', b.license.downgraded_from);
  const oldVer = 'stale-version-0001';
  const hbDown = (await beat(expTok, { entitlement_version: oldVer })).json();
  check('心跳报旧版本 → entitlement_changed=true', hbDown.entitlement_changed === true, hbDown.entitlement_changed);
  check('心跳也下发免费版 entitlement', hbDown.license && hbDown.license.entitlement.plan_name === '免费版', hbDown.license && hbDown.license.entitlement);
  check('心跳带 entitlement_version', typeof hbDown.entitlement_version === 'string' && hbDown.entitlement_version.length > 0, hbDown.entitlement_version);

  console.log('\n[6] 续费 / 重新激活原地升回（走真实发货链路）');
  const { deliverOrder } = require('../server/services/deliver');
  const delivered = deliverOrder({
    id: 99001, kind: 'renew', plan_id: memberPlan.id, ref_license_id: expId,
    user_id: uid, app_id: appRow.id, items: '[]',
  });
  check('发货返回 license_renew（原码原地升回，不发新码）', delivered[0].type === 'license_renew', delivered);
  const licAfter = db.prepare('SELECT * FROM licenses WHERE id = ?').get(expId);
  check('续费清掉 downgraded_from / downgraded_at', !licAfter.downgraded_from && !licAfter.downgraded_at, licAfter);
  r = await verify(expTok); b = r.json();
  check('升回会员档', b.valid === true && b.license.entitlement.plan_code === 'member', b.license && b.license.entitlement);
  check('配额升回 30', Number(b.license.entitlement.limits['labelgo.library']) === 30, b.license.entitlement.limits);
  check('降级痕迹清空', !b.license.downgraded_from, b.license.downgraded_from);
  check('权益版本与免费档不同', b.entitlement_version !== hbDown.entitlement_version, [b.entitlement_version, hbDown.entitlement_version]);
  sampleRenewed = b;

  console.log('\n[7] 所有授权结论都带 license 字段（含失败分支）');
  const badTok = makeSession(uid, appRow.id, makeLicense(uid, appRow.id, memberPlan, { status: 'revoked' }));
  const signedMissing = await app.inject({ method: 'POST', url: '/api/open/v1/license/verify', payload: {} });
  const responses = [
    ['verify 正常', (await verify(expTok)).json()],
    ['verify 吊销', (await verify(badTok)).json()],
    ['verify 无授权', (await verify(emptyTok)).json()],
    ['心跳正常', (await beat(expTok)).json()],
    ['心跳吊销', (await beat(badTok)).json()],
    ['心跳无授权', (await beat(emptyTok)).json()],
    ['verify 无签名', signedMissing.json()],
  ];
  for (const [label, body] of responses) {
    check(`${label} 带 license 字段`, has(body, 'license'), Object.keys(body));
  }

  console.log('\n[8] 登录类响应也不能省略 license（否则沿用旧快照）');
  // 扫码登录已确认：该 GET 只需要 app_key，走真实选码/绑定链路
  const scene = 'SCENE-VERDICT';
  db.prepare(`INSERT INTO wechat_sessions (scene, ticket, qrcode_url, status, openid, user_id, created_at, expires_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(scene, '', '', 'confirmed', 'openid-verdict', uid, ts, future);
  const qr = await app.inject({
    method: 'GET',
    url: `/api/open/v1/auth/qrcode/${scene}?app_key=${encodeURIComponent(appRow.app_key)}&machine_id=MAC-LABELGO-01`,
  });
  check('扫码登录返回 confirmed', qr.json().status === 'confirmed', qr.json());
  check('扫码登录带 license 字段（有授权就是对象）', has(qr.json(), 'license'), Object.keys(qr.json()));
  const rf = await app.inject({
    method: 'POST', url: '/api/open/v1/auth/refresh', payload: { refresh_token: 'rt-' + expTok },
  });
  check('刷新令牌返回 200', rf.statusCode === 200, rf.json());
  check('刷新令牌带 license 字段', has(rf.json(), 'license'), Object.keys(rf.json()));

  console.log('\n[9] 部署故障用 5xx，不用 403');
  const origPrepare = db.prepare;
  db.prepare = () => { throw new Error('simulated DB outage'); };
  let outage;
  try {
    outage = await app.inject({ method: 'POST', url: '/api/open/v1/license/verify', headers: H(expTok), payload: {} });
  } finally { db.prepare = origPrepare; }
  check('数据库异常 → 5xx（客户端走离线宽限，不会误降免费版）', outage && outage.statusCode >= 500, outage && outage.statusCode);
  check('不是 403', outage && outage.statusCode !== 403, outage && outage.statusCode);

  // 软件方验收要的响应 body：直接可复制回传（截图在客户端侧补）
  console.log('\n========== 验收响应 body ==========');
  const pick = (o) => o && ({ valid: o.valid, license: o.license, reason: o.reason, code: o.code,
    entitlement_version: o.entitlement_version, entitlement_changed: o.entitlement_changed });
  console.log('[刷新前 · 会员档] ' + JSON.stringify(pick(sampleValid)));
  console.log('[删码后 · 刷新授权] ' + JSON.stringify(pick(sampleDeleted)));
  console.log('[降免费档] ' + JSON.stringify(pick(sampleFree)));
  console.log('[续费恢复] ' + JSON.stringify(pick(sampleRenewed)));
  console.log('====================================');

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  await app.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

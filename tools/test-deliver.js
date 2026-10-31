/* 支付后自动发货自测（重点是 API 额度包）
 *
 * 背景（2026-11-01 线上故障）：用户买了「API 调用额度包」，钱付了、订单也标记已支付，
 * 但用户端额度纹丝不动。两个真因叠加：
 *  1. 发货把额度充进了 api_keys 表，而用户端真正扣减的额度池是 users.blcloud_quota
 *     （blcloud 开放平台），两张表互不相干 —— 钱付了，额度一点没变
 *  2. 额度数量是从商品 description 里正则猜「N 万次」得来的，种子商品把「10 万次」
 *     写在 subtitle 里，压根猜不到，只能按默认值发
 *  顺带：发货结果没有任何落库/展示，付了钱到底发了什么，用户和管理员都看不到
 *
 * 用法：node tools/test-deliver.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const CHILD = path.join(ROOT, 'data', '.test-deliver-child.js');
const RESULT = path.join(ROOT, 'data', '.test-deliver-result.json');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); } else {
    fail++;
    console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + String(extra).slice(0, 400) : ''));
  }
}

const childLines = [
  'const fs = require("fs");',
  'const ROOT = process.env.CHILD_ROOT;',
  'const RESULT = process.env.CHILD_RESULT;',
  'const db = require(ROOT + "/server/db/index.js");',
  'const { build } = require(ROOT + "/server/index.js");',
  'const config = require(ROOT + "/server/lib/config.js");',
  'const auth = require(ROOT + "/server/lib/auth.js");',
  'const { markPaid } = require(ROOT + "/server/services/pay.js");',
  'const paydiag = require(ROOT + "/server/lib/paydiag.js");',
  'const out = [];',
  'const t = (name, ok, extra) => out.push({ name, ok: !!ok, extra: extra === undefined ? "" : String(extra).slice(0, 400) });',
  'const ts = new Date().toISOString();',
  '',
  'function mkUser(tag) {',
  '  const i = db.prepare("INSERT INTO users (openid, nickname, avatar, phone, status, created_at) VALUES (?,?,?,?,?,?)")',
  // phone 上有 UNIQUE 约束，多个测试用户必须给不同的值，否则第二个就插不进去
  '    .run("oDeliver" + tag + Date.now(), "发货测试" + tag, "", "1" + tag + Date.now(), "active", ts);',
  '  return Number(i.lastInsertRowid);',
  '}',
  'function mkProduct(tag, type, extra) {',
  '  const p = Object.assign({ type, name: "商品" + tag, subtitle: "", description: "描述" + tag,',
  '    category: "测试", price: 1, original_price: 1, version: "1.0.0", stock: 999, status: "on", quota: 0 }, extra || {});',
  '  const i = db.prepare("INSERT INTO products (type, name, subtitle, description, category, price,"',
  '    + " original_price, version, stock, status, quota, created_at, updated_at)"',
  '    + " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")',
  '    .run(p.type, p.name, p.subtitle, p.description, p.category, p.price, p.original_price,',
  '      p.version, p.stock, p.status, p.quota, ts, ts);',
  '  return Number(i.lastInsertRowid);',
  '}',
  'function mkOrder(uid, pid, type, tag, amount) {',
  '  const no = "NO_DELIVER_" + tag + "_" + Date.now();',
  '  const items = JSON.stringify([{ product_id: pid, product_name: "商品" + tag, product_type: type, price: amount, qty: 1 }]);',
  '  const i = db.prepare("INSERT INTO orders (order_no, user_id, amount, pay_amount, channel, status, items, created_at)"',
  '    + " VALUES (?,?,?,?,?,?,?,?)").run(no, uid, amount, amount, "wxpay", "pending", items, ts);',
  '  return { id: Number(i.lastInsertRowid), no };',
  '}',
  'function quotaOf(uid) {',
  '  return Number(db.prepare("SELECT blcloud_quota FROM users WHERE id = ?").get(uid).blcloud_quota || 0);',
  '}',
  'function deliverResult(oid) {',
  '  const raw = db.prepare("SELECT deliver_result FROM orders WHERE id = ?").get(oid).deliver_result;',
  '  try { return JSON.parse(raw || "[]"); } catch { return []; }',
  '}',
  '',
  '(async () => {',
  '  const app = build();',
  '  const bp = config.basePath();',
  '',
  '  // ① 额度包：额度必须进用户端真正扣减的池子（users.blcloud_quota）',
  '  //    商品按线上种子数据的写法：「10 万次」在 subtitle，description 里没有数字',
  '  const uid1 = mkUser("A");',
  '  const pid1 = mkProduct("A", "service", { subtitle: "10 万次设备数据接口", description: "适用于自有系统集成" });',
  '  const o1 = mkOrder(uid1, pid1, "service", "A", 1);',
  '  t("发货前账户额度为 0", quotaOf(uid1) === 0, quotaOf(uid1));',
  '  markPaid(o1.no, "TXDELIVER1", "wxpay", "{}", 1);',
  '  t("额度包发货后账户额度增加 10 万次", quotaOf(uid1) === 100000, quotaOf(uid1));',
  '  const oldKeys = db.prepare("SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ?").get(uid1).c;',
  '  t("不再把额度充进用户看不到的 api_keys 表", oldKeys === 0, oldKeys);',
  '  const r1 = deliverResult(o1.id);',
  '  t("发货结果写回订单（api_quota）", r1.length === 1 && r1[0].type === "api_quota", JSON.stringify(r1));',
  '  t("发货结果里记录了额度与余额", r1[0] && r1[0].quota === 100000 && r1[0].after === 100000, JSON.stringify(r1[0]));',
  '',
  '  // ② 后台显式填的「API 额度」必须优先，不能被名称里的数字盖掉',
  '  const uid2 = mkUser("B");',
  '  const pid2 = mkProduct("B", "service", { quota: 500, subtitle: "100 万次", description: "100万次" });',
  '  const o2 = mkOrder(uid2, pid2, "service", "B", 1);',
  '  markPaid(o2.no, "TXDELIVER2", "wxpay", "{}", 1);',
  '  t("显式配置的额度优先于名称里的数字", quotaOf(uid2) === 500, quotaOf(uid2));',
  '',
  '  // ③ 软件类商品照旧发授权码',
  '  const uid3 = mkUser("C");',
  '  const pid3 = mkProduct("C", "software", {});',
  '  const o3 = mkOrder(uid3, pid3, "software", "C", 1);',
  '  markPaid(o3.no, "TXDELIVER3", "wxpay", "{}", 1);',
  '  const lic = db.prepare("SELECT * FROM licenses WHERE user_id = ?").all(uid3);',
  '  t("软件商品发放授权码", lic.length === 1, JSON.stringify(lic).slice(0, 120));',
  '  const r3 = deliverResult(o3.id);',
  '  t("授权码写进发货结果", r3.length === 1 && r3[0].type === "license" && !!r3[0].license_key, JSON.stringify(r3));',
  '  t("授权码与库里的一致", !!lic[0] && r3[0] && r3[0].license_key === lic[0].license_key, JSON.stringify(r3[0]));',
  '',
  '  // ④ 发货留痕：诊断里能看到发了什么（客服核对用）',
  '  const evs = paydiag.list(50).filter((e) => e.type === "deliver");',
  '  t("发货写入支付诊断", evs.length >= 3, JSON.stringify(evs.slice(0, 1)));',
  '  t("诊断里写明额度包发了多少次", evs.some((e) => /API 额度 \\+100000/.test(e.detail)), JSON.stringify(evs.map((e) => e.detail).slice(0, 3)));',
  '',
  '  // ⑤ 管理员手动补发也要留下结果（否则重复发货无从核对）',
  '  const token = (await app.inject({ method: "POST", url: bp + "/api/admin/login",',
  '    payload: { username: "admin", password: process.env.ADMIN_INIT_PASSWORD } })).json().token;',
  '  const ah = { authorization: "Bearer " + token };',
  '  const res = await app.inject({ method: "POST", url: bp + "/api/orders/" + o2.id + "/deliver", headers: ah, payload: {} });',
  '  t("手动补发接口可用", res.statusCode === 200, res.statusCode + " " + String(res.body).slice(0, 120));',
  '  t("手动补发后额度再次增加", quotaOf(uid2) === 1000, quotaOf(uid2));',
  '  t("手动补发结果也写回订单", deliverResult(o2.id).length === 1, JSON.stringify(deliverResult(o2.id)));',
  '',
  '  // ⑥ 商品被删时不能静默：订单已支付但没有发放任何东西，必须留痕',
  '  const uid4 = mkUser("D");',
  '  const o4 = mkOrder(uid4, 999999, "software", "D", 1);',
  '  markPaid(o4.no, "TXDELIVER4", "wxpay", "{}", 1);',
  '  const r4 = deliverResult(o4.id);',
  '  t("商品不存在时发货结果为空数组", Array.isArray(r4) && r4.length === 0, JSON.stringify(r4));',
  '  const warn = paydiag.list(50).filter((e) => e.type === "deliver" && e.level !== "ok");',
  '  t("空发货会被诊断标出来", warn.some((e) => /没有发放任何东西/.test(e.detail)), JSON.stringify(warn.map((e) => e.detail).slice(0, 2)));',
  '  await app.close();',
  '  fs.writeFileSync(RESULT, JSON.stringify(out));',
  '})().catch((e) => { fs.writeFileSync(RESULT, JSON.stringify([{ name: "子进程异常: " + e.message, ok: false, extra: String(e.stack || "").slice(0, 400) }])); });',
];

fs.rmSync(RESULT, { force: true });
fs.writeFileSync(CHILD, childLines.join('\n'));
const db = path.join(ROOT, 'data', '.test-deliver.db');
for (const f of [db, db + '-shm', db + '-wal']) fs.rmSync(f, { force: true });
try {
  execFileSync(NODE, [CHILD], {
    cwd: ROOT,
    env: {
      ...process.env, DB_PATH: db, ADMIN_INIT_PASSWORD: 'admin123',
      CHILD_ROOT: ROOT.replace(/\\/g, '/'), CHILD_RESULT: RESULT.replace(/\\/g, '/'),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
} catch (e) {
  check('子进程可执行', false, e.message + '（子进程源码保留在 ' + CHILD + '，可直接 node 运行复现）');
}
if (!fs.existsSync(RESULT)) {
  check('子进程产出结果', false, '无结果文件');
} else {
  console.log('\n支付后自动发货（API 额度包 / 授权码 / 发货留痕）');
  for (const row of JSON.parse(fs.readFileSync(RESULT, 'utf8'))) check(row.name, row.ok, row.extra);
}
// 失败时保留子进程源码，便于直接运行复现
if (fail === 0) fs.rmSync(CHILD, { force: true });
for (const f of [RESULT, db, db + '-shm', db + '-wal']) fs.rmSync(f, { force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

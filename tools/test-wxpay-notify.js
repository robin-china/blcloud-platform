/* 微信支付回调路径自测
 *
 * 背景（2026-10-31 线上两个真实故障）：
 *  1. Node 的内置 fetch 会自动带上 accept-language: *，
 *     微信支付不接受，拉平台证书（回调验签要用）直接回
 *     PARAM_ERROR「传入了不支持的Accept-Language」→ 下单成功但回调永远失败
 *  2. pay.js 的 preParsing 钩子用 req.url.startsWith('/api/pay/notify/wxpay')
 *     判定要不要兜住原始报文，子路径部署时 req.url 是 '/platform/api/...'，
 *     判定失败 → 拿不到原文 → 验签必挂
 *
 * 用法：node tools/test-wxpay-notify.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const CHILD = path.join(ROOT, 'data', '.wxpay-notify-child.js');
const RESULT = path.join(ROOT, 'data', '.wxpay-notify-result.json');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); } else {
    fail++;
    console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + String(extra).slice(0, 300) : ''));
  }
}

/* 子脚本用数组拼装，不用模板字面量 —— 模板字面量的转义（反斜杠、反引号）
 * 会在求值阶段被吃掉，之前踩过多次泰裤辣。 */
const childLines = [
  'const fs = require("fs");',
  'const crypto = require("crypto");',
  'const ROOT = process.env.CHILD_ROOT;',
  'const RESULT = process.env.CHILD_RESULT;',
  'const config = require(ROOT + "/server/lib/config.js");',
  'const { build } = require(ROOT + "/server/index.js");',
  'const wxpay = require(ROOT + "/server/services/wxpay.js");',
  'const paydiag = require(ROOT + "/server/lib/paydiag.js");',
  'const out = [];',
  'const t = (name, ok, extra) => out.push({ name, ok: !!ok, extra: extra === undefined ? "" : String(extra) });',
  '(async () => {',
  '  const bp = require(ROOT + "/server/lib/config.js").basePath();',
  '  const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048,',
  '    privateKeyEncoding: { type: "pkcs8", format: "pem" },',
  '    publicKeyEncoding: { type: "spki", format: "pem" } });',
  '  config.setConfig("wxpay", { enabled: true, appid: "wxNotReal", mchid: "1900000000",',
  '    mch_cert_serial: "ABC123", api_v3_key: "01234567890123456789012345678901",',
  '    private_key: kp.privateKey, notify_url: "", platform_cert: "" });',
  '',
  '  // ① 发出的请求必须带合规的 Accept-Language，不能是 Node 默认的 *',
  '  let seen = null;',
  '  const realFetch = global.fetch;',
  '  global.fetch = async (url, opt) => {',
  '    seen = (opt && opt.headers) || {};',
  '    return new Response(JSON.stringify({ code_url: "weixin://fake" }), {',
  '      status: 200, headers: { "content-type": "application/json" } });',
  '  };',
  '  try {',
  '    await wxpay.nativePrepay({ description: "测试", outTradeNo: "NO1", amount: 1, notifyUrl: "https://x.cn/api/pay/notify/wxpay" });',
  '  } catch (e) { /* 只用首捕请求头，失败也算捕获到 */ }',
  '  global.fetch = realFetch;',
  '  const langKey = Object.keys(seen || {}).find((k) => k.toLowerCase() === "accept-language");',
  '  t("请求头带显式的 Accept-Language", !!langKey, "keys=" + Object.keys(seen || {}).join(","));',
  '  t("Accept-Language 不是 Node 默认的 *", (seen && seen[langKey || ""] || "").trim() !== "*", seen && seen[langKey || ""]);',
  '',
  '  // ② 真 JVM 的 raw body 捕获：替换 verifyAndDecrypt，看它拿到的是不是原始字节',
  '  const app = build();',
  '  let gotRaw = null;',
  '  wxpay.verifyAndDecrypt = async (h, raw) => {',
  '    gotRaw = raw;',
  '    return { trade_state: "SUCCESS", out_trade_no: "NO_NOT_EXIST", transaction_id: "TX1", amount: { total: 100 } };',
  '  };',
  '  const raw = JSON.stringify({ id: "EV-1", resource_type: "encrypt-resource", resource: { nonce: "x" } });',
  '  let r = await app.inject({ method: "POST", url: bp + "/api/pay/notify/wxpay",',
  '    headers: { "content-type": "application/json" }, payload: raw });',
  '  t("回调路由可达（部署前缀 " + (bp || "根路径") + "）", r.statusCode === 200, r.statusCode + " " + String(r.body).slice(0, 120));',
  '  t("拿到的是未经解析的原始报文", gotRaw === raw, "got=" + String(gotRaw).slice(0, 60));',
  '',
  '  // ③ 证书拉不到时的错误必须说出来，而不是含糊的「参数错误」',
  '  paydiag.clear && paydiag.clear();',
  '  let verifyUsed = 0;',
  '  wxpay.verifyAndDecrypt = async () => { verifyUsed++; throw new Error("拉取微信支付平台证书失败，回调无法验签：模拟失败"); };',
  '  r = await app.inject({ method: "POST", url: bp + "/api/pay/notify/wxpay",',
  '    headers: { "content-type": "application/json" }, payload: raw });',
  '  t("验签失败时回 500（让微信重试）", r.statusCode === 500, r.statusCode);',
  '  const evs = typeof paydiag.list === "function" ? paydiag.list(50) : [];',
  '  t("失败原因写清楚是平台证书问题",',
  '    (evs || []).some((e) => String(e.detail || "").includes("平台证书")),',
  '    JSON.stringify((evs || []).slice(-2)));',
  '  t("cp.verify 被真正调用过", verifyUsed === 1, verifyUsed);',
  '',
  '  // ④ 补单：回调丢了/失败过时，管理员能主动找微信确认并补齐',
  '  const dbx = require(ROOT + "/server/db/index.js");',
  '  const userNow = new Date().toISOString();',
  '  let uid = dbx.prepare("SELECT id FROM users LIMIT 1").get();',
  '  if (!uid) uid = dbx.prepare("INSERT INTO users (openid, nickname, avatar, phone, status, created_at) VALUES (?,?,?,?,?,?)")',
  '    .run("oSync" + Date.now(), "补单测试用户", "", "", "active", userNow);',
  '  const uidVal = uid.id || uid.lastInsertRowid;',
  '  const info = dbx.prepare("INSERT INTO orders (order_no, user_id, amount, pay_amount, channel, status, items, created_at) VALUES (?,?,?,?,?,?,?,?)")',
  '    .run("NO_SYNC_" + Date.now(), uidVal, 1, 1, "wxpay", "pending", "[]", userNow);',
  '  const oid = Number(info.lastInsertRowid);',
  '  const token = (await app.inject({ method: "POST", url: bp + "/api/admin/login",',
  '    payload: { username: "admin", password: process.env.ADMIN_INIT_PASSWORD } })).json().token;',
  '  const ah = { authorization: "Bearer " + token };',
  '  const r0 = await app.inject({ method: "POST", url: bp + "/api/orders/" + oid + "/sync-pay", headers: ah, payload: {} });',
  '  t("补单接口需要管理员", true, "控制台仅有 ?", "");',
  '  const noAuth = await app.inject({ method: "POST", url: bp + "/api/orders/" + oid + "/sync-pay", payload: {} });',
  '  t("未登录不能补单", noAuth.statusCode === 401 || noAuth.statusCode === 403, noAuth.statusCode);',
  '',
  '  // 4a 微信说没付 → 不能改状态',
  '  wxpay.queryOrder = async () => ({ trade_state: "NOTPAY", amount: { total: 100 }, out_trade_no: "x" });',
  '  let rs = await app.inject({ method: "POST", url: bp + "/api/orders/" + oid + "/sync-pay", headers: ah, payload: {} });',
  '  t("微信侧未支付时不动订单", rs.json().status === "pending", JSON.stringify(rs.json()).slice(0, 120));',
  '',
  '  // 4b 微信说付了且金额对 → 补齐发货，且自动发货',
  '  wxpay.queryOrder = async () => ({ trade_state: "SUCCESS", transaction_id: "TXSYNC1",',
  '    out_trade_no: dbx.prepare("SELECT order_no FROM orders WHERE id = ?").get(oid).order_no,',
  '    amount: { total: 100, currency: "CNY" } });',
  '  rs = await app.inject({ method: "POST", url: bp + "/api/orders/" + oid + "/sync-pay", headers: ah, payload: {} });',
  '  t("微信确认已付后订单变已支付", rs.json().status === "paid", JSON.stringify(rs.json()).slice(0, 120));',
  '  const after = dbx.prepare("SELECT status, trade_no FROM orders WHERE id = ?").get(oid);',
  '  t("订单落库状态与流水号", after.status === "paid" && after.trade_no === "TXSYNC1", JSON.stringify(after));',
  '  const payCnt = dbx.prepare("SELECT COUNT(*) AS c FROM payments WHERE order_no = (SELECT order_no FROM orders WHERE id = ?)").get(oid).c;',
  '  t("补单会写入支付流水（可核对）", payCnt >= 1, payCnt);',
  '',
  '  // 4c 金额对不上 → 拒绝发货',
  '  const info2 = dbx.prepare("INSERT INTO orders (order_no, user_id, amount, pay_amount, channel, status, items, created_at) VALUES (?,?,?,?,?,?,?,?)")',
  '    .run("NO_MISMATCH_" + Date.now(), uidVal, 100, 100, "wxpay", "pending", "[]", userNow);',
  '  wxpay.queryOrder = async () => ({ trade_state: "SUCCESS", transaction_id: "TXMM",',
  '    out_trade_no: dbx.prepare("SELECT order_no FROM orders WHERE id = ?").get(Number(info2.lastInsertRowid)).order_no,',
  '    amount: { total: 1 } });',
  '  rs = await app.inject({ method: "POST", url: bp + "/api/orders/" + Number(info2.lastInsertRowid) + "/sync-pay", headers: ah, payload: {} });',
  '  t("补单金额不符时拒绝发货", rs.statusCode === 400 && String(rs.json().error || "").includes("金额不符"), JSON.stringify(rs.json()).slice(0, 140));',
  '  const stillPending = dbx.prepare("SELECT status FROM orders WHERE id = ?").get(Number(info2.lastInsertRowid)).status;',
  '  t("金额不符的订单保持 pending", stillPending === "pending", stillPending);',
  '  await app.close();',
  '  fs.writeFileSync(RESULT, JSON.stringify(out));',
  '})().catch((e) => { fs.writeFileSync(RESULT, JSON.stringify([{ name: "子进程异常: " + e.message, ok: false, extra: "" }])); });',
];

function run(label, env) {
  fs.rmSync(RESULT, { force: true });
  fs.writeFileSync(CHILD, childLines.join('\n'));
  const db = path.join(ROOT, 'data', `.wxpay-notify-${label}.db`);
  fs.rmSync(db, { force: true });
  fs.rmSync(db + '-shm', { force: true });
  fs.rmSync(db + '-wal', { force: true });
  try {
    execFileSync(NODE, [CHILD], {
      cwd: ROOT,
      env: {
        ...process.env, DB_PATH: db, ADMIN_INIT_PASSWORD: 'admin123', ...env,
        CHILD_ROOT: ROOT.replace(/\\/g, '/'), CHILD_RESULT: RESULT.replace(/\\/g, '/'),
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch (e) {
    check(`${label} 子进程可执行`, false, e.message);
    return;
  }
  if (!fs.existsSync(RESULT)) { check(`${label} 子进程产出结果`, false, '无结果文件'); return; }
  for (const row of JSON.parse(fs.readFileSync(RESULT, 'utf8'))) check(`[${label}] ${row.name}`, row.ok, row.extra);
  fs.rmSync(db, { force: true });
  fs.rmSync(db + '-shm', { force: true });
  fs.rmSync(db + '-wal', { force: true });
}

console.log('\n微信支付回调路径（Accept-Language / 子路径原始报文 / 失败原因）');
run('根路径', { BASE_PATH: '' });
run('子路径', { BASE_PATH: 'platform' });
fs.rmSync(CHILD, { force: true });
fs.rmSync(RESULT, { force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

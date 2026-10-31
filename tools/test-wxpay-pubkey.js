/* 微信支付「公钥模式」回调验签自测
 *
 * 背景（2026-10-31 线上真实故障）：
 *   用户商户号是新商户，微信已不再提供平台证书下载。下单成功、查单成功，
 *   唯独回调一直失败：
 *     「拉取微信支付平台证书失败 … 无可用的平台证书 …
 *       请在商户平台-API安全申请使用微信支付公钥｜RESOURCE_NOT_EXISTS」
 *   根因是回调验签强依赖 GET /v3/certificates，而该商户号根本没有平台证书。
 *   修复：支持「微信支付公钥」模式 —— 公钥配在本地，回调直接本地验签，不联网。
 *
 * 用法：node tools/test-wxpay-pubkey.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const CHILD = path.join(ROOT, 'data', '.wxpay-pubkey-child.js');
const RESULT = path.join(ROOT, 'data', '.wxpay-pubkey-result.json');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); } else {
    fail++;
    console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + String(extra).slice(0, 400) : ''));
  }
}

/* 子脚本用数组拼装，不用模板字面量 —— 反斜杠 / 反引号 / ${} 会在求值阶段被吃掉 */
const childLines = [
  'const fs = require("fs");',
  'const crypto = require("crypto");',
  'const ROOT = process.env.CHILD_ROOT;',
  'const RESULT = process.env.CHILD_RESULT;',
  'const config = require(ROOT + "/server/lib/config.js");',
  'const wxpay = require(ROOT + "/server/services/wxpay.js");',
  'const auth = require(ROOT + "/server/lib/auth.js");',
  'const { build } = require(ROOT + "/server/index.js");',
  'const out = [];',
  'const t = (name, ok, extra) => out.push({ name, ok: !!ok, extra: extra === undefined ? "" : String(extra).slice(0, 400) });',
  '',
  'const API_KEY = "01234567890123456789012345678901";',
  'function genKey() {',
  '  return crypto.generateKeyPairSync("rsa", { modulusLength: 2048,',
  '    privateKeyEncoding: { type: "pkcs8", format: "pem" },',
  '    publicKeyEncoding: { type: "spki", format: "pem" } });',
  '}',
  'const wxKey = genKey();      // 模拟「微信侧」密钥对，公钥即商户平台下载的微信支付公钥',
  'const otherKey = genKey();   // 另一对，用来验证「公钥填错」的报错',
  '',
  '// 按微信 v3 规则加密 resource（AES-256-GCM，密文末尾 16 字节是 auth tag）',
  'function encryptResource(obj) {',
  '  const nonce = "abcdefghijkl";',
  '  const aad = "transaction";',
  '  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(API_KEY, "utf8"), Buffer.from(nonce, "utf8"));',
  '  c.setAAD(Buffer.from(aad, "utf8"));',
  '  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);',
  '  return { ciphertext: Buffer.concat([ct, c.getAuthTag()]).toString("base64"), nonce, associated_data: aad };',
  '}',
  '',
  '// 按微信 v3 规则签名回调报文',
  'function signNotify(body, serial, key) {',
  '  const ts = String(Math.floor(Date.now() / 1000));',
  '  const nonce = "NONCE123456";',
  '  const sig = crypto.createSign("RSA-SHA256").update(ts + "\\n" + nonce + "\\n" + body + "\\n")',
  '    .sign(key || wxKey.privateKey, "base64");',
  '  return { "wechatpay-timestamp": ts, "wechatpay-nonce": nonce,',
  '    "wechatpay-signature": sig, "wechatpay-serial": serial };',
  '}',
  '',
  'function makeBody() {',
  '  const resource = encryptResource({ out_trade_no: "NO_PUBKEY_1", transaction_id: "TXPUB1",',
  '    trade_state: "SUCCESS", amount: { total: 100, currency: "CNY" } });',
  '  return JSON.stringify({ id: "EV-1", create_time: "2026-10-31T23:00:00+08:00",',
  '    resource_type: "encrypt-resource", event_type: "TRANSACTION.SUCCESS", resource });',
  '}',
  '',
  '// 把 fetch 换成可控的桩，并记录请求过的 URL',
  'function stubFetch(handler) {',
  '  const seen = [];',
  '  global.fetch = async (url, opt) => {',
  '    seen.push(String(url));',
  '    const r = handler ? handler(String(url)) : null;',
  '    const status = (r && r.status) || 200;',
  '    const body = r && r.body !== undefined ? r.body : {};',
  '    return new Response(typeof body === "string" ? body : JSON.stringify(body),',
  '      { status, headers: { "content-type": "application/json" } });',
  '  };',
  '  return seen;',
  '}',
  'const noCert = () => ({ status: 400, body: { code: "RESOURCE_NOT_EXISTS",',
  '  message: "无可用的平台证书，请在商户平台-API安全申请使用微信支付公钥" } });',
  '',
  '(async () => {',
  '  const body = makeBody();',
  '  const serial = "PUB_KEY_ID_0000000000000000000000000001";',
  '',
  '  // ① 公钥模式：本地验签，一次网络请求都不该发',
  '  config.setConfig("wxpay", { enabled: 1, appid: "wxPub", mchid: "1900000000",',
  '    mch_cert_serial: "ABC123", api_v3_key: API_KEY, private_key: wxKey.privateKey,',
  '    pub_key_id: serial, pub_key: wxKey.publicKey, platform_cert: "" });',
  '  t("验签模式识别为 pubkey", wxpay.verifyMode() === "pubkey", wxpay.verifyMode());',
  '  let seen = stubFetch(() => { throw new Error("公钥模式不应发起任何请求"); });',
  '  let err = null;',
  '  let data = null;',
  '  try { data = await wxpay.verifyAndDecrypt(signNotify(body, serial), body); } catch (e) { err = e; }',
  '  t("微信支付公钥模式回调验签通过", !err && data && data.out_trade_no === "NO_PUBKEY_1",',
  '    err ? err.message : JSON.stringify(data));',
  '  t("公钥模式下不再联网拉平台证书", seen.length === 0, seen.join(","));',
  '',
  '  // ② 解密后的金额/状态可正常用于发货',
  '  t("解密得到正确的交易状态与金额", data && data.trade_state === "SUCCESS" && Number(data.amount.total) === 100,',
  '    JSON.stringify(data && data.amount));',
  '',
  '  // ③ 公钥填错：必须说清是公钥不匹配，并回显回调头里的 serial',
  '  config.setConfig("wxpay", { pub_key: otherKey.publicKey });',
  '  seen = stubFetch(() => { throw new Error("不联网"); });',
  '  err = null;',
  '  try { await wxpay.verifyAndDecrypt(signNotify(body, serial), body); } catch (e) { err = e; }',
  '  t("公钥不匹配时验签失败", !!err, "没有抛错");',
  '  t("失败提示点名是微信支付公钥不匹配", !!err && /微信支付回调验签失败/.test(err.message) && /微信支付公钥/.test(err.message),',
  '    err && err.message);',
  '  t("失败提示回显 Wechatpay-Serial 便于核对", !!err && err.message.includes(serial), err && err.message);',
  '',
  '  // ④ 未配公钥的新商户：拉证书 RESOURCE_NOT_EXISTS，必须指引去申请微信支付公钥',
  '  config.setConfig("wxpay", { pub_key: "", pub_key_id: "", platform_cert: "" });',
  '  t("未配公钥时模式为 auto", wxpay.verifyMode() === "auto", wxpay.verifyMode());',
  '  stubFetch(noCert);',
  '  err = null;',
  '  try { await wxpay.verifyAndDecrypt(signNotify(body, serial), body); } catch (e) { err = e; }',
  '  t("拉不到证书时回调失败", !!err, "没有抛错");',
  '  t("错误里明确要求改用微信支付公钥", !!err && /微信支付公钥/.test(err.message) && /申请/.test(err.message),',
  '    err && err.message);',
  '  t("错误里保留微信原始错误码", !!err && /RESOURCE_NOT_EXISTS/.test(err.message), err && err.message);',
  '',
  '  // ⑤ 手动平台证书模式仍然可用（老商户）',
  '  config.setConfig("wxpay", { platform_cert: wxKey.publicKey });',
  '  t("配了手动平台证书时模式为 cert", wxpay.verifyMode() === "cert", wxpay.verifyMode());',
  '  seen = stubFetch(() => { throw new Error("手动证书不应联网"); });',
  '  err = null;',
  '  try { data = await wxpay.verifyAndDecrypt(signNotify(body, "ANY_SERIAL"), body); } catch (e) { err = e; }',
  '  t("手动平台证书模式验签通过", !err && data && data.out_trade_no === "NO_PUBKEY_1", err && err.message);',
  '',
  '  // ⑥ 配置自检：公钥模式下用「查一个不存在的订单」验证商户签名，不再依赖证书接口',
  '  config.setConfig("wxpay", { platform_cert: "", pub_key: wxKey.publicKey, pub_key_id: serial });',
  '  seen = stubFetch(() => ({ status: 404, body: { code: "ORDER_NOT_EXIST", message: "订单不存在" } }));',
  '  let r = null;',
  '  err = null;',
  '  try { r = await wxpay.testConfig(); } catch (e) { err = e; }',
  '  t("公钥模式自检通过", !err && r && r.ok && r.mode === "pubkey", err ? err.message : JSON.stringify(r));',
  '  t("自检只查订单、不去拉证书", seen.length === 1 && !seen.some((u) => /\\/v3\\/certificates/.test(u)), seen.join(","));',
  '  t("自检结果说明是公钥模式", !!r && /微信支付公钥/.test(r.message), r && r.message);',
  '',
  '  // ⑦ 自检：签名不被接受时要报出来（商户号/序列号/私钥三者之一错）',
  '  stubFetch(() => ({ status: 401, body: { code: "SIGN_ERROR", message: "签名验证失败" } }));',
  '  err = null;',
  '  try { await wxpay.testConfig(); } catch (e) { err = e; }',
  '  t("商户签名不被接受时自检失败", !!err, "竟然通过了");',
  '  t("签名失败提示指向商户配置", !!err && /商户请求签名未被微信接受/.test(err.message), err && err.message);',
  '',
  '  // ⑧ 自检：既没公钥又拉不到证书 —— 直接给可执行指引',
  '  //    （签名探测走查单接口、验签走证书接口，两个接口分开 stub 才符合真实场景）',
  '  config.setConfig("wxpay", { pub_key: "", pub_key_id: "" });',
  '  stubFetch((u) => (/\\/v3\\/certificates/.test(u)',
  '    ? noCert() : { status: 404, body: { code: "ORDER_NOT_EXIST", message: "订单不存在" } }));',
  '  err = null;',
  '  try { await wxpay.testConfig(); } catch (e) { err = e; }',
  '  t("无公钥且拉不到证书时自检失败", !!err, "竟然通过了");',
  '  t("自检失败给出申请微信支付公钥的指引", !!err && /微信支付公钥/.test(err.message), err && err.message);',
  '',
  '  // ⑨ API v3 密钥长度必须校验（内容无法离线验证，长度错了要先拦住）',
  '  config.setConfig("wxpay", { pub_key: wxKey.publicKey, api_v3_key: API_KEY.slice(0, 31) });',
  '  err = null;',
  '  try { await wxpay.testConfig(); } catch (e) { err = e; }',
  '  t("API v3 密钥长度不对时自检报错", !!err && /32 位/.test(err.message), err && err.message);',
  '  config.setConfig("wxpay", { api_v3_key: API_KEY });',
  '',
  '  // ⑩ 用户端自动补单：回调失败后刷新「我的订单」应自己补齐',
  '  const dbx = require(ROOT + "/server/db/index.js");',
  '  const app = build();',
  '  const bp = config.basePath();',
  '  const old = new Date(Date.now() - 5 * 60 * 1000).toISOString();',
  '  let u = dbx.prepare("SELECT id FROM users LIMIT 1").get();',
  '  if (!u) u = dbx.prepare("INSERT INTO users (openid, nickname, avatar, phone, status, created_at)"',
  '    + " VALUES (?,?,?,?,?,?)").run("oPub" + Date.now(), "自动补单用户", "", "", "active", old);',
  '  const uid = u.id || u.lastInsertRowid;',
  '  const mk = (no) => dbx.prepare("INSERT INTO orders (order_no, user_id, amount, pay_amount,"',
  '    + " channel, status, items, created_at) VALUES (?,?,?,?,?,?,?,?)").run(no, uid, 1, 1, "wxpay", "pending", "[]", old);',
  '  const paidInfo = mk("NO_AUTO_PAID_" + Date.now());',
  '  const oidPaid = Number(paidInfo.lastInsertRowid);',
  '  const noPaid = dbx.prepare("SELECT order_no FROM orders WHERE id = ?").get(oidPaid).order_no;',
  '  const notPayInfo = mk("NO_AUTO_NOTPAY_" + Date.now());',
  '  const oidNotPay = Number(notPayInfo.lastInsertRowid);',
  '  const noNotPay = dbx.prepare("SELECT order_no FROM orders WHERE id = ?").get(oidNotPay).order_no;',
  '',
  '  let queryCalls = 0;',
  '  wxpay.queryOrder = async (no) => {',
  '    queryCalls++;',
  '    if (no === noPaid) return { trade_state: "SUCCESS", transaction_id: "TXAUTO1",',
  '      out_trade_no: no, amount: { total: 100, currency: "CNY" } };',
  '    return { trade_state: "NOTPAY", out_trade_no: no, amount: { total: 100 } };',
  '  };',
  '  const userToken = auth.signUser({ id: uid, openid: "oPub" });',
  '  const uh = { authorization: "Bearer " + userToken };',
  '  let res = await app.inject({ method: "GET", url: bp + "/api/portal/orders", headers: uh });',
  '  t("我的订单接口正常", res.statusCode === 200, res.statusCode + " " + String(res.body).slice(0, 120));',
  '  const st1 = dbx.prepare("SELECT status, trade_no FROM orders WHERE id = ?").get(oidPaid);',
  '  t("已付款但回调失败的订单被自动补齐", st1.status === "paid" && st1.trade_no === "TXAUTO1", JSON.stringify(st1));',
  '  const st2 = dbx.prepare("SELECT status FROM orders WHERE id = ?").get(oidNotPay);',
  '  t("微信侧未支付的订单保持 pending", st2.status === "pending", st2.status);',
  '  const calls1 = queryCalls;',
  '  res = await app.inject({ method: "GET", url: bp + "/api/portal/orders", headers: uh });',
  '  t("60 秒内不重复查单（节流生效）", queryCalls === calls1, calls1 + " -> " + queryCalls);',
  '  t("订单列表仍然可用", res.statusCode === 200, res.statusCode);',
  '  await app.close();',
  '  fs.writeFileSync(RESULT, JSON.stringify(out));',
  '})().catch((e) => { fs.writeFileSync(RESULT, JSON.stringify([{ name: "子进程异常: " + e.message, ok: false, extra: String(e.stack || "").slice(0, 400) }])); });',
];

function run(label, env) {
  fs.rmSync(RESULT, { force: true });
  fs.writeFileSync(CHILD, childLines.join('\n'));
  const db = path.join(ROOT, 'data', `.wxpay-pubkey-${label}.db`);
  for (const f of [db, db + '-shm', db + '-wal']) fs.rmSync(f, { force: true });
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
  for (const f of [db, db + '-shm', db + '-wal']) fs.rmSync(f, { force: true });
}

console.log('\n微信支付「公钥模式」回调验签（新商户无平台证书 / 自动补单）');
run('根路径', { BASE_PATH: '' });
fs.rmSync(CHILD, { force: true });
fs.rmSync(RESULT, { force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

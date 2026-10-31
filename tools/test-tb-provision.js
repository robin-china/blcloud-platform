/* blcloud 物联（ThingsBoard）账户开通链路自测
 *
 * 背景（2026-11-01 线上故障）：用户扫码登录后 blcloud 账户一直「未开通 / 待激活」。
 * 根因在开通实现本身：
 *   POST /api/user 只是「建档」——不带密码，TB 也没有给管理员设密码的接口，
 *   密码只能靠激活流程（激活链接里的 activateToken + POST /api/noauth/activate）写入。
 *   老实现建完档就返回 pending「等待激活」，而账户永远不会有密码 → 永远登不上。
 * 附带问题：开通失败被 .catch(() => null) 吞掉，管理员只看到「待激活」，没有任何线索。
 *
 * 用法：node tools/test-tb-provision.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
const CHILD = path.join(ROOT, 'data', '.test-tb-child.js');
const RESULT = path.join(ROOT, 'data', '.test-tb-result.json');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); } else {
    fail++;
    console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + String(extra).slice(0, 400) : ''));
  }
}

/* 子脚本用数组拼装：反斜杠 / 反引号 / ${} 会在模板求值阶段被吃掉 */
const childLines = [
  'const http = require("http");',
  'const fs = require("fs");',
  'const ROOT = process.env.CHILD_ROOT;',
  'const RESULT = process.env.CHILD_RESULT;',
  'const config = require(ROOT + "/server/lib/config.js");',
  'const tb = require(ROOT + "/server/services/tb.js");',
  'const tbdiag = require(ROOT + "/server/lib/tbdiag.js");',
  'const out = [];',
  'const t = (name, ok, extra) => out.push({ name, ok: !!ok, extra: extra === undefined ? "" : String(extra).slice(0, 400) });',
  '',
  'const ADMIN = "sysadmin@thingsboard.org";',
  'const ADMIN_PWD = "sysadmin";',
  'const SUFFIX = "@blcloud.cn";',
  '',
  '// ---- 假的 TB 服务 ----',
  'const store = new Map();   // email -> { id, password, activated }',
  'let activateCalls = 0;',
  'let createQuery = "";',
  'let linkAccept = "";',
  'let activateMode = "ok";   // ok | policy | notoken',
  'let linkStatus = 200;',
  'let customerId = "C-1";',
  '',
  'function b64url(o) {',
  '  return Buffer.from(JSON.stringify(o)).toString("base64")',
  '    .split("+").join("-").split("/").join("_").split("=").join("");',
  '}',
  'function jwt(payload) {',
  '  return b64url({ alg: "HS256", typ: "JWT" }) + "." + b64url(payload) + ".sig";',
  '}',
  '',
  'const server = http.createServer((req, res) => {',
  '  let raw = "";',
  '  req.on("data", (c) => { raw += c; });',
  '  req.on("end", () => {',
  '    const url = req.url;',
  '    const pathname = url.split("?")[0];',
  '    let body = {};',
  '    try { body = raw ? JSON.parse(raw) : {}; } catch (e) { body = {}; }',
  '    const send = (code, obj) => {',
  '      res.writeHead(code, { "Content-Type": "application/json" });',
  '      res.end(JSON.stringify(obj));',
  '    };',
  '    const sendText = (code, txt) => {',
  '      res.writeHead(code, { "Content-Type": "text/plain" });',
  '      res.end(txt);',
  '    };',
  '',
  '    if (pathname === "/api/auth/login") {',
  '      if (body.username === ADMIN && body.password === ADMIN_PWD) {',
  '        return send(200, { token: jwt({ userId: "ADMIN-ID", authority: "TENANT_ADMIN", exp: Math.floor(Date.now()/1000)+3600 }), refreshToken: "r" });',
  '      }',
  '      const u = store.get(body.username);',
  '      if (u && u.activated && body.password === u.password) {',
  '        return send(200, { token: jwt({ userId: u.id, authority: "CUSTOMER_USER", exp: Math.floor(Date.now()/1000)+3600 }), refreshToken: "r" });',
  '      }',
  '      return send(401, { status: 401, message: "Authentication failed" });',
  '    }',
  '    if (pathname === "/api/auth/user") {',
  '      return send(200, { email: ADMIN, authority: "TENANT_ADMIN", tenantId: { entityType: "TENANT", id: "T-1" } });',
  '    }',
  '    if (pathname === "/api/customers") {',
  '      return send(200, { data: customerId ? [{ id: { entityType: "CUSTOMER", id: customerId }, title: "default" }] : [] });',
  '    }',
  '    if (pathname === "/api/customer" && req.method === "POST") {',
  '      customerId = "C-1";',
  '      return send(200, { id: { entityType: "CUSTOMER", id: customerId }, title: body.title });',
  '    }',
  '    if (pathname === "/api/user" && req.method === "POST") {',
  '      createQuery = url.indexOf("?") >= 0 ? url.slice(url.indexOf("?") + 1) : "";',
  '      if (store.has(body.email)) {',
  '        return send(400, { status: 400, message: "User with email " + body.email + " already exists" });',
  '      }',
  '      const id = "U-" + (store.size + 1);',
  '      store.set(body.email, { id: id, password: "", activated: false });',
  '      return send(200, { id: { entityType: "USER", id: id }, email: body.email });',
  '    }',
  '    if (pathname.indexOf("/api/user/") === 0 && pathname.indexOf("/activationLink") > 0) {',
  '      linkAccept = req.headers.accept || "";',
  '      if (linkStatus !== 200) return send(linkStatus, { status: linkStatus, message: "User credentials already activated" });',
  '      const id = pathname.split("/")[3];',
  '      if (activateMode === "notoken") return sendText(200, "http://tb/login/createPassword");',
  '      return sendText(200, "http://tb/api/noauth/activate?activateToken=tok-" + id);',
  '    }',
  '    if (pathname === "/api/noauth/activate") {',
  '      activateCalls += 1;',
  '      if (activateMode === "policy" && activateCalls === 1) {',
  '        return send(400, { status: 400, message: "Password does not meet the password policy" });',
  '      }',
  '      const id = String(body.activateToken || "").replace("tok-", "");',
  '      for (const u of store.values()) if (u.id === id) { u.password = body.password; u.activated = true; }',
  '      return send(200, { token: jwt({ userId: id, authority: "CUSTOMER_USER", exp: 1 }), refreshToken: "r" });',
  '    }',
  '    if (pathname === "/api/customer/C-1/users" || pathname === "/api/tenant/users") {',
  '      const data = [];',
  '      for (const [email, u] of store.entries()) data.push({ id: { entityType: "USER", id: u.id }, email: email });',
  '      return send(200, { data: data });',
  '    }',
  '    return send(404, { status: 404, message: "no such api " + pathname });',
  '  });',
  '});',
  '',
  'function setCfg(over) {',
  '  config.setConfig("tb", Object.assign({',
  '    enabled: 1, base_url: "", username: ADMIN, password: ADMIN_PWD,',
  '    email_suffix: SUFFIX, default_customer: "default", device_profile: "",',
  '  }, over || {}));',
  '}',
  '',
  '(async () => {',
  '  await new Promise((r) => server.listen(0, "127.0.0.1", r));',
  '  const base = "http://127.0.0.1:" + server.address().port;',
  '  setCfg({ base_url: base });',
  '',
  '  // ① 全新用户：建档 → 激活 → 登录验证',
  '  let r = await tb.provisionUser("oA AAA1", "张三");',
  '  t("新用户开通成功", r.status === "active", r.status + " / " + r.message);',
  '  t("账户名按 OpenID+后缀生成", r.username === "oA AAA1@blcloud.cn", r.username);',
  '  t("密码被真正写进 TB（激活生效）", (store.get(r.username) || {}).password === "oA AAA1", JSON.stringify(store.get(r.username)));',
  '  t("建档时关闭了激活邮件（避免邮件服务没配好 500）", /sendActivationMail=false/.test(createQuery), createQuery);',
  '  t("取激活链接时 Accept 用 text/plain（否则 Spring 回 406）", linkAccept === "text/plain", linkAccept);',
  '  t("用户 ID 从登录 JWT 里取到（老实现永远为空）", r.userId === "U-1", r.userId);',
  '  t("steps 全部通过", r.steps.length >= 5 && r.steps.every((s) => s.ok), JSON.stringify(r.steps));',
  '',
  '  // ② 已开通用户再点一次：直接复用，不重复建档',
  '  const beforeSize = store.size;',
  '  r = await tb.provisionUser("oA AAA1", "张三");',
  '  t("重复开通直接复用已有账户", r.status === "active" && r.message.indexOf("已存在") >= 0, r.message);',
  '  t("重复开通不会重复建档", store.size === beforeSize, store.size + " vs " + beforeSize);',
  '',
  '  // ③ 旧版本遗留的「半死账户」：已建档、从未激活 → 必须能找回并激活（本次线上最关键的修复点）',
  '  store.set("oB BBB2@blcloud.cn", { id: "U-9", password: "", activated: false });',
  '  r = await tb.provisionUser("oB BBB2", "李四");',
  '  t("已建档但未激活的账户能被找回并激活", r.status === "active", r.status + " / " + r.message);',
  '  t("找回时定位到正确 ID", r.userId === "U-9", r.userId);',
  '  t("找回的账户密码被真正写入", store.get("oB BBB2@blcloud.cn").password === "oB BBB2", store.get("oB BBB2@blcloud.cn").password);',
  '  const createStep = r.steps.find((s) => s.name === "创建用户");',
  '  t("「已存在」被记为可恢复步骤而非直接失败", createStep && createStep.ok === false && /已存在/.test(createStep.detail), JSON.stringify(createStep));',
  '  const findStep = r.steps.find((s) => s.name === "查找已有账户");',
  '  t("找回步骤被记录", findStep && findStep.ok === true, JSON.stringify(findStep));',
  '',
  '  // ④ 开关没打开：明确说明不会创建，而不是含糊的 pending',
  '  setCfg({ base_url: base, enabled: 0 });',
  '  r = await tb.provisionUser("oC CCC3", "王五");',
  '  t("未启用时状态为 pending", r.status === "pending", r.status);',
  '  t("未启用时说清原因", /未启用/.test(r.message), r.message);',
  '  t("未启用时不向 TB 建档", !store.has("oC CCC3@blcloud.cn"), "不该创建");',
  '',
  '  // ⑤ 平台地址没填',
  '  setCfg({ enabled: 1, base_url: "" });',
  '  r = await tb.provisionUser("oD DDD4", "赵六");',
  '  t("地址为空时报 error 而非静默 pending", r.status === "error", r.status);',
  '  t("地址为空时提示未配置", /平台地址/.test(r.message), r.message);',
  '',
  '  // ⑥ 管理员账号错：定位到「管理员登录」这一步',
  '  setCfg({ enabled: 1, base_url: base, password: "wrong-pwd" });',
  '  tb.resetAdminToken();',
  '  r = await tb.provisionUser("oE EEE5", "孙七");',
  '  t("管理员密码错时报 error", r.status === "error", r.status);',
  '  t("错误定位到管理员登录", /管理员登录失败/.test(r.message), r.message);',
  '  const adminStep = r.steps.find((s) => s.name === "管理员登录");',
  '  t("管理员登录步骤被标红", adminStep && adminStep.ok === false, JSON.stringify(adminStep));',
  '',
  '  // ⑦ 密码策略不通过：自动换一个更强的密码重试，并把真实生效的密码回传',
  '  setCfg({ enabled: 1, base_url: base, password: ADMIN_PWD });',
  '  activateMode = "policy";',
  '  activateCalls = 0;',
  '  r = await tb.provisionUser("oF FFF6", "周八");',
  '  t("密码策略不通过时会换强密码重试", r.status === "active", r.status + " / " + r.message);',
  '  t("回传的是真正生效的密码", r.password === "oF FFF6Tb#1", r.password);',
  '  t("该密码确实能登录", (store.get(r.username) || {}).password === r.password, JSON.stringify(store.get(r.username)));',
  '  activateMode = "ok";',
  '',
  '  // ⑧ 反向验证：激活链接拿不到 token 时必须报 error，绝不能假装 pending（老实现就是这样静默失败的）',
  '  activateMode = "notoken";',
  '  r = await tb.provisionUser("oG GGG7", "吴九");',
  '  t("拿不到 activateToken 时报 error", r.status === "error", r.status);',
  '  t("报错点名激活环节", /激活/.test(r.message), r.message);',
  '  t("绝不再返回「等待激活」这种假成功", r.message.indexOf("等待激活") < 0, r.message);',
  '  const actStep = r.steps.find((s) => s.name === "激活账户");',
  '  t("激活步骤被标红", actStep && actStep.ok === false, JSON.stringify(actStep));',
  '  activateMode = "ok";',
  '',
  '  // ⑨ 取激活链接被 TB 拒绝（例如账户已激活过）',
  '  linkStatus = 400;',
  '  r = await tb.provisionUser("oH HHH8", "郑十");',
  '  t("激活链接被拒时报 error 并带上 TB 原因", r.status === "error" && /激活/.test(r.message), r.message);',
  '  linkStatus = 200;',
  '',
  '  // ⑩ 诊断留痕：管理员得能看到最近发生了什么',
  '  const events = tbdiag.list(50);',
  '  t("开通步骤写入诊断日志", events.length >= 5, events.length);',
  '  t("诊断里能找到失败记录", events.some((e) => e.level === "error"), "无 error 记录");',
  '  t("诊断里能找到成功记录", events.some((e) => e.level === "info"), "无 info 记录");',
  '',
  '  // ⑪ JWT 解析：用户 ID 只能从这里拿',
  '  const payload = tb.decodeJwt(jwt({ userId: "U-77", exp: 1 }));',
  '  t("能解出 base64url JWT 里的 userId", payload.userId === "U-77", JSON.stringify(payload));',
  '',
  '  server.close();',
  '  fs.writeFileSync(RESULT, JSON.stringify(out));',
  '})().catch((e) => {',
  '  fs.writeFileSync(RESULT, JSON.stringify([{ name: "子进程异常", ok: false, extra: e.stack || e.message }]));',
  '  process.exit(1);',
  '});',
];

console.log('blcloud 物联账户开通链路自测\n');

fs.writeFileSync(CHILD, childLines.join('\n'));
try {
  execFileSync(NODE, [CHILD], {
    env: { ...process.env, CHILD_ROOT: ROOT, CHILD_RESULT: RESULT, DB_PATH: path.join(ROOT, 'data', '.test-tb.db'), ADMIN_INIT_PASSWORD: 'admin123' },
    stdio: 'pipe',
  });
} catch (e) {
  check('子进程可执行', false, String(e.stdout || '') + String(e.stderr || '').slice(0, 500));
}
if (!fs.existsSync(RESULT)) {
  check('子进程产出结果', false, '无结果文件');
} else {
  for (const row of JSON.parse(fs.readFileSync(RESULT, 'utf8'))) check(row.name, row.ok, row.extra);
}
for (const f of [CHILD, RESULT, path.join(ROOT, 'data', '.test-tb.db'),
  path.join(ROOT, 'data', '.test-tb.db-shm'), path.join(ROOT, 'data', '.test-tb.db-wal')]) {
  fs.rmSync(f, { force: true });
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);

/* 短信发送通道集成自测
 * 运行：node tools/test-sms.js
 *
 * 背景：此前后台能存短信配置，但两个发码端点从不读配置、也没调服务商，一律回
 * {ok:true}，用户「发送成功」却收不到。本测试用拦截 fetch 的方式验证：
 * 阿里云 V1 签名 / 腾讯云 TC3 签名、服务商错误透传、配置缺失明确报错、
 * 频控、生产环境不外泄验证码、发送失败不入库、后台自检与测试发送端点。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TMP = path.join(__dirname, '..', 'data', 'test-sms-tmp');
// 本机安全策略偶尔会拦下递归删除；清理失败只留个临时目录，不影响测试结论
function cleanup() { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } }
cleanup();
fs.mkdirSync(TMP, { recursive: true });
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.NODE_ENV = 'test';
process.env.BASE_PATH = 'platform';

/* 拦截 HTTP：记录每次请求，按 fetchImpl 返回模拟的服务商响应 */
const calls = [];
let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
global.fetch = async (url, opts) => {
  calls.push({ url: String(url), opts });
  return fetchImpl(url, opts);
};
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const { build } = require('../server');
const db = require('../server/db');
const { setConfig, setSetting } = require('../server/lib/config');
const sms = require('../server/services/sms');
const { signUser } = require('../server/lib/auth');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else {
    fail += 1;
    console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 400) : ''));
  }
}
const json = (r) => { try { return JSON.parse(r.body); } catch { return { raw: String(r.body).slice(0, 200) }; } };
const B = '/platform';
const phone = (n) => `1380013${String(n).padStart(4, '0')}`;
const clearLogs = () => db.prepare('DELETE FROM sms_send_logs').run();
const clearCodes = () => db.prepare('DELETE FROM sms_codes').run();

function hmacSha1(key, msg) {
  return crypto.createHmac('sha1', key).update(msg, 'utf8').digest('base64');
}
function pct(s) {
  return encodeURIComponent(String(s)).replace(/\+/g, '%20').replace(/\*/g, '%2A')
    .replace(/%7E/g, '~').replace(/!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29');
}
function sha256hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function hmac(key, msg) { return crypto.createHmac('sha256', key).update(msg, 'utf8').digest(); }

const ALI_CFG = {
  enabled: 1, vendor: 'aliyun', access_key: 'AK_TEST', secret: 'SK_TEST',
  sign_name: '博联云', template_code: 'SMS_001', sdk_app_id: '',
};
const TC_CFG = {
  enabled: 1, vendor: 'tencent', access_key: 'AKID_TEST', secret: 'TC_SECRET',
  sign_name: '博联云', template_code: '1110', sdk_app_id: '1400006666',
};
const SIM_CFG = {
  enabled: 1, vendor: 'simulate', access_key: '', secret: '', sign_name: '',
  template_code: '', sdk_app_id: '',
};

(async () => {
  const app = build();
  await app.ready();
  const login = json(await app.inject({
    method: 'POST', url: `${B}/api/admin/login`, payload: { username: 'admin', password: 'admin123' },
  }));
  const AH = { authorization: 'Bearer ' + login.token, 'content-type': 'application/json' };
  const t = new Date().toISOString();

  db.prepare(`INSERT INTO users (openid, nickname, points, created_at) VALUES (?,?,?,?)`)
    .run('sms-test-openid', '短信测试用户', 0, t);
  const user = db.prepare("SELECT * FROM users WHERE openid = 'sms-test-openid'").get();
  const UH = { authorization: 'Bearer ' + signUser(user), 'content-type': 'application/json' };
  db.prepare(`INSERT INTO open_apps (app_key, app_secret, name, status, public_auth, offline_days, created_at)
    VALUES (?,?,?,?,1,7,?)`).run('ak_sms_test', 'secret_sms', '短信测试应用', 'active', t);
  const PUB = { 'x-app-key': 'ak_sms_test', 'x-nonce': 'sms-nonce-1', 'content-type': 'application/json' };

  /* ------------------------------------------------------------ [1] 默认状态与自检 */
  console.log('\n[1] 默认开发模式与自检');
  ok('默认启用且为开发模式', sms.testConfig().enabled === true && sms.testConfig().vendor === 'simulate');
  ok('本地自检可发送', sms.testConfig().ok === true, sms.testConfig());
  ok('本地允许回显验证码', sms.canRevealCode() === true);

  setConfig('sms', SIM_CFG);
  clearLogs(); clearCodes();
  let r = await app.inject({ method: 'POST', url: `${B}/api/portal/phone/code`, headers: UH, payload: { phone: phone(1) } });
  ok('网页端发码 200 且回开发验证码', r.statusCode === 200 && /^\d{6}$/.test(String(json(r).devCode || '')), json(r));
  ok('模拟发送写入发送台账', db.prepare('SELECT COUNT(*) AS c FROM sms_send_logs').get().c === 1);
  ok('验证码已入库', db.prepare('SELECT COUNT(*) AS c FROM sms_codes').get().c === 1);

  await setSetting('dev_simulate', '0');
  r = await app.inject({ method: 'POST', url: `${B}/api/portal/phone/code`, headers: UH, payload: { phone: phone(2) } });
  ok('显式关闭演示模式后不回明文验证码', r.statusCode === 200 && !('devCode' in json(r)), json(r));
  await setSetting('dev_simulate', '1');

  /* ------------------------------------------------------------ [2] 阿里云 V1 签名 */
  console.log('\n[2] 阿里云 Dysmsapi V1（HMAC-SHA1）');
  setConfig('sms', ALI_CFG);
  calls.length = 0;
  fetchImpl = async () => reply({ Code: 'OK', Message: 'OK', BizId: 'BIZ-ALI-1', RequestId: 'REQ-ALI-1' });
  clearLogs();
  let out = await sms.sendVerifyCode({ phone: phone(3), code: '654321', scene: 'test', ip: '10.0.0.1' });
  ok('阿里云发送成功且回执号透传', out.ok && out.mode === 'aliyun' && out.bizId === 'BIZ-ALI-1', out);
  const aliCall = calls[0];
  ok('请求域名正确', /^https:\/\/dysmsapi\.aliyuncs\.com\/\?/.test(aliCall.url), aliCall.url);
  const aliUrl = new URL(aliCall.url);
  const aliParams = Object.fromEntries(aliUrl.searchParams.entries());
  ok('公共参数齐全', aliParams.Action === 'SendSms' && aliParams.Version === '2017-05-25'
    && aliParams.Format === 'JSON' && aliParams.SignatureMethod === 'HMAC-SHA1'
    && aliParams.SignatureVersion === '1.0' && aliParams.AccessKeyId === 'AK_TEST', aliParams);
  ok('业务参数含签名/模板/单变量 code', aliParams.SignName === '博联云'
    && aliParams.TemplateCode === 'SMS_001' && aliParams.TemplateParam === '{"code":"654321"}'
    && aliParams.PhoneNumbers === phone(3), aliParams);
  const sigFromUrl = aliParams.Signature;
  delete aliParams.Signature;
  const canonical = Object.keys(aliParams).sort().map((k) => `${pct(k)}=${pct(aliParams[k])}`).join('&');
  const expectSig = hmacSha1('SK_TEST&', `GET&%2F&${pct(canonical)}`);
  ok('签名与独立重算一致（防排序/编码错）', sigFromUrl === expectSig, { got: sigFromUrl, expect: expectSig });
  ok('请求头显式写死（Node fetch 不补默认头）', aliCall.opts.headers['Accept-Language'] === 'zh-CN'
    && aliCall.opts.headers.Host === 'dysmsapi.aliyuncs.com', aliCall.opts.headers);
  ok('percentEncode 空格/星号/波浪号/中文正确', sms.pct('a b') === 'a%20b' && sms.pct('*') === '%2A'
    && sms.pct('~') === '~' && sms.pct('中') === '%E4%B8%AD');
  const aliVector = sms.aliSignParams({ Action: 'SendSms', SignName: '博联云', Z: '1', A: '2' }, 'SK_TEST');
  ok('签名向量可复现且键按字典序', aliVector.canonical === 'A=2&Action=SendSms&SignName=%E5%8D%9A%E8%81%94%E4%BA%91&Z=1'
    && aliVector.stringToSign.startsWith('GET&%2F&') && aliVector.signature === hmacSha1('SK_TEST&', aliVector.stringToSign));

  /* ------------------------------------------------------------ [3] 腾讯云 TC3 签名 */
  console.log('\n[3] 腾讯云 SMS TC3-HMAC-SHA256');
  setConfig('sms', TC_CFG);
  calls.length = 0;
  fetchImpl = async () => reply({ Response: { SendStatusSet: [{ Code: 'Ok', Message: 'send success', SerialNo: 'SN-1' }], RequestId: 'REQ-TC-1' } });
  clearLogs();
  out = await sms.sendVerifyCode({ phone: phone(4), code: '111222', scene: 'test', ip: '10.0.0.2' });
  ok('腾讯云发送成功', out.ok && out.mode === 'tencent' && out.bizId === 'SN-1', out);
  const tcCall = calls[0];
  ok('请求 POST 到 sms.tencentcloudapi.com', tcCall.url === 'https://sms.tencentcloudapi.com/' && tcCall.opts.method === 'POST');
  const tcBody = JSON.parse(tcCall.opts.body);
  ok('参数含 +86 号码 / SdkAppId / 模板 / 单变量', tcBody.PhoneNumberSet[0] === '+86' + phone(4)
    && tcBody.SmsSdkAppId === '1400006666' && tcBody.TemplateId === '1110'
    && tcBody.TemplateParamSet.length === 1 && tcBody.TemplateParamSet[0] === '111222', tcBody);
  const H = tcCall.opts.headers;
  ok('TC3 公共头齐全', H['X-TC-Action'] === 'SendSms' && H['X-TC-Version'] === '2021-01-11'
    && H['X-TC-Region'] === 'ap-guangzhou' && /^\d+$/.test(H['X-TC-Timestamp'])
    && H['Content-Type'] === 'application/json; charset=utf-8');
  ok('Authorization 格式正确', /^TC3-HMAC-SHA256 Credential=AKID_TEST\/\d{4}-\d{2}-\d{2}\/sms\/tc3_request, SignedHeaders=content-type;host, Signature=[a-f0-9]{64}$/.test(H.Authorization), H.Authorization);
  // 独立重算 TC3 签名（不复用被测实现）
  const ts = Number(H['X-TC-Timestamp']);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const scope = `${date}/sms/tc3_request`;
  const canonHeaders = 'content-type:application/json; charset=utf-8\nhost:sms.tencentcloudapi.com\n';
  const canonReq = ['POST', '/', '', canonHeaders, 'content-type;host', sha256hex(tcCall.opts.body)].join('\n');
  const strToSign = ['TC3-HMAC-SHA256', String(ts), scope, sha256hex(canonReq)].join('\n');
  const kDate = hmac('TC3TC_SECRET', date);
  const kService = hmac(kDate, 'sms');
  const kSigning = hmac(kService, 'tc3_request');
  const expectTcSig = crypto.createHmac('sha256', kSigning).update(strToSign, 'utf8').digest('hex');
  ok('TC3 签名与独立重算一致', H.Authorization.endsWith('Signature=' + expectTcSig), {
    got: H.Authorization.slice(-64), expect: expectTcSig,
  });

  /* ------------------------------------------------------------ [4] 错误透传 */
  console.log('\n[4] 服务商错误与网络异常');
  setConfig('sms', ALI_CFG);
  fetchImpl = async () => reply({ Code: 'isv.BUSINESS_LIMIT_CONTROL', Message: '触发流控', RequestId: 'R1' });
  clearLogs();
  let err = null;
  try { await sms.sendVerifyCode({ phone: phone(5), code: '123456' }); } catch (e) { err = e; }
  ok('阿里云错误码透传为 SMS_VENDOR_ERROR', err && err.code === 'SMS_VENDOR_ERROR'
    && err.extra.vendorCode === 'isv.BUSINESS_LIMIT_CONTROL' && err.message === '触发流控', err && err.message);
  ok('失败写台账且带原始错误码', db.prepare('SELECT COUNT(*) AS c FROM sms_send_logs WHERE ok=0').get().c === 1
    && db.prepare("SELECT vendor_code FROM sms_send_logs ORDER BY id DESC LIMIT 1").get().vendor_code.includes('BUSINESS_LIMIT_CONTROL'));

  setConfig('sms', TC_CFG);
  fetchImpl = async () => reply({ Response: { Error: { Code: 'AuthFailure.SignatureExpire', Message: '签名过期' }, RequestId: 'R2' } });
  err = null;
  try { await sms.sendVerifyCode({ phone: phone(6), code: '123456' }); } catch (e) { err = e; }
  ok('腾讯云 Response.Error 透传', err && err.code === 'SMS_VENDOR_ERROR'
    && err.extra.vendorCode === 'AuthFailure.SignatureExpire', err && err.message);
  fetchImpl = async () => reply({ Response: { SendStatusSet: [{ Code: 'FailedOperation.TemplateParamSetNotMatchApprovedTemplate', Message: '模板变量不匹配' }] } });
  err = null;
  try { await sms.sendVerifyCode({ phone: phone(7), code: '123456' }); } catch (e) { err = e; }
  ok('单条 SendStatus 非 Ok 也判失败', err && err.extra.vendorCode === 'FailedOperation.TemplateParamSetNotMatchApprovedTemplate', err && err.message);
  fetchImpl = async () => { throw new Error('ECONNRESET'); };
  err = null;
  try { await sms.sendVerifyCode({ phone: phone(8), code: '123456' }); } catch (e) { err = e; }
  ok('网络异常归为 SMS_NETWORK_ERROR', err && err.code === 'SMS_NETWORK_ERROR', err && err.message);

  // 用户实测报的签名错误：官方要求 SignName 填签名内容、不带空格、2~12 字
  setConfig('sms', { ...TC_CFG, sign_name: '  博联云  ' });
  calls.length = 0;
  fetchImpl = async () => reply({ Response: { SendStatusSet: [{ Code: 'FailedOperation.SignatureIncorrectOrUnapproved', Message: 'signature format is incorrect or signature is not approved' }] } });
  clearLogs();
  err = null;
  try { await sms.sendVerifyCode({ phone: phone(13), code: '123456' }); } catch (e) { err = e; }
  const sentSign = JSON.parse(calls[calls.length - 1].opts.body).SignName;
  ok('配置字段首尾空格发送前被剔除', sentSign === '博联云', sentSign);
  ok('签名错误码翻成中文处置建议', !!err && !!err.extra.hint
    && err.extra.hint.includes('签名内容') && err.extra.hint.includes('2~12'), err && err.extra.hint);
  ok('vendorHint 覆盖签名/模板/权限/密钥类错误',
    !!sms.vendorHint('FailedOperation.TemplateIncorrectOrUnapproved')
    && !!sms.vendorHint('UnauthorizedOperation.SmsSdkAppIdVerifyFail')
    && !!sms.vendorHint('AuthFailure.SignatureFailure'));
  setConfig('sms', { ...TC_CFG, sign_name: '【博联云】' });
  ok('自检会提示签名带【】', sms.testConfig().hints.some((h) => h.includes('【】')), sms.testConfig().hints);
  setConfig('sms', { ...TC_CFG, sign_name: '1400006666' });
  ok('自检会提示疑似填了签名 ID', sms.testConfig().hints.some((h) => h.includes('签名 ID')), sms.testConfig().hints);

  /* ------------------------------------------------------------ [5] 配置与生产护栏 */
  console.log('\n[5] 配置缺失 / 生产模式 / 失败不入库');
  // setConfig 对加密字段是「留空表示不修改」，要模拟真缺 Secret 得直接改配置行
  db.prepare("UPDATE settings SET value = ? WHERE key = 'cfg.sms'")
    .run(JSON.stringify({ ...ALI_CFG, secret: '' }));
  clearLogs(); clearCodes();
  r = await app.inject({ method: 'POST', url: `${B}/api/portal/phone/code`, headers: UH, payload: { phone: phone(9) } });
  ok('缺 Secret 明确回 503 SMS_CONFIG_MISSING', r.statusCode === 503 && json(r).code === 'SMS_CONFIG_MISSING', json(r));
  ok('发送失败不写可用验证码', db.prepare('SELECT COUNT(*) AS c FROM sms_codes').get().c === 0);

  setConfig('sms', { ...SIM_CFG, enabled: 0 });
  r = await app.inject({ method: 'POST', url: `${B}/api/portal/phone/code`, headers: UH, payload: { phone: phone(10) } });
  ok('通道关闭明确回 503 SMS_DISABLED', r.statusCode === 503 && json(r).code === 'SMS_DISABLED', json(r));

  process.env.NODE_ENV = 'production';
  setConfig('sms', SIM_CFG);
  r = await app.inject({ method: 'POST', url: `${B}/api/portal/phone/code`, headers: UH, payload: { phone: phone(11) } });
  ok('生产禁止模拟模式', r.statusCode === 503 && json(r).code === 'SMS_SIMULATE_FORBIDDEN', json(r));
  ok('生产响应绝无 devCode', !('devCode' in json(r)) && !String(r.body).includes('devCode'));
  setConfig('sms', ALI_CFG);
  fetchImpl = async () => reply({ Code: 'OK', BizId: 'BIZ-PROD', RequestId: 'R3' });
  clearLogs();
  r = await app.inject({
    method: 'POST', url: `${B}/api/open/v1/auth/sms/send`, headers: PUB, payload: { phone: phone(12) },
  });
  ok('生产开放接口发送成功', r.statusCode === 200 && json(r).ok === true, json(r));
  ok('生产开放接口绝无 dev_code', !('dev_code' in json(r)) && !String(r.body).includes('dev_code'), r.body);
  process.env.NODE_ENV = 'test';
  setConfig('sms', SIM_CFG);

  /* ------------------------------------------------------------ [6] 频控 */
  console.log('\n[6] 频控（同号 60s / 每日 / 同 IP）');
  clearLogs(); clearCodes();
  await sms.sendVerifyCode({ phone: phone(20), code: '100001', ip: '10.1.1.1' });
  err = null;
  try { await sms.sendVerifyCode({ phone: phone(20), code: '100002', ip: '10.1.1.1' }); } catch (e) { err = e; }
  ok('同号 60 秒内第二次被拒', err && err.code === 'SMS_RATE_LIMITED' && sms.httpStatus(err.code) === 429);
  clearLogs();
  // 种子日志放在 2 分钟前：避开 60 秒规则，才能单独验证「每日上限」
  const twoMinAgo = new Date(Date.now() - 120000).toISOString();
  for (let i = 0; i < sms.LIMITS.perPhoneDay; i += 1) {
    sms.writeLog({ phone: phone(21), ip: '10.1.1.2', vendor: 'simulate', ok: 1, vendorCode: 'SIMULATED', message: 'seed', createdAt: twoMinAgo });
  }
  err = null;
  try { await sms.sendVerifyCode({ phone: phone(21), code: '100003', ip: '10.1.1.3' }); } catch (e) { err = e; }
  ok('单号每日上限生效', err && err.message.includes('今日'), err && err.message);
  clearLogs();
  for (let i = 0; i < sms.LIMITS.perIpHour; i += 1) {
    sms.writeLog({ phone: phone(30 + i), ip: '10.2.2.2', vendor: 'simulate', ok: 1, vendorCode: 'SIMULATED', message: 'seed', createdAt: twoMinAgo });
  }
  err = null;
  try { await sms.sendVerifyCode({ phone: phone(60), code: '100004', ip: '10.2.2.2' }); } catch (e) { err = e; }
  ok('同 IP 每小时上限生效', err && err.message.includes('网络'), err && err.message);

  /* ------------------------------------------------------------ [7] 后台端点 */
  console.log('\n[7] 后台自检 / 测试发送 / 台账');
  clearLogs();
  r = await app.inject({ method: 'GET', url: `${B}/api/admin/sms/status`, headers: AH });
  ok('自检端点返回 check/logs/diagnostics', r.statusCode === 200 && !!json(r).check
    && Array.isArray(json(r).logs) && Array.isArray(json(r).diagnostics), json(r));
  r = await app.inject({ method: 'GET', url: `${B}/api/admin/sms/status` });
  ok('自检端点需管理员登录', r.statusCode === 401);
  r = await app.inject({ method: 'POST', url: `${B}/api/admin/sms/test`, headers: AH, payload: { phone: 'abc' } });
  ok('测试发送校验手机号', r.statusCode === 400, json(r));
  r = await app.inject({ method: 'POST', url: `${B}/api/admin/sms/test`, headers: AH, payload: { phone: phone(70) } });
  ok('开发模式测试发送返回验证码', r.statusCode === 200 && /^\d{6}$/.test(String(json(r).devCode || '')), json(r));
  ok('测试发送写入台账', db.prepare("SELECT COUNT(*) AS c FROM sms_send_logs WHERE scene='admin.test'").get().c === 1);
  setConfig('sms', TC_CFG);
  fetchImpl = async () => reply({ Response: { SendStatusSet: [{ Code: 'FailedOperation.SignatureIncorrectOrUnapproved', Message: 'signature format is incorrect' }] } });
  r = await app.inject({ method: 'POST', url: `${B}/api/admin/sms/test`, headers: AH, payload: { phone: phone(71) } });
  ok('后台测试端点直接回显中文处置建议', r.statusCode === 502 && !!json(r).hint
    && json(r).error.includes('签名内容'), json(r));
  setConfig('sms', SIM_CFG);
  setConfig('sms', { ...TC_CFG, sdk_app_id: '' });
  const chk = sms.testConfig();
  ok('腾讯云缺 SdkAppId 被自检抓到', !chk.ok && chk.missing.includes('SmsSdkAppId'), chk);
  setConfig('sms', SIM_CFG);

  /* ------------------------------------------------------------ [8] 前端模板 */
  console.log('\n[8] 后台短信配置页真编译');
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/platform/admin/',
  });
  const w = dom.window;
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'node_modules/vue/dist/vue.global.prod.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'public/admin/js/pages-system.js'), 'utf8'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/admin/js/pages-system.js'), 'utf8');
  ok('配置页有 SdkAppId 字段与自检区', /sdk_app_id/.test(src) && /loadSmsStatus/.test(src) && /发送自检与测试/.test(src));
  ok('模板未引入会吞字符串的 ${ 插值', !/\$\{code\}/.test(src));
  try {
    const render = w.Vue.compile(w.PageIntegration.template);
    ok('PageIntegration 模板可编译（新增区块无语法错）', typeof render === 'function');
    ok('模板不引用全局 U / location', !/\{\{\s*U\./.test(src) && !/\{\{\s*location\./.test(src));
  } catch (e) { ok('PageIntegration 模板可编译', false, e.message); }

  await app.close();
  console.log(`\n短信发送通道测试：${pass} 通过 / ${fail} 失败`);
  cleanup();
  if (fail) process.exit(1);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});

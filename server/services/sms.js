/**
 * 短信验证码发送通道（零新依赖，Node 内置 fetch + crypto）
 *
 * 背景：后台「接入配置 → 短信」早就能存 AccessKey / 签名 / 模板，但两个发码端点
 * 从来没读过配置、也没调过任何服务商，接口一律回 {ok:true} —— 用户看到「发送成功」
 * 却永远收不到短信。这里把发送链路真正补上，并且遵守项目约定：
 *   - 渠道未开通 / 配置不全 **不静默降级为模拟**（与支付渠道同口径）；
 *   - 生产环境**绝不**把验证码回给客户端；
 *   - 服务商原始错误码原样留痕，方便排障，但响应不回传任何密钥。
 *
 * 阿里云：Dysmsapi 2017-05-25 RPC V1 签名（HMAC-SHA1），GET 请求；TemplateParam={"code":"123456"}。
 * 腾讯云：SMS 2021-01-11 + TC3-HMAC-SHA256，POST / JSON；模板变量是顺序占位符 {1}，
 * 按出现顺序传值，TemplateParamSet=["123456"] 即替换 {1}。
 * 两家都只支持「单变量验证码」模板（服务端只传验证码本身）。
 */
const crypto = require('crypto');
const db = require('../db');
const { getConfig, getSetting } = require('../lib/config');
const { now } = require('../lib/util');

const ALI_HOST = 'dysmsapi.aliyuncs.com';
const TC_HOST = 'sms.tencentcloudapi.com';
const TIMEOUT_MS = 8000;

class SmsError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

/* ------------------------------------------------------------------ 诊断留痕 */

const MAX_EVENTS = 40;
const events = [];

function push(level, type, detail) {
  events.push({ ts: now(), level, type, detail: String(detail || '').slice(0, 500) });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

function diagnostics(limit = 20) {
  return events.slice(-Math.min(limit, MAX_EVENTS)).reverse();
}

function writeLog({ phone, ip, scene, vendor, ok, vendorCode, message, bizId, createdAt }) {
  try {
    db.prepare(`INSERT INTO sms_send_logs
      (phone, ip, scene, vendor, ok, vendor_code, message, biz_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      String(phone || ''), String(ip || ''), String(scene || ''), String(vendor || ''),
      ok ? 1 : 0, String(vendorCode || '').slice(0, 80), String(message || '').slice(0, 300),
      String(bizId || '').slice(0, 80), createdAt || now()
    );
  } catch { /* 日志失败不影响发送结果 */ }
}

function recentLogs(limit = 30) {
  try {
    return db.prepare('SELECT * FROM sms_send_logs ORDER BY id DESC LIMIT ?').all(Math.min(Number(limit) || 30, 100));
  } catch { return []; }
}

/* ------------------------------------------------------------------ 配置校验 */

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/** 不用真发短信的自检：管理员保存配置后立刻能看出「为什么发不出去」。 */
function testConfig() {
  const cfg = getConfig('sms');
  const vendor = String(cfg.vendor || 'simulate');
  const enabled = Number(cfg.enabled || 0) === 1;
  const missing = [];
  if (!String(cfg.access_key || '').trim()) missing.push('AccessKey / SecretId');
  if (!String(cfg.secret || '').trim()) missing.push('Secret');
  if (!String(cfg.sign_name || '').trim()) missing.push('签名');
  if (!String(cfg.template_code || '').trim()) missing.push('模板 Code / TemplateId');
  if (vendor === 'tencent' && !String(cfg.sdk_app_id || '').trim()) missing.push('SmsSdkAppId');

  const hints = [];
  if (!enabled) hints.push('「启用」开关未打开');
  if (vendor === 'simulate' && isProduction()) hints.push('生产环境不允许开发模式（不下发真实短信）');
  if (vendor === 'tencent') hints.push('模板须为单变量验证码模板，SdkAppId 在短信控制台「应用管理」里');
  if (vendor === 'aliyun') hints.push('模板变量须为 ${code}，AccessKey 需具备 dysms:SendSms 权限');

  return {
    ok: enabled && (vendor === 'simulate' ? !isProduction() : missing.length === 0),
    enabled, vendor, missing, hints,
    production: isProduction(),
  };
}

/** 是否允许把验证码回显给调用方：生产恒 false；本地还要尊重「演示模式」开关。 */
function canRevealCode() {
  if (isProduction()) return false;
  if (String(getConfig('sms').vendor || 'simulate') !== 'simulate') return false;
  return getSetting('dev_simulate', '') !== '0';
}

function assertReady() {
  const st = testConfig();
  if (!st.enabled) throw new SmsError('SMS_DISABLED', '短信通道尚未启用，请到「接入配置 → 短信」开启并填写服务商信息');
  if (st.vendor === 'simulate' && isProduction()) {
    throw new SmsError('SMS_SIMULATE_FORBIDDEN', '生产环境不允许短信开发模式，请切换为阿里云 / 腾讯云');
  }
  if (st.vendor !== 'simulate' && st.missing.length) {
    throw new SmsError('SMS_CONFIG_MISSING', `短信配置不完整：缺少 ${st.missing.join('、')}`);
  }
  return getConfig('sms');
}

/* ------------------------------------------------------------------ 频控 */

const LIMITS = { perPhoneSec: 60, perPhoneDay: 10, perIpHour: 30 };

function rateGuard(phone, ip) {
  const since60 = new Date(Date.now() - LIMITS.perPhoneSec * 1000).toISOString();
  const sinceDay = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const sinceHour = new Date(Date.now() - 3600 * 1000).toISOString();
  const q = (sql, ...args) => {
    try { return db.prepare(sql).get(...args).c; } catch { return 0; }
  };
  if (q('SELECT COUNT(*) AS c FROM sms_send_logs WHERE phone = ? AND created_at > ?', phone, since60) > 0) {
    throw new SmsError('SMS_RATE_LIMITED', '发送太频繁，请 60 秒后再试');
  }
  if (q('SELECT COUNT(*) AS c FROM sms_send_logs WHERE phone = ? AND created_at > ?', phone, sinceDay) >= LIMITS.perPhoneDay) {
    throw new SmsError('SMS_RATE_LIMITED', '该号码今日发送次数已达上限');
  }
  if (ip && q('SELECT COUNT(*) AS c FROM sms_send_logs WHERE ip = ? AND created_at > ?', ip, sinceHour) >= LIMITS.perIpHour) {
    throw new SmsError('SMS_RATE_LIMITED', '当前网络发送次数过多，请稍后再试');
  }
}

/* ------------------------------------------------------------------ 签名工具 */

function pct(s) {
  // 阿里云 RPC 规范：除 A-Z a-z 0-9 - _ . ~ 外全部大写百分号编码，空格是 %20 不是 +
  return encodeURIComponent(String(s))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function hmac(key, msg) {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest();
}

/** 阿里云 V1 签名只暴露给测试，便于做黄金向量回归。 */
function aliSignParams(params, secret) {
  const canonical = Object.keys(params).sort().map((k) => `${pct(k)}=${pct(params[k])}`).join('&');
  const stringToSign = `GET&%2F&${pct(canonical)}`;
  const signature = crypto.createHmac('sha1', `${secret}&`).update(stringToSign, 'utf8').digest('base64');
  return { canonical, stringToSign, signature };
}

function tcAuthorization(cfg, payload, timestamp) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // UTC 日期
  const service = 'sms';
  const credentialScope = `${date}/${service}/tc3_request`;
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${TC_HOST}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST', '/', '', canonicalHeaders, signedHeaders, sha256hex(payload),
  ].join('\n');
  const stringToSign = [
    'TC3-HMAC-SHA256', String(timestamp), credentialScope, sha256hex(canonicalRequest),
  ].join('\n');
  const secretDate = hmac(`TC3${cfg.secret}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    authorization: `TC3-HMAC-SHA256 Credential=${cfg.access_key}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    credentialScope, canonicalRequest, stringToSign,
  };
}

/* ------------------------------------------------------------------ 两家服务商 */

async function sendAliyun(cfg, phone, code) {
  const params = {
    AccessKeyId: String(cfg.access_key),
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: 'cn-hangzhou',
    SignName: String(cfg.sign_name),
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID().replace(/-/g, ''),
    SignatureVersion: '1.0',
    TemplateCode: String(cfg.template_code),
    TemplateParam: JSON.stringify({ code }),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2017-05-25',
  };
  const signed = aliSignParams(params, String(cfg.secret));
  const url = `https://${ALI_HOST}/?Signature=${pct(signed.signature)}&${signed.canonical}`;
  // Node 内置 fetch 会自作主张补 accept-language / sec-fetch-mode，这里显式写死
  const res = await fetch(url, {
    method: 'GET',
    headers: { Host: ALI_HOST, Accept: 'application/json', 'Accept-Language': 'zh-CN' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let data = {};
  try { data = await res.json(); } catch { /* 非 JSON 响应下面统一报错 */ }
  const vendorCode = String(data.Code || (res.ok ? '' : `HTTP_${res.status}`));
  if (vendorCode && vendorCode !== 'OK') {
    throw new SmsError('SMS_VENDOR_ERROR', data.Message || '阿里云短信返回失败', {
      vendorCode, requestId: data.RequestId || '', httpStatus: res.status,
    });
  }
  if (vendorCode !== 'OK') {
    throw new SmsError('SMS_VENDOR_ERROR', `阿里云短信响应异常（HTTP ${res.status}）`, { httpStatus: res.status });
  }
  return { bizId: String(data.BizId || ''), requestId: String(data.RequestId || '') };
}

async function sendTencent(cfg, phone, code) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    PhoneNumberSet: [`+86${phone}`],
    SmsSdkAppId: String(cfg.sdk_app_id),
    SignName: String(cfg.sign_name),
    TemplateId: String(cfg.template_code),
    TemplateParamSet: [String(code)],
  });
  const signed = tcAuthorization(cfg, payload, timestamp);
  const headers = {
    Authorization: signed.authorization,
    'Content-Type': 'application/json; charset=utf-8',
    Host: TC_HOST,
    'X-TC-Action': 'SendSms',
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Version': '2021-01-11',
    'X-TC-Region': 'ap-guangzhou',
    Accept: 'application/json',
    'Accept-Language': 'zh-CN',
  };
  const res = await fetch(`https://${TC_HOST}/`, {
    method: 'POST', headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let data = {};
  try { data = await res.json(); } catch { /* 非 JSON 响应下面统一报错 */ }
  const r = data.Response || {};
  if (r.Error) {
    throw new SmsError('SMS_VENDOR_ERROR', r.Error.Message || '腾讯云短信返回失败', {
      vendorCode: r.Error.Code || '', requestId: r.RequestId || '', httpStatus: res.status,
    });
  }
  const st = (r.SendStatusSet || [])[0];
  if (!st || st.Code !== 'Ok') {
    throw new SmsError('SMS_VENDOR_ERROR', (st && st.Message) || '腾讯云短信未确认送达', {
      vendorCode: (st && st.Code) || 'NO_STATUS', requestId: r.RequestId || '', httpStatus: res.status,
    });
  }
  return { bizId: String(st.SerialNo || ''), requestId: String(r.RequestId || '') };
}

/* ------------------------------------------------------------------ 统一入口 */

/**
 * 发一条验证码。成功才返回；失败一律抛 SmsError，由路由转成明确错误响应。
 * 调用方负责在成功后把验证码写入 sms_codes（发失败不留可用码）。
 */
async function sendVerifyCode({ phone, code, scene = 'bind', ip = '' }) {
  const cfg = assertReady();
  rateGuard(phone, ip);
  const vendor = String(cfg.vendor || 'simulate');

  if (vendor === 'simulate') {
    writeLog({ phone, ip, scene, vendor, ok: 1, vendorCode: 'SIMULATED', message: '开发模式，未真实下发' });
    push('info', 'send.simulate', `${phone} 开发模式未下发`);
    return { ok: true, mode: 'simulate', bizId: '' };
  }

  try {
    const r = vendor === 'aliyun'
      ? await sendAliyun(cfg, phone, code)
      : await sendTencent(cfg, phone, code);
    writeLog({ phone, ip, scene, vendor, ok: 1, vendorCode: 'OK', message: '已提交服务商', bizId: r.bizId });
    push('info', 'send.ok', `${phone} ${vendor} ${r.requestId || ''}`);
    return { ok: true, mode: vendor, bizId: r.bizId, requestId: r.requestId };
  } catch (e) {
    const err = e instanceof SmsError ? e : new SmsError('SMS_NETWORK_ERROR', `短信服务商请求失败：${e.message}`);
    writeLog({
      phone, ip, scene, vendor, ok: 0,
      vendorCode: err.code + (err.extra.vendorCode ? `:${err.extra.vendorCode}` : ''),
      message: err.message,
    });
    push('warn', 'send.fail', `${phone} ${vendor} ${err.code} ${err.message}`);
    throw err;
  }
}

/** 把内部错误码映射成 HTTP 状态：配置问题 503、限流 429、上游/网络 502。 */
function httpStatus(code) {
  if (code === 'SMS_RATE_LIMITED') return 429;
  if (['SMS_DISABLED', 'SMS_CONFIG_MISSING', 'SMS_SIMULATE_FORBIDDEN'].includes(code)) return 503;
  return 502;
}

module.exports = {
  SmsError, sendVerifyCode, testConfig, canRevealCode, httpStatus,
  diagnostics, recentLogs, writeLog,
  // 测试用
  aliSignParams, tcAuthorization, pct, LIMITS,
};

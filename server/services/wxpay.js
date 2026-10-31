const crypto = require('crypto');
const { getConfig } = require('../lib/config');
const paydiag = require('../lib/paydiag');

const HOST = 'https://api.mch.weixin.qq.com';

/**
 * 把微信支付的错误码翻成「下一步该做什么」。
 * 微信返回的 message 常常只是「签名验证失败」「参数错误」，
 * 光看它无法判断到底是私钥、证书序列号还是 AppID 绑定出了问题。
 */
function explainPayError(code = '', message = '', status = 0) {
  const TABLE = {
    SIGN_ERROR: '商户证书不对：通常是「证书序列号」串成了平台证书的序列号，或私钥与证书不是一对（到商户平台重新下载 apiclient_cert/private_key）',
    MCH_NOT_EXISTS: '商户号不存在或不匹配：mchid 是 10 位数字，别填成 AppID 或商户名称',
    APPID_MCHID_NOT_MATCH: 'AppID 与商户号未关联：商户平台 → 产品中心 → AppID 账号管理，把使用的 AppID 关联到该商户号',
    APPID_NOT_BIND_MCHID: 'AppID 未绑定商户号：同上，在商户平台完成 AppID 与商户号的关联',
    NO_AUTH: '商户无该接口权限：Native 扫码支付需在商户平台开通；也可能是 AppID 与商户号未绑定导致的权限不足',
    OUT_TRADE_NO_USED: '商户订单号重复：同一商户号下 out_trade_no 不能重号，请重新下单（不要重复点「立即支付」同一笔订单）',
    ORDERPAID: '该订单已支付',
    INVALID_REQUEST: '请求参数不合法：多为 notify_url 不是公网可访问的 https 地址，或金额小于 0.01 元',
    PARAM_ERROR: '参数错误：检查商户号、AppID、金额（单位必须是分，最小 0.01 元）与 notify_url',
    NOTENOUGH: '余额不足',
    RULELIMIT: '触发业务规则限制（如限额），详见商户平台的交易限制',
    USER_ACCOUNT_ABNORMAL: '用户支付账户异常',
    OPENID_MISMATCH: 'OpenID 不属于该 AppID',
    FREQUENCY_LIMITED: '接口调用频率超限，稍后再试',
    SYSTEM_ERROR: '微信侧系统错误，可重试一次',
  };
  const tip = TABLE[String(code || '').toUpperCase()];
  const parts = [];
  if (tip) parts.push(tip);
  if (message) parts.push(`原始提示：${message}`);
  if (code) parts.push(`错误码 ${code}`);
  if (!parts.length) parts.push(status ? `微信支付返回 HTTP ${status}${message ? '：' + message : ''}` : message || '未知错误');
  return parts.join('｜');
}

/**
 * 商户私钥经常是从文本查看器里复制出来的，换行会变成字面量 \n 或被压成一行，
 * 直接拿去签名会报 "DECODER routines::unsupported" 这类看不懂的错。
 */
function normalizePrivateKey(pem) {
  if (!pem) return '';
  let s = String(pem).trim().replace(/\r/g, '');
  s = s.replace(/\\n/g, '\n');
  if (!/-----(BEGIN|END)/.test(s)) return s;
  // 补回首尾缺失的换行，并按 64 字符一行重排（PEM 标准格式）
  const head = s.match(/-----BEGIN[^-]*-----/);
  const tail = s.match(/-----END[^-]*-----/);
  if (!head || !tail) return s;
  const body = s.slice(head.index + head[0].length, tail.index)
    .replace(/\s+/g, '');
  return `${head[0]}\n${(body.match(/.{1,64}/g) || []).join('\n')}\n${tail[0]}\n`;
}

let certCache = { pem: '', serial: '', expiresAt: 0 };

function sign(method, urlPath, timestamp, nonceStr, body) {
  const cfg = readConfig();
  const payload = `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${body}\n`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(payload);
  let signature;
  try {
    signature = signer.sign(cfg.private_key, 'base64');
  } catch (e) {
    throw new Error('商户私钥无法用于签名：请检查后台粘贴的是 apiclient_key.pem 的完整内容'
      + `（含 -----BEGIN PRIVATE KEY----- 与 -----END PRIVATE KEY----- 两行）｜原始错误：${e.message}`);
  }
  return `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchid}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${timestamp}",serial_no="${cfg.mch_cert_serial}"`;
}

/**
 * 商户参数里混进空格、换行是极常见的复制错误（微信会把含空格的商户号判为不存在），
 * 统一在这里去掉首尾空白。
 */
function readConfig() {
  const c = getConfig('wxpay');
  return {
    ...c,
    appid: String(c.appid || '').trim(),
    mchid: String(c.mchid || '').trim(),
    mch_cert_serial: String(c.mch_cert_serial || '').trim().toUpperCase(),
    api_v3_key: String(c.api_v3_key || '').trim(),
    notify_url: String(c.notify_url || '').trim(),
    private_key: normalizePrivateKey(c.private_key),
  };
}

async function call(method, urlPath, body) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const payload = body ? JSON.stringify(body) : '';
  const res = await fetch(`${HOST}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'iot-admin/1.0',
      Authorization: sign(method, urlPath, timestamp, nonceStr, payload),
    },
    body: payload || undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(explainPayError(data?.code, data?.message, res.status));
    err.status = res.status;
    err.code = data?.code;
    err.data = data;
    throw err;
  }
  return data;
}

/** Native 扫码支付下单，返回 code_url */
async function nativePrepay({ description, outTradeNo, amount, notifyUrl, attach = '' }) {
  const cfg = readConfig();
  const total = Math.round(amount * 100);
  if (!(Number(amount) > 0)) throw new Error('支付金额必须大于 0 元，当前 ' + Number(amount || 0) + ' 元');
  if (notifyUrl && !/^https?:\/\//.test(notifyUrl)) {
    throw new Error(`回调地址不是合法 URL：${notifyUrl}`);
  }
  paydiag.push('info', 'prepay', `发起 Native 下单：订单 ${outTradeNo}，金额 ¥${amount}（${total} 分），回调 ${notifyUrl}`);
  try {
    const data = await call('POST', '/v3/pay/transactions/native', {
      appid: cfg.appid,
      mchid: cfg.mchid,
      description: String(description || '商品').slice(0, 127),
      out_trade_no: outTradeNo,
      notify_url: notifyUrl,
      attach: String(attach || '').slice(0, 128),
      amount: { total, currency: 'CNY' },
    });
    if (!data.code_url) {
      paydiag.push('error', 'prepay', `下单成功但微信未返回 code_url：${JSON.stringify(data).slice(0, 200)}`);
      throw new Error('微信未返回支付二维码链接（code_url）');
    }
    paydiag.push('ok', 'prepay', `下单成功，付款码已生成：订单 ${outTradeNo}`);
    return data;
  } catch (e) {
    paydiag.push('error', 'prepay', `下单失败：订单 ${outTradeNo}，${e.message}`);
    throw e;
  }
}

/** JSAPI 下单（公众号/小程序支付），返回 prepay_id 与调起支付参数 */
async function jsapiPrepay({ description, outTradeNo, amount, notifyUrl, openid, attach = '' }) {
  const cfg = readConfig();
  const data = await call('POST', '/v3/pay/transactions/jsapi', {
    appid: cfg.appid,
    mchid: cfg.mchid,
    description,
    out_trade_no: outTradeNo,
    notify_url: notifyUrl,
    attach,
    amount: { total: Math.round(amount * 100), currency: 'CNY' },
    payer: { openid },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const pkg = `prepay_id=${data.prepay_id}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${cfg.appid}\n${timestamp}\n${nonceStr}\n${pkg}\n`);
  return {
    prepay_id: data.prepay_id,
    paySign: signer.sign(cfg.private_key, 'base64'),
    timeStamp: String(timestamp),
    nonceStr,
    package: pkg,
    signType: 'RSA',
  };
}

async function queryOrder(outTradeNo) {
  return call('GET', `/v3/pay/transactions/out-trade-no/${outTradeNo}?mchid=${readConfig().mchid}`);
}

async function refund({ outTradeNo, outRefundNo, total, refundAmount, reason = '' }) {
  const cfg = readConfig();
  return call('POST', '/v3/refund/domestic/refunds', {
    out_trade_no: outTradeNo,
    out_refund_no: outRefundNo,
    reason,
    notify_url: '',
    amount: {
      refund: Math.round(refundAmount * 100),
      total: Math.round(total * 100),
      currency: 'CNY',
    },
  });
}

async function getPlatformCert(force = false) {
  if (!force && certCache.pem && certCache.expiresAt > Date.now()) return certCache;
  const cfg = readConfig();
  if (cfg.platform_cert) return { pem: cfg.platform_cert, serial: '' };
  const data = await call('GET', '/v3/certificates');
  const cert = (data.data || [])[0];
  if (!cert) throw new Error('未获取到微信支付平台证书');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(cfg.api_v3_key, 'utf8'), Buffer.from(cert.encrypt_certificate.nonce, 'utf8'));
  decipher.setAAD(Buffer.from(cert.encrypt_certificate.associated_data, 'utf8'));
  decipher.setAuthTag(Buffer.from(cert.encrypt_certificate.ciphertext, 'base64').subarray(-16));
  const pem = Buffer.concat([
    decipher.update(Buffer.from(cert.encrypt_certificate.ciphertext, 'base64').subarray(0, -16)),
    decipher.final(),
  ]).toString('utf8');
  certCache = { pem, serial: cert.serial_no, expiresAt: Date.now() + 12 * 3600 * 1000 };
  return certCache;
}

function verifyNotify(headers, rawBody) {
  const cfg = readConfig();
  const signature = headers['wechatpay-signature'];
  const timestamp = headers['wechatpay-timestamp'];
  const nonce = headers['wechatpay-nonce'];
  const serial = headers['wechatpay-serial'];
  if (!signature) throw new Error('缺少微信支付签名头');
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) throw new Error('微信支付回调时间戳超出范围');
  return { signature, timestamp, nonce, serial, cfg };
}

async function verifyAndDecrypt(headers, rawBody) {
  const { signature, timestamp, nonce, cfg } = verifyNotify(headers, rawBody);
  const cert = await getPlatformCert();
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${timestamp}\n${nonce}\n${rawBody}\n`);
  if (!verifier.verify(cert.pem, signature, 'base64')) {
    certCache = { pem: '', serial: '', expiresAt: 0 };
    const fresh = await getPlatformCert(true);
    const v2 = crypto.createVerify('RSA-SHA256');
    v2.update(`${timestamp}\n${nonce}\n${rawBody}\n`);
    if (!v2.verify(fresh.pem, signature, 'base64')) throw new Error('微信支付回调验签失败');
  }
  const body = JSON.parse(rawBody);
  const r = body.resource;
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(cfg.api_v3_key, 'utf8'), Buffer.from(r.nonce, 'utf8'));
  decipher.setAAD(Buffer.from(r.associated_data || '', 'utf8'));
  decipher.setAuthTag(Buffer.from(r.ciphertext, 'base64').subarray(-16));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(r.ciphertext, 'base64').subarray(0, -16)),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plain);
}

/**
 * 配置自检：调用「获取平台证书」接口并解密。
 * 这一步能同时验证四样配置：
 *   - 商户号 + 证书序列号 + 商户私钥 → 请求签名能否被微信接受
 *   - API v3 密钥                    → AEAD 解密能否通过（final() 会校验 GCM tag）
 * 不需要真实付款，是上线前唯一能完整验证支付配置的方法。
 */
async function testConfig() {
  const cfg = readConfig();
  const missing = [];
  for (const [k, label] of [['mchid', '商户号'], ['appid', '应用 AppID'],
    ['mch_cert_serial', '证书序列号'], ['private_key', '商户私钥'], ['api_v3_key', 'API v3 密钥']]) {
    if (!cfg[k]) missing.push(label);
  }
  if (missing.length) throw new Error(`缺少配置：${missing.join('、')}`);
  certCache = { pem: '', serial: '', expiresAt: 0 };
  const cert = await getPlatformCert(true);
  return { ok: true, message: '微信支付配置可用（已成功拉取并解密平台证书）', serial: cert.serial };
}

module.exports = { nativePrepay, jsapiPrepay, queryOrder, refund, verifyAndDecrypt, testConfig, explainPayError, normalizePrivateKey, readConfig };

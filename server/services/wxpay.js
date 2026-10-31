const crypto = require('crypto');
const { getConfig } = require('../lib/config');

const HOST = 'https://api.mch.weixin.qq.com';

let certCache = { pem: '', serial: '', expiresAt: 0 };

function sign(method, urlPath, timestamp, nonceStr, body) {
  const cfg = getConfig('wxpay');
  const payload = `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${body}\n`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(payload);
  const signature = signer.sign(cfg.private_key, 'base64');
  return `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchid}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${timestamp}",serial_no="${cfg.mch_cert_serial}"`;
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
    const err = new Error(data?.message || `微信支付 ${res.status}`);
    err.status = res.status;
    err.code = data?.code;
    err.data = data;
    throw err;
  }
  return data;
}

/** Native 扫码支付下单，返回 code_url */
async function nativePrepay({ description, outTradeNo, amount, notifyUrl, attach = '' }) {
  const cfg = getConfig('wxpay');
  return call('POST', '/v3/pay/transactions/native', {
    appid: cfg.appid,
    mchid: cfg.mchid,
    description,
    out_trade_no: outTradeNo,
    notify_url: notifyUrl,
    attach,
    amount: { total: Math.round(amount * 100), currency: 'CNY' },
  });
}

/** JSAPI 下单（公众号/小程序支付），返回 prepay_id 与调起支付参数 */
async function jsapiPrepay({ description, outTradeNo, amount, notifyUrl, openid, attach = '' }) {
  const cfg = getConfig('wxpay');
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
  return call('GET', `/v3/pay/transactions/out-trade-no/${outTradeNo}?mchid=${getConfig('wxpay').mchid}`);
}

async function refund({ outTradeNo, outRefundNo, total, refundAmount, reason = '' }) {
  const cfg = getConfig('wxpay');
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
  const cfg = getConfig('wxpay');
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
  const cfg = getConfig('wxpay');
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

module.exports = { nativePrepay, jsapiPrepay, queryOrder, refund, verifyAndDecrypt };

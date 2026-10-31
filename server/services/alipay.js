const crypto = require('crypto');
const { getConfig } = require('../lib/config');

const DEFAULT_METHOD = 'alipay.trade.page.pay';

function buildParams(method, bizContent, notifyUrl) {
  const cfg = getConfig('alipay');
  return {
    app_id: cfg.appid,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '').replace('Z', ''),
    version: '1.0',
    ...(notifyUrl ? { notify_url: notifyUrl } : {}),
    biz_content: typeof bizContent === 'string' ? bizContent : JSON.stringify(bizContent),
  };
}

function sortAndJoin(params) {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] != null)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

function rsa2Sign(content) {
  const cfg = getConfig('alipay');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(content, 'utf8');
  return signer.sign(cfg.private_key, 'base64');
}

/** 电脑网站支付：返回可直接跳转的 URL */
function pagePay({ outTradeNo, totalAmount, subject, body = '', notifyUrl, returnUrl }) {
  const cfg = getConfig('alipay');
  const params = buildParams(DEFAULT_METHOD, {
    out_trade_no: outTradeNo,
    total_amount: Number(totalAmount).toFixed(2),
    subject,
    body,
    product_code: 'FAST_INSTANT_TRADE_PAY',
  }, notifyUrl);
  const content = sortAndJoin(params);
  params.sign = rsa2Sign(content);
  const gateway = cfg.gateway || 'https://openapi.alipay.com/gateway.do';
  const query = Object.keys(params).map((k) => `${k}=${encodeURIComponent(params[k])}`).join('&');
  return { payUrl: `${gateway}?${query}`, params };
}

/** 当面付扫码：返回二维码内容 */
function precreate({ outTradeNo, totalAmount, subject, notifyUrl }) {
  const cfg = getConfig('alipay');
  const params = buildParams('alipay.trade.precreate', {
    out_trade_no: outTradeNo,
    total_amount: Number(totalAmount).toFixed(2),
    subject,
  }, notifyUrl);
  const content = sortAndJoin(params);
  params.sign = rsa2Sign(content);
  const gateway = cfg.gateway || 'https://openapi.alipay.com/gateway.do';
  return { gateway, params: { ...params, sign: params.sign } };
}

async function tradeQuery(outTradeNo) {
  const cfg = getConfig('alipay');
  const params = buildParams('alipay.trade.query', { out_trade_no: outTradeNo });
  params.sign = rsa2Sign(sortAndJoin(params));
  const gateway = cfg.gateway || 'https://openapi.alipay.com/gateway.do';
  const res = await fetch(`${gateway}?${Object.keys(params).map((k) => `${k}=${encodeURIComponent(params[k])}`).join('&')}`);
  const data = await res.json();
  return data[`${DEFAULT_METHOD === '' ? '' : 'alipay_trade_query_response'}`] || data;
}

function verifyNotify(params) {
  const cfg = getConfig('alipay');
  const sign = params.sign;
  if (!sign) return false;
  const content = sortAndJoin(params);
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(content, 'utf8');
  try {
    return verifier.verify(cfg.alipay_public_key, sign, 'base64');
  } catch {
    return false;
  }
}

module.exports = { pagePay, precreate, tradeQuery, verifyNotify };

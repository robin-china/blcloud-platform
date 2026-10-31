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
 * 私钥/公钥经常是从文本查看器里复制出来的，换行会变成字面量 \n 或被压成一行，
 * 直接拿去签名会报 "DECODER routines::unsupported" 这类看不懂的错。
 */
function normalizePem(pem) {
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

function normalizePrivateKey(pem) {
  return normalizePem(pem);
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
    // 微信支付公钥模式（2024 年起新商户默认模式，无法下载平台证书）
    pub_key_id: String(c.pub_key_id || '').trim().toUpperCase(),
    pub_key: normalizePem(c.pub_key),
    platform_cert: normalizePem(c.platform_cert),
  };
}

/** 验签模式：pubkey=微信支付公钥 / cert=手动平台证书 / auto=拉取平台证书 */
function verifyMode() {
  const cfg = readConfig();
  if (cfg.platform_cert) return 'cert';
  if (cfg.pub_key) return 'pubkey';
  return 'auto';
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
      // Node 的内置 fetch 会自带 accept-language: *，微信支付不接受这个值，
      // 会直接回 PARAM_ERROR「传入了不支持的Accept-Language」。这里必须显式指定。
      'Accept-Language': 'zh-CN',
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

/**
 * 下载并解密微信支付平台证书。
 * 注意：2024 年起新商户号已无法下载平台证书，微信会返回 RESOURCE_NOT_EXISTS，
 * 要求改用「微信支付公钥」。这种情况必须给出可执行的指引，而不是让运维去查回调地址。
 */
async function fetchPlatformCert(force = false) {
  if (!force && certCache.pem && certCache.expiresAt > Date.now()) return certCache;
  const cfg = readConfig();
  let data;
  try {
    data = await call('GET', '/v3/certificates');
  } catch (e) {
    const code = String(e.code || '').toUpperCase();
    if (code === 'RESOURCE_NOT_EXISTS' || /公钥/.test(String(e.message || ''))) {
      throw new Error('该商户号已无法下载平台证书（微信已全面改用「微信支付公钥」）：'
        + '请到 商户平台 → 账户中心 → API安全 → 申请「微信支付公钥」，把「微信支付公钥ID」和「公钥内容」'
        + '填到本页并保存，回调即可本地验签成功｜' + e.message);
    }
    throw e;
  }
  const cert = (data.data || [])[0];
  if (!cert) throw new Error('未获取到微信支付平台证书');
  let pem;
  try {
    const enc = cert.encrypt_certificate || {};
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(cfg.api_v3_key, 'utf8'), Buffer.from(enc.nonce, 'utf8'));
    decipher.setAAD(Buffer.from(enc.associated_data, 'utf8'));
    const buf = Buffer.from(enc.ciphertext, 'base64');
    decipher.setAuthTag(buf.subarray(-16));
    pem = Buffer.concat([decipher.update(buf.subarray(0, -16)), decipher.final()]).toString('utf8');
  } catch (e) {
    // GCM tag 校验不过 = API v3 密钥不对，这是最典型的症状
    throw new Error(`平台证书解密失败，几乎可以确定是 API v3 密钥填错：${e.message}`);
  }
  certCache = { pem, serial: cert.serial_no, expiresAt: Date.now() + 12 * 3600 * 1000 };
  return certCache;
}

/**
 * 取得「验签用的公钥」。
 * 微信有两种模式：
 *   - 平台证书模式：回调头 Wechatpay-Serial 是平台证书序列号，需要先联网下载证书
 *   - 微信支付公钥模式：回调头是公钥ID（PUB_KEY_ID_xxx），用本地配置的公钥直接验签，不联网
 * 公钥模式优先，因为它不依赖任何网络请求，回调链路最短也最稳。
 */
async function getVerifyKey(serial) {
  const cfg = readConfig();
  if (cfg.platform_cert) return { pem: cfg.platform_cert, source: '手动配置的平台证书' };
  if (cfg.pub_key) {
    if (cfg.pub_key_id && serial && String(serial).toUpperCase() !== cfg.pub_key_id) {
      paydiag.push('warn', 'notify', `回调头 Wechatpay-Serial（${serial}）与后台填写的微信支付公钥ID（${cfg.pub_key_id}）不一致，仍尝试用已填公钥验签`);
    }
    return { pem: cfg.pub_key, source: '微信支付公钥' };
  }
  const cert = await fetchPlatformCert();
  return { pem: cert.pem, source: '平台证书（自动下载）' };
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
  const { signature, timestamp, nonce, serial, cfg } = verifyNotify(headers, rawBody);
  if (!String(rawBody || '').trim()) throw new Error('回调报文为空：拿不到原始 body 无法验签（检查 Nginx 是否转发完整请求体）');
  let key;
  try {
    key = await getVerifyKey(serial);
  } catch (e) {
    // 拿不到验签公钥就没法验签，这不是回调地址的问题，别让人去查回调地址
    throw new Error(`无法获取验签公钥，回调无法验签：${e.message}`);
  }
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  const check = (pem) => {
    const v = crypto.createVerify('RSA-SHA256');
    v.update(message);
    try { return v.verify(pem, signature, 'base64'); } catch { return false; }
  };
  if (!check(key.pem)) {
    // 平台证书可能是微信刚轮换的，强制刷新再试一次；本地公钥则无需刷新
    if (key.source === '平台证书（自动下载）') {
      certCache = { pem: '', serial: '', expiresAt: 0 };
      let fresh;
      try {
        fresh = await fetchPlatformCert(true);
      } catch (e) {
        throw new Error(`拉取微信支付平台证书失败，回调无法验签：${e.message}`);
      }
      if (!check(fresh.pem)) throw new Error('微信支付回调验签失败（已强制刷新平台证书仍不通过）');
    } else if (key.source === '微信支付公钥') {
      throw new Error(`微信支付回调验签失败：已填的微信支付公钥与本次回调不匹配。`
        + `请核对公钥内容完整（含 -----BEGIN PUBLIC KEY----- 两行）、且「微信支付公钥ID」与回调头一致（本次 Wechatpay-Serial=${serial}）；`
        + `若商户平台实际用的是平台证书模式，请清空公钥两项`);
    } else {
      throw new Error('微信支付回调验签失败：手动配置的平台证书不正确或已过期');
    }
  }
  let r;
  try { r = JSON.parse(rawBody).resource; } catch { throw new Error('回调报文不是合法 JSON'); }
  if (!r || !r.ciphertext) throw new Error('回调报文缺少 resource 密文');
  try {
    return decryptResource(r, cfg);
  } catch (e) {
    // GCM tag 校验不过 = API v3 密钥不对，这是最典型的症状
    throw new Error(`回调报文解密失败，几乎可以确定是 API v3 密钥填错：${e.message}`);
  }
}

function decryptResource(r, cfg) {
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
 * 用「查询一个不存在的订单」探测商户请求签名是否被微信接受。
 * 返回 404/ORDER_NOT_EXIST 恰恰说明签名是合法的（微信认出了这个商户），
 * 反之若 SIGN_ERROR 就是商户号/证书序列号/私钥三者之一填错。
 * 公钥模式下必须走这条路，因为平台证书接口已经不可用。
 */
async function probeSignature() {
  const cfg = readConfig();
  const probe = `SELFTEST${Date.now()}`;
  try {
    await call('GET', `/v3/pay/transactions/out-trade-no/${probe}?mchid=${encodeURIComponent(cfg.mchid)}`);
    return { ok: true, note: '查询接口返回成功' };
  } catch (e) {
    if (e.status === 404 || /ORDER_?NOT_?EXIST/i.test(String(e.code || ''))) {
      return { ok: true, note: '签名已被微信接受（订单不存在是预期结果）' };
    }
    throw new Error(`商户请求签名未被微信接受：${e.message}`);
  }
}

/**
 * 配置自检：不需要真实付款就能验证支付配置。
 * 两种模式验证的能力不同，必须分开说清楚，否则运维会误以为「测过了但回调还是失败」。
 */
async function testConfig() {
  const cfg = readConfig();
  const missing = [];
  for (const [k, label] of [['mchid', '商户号'], ['appid', '应用 AppID'],
    ['mch_cert_serial', '证书序列号'], ['private_key', '商户私钥'], ['api_v3_key', 'API v3 密钥']]) {
    if (!cfg[k]) missing.push(label);
  }
  if (missing.length) throw new Error(`缺少配置：${missing.join('、')}`);
  if (cfg.api_v3_key.length !== 32) {
    throw new Error(`API v3 密钥应为 32 位字符串，当前 ${cfg.api_v3_key.length} 位（到商户平台 → API安全 → 设置 APIv3 密钥重新复制）`);
  }
  certCache = { pem: '', serial: '', expiresAt: 0 };
  const probe = await probeSignature();
  // 公钥模式：验签公钥在本地，不必联网下载证书
  if (cfg.pub_key || cfg.platform_cert) {
    const mode = cfg.pub_key ? '微信支付公钥' : '手动平台证书';
    return {
      ok: true,
      mode: cfg.pub_key ? 'pubkey' : 'cert',
      message: `${mode}模式配置可用：${probe.note}，回调将用本地${mode}验签（API v3 密钥长度正确，其内容会在真实回调时校验）`,
    };
  }
  const cert = await fetchPlatformCert(true);
  return {
    ok: true,
    mode: 'auto',
    message: `平台证书模式配置可用：${probe.note}，且已成功拉取并解密平台证书（说明 API v3 密钥正确）`,
    serial: cert.serial,
  };
}

module.exports = {
  nativePrepay, jsapiPrepay, queryOrder, refund,
  verifyAndDecrypt, testConfig, explainPayError,
  normalizePrivateKey, normalizePem, readConfig, verifyMode, probeSignature,
};

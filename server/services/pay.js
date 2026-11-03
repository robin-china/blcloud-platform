const db = require('../db');
const { now, safeJson } = require('../lib/util');
const { getConfig, getSetting, basePath } = require('../lib/config');
const wxpay = require('./wxpay');
const alipay = require('./alipay');
const paydiag = require('../lib/paydiag');
const { deliverOrder } = require('./deliver');
const commission = require('../lib/commission');

/** 把发货结果说成人话，便于诊断与客服核对 */
function describeDelivery(created) {
  return (created || []).map((c) => {
    if (c.type === 'api_quota') return `API 额度 +${c.quota} 次（账户余额 ${c.after}）`;
    if (c.type === 'license') return `授权码 ${c.license_key}（${c.product}）`;
    if (c.type === 'license_renew') return `授权 ${c.license_key} 续期 ${c.days} 天，至 ${String(c.end_at).slice(0, 10)}`;
    if (c.type === 'license_upgrade') return `授权 ${c.license_key} 升级至 ${c.product}（${c.plan_code}）`;
    if (c.type === 'device') return `设备 ${c.sn}（${c.product}）`;
    return String(c.type || '未知');
  }).join('；');
}

function baseUrl(req) {
  const cfg = getConfig('wxpay');
  // 手动填了回调地址就以它为准（需自己带完整路径）
  if (cfg.notify_url) return cfg.notify_url.replace(/\/+$/, '');
  // 反代没传 X-Forwarded-Proto 时不能默认 http：微信支付要求回调地址是公网可访问的 https，
  // 用 http 下单会被拒，且这种失败在页面上看不出原因
  const forwarded = req?.headers['x-forwarded-proto'];
  const isLocal = String(req?.headers.host || '').startsWith('127.0.0.1') || String(req?.headers.host || '').startsWith('localhost');
  const proto = String(forwarded || req?.protocol || (isLocal ? 'http' : 'https')).split(',')[0];
  const host = req?.headers['x-forwarded-host'] || req?.headers.host || 'localhost';
  // 子路径部署时必须带上前缀，否则微信回调会打到错误的地址
  return `${proto}://${host}${basePath()}`;
}

async function createPayment(req, order, channel) {
  const productName = (safeJson(order.items, [])[0] || {}).product_name || '商品购买';
  const wx = getConfig('wxpay');
  const ali = getConfig('alipay');
  const base = baseUrl(req);

  if (channel === 'wxpay' && wx.enabled) {
    const data = await wxpay.nativePrepay({
      description: productName.slice(0, 40),
      outTradeNo: order.order_no,
      amount: order.pay_amount,
      notifyUrl: `${base}/api/pay/notify/wxpay`,
      attach: String(order.user_id),
    });
    return { mode: 'qrcode', channel: 'wxpay', code_url: data.code_url };
  }

  if (channel === 'alipay' && ali.enabled) {
    const { payUrl } = alipay.pagePay({
      outTradeNo: order.order_no,
      totalAmount: order.pay_amount,
      subject: productName.slice(0, 40),
      notifyUrl: `${base}/api/pay/notify/alipay`,
      returnUrl: `${base}/user/#/orders`,
    });
    return { mode: 'redirect', channel: 'alipay', pay_url: payUrl };
  }

  // 渠道未开通时不得静默降级为模拟支付，否则相当于 0 元发货
  if (channel === 'wxpay' || channel === 'alipay') {
    throw new Error(channel === 'wxpay' ? '微信支付尚未开通' : '支付宝尚未开通');
  }

  // 只有显式开启模拟支付（pay_simulate=1）才允许走模拟通道
  if (String(getSetting('pay_simulate', '0')) !== '1') {
    throw new Error('当前未开通任何支付方式，请联系管理员');
  }
  return { mode: 'simulate', channel, code_url: '', pay_url: '' };
}

/**
 * 标记订单已支付并发货。
 * paidAmount 为支付渠道回调的实付金额（单位：元），必须与订单应付金额一致，
 * 不一致时只记账不发货，避免回调被伪造或金额被篡改导致的损失。
 */
function markPaid(orderNo, tradeNo, channel, raw = '', paidAmount = null) {
  const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo);
  if (!order) return null;
  if (order.status === 'paid') return order;

  if (paidAmount != null && Number.isFinite(Number(paidAmount))) {
    const expected = Math.round(Number(order.pay_amount) * 100) / 100;
    const actual = Math.round(Number(paidAmount) * 100) / 100;
    if (actual !== expected) {
      db.prepare(`INSERT INTO payments (order_no, channel, trade_no, amount, status, raw, created_at)
        VALUES (?,?,?,?,?,?,?)`)
        .run(orderNo, channel || order.channel, tradeNo || '', actual, 'amount_mismatch',
          `回调金额 ${actual} 与订单金额 ${expected} 不一致，已拒绝发货`.slice(0, 4000), now());
      return { mismatch: true, expected, actual };
    }
  }
  db.prepare('UPDATE orders SET status = ?, trade_no = ?, channel = ?, paid_at = ? WHERE id = ?')
    .run('paid', tradeNo || '', channel || order.channel, now(), order.id);
  db.prepare('INSERT INTO payments (order_no, channel, trade_no, amount, status, raw, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(orderNo, channel || order.channel, tradeNo || '', order.pay_amount, 'success', String(raw).slice(0, 4000), now());
  const date = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO stats_daily (date, revenue) VALUES (?,?)
    ON CONFLICT(date) DO UPDATE SET revenue = revenue + ?`).run(date, order.pay_amount, order.pay_amount);
  const fresh = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  // 发货结果必须留痕：付了钱却什么都没发（比如商品被删/下架）是最难自查的故障，
  // 光看订单状态是「已支付」根本发现不了
  let created = [];
  try {
    created = deliverOrder(fresh) || [];
  } catch (e) {
    paydiag.push('error', 'deliver', `订单 ${orderNo} 已支付但发货失败：${e.message}`);
  }
  db.prepare('UPDATE orders SET deliver_result = ? WHERE id = ?').run(JSON.stringify(created), order.id);
  if (created.length) {
    paydiag.push('ok', 'deliver', `订单 ${orderNo} 已发货：${describeDelivery(created)}`);
  } else {
    paydiag.push('warn', 'deliver', `订单 ${orderNo} 已支付但没有发放任何东西：检查商品是否存在/已下架`);
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(order.user_id);
  if (user) {
    const gained = Math.floor(order.pay_amount);
    const balance = (user.points || 0) + gained;
    db.prepare('UPDATE users SET points = ? WHERE id = ?').run(balance, order.user_id);
    db.prepare('INSERT INTO points_logs (user_id, change, balance, reason, created_at) VALUES (?,?,?,?,?)')
      .run(order.user_id, gained, balance, `订单 ${orderNo} 消费返积分`, now());
  }
  // 代理商佣金按实收计。放在最后：即便发货抛错也不影响记账，
  // UNIQUE(order_id, agent_user_id, kind) 保证回调与主动查单重复触发不会记两笔。
  commission.accrueForOrder(fresh);
  return fresh;
}

module.exports = { createPayment, markPaid, baseUrl };

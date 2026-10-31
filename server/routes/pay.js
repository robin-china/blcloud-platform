const { Readable } = require('stream');
const db = require('../db');
const { now, safeJson } = require('../lib/util');
const { getSetting, basePath } = require('../lib/config');
const { requireUser } = require('../lib/auth');
const wxpay = require('../services/wxpay');
const paydiag = require('../lib/paydiag');
const alipay = require('../services/alipay');
const { createPayment, markPaid } = require('../services/pay');

module.exports = async function payRoutes(app) {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    const out = {};
    for (const [k, v] of new URLSearchParams(body)) out[k] = v;
    done(null, out);
  });

  // 回调必须拿到**原始报文**才能验签（验签串里就是这段字节），
  // 所以要在 body 被解析之前先把兜住。注意子路径部署时 req.url 带前缀，
  // 路径判断必须跟着 BASE_PATH 走，否则子路径下拿不到原文 → 验签必失败。
  const notifyPath = basePath() + '/api/pay/notify/wxpay';
  app.addHook('preParsing', async (req, reply, payload) => {
    if ((req.url || '').split('?')[0] === notifyPath) {
      const chunks = [];
      for await (const chunk of payload) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      req.wxRawBody = raw;
      return Readable.from([raw]);
    }
    return payload;
  });

  app.post('/api/pay/notify/wxpay', async (req, reply) => {
    try {
      const data = await wxpay.verifyAndDecrypt(req.headers, req.wxRawBody || '');
      if (data.trade_state === 'SUCCESS') {
        // 微信 v3 金额单位为分
        const paid = Number(data.amount?.total || 0) / 100;
        const r = markPaid(data.out_trade_no, data.transaction_id, 'wxpay', JSON.stringify(data), paid);
        if (r && r.mismatch) {
          paydiag.push('error', 'notify', `回调金额不符，拒绝发货：订单 ${data.out_trade_no}，应收 ¥${r.expected}，实收 ¥${r.actual}`);
        } else {
          paydiag.push('ok', 'notify', `支付成功：订单 ${data.out_trade_no}，微信单号 ${data.transaction_id}`);
        }
      } else {
        paydiag.push('info', 'notify', `收到回调但交易未完成：订单 ${data.out_trade_no}，状态 ${data.trade_state}`);
      }
    } catch (e) {
      app.log.warn(`微信支付回调处理失败: ${e.message}`);
      paydiag.push('error', 'notify', `回调处理失败：${e.message}（微信会重试，务必确认 API v3 密钥与平台证书正确）`);
      return reply.code(500).send({ code: 'FAIL', message: e.message });
    }
    return { code: 'SUCCESS', message: '成功' };
  });

  app.post('/api/pay/notify/alipay', async (req, reply) => {
    const params = req.body || {};
    try {
      if (!alipay.verifyNotify(params)) throw new Error('验签失败');
      if (params.trade_status === 'TRADE_SUCCESS' || params.trade_status === 'TRADE_FINISHED') {
        // 支付宝金额单位为元
        markPaid(params.out_trade_no, params.trade_no, 'alipay', JSON.stringify(params), Number(params.total_amount || 0));
      }
    } catch (e) {
      app.log.warn(`支付宝回调处理失败: ${e.message}`);
      return 'fail';
    }
    return 'success';
  });

  app.post('/api/pay/simulate/:orderNo', async (req, reply) => {
    // 必须显式开启模拟支付，且只能支付自己的订单
    if (String(getSetting('pay_simulate', '0')) !== '1') {
      return reply.code(403).send({ error: '模拟支付未开启' });
    }
    if (!(await requireUser(req, reply))) return;
    const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(req.params.orderNo);
    if (!order) return reply.code(404).send({ error: '订单不存在' });
    if (order.user_id !== req.user.sub) return reply.code(403).send({ error: '无权操作该订单' });
    if (order.status === 'paid') return { ok: true, status: 'paid' };
    markPaid(order.order_no, `SIM${Date.now()}`, order.channel || 'simulate', 'simulate', order.pay_amount);
    return { ok: true, status: 'paid' };
  });
};

const { Readable } = require('stream');
const db = require('../db');
const { now, safeJson } = require('../lib/util');
const { getSetting } = require('../lib/config');
const { requireUser } = require('../lib/auth');
const wxpay = require('../services/wxpay');
const alipay = require('../services/alipay');
const { createPayment, markPaid } = require('../services/pay');

module.exports = async function payRoutes(app) {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    const out = {};
    for (const [k, v] of new URLSearchParams(body)) out[k] = v;
    done(null, out);
  });

  app.addHook('preParsing', async (req, reply, payload) => {
    if (req.url.startsWith('/api/pay/notify/wxpay')) {
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
        markPaid(data.out_trade_no, data.transaction_id, 'wxpay', JSON.stringify(data), paid);
      }
    } catch (e) {
      app.log.warn(`微信支付回调处理失败: ${e.message}`);
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

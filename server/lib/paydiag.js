/**
 * 支付链路诊断 ring buffer
 *
 * 微信支付「还没出码就失败」时，用户端只看到一个 toast，
 * 管理员要么去翻 pm2 logs，要么只能问开发。这里把最近若干次
 * 下单/回调的关键信息留下来（含微信返回的 code 与翻成中文的建议），
 * 供管理后台直接查看。注意：只记字段名与错误码，不记密钥、不记完整私钥。
 */
const MAX = 30;
const events = [];

function push(level, type, detail) {
  events.push({ ts: new Date().toISOString(), level, type, detail: String(detail || '') });
  if (events.length > MAX) events.splice(0, events.length - MAX);
  return events[events.length - 1];
}

function list(limit = 20) {
  return events.slice(-limit).reverse();
}

module.exports = { push, list };

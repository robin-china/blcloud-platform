/**
 * 微信服务号回调诊断 ring buffer
 *
 * 线上最难排的情况不是报错，而是「静默失败」：
 *   用户扫码了，手机有反应，网页不动，服务端一行日志都没留。
 * 012/015/403 这类问题如果只能靠 `pm2 logs` 才能看到，定位成本极高。
 *
 * 这里在进程内存里保留最近若干条回调事件（成功 / 失败原因），
 * 供管理后台「回调诊断」直接展示，不需要登录服务器。
 */
const MAX = 30;
const events = [];

/**
 * @param {'info'|'warn'|'error'|'ok'} level
 * @param {string} type   事件类型，如 callback / decrypt / signature / login
 * @param {string} detail 人话描述
 */
function push(level, type, detail) {
  events.push({
    ts: new Date().toISOString(),
    level,
    type,
    detail: String(detail || ''),
  });
  if (events.length > MAX) events.splice(0, events.length - MAX);
  return events[events.length - 1];
}

function list(limit = 20) {
  // 最新的排前面，后台展示更直观
  return events.slice(-limit).reverse();
}

function clear() {
  events.length = 0;
}

module.exports = { push, list, clear, MAX };

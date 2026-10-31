/**
 * blcloud 物联（ThingsBoard）开通链路诊断 ring buffer
 *
 * 开户失败时用户端只显示「待激活」，管理员什么线索都没有 —— 既不知道是开关没开、
 * 管理员账号错、Customer 建不出来，还是 TB 建档后没激活。这里把每一步的结果留下，
 * 供后台「开通诊断」直接查看。只记错误码和步骤名，不记密码。
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

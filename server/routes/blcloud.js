/* blcloud 开放接口 /api/blcloud/v1/*
 * 用户凭「个人中心 → blcloud」生成的 API 密钥，直接访问其物联账户下的设备 API。
 * 所有请求经本系统中转：身份校验 → 额度校验 → 转发设备平台 → 记账统计。
 *
 * 鉴权：X-BLC-Key: blc_xxxx  或  Authorization: Bearer blc_xxxx
 */
const db = require('../db');
const tb = require('../services/tb');
const { getConfig } = require('../lib/config');
const bl = require('../lib/blcloud');

/* 允许透传的设备平台路径前缀，防止越权访问其他资源 */
const PATH_WHITELIST = [
  '/api/user/', '/api/devices', '/api/device/', '/api/device',
  '/api/plugins/telemetry/', '/api/rpc/', '/api/tenant/devices', '/api/customer/',
];

function pickKey(req) {
  const h = req.headers || {};
  const raw = h['x-blc-key'] || h['x-blcloud-key'] || '';
  if (raw) return String(raw).trim();
  const auth = String(h.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

function clientIp(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
}

function fail(reply, status, code, message) {
  return reply.code(status).send({ error: message, code });
}

/**
 * 统一代理执行：鉴权 → 额度 → 转发 → 记账
 * spec: { endpoint, scope, cost, build(req) -> { method, path, query, body } }
 */
async function handle(spec, req, reply) {
  const started = Date.now();
  const guard = (code, message, status) => {
    if (guard.done) return;
    guard.done = true;
    bl.reject(null, guard.keyRow, { endpoint: spec.endpoint, path: req.url, method: req.method, status, message });
    fail(reply, status, code, message);
  };

  const raw = pickKey(req);
  if (!raw) return guard('KEY_MISSING', '缺少 blcloud API 密钥（X-BLC-Key）', 401);
  const resolved = bl.resolveKey(raw);
  if (!resolved) return guard('KEY_INVALID', 'API 密钥无效', 401);
  guard.keyRow = resolved.key;

  const { key: keyRow, user } = resolved;
  if (user.status !== 'active') return guard('USER_DISABLED', '账户已被停用', 403);
  if (keyRow.status !== 'active') return guard('KEY_DISABLED', '密钥已停用', 403);
  if (keyRow.expires_at && new Date(keyRow.expires_at).getTime() < Date.now()) {
    return guard('KEY_EXPIRED', '密钥已过期', 403);
  }
  if (spec.scope === 'write' && !String(keyRow.scopes || '').includes('device.write')) {
    return guard('SCOPE_DENIED', '该密钥未开通写入权限', 403);
  }

  const user2 = bl.ensureFreeQuota(user);
  const cost = Number(spec.cost) || 1;
  const ok = bl.check(user2, keyRow, cost);
  if (!ok.ok) return guard(ok.code, ok.reason, 402);

  const target = spec.build(req);
  if (!target || !target.path) return guard('BAD_REQUEST', '请求参数不完整', 400);
  if (target.path.includes('..')) return guard('BAD_REQUEST', '非法路径', 400);
  if (!PATH_WHITELIST.some((p) => target.path.startsWith(p))) {
    return guard('PATH_FORBIDDEN', '该接口不在开放范围内', 403);
  }

  // 取用户自己的物联账户令牌
  let jwt;
  try {
    jwt = await tb.userJwt(user2.tb_username, user2.tb_password);
  } catch (e) {
    bl.consume(user2, keyRow, {
      endpoint: spec.endpoint, path: target.path, method: target.method,
      cost: 0, status: 503, ok: false, message: e.message, ip: clientIp(req),
    });
    return fail(reply, 503, 'BLCLOUD_ACCOUNT_UNAVAILABLE', e.message || '物联账户不可用');
  }

  let r = await tb.raw(target.method, target.path, { query: target.query, body: target.body, token: jwt });
  if (r.status === 401) {
    // 令牌可能过期，强制刷新后重试一次
    tb.dropUserJwt(user2.tb_username);
    try {
      jwt = await tb.userJwt(user2.tb_username, user2.tb_password);
      r = await tb.raw(target.method, target.path, { query: target.query, body: target.body, token: jwt });
    } catch { /* 保留首次结果 */ }
  }

  const success = r.ok;
  bl.consume(user2, keyRow, {
    endpoint: spec.endpoint, path: target.path, method: target.method,
    cost: success ? cost : 0, status: r.status, ok: success,
    message: success ? '' : (r.data?.message || ''), ip: clientIp(req),
  });

  if (!success) {
    return reply.code(r.status === 502 || r.status === 503 ? r.status : 400).send({
      error: r.data?.message || r.data?.error || '设备平台返回错误',
      code: 'TB_ERROR', status: r.status,
    });
  }
  return {
    ok: true,
    cost: success ? cost : 0,
    elapsed_ms: Date.now() - started,
    data: r.data,
  };
}

const ROUTES = [
  /* ---------- 设备 ---------- */
  {
    method: 'GET', path: '/devices', endpoint: 'devices.list', scope: 'read', cost: 1,
    build: (req) => ({
      method: 'GET', path: '/api/user/devices',
      query: {
        pageSize: Math.min(Number(req.query.pageSize) || 100, 500),
        page: Number(req.query.page) || 0,
        type: req.query.type, textSearch: req.query.textSearch, sortProperty: req.query.sortProperty,
      },
    }),
  },
  {
    method: 'GET', path: '/devices/:deviceId', endpoint: 'devices.get', scope: 'read', cost: 1,
    build: (req) => ({ method: 'GET', path: `/api/device/${encodeURIComponent(req.params.deviceId)}` }),
  },
  {
    method: 'GET', path: '/devices/:deviceId/credentials', endpoint: 'devices.credentials', scope: 'read', cost: 2,
    build: (req) => ({ method: 'GET', path: `/api/device/${encodeURIComponent(req.params.deviceId)}/credentials` }),
  },
  /* ---------- 遥测 ---------- */
  {
    method: 'GET', path: '/devices/:deviceId/telemetry', endpoint: 'telemetry.read', scope: 'read', cost: 1,
    build: (req) => ({
      method: 'GET', path: `/api/plugins/telemetry/DEVICE/${encodeURIComponent(req.params.deviceId)}/values/timeseries`,
      query: {
        keys: req.query.keys, startTs: req.query.startTs, endTs: req.query.endTs,
        limit: Math.min(Number(req.query.limit) || 100, 1000),
        interval: req.query.interval, agg: req.query.agg, orderBy: req.query.orderBy,
      },
    }),
  },
  {
    method: 'GET', path: '/devices/:deviceId/telemetry/latest', endpoint: 'telemetry.latest', scope: 'read', cost: 1,
    build: (req) => ({
      method: 'GET', path: `/api/plugins/telemetry/DEVICE/${encodeURIComponent(req.params.deviceId)}/values/timeseries`,
      query: { keys: req.query.keys, useStrictDataTypes: 'false' },
    }),
  },
  {
    method: 'POST', path: '/devices/:deviceId/telemetry', endpoint: 'telemetry.write', scope: 'write', cost: 2,
    build: (req) => ({
      method: 'POST',
      path: `/api/plugins/telemetry/DEVICE/${encodeURIComponent(req.params.deviceId)}/timeseries/${req.body?.scope || 'ANY'}`,
      body: { ts: req.body?.ts || Date.now(), values: req.body?.values || {} },
    }),
  },
  /* ---------- 属性 ---------- */
  {
    method: 'GET', path: '/devices/:deviceId/attributes', endpoint: 'attributes.read', scope: 'read', cost: 1,
    build: (req) => ({
      method: 'GET', path: `/api/plugins/telemetry/DEVICE/${encodeURIComponent(req.params.deviceId)}/values/attributes`,
      query: { keys: req.query.keys, scope: req.query.scope },
    }),
  },
  {
    method: 'POST', path: '/devices/:deviceId/attributes', endpoint: 'attributes.write', scope: 'write', cost: 2,
    build: (req) => ({
      method: 'POST',
      path: `/api/plugins/telemetry/DEVICE/${encodeURIComponent(req.params.deviceId)}/attributes/${req.body?.scope || 'SHARED_SCOPE'}`,
      body: req.body?.values || {},
    }),
  },
  /* ---------- RPC ---------- */
  {
    method: 'POST', path: '/devices/:deviceId/rpc', endpoint: 'rpc.send', scope: 'write', cost: 5,
    build: (req) => {
      const twoWay = String(req.body?.mode || '').toLowerCase() === 'twoway';
      return {
        method: 'POST',
        path: `/api/rpc/${twoWay ? 'twoway' : 'oneway'}/${encodeURIComponent(req.params.deviceId)}`,
        body: { method: req.body?.method || '', params: req.body?.params || {} },
        query: twoWay ? { timeout: Number(req.body?.timeout) || 5000 } : {},
      };
    },
  },
  /* ---------- 通用透传（限白名单） ---------- */
  {
    method: 'POST', path: '/proxy', endpoint: 'proxy.passthrough', scope: 'write', cost: 1,
    build: (req) => {
      const b = req.body || {};
      const method = String(b.method || 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return null;
      return {
        method, path: String(b.path || ''), query: b.query || {},
        body: method === 'GET' || method === 'DELETE' ? undefined : (b.body === undefined ? null : b.body),
      };
    },
  },
];

module.exports = async function blcloudRoutes(app) {
  for (const spec of ROUTES) {
    app.route({
      method: spec.method,
      url: `/api/blcloud/v1${spec.path}`,
      handler: async (req, reply) => handle(spec, req, reply),
    });
  }

  /* 直连模式：签发设备平台 JWT（成本较高，按 10 次额度计） */
  app.post('/api/blcloud/v1/token', async (req, reply) => {
    const spec = {
      endpoint: 'token.issue', scope: 'read', cost: 10,
      build: () => ({ method: 'GET', path: '/api/auth/user' }),
    };
    const raw = pickKey(req);
    if (!raw) return fail(reply, 401, 'KEY_MISSING', '缺少 blcloud API 密钥（X-BLC-Key）');
    const resolved = bl.resolveKey(raw);
    if (!resolved) return fail(reply, 401, 'KEY_INVALID', 'API 密钥无效');
    const { key: keyRow, user } = resolved;
    if (keyRow.status !== 'active') return fail(reply, 403, 'KEY_DISABLED', '密钥已停用');
    const user2 = bl.ensureFreeQuota(user);
    const ok = bl.check(user2, keyRow, spec.cost);
    if (!ok.ok) return fail(reply, 402, ok.code, ok.reason);
    try {
      const jwt = await tb.userJwt(user2.tb_username, user2.tb_password);
      const cfg = getConfig('tb');
      bl.consume(user2, keyRow, {
        endpoint: spec.endpoint, path: '/api/auth/user', method: 'POST',
        cost: spec.cost, status: 200, ok: true, ip: clientIp(req),
      });
      return {
        ok: true, cost: spec.cost,
        token: jwt,
        base_url: String(cfg.base_url || '').replace(/\/+$/, ''),
        expires_at: new Date(tb.jwtExp(jwt) || Date.now() + 1800000).toISOString(),
        usage: 'Authorization: Bearer <token> 直连设备平台；该方式不统计后续调用量，建议使用代理接口',
      };
    } catch (e) {
      bl.reject(user2, keyRow, { endpoint: spec.endpoint, path: '/api/auth/user', status: 503, message: e.message });
      return fail(reply, 503, 'BLCLOUD_ACCOUNT_UNAVAILABLE', e.message);
    }
  });

  /* 密钥自检与用量查询（不计费） */
  app.get('/api/blcloud/v1/me', async (req, reply) => {
    const raw = pickKey(req);
    const resolved = raw ? bl.resolveKey(raw) : null;
    if (!resolved) return fail(reply, 401, 'KEY_INVALID', 'API 密钥无效');
    const user = bl.ensureFreeQuota(resolved.user);
    return {
      ok: true,
      key: bl.keyPayload(resolved.key),
      quota: bl.quotaState(user),
      user: { id: user.id, nickname: user.nickname, tb_status: user.tb_status },
    };
  });

  app.get('/api/blcloud/v1/usage', async (req, reply) => {
    const raw = pickKey(req);
    const resolved = raw ? bl.resolveKey(raw) : null;
    if (!resolved) return fail(reply, 401, 'KEY_INVALID', 'API 密钥无效');
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
    return { ok: true, ...bl.summary(resolved.user.id, days) };
  });

  app.get('/api/blcloud/v1/_endpoints', async () => ({
    ok: true,
    base: '/api/blcloud/v1',
    auth: 'X-BLC-Key: blc_xxxxxxxx',
    endpoints: ROUTES.map((r) => ({ method: r.method, path: r.path, endpoint: r.endpoint, cost: r.cost, scope: r.scope })),
  }));
};

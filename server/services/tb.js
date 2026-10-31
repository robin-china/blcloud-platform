const { getConfig } = require('../lib/config');

let cached = { token: '', baseUrl: '', expiresAt: 0 };

/**
 * 底层转发：返回 { status, ok, data }，不抛异常，便于代理层统一处理错误码
 */
async function raw(method, urlPath, opts = {}) {
  const cfg = getConfig('tb');
  const base = String(cfg.base_url || '').replace(/\/+$/, '');
  if (!base) return { status: 503, ok: false, data: { message: '未配置 blcloud 物联平台地址' } };
  const qs = opts.query
    ? '?' + Object.entries(opts.query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    : '';
  let res;
  try {
    res = await fetch(`${base}${urlPath}${qs}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(opts.token ? { 'X-Authorization': `Bearer ${opts.token}` } : {}),
      },
      body: opts.body === undefined || opts.body === null ? undefined : JSON.stringify(opts.body),
    });
  } catch (e) {
    return { status: 502, ok: false, data: { message: `无法连接 blcloud 物联平台：${e.message}` } };
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

async function request(method, urlPath, body, token) {
  const r = await raw(method, urlPath, { body, token });
  if (!r.ok) {
    const err = new Error(r.data?.message || `TB ${r.status}`);
    err.status = r.status;
    err.data = r.data;
    throw err;
  }
  return r.data;
}

/* ---------- 用户级 JWT（供 blcloud API 代理使用） ---------- */
const userTokens = new Map(); // `${username}` -> { token, exp }

function jwtExp(token) {
  try {
    const seg = String(token).split('.')[1];
    const payload = JSON.parse(Buffer.from(seg, 'base64').toString('utf8'));
    return Number(payload.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

/** 用用户自己的 TB 账户登录换取 JWT，并按过期时间缓存 */
async function userJwt(username, password) {
  if (!username || !password) throw new Error('该用户尚未开通 blcloud 物联账户');
  const hit = userTokens.get(username);
  if (hit && hit.exp > Date.now() + 60000) return hit.token;
  const data = await request('POST', '/api/auth/login', { username, password });
  const token = data?.token || '';
  if (!token) throw new Error('blcloud 物联账户登录失败');
  userTokens.set(username, { token, exp: jwtExp(token) || Date.now() + 20 * 60 * 1000 });
  return token;
}

function dropUserJwt(username) {
  if (username) userTokens.delete(username);
}

async function login(username, password) {
  return request('POST', '/api/auth/login', { username, password });
}

async function adminToken(force = false) {
  const cfg = getConfig('tb');
  const base = String(cfg.base_url || '').replace(/\/+$/, '');
  if (!force && cached.token && cached.baseUrl === base && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }
  const data = await login(cfg.username, cfg.password);
  cached = { token: data.token, baseUrl: base, expiresAt: Date.now() + 25 * 60 * 1000 };
  return cached.token;
}

async function ensureCustomer(token, title, tenantId) {
  const cfg = getConfig('tb');
  const wanted = cfg.default_customer || title;
  if (!wanted) return null;
  const list = await request('GET', `/api/customers?pageSize=200&page=0`, null, token);
  const found = (list?.data || []).find((c) => c.title === wanted);
  if (found) return found.id.id;
  const created = await request('POST', '/api/customer', { title: wanted, tenantId }, token);
  return created.id.id;
}

/**
 * 按规则开通 TB 账户：openid -> openid@tb.cn，密码为 openid 本身
 * 返回 { username, password, status: 'active'|'pending'|'error', userId, message }
 */
async function provisionUser(openid, nickname) {
  const cfg = getConfig('tb');
  const suffix = cfg.email_suffix || '@tb.cn';
  const email = `${openid}${suffix}`;
  const password = openid;
  const result = { username: email, password, status: 'pending', userId: '', message: '' };

  try {
    const self = await login(email, password);
    result.status = 'active';
    result.userId = self.userId?.id || '';
    result.message = '账户已存在且可登录';
    return result;
  } catch (e) {
    if (e.status !== 401 && e.status !== 400) {
      result.status = 'error';
      result.message = e.message;
      return result;
    }
  }

  if (!cfg.enabled) {
    result.message = 'TB 未启用，仅本地登记账户';
    return result;
  }

  try {
    const token = await adminToken();
    const tenant = await request('GET', '/api/auth/user', null, token);
    const tenantId = tenant.tenantId?.id || null;
    const customerId = await ensureCustomer(token, 'default', tenantId);
    const payload = {
      email,
      authority: 'CUSTOMER_USER',
      firstName: nickname || openid,
      lastName: '',
      ...(customerId ? { customerId: { entityType: 'CUSTOMER', id: customerId } } : {}),
    };
    const created = await request('POST', '/api/user', payload, token);
    result.userId = created.id?.id || '';
    try {
      const self = await login(email, password);
      result.status = 'active';
      result.message = '已开通并可登录';
      result.userId = self.userId?.id || result.userId;
    } catch {
      result.status = 'pending';
      result.message = '已创建，等待激活后设置密码';
    }
    return result;
  } catch (e) {
    if (String(e.message || '').includes('already exists') || e.status === 400) {
      result.status = 'pending';
      result.message = '账户已存在，需重置密码或激活';
      return result;
    }
    result.status = 'error';
    result.message = e.message;
    return result;
  }
}

async function createDevice({ name, type = 'default', customerId, token }) {
  const t = token || (await adminToken());
  const cfg = getConfig('tb');
  const payload = { name, type: cfg.device_profile || type, label: name };
  const device = await request('POST', '/api/device', payload, t);
  const deviceId = device.id?.id;
  if (customerId) {
    await request('POST', `/api/customer/${customerId}/device/${deviceId}`, null, t).catch(() => {});
  }
  const cred = await request('GET', `/api/device/${deviceId}/credentials`, null, t).catch(() => null);
  return { deviceId, token: cred?.credentialsId || cred?.credentialsType ? cred.credentialsId : '' , raw: device };
}

async function listDevices(token) {
  const t = token || (await adminToken());
  const data = await request('GET', '/api/devices?pageSize=100&page=0', null, t);
  return data?.data || [];
}

module.exports = {
  adminToken, login, provisionUser, createDevice, listDevices,
  request, raw, userJwt, dropUserJwt, jwtExp,
};

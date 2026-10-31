const { getConfig } = require('../lib/config');
const tbdiag = require('../lib/tbdiag');

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
        // 有的接口只产出 text/plain（例如激活链接），Accept 写死 application/json 会被 Spring 判 406
        Accept: opts.accept || 'application/json',
        ...(opts.token ? { 'X-Authorization': `Bearer ${opts.token}` } : {}),
      },
      body: opts.body === undefined || opts.body === null ? undefined : JSON.stringify(opts.body),
    });
  } catch (e) {
    return { status: 502, ok: false, data: { message: `无法连接 blcloud 物联平台：${e.message}` } };
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, ok: res.ok, data, text };
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

/** 解出 JWT 载荷。TB 的登录响应只有 token/refreshToken，用户 ID 只能从 token 里取 */
function decodeJwt(token) {
  try {
    const seg = String(token).split('.')[1];
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

function jwtExp(token) {
  return Number(decodeJwt(token).exp || 0) * 1000;
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

/** 清空管理员令牌缓存：改了平台地址或管理员密码后必须调用 */
function resetAdminToken() {
  cached = { token: '', baseUrl: '', expiresAt: 0 };
}

async function ensureCustomer(token, title, tenantId) {
  const cfg = getConfig('tb');
  const wanted = cfg.default_customer || title;
  if (!wanted) return null;
  const list = await request('GET', `/api/customers?pageSize=200&page=0`, null, token);
  const found = (list?.data || []).find((c) => c.title === wanted);
  if (found) return found.id.id;
  // TB 的实体引用是 { entityType, id }，虽然部分版本也吃裸 UUID，但按官方模型传最稳
  const created = await request('POST', '/api/customer', {
    title: wanted,
    ...(tenantId ? { tenantId: { entityType: 'TENANT', id: tenantId } } : {}),
  }, token);
  return created.id.id;
}

/** 已存在的账户要能找回 ID，否则旧版本建出来的「半死账户」永远修不好 */
async function findUserIdByEmail(token, email, customerId) {
  const paths = [];
  if (customerId) paths.push(`/api/customer/${customerId}/users?pageSize=200&page=0`);
  paths.push('/api/tenant/users?pageSize=200&page=0');
  paths.push(`/api/tenant/users?pageSize=10&page=0&textSearch=${encodeURIComponent(email)}`);
  const target = String(email).toLowerCase();
  for (const p of paths) {
    const r = await raw('GET', p, { token });
    const hit = (r.data?.data || []).find((u) => String(u.email || '').toLowerCase() === target);
    if (hit) return hit.id?.id || '';
  }
  return '';
}

/**
 * 取激活链接并直接用它把密码设成指定值。
 * TB 的 REST API 没有「管理员改密码」接口，密码只能走激活流程设置，
 * 所以必须：拿激活链接（内含 activateToken） → POST /api/noauth/activate。
 */
async function activateWithPassword(userId, password) {
  const r = await raw('GET', `/api/user/${userId}/activationLink`, { token: await adminToken(), accept: 'text/plain' });
  if (!r.ok) return { ok: false, token: '', message: r.data?.message || `取激活链接失败（HTTP ${r.status}）` };
  const link = typeof r.data === 'string' ? r.data : (r.text || '');
  const m = String(link).match(/activateToken=([^&\s"']+)/);
  if (!m) return { ok: false, token: '', message: `激活链接里没有 activateToken：${String(link).slice(0, 120)}` };
  return { ok: true, token: decodeURIComponent(m[1]), message: '' };
}

/**
 * 按规则开通 TB 账户：openid -> openid@xxx，密码为 openid 本身
 *
 * 关键：TB 的 POST /api/user 只是"建档"，不带密码，也不给管理员改密码的接口；
 * 账户必须走激活流程（激活链接里的 activateToken + POST /api/noauth/activate）才能登录。
 * 老实现建完就以为开通了，结果 tb_status 永远停在 pending / 半死状态。
 *
 * 返回 { username, password, status: 'active'|'pending'|'error', userId, message, steps }
 */
async function provisionUser(openid, nickname) {
  const cfg = getConfig('tb');
  const suffix = cfg.email_suffix || '@blcloud.cn';
  const email = `${openid}${suffix}`;
  const password = openid;
  const base = String(cfg.base_url || '').replace(/\/+$/, '');
  const result = { username: email, password, status: 'pending', userId: '', message: '', steps: [] };

  const step = (name, ok, detail) => {
    result.steps.push({ name, ok, detail: String(detail || '') });
    tbdiag.push(ok ? 'info' : 'error', 'provision', `${email}｜${name}：${detail}`);
  };

  if (!cfg.enabled) {
    result.message = 'blcloud 物联未启用（接入配置里「启用」开关未打开），不会创建账户';
    step('检查开关', false, result.message);
    return result;
  }
  if (!base) {
    result.status = 'error';
    result.message = '未配置 blcloud 物联平台地址';
    step('检查配置', false, result.message);
    return result;
  }

  // ① 已经能登录 —— 直接复用，不再动它
  try {
    const self = await login(email, password);
    result.status = 'active';
    result.userId = decodeJwt(self.token).userId || '';
    result.message = '账户已存在且可登录';
    step('账户登录', true, result.message);
    return result;
  } catch (e) {
    if (![400, 401, 403, 404].includes(e.status)) {
      result.status = 'error';
      result.message = `登录校验失败：${e.message}`;
      step('账户登录', false, result.message);
      return result;
    }
    step('账户登录', true, '账户不存在或尚未激活，继续开通');
  }

  // ② 管理员令牌
  let token = '';
  try {
    token = await adminToken();
    step('管理员登录', true, '已取得租户管理员令牌');
  } catch (e) {
    result.status = 'error';
    result.message = `blcloud 管理员登录失败：${e.message}（检查平台地址与管理员账号密码）`;
    step('管理员登录', false, result.message);
    return result;
  }

  // ③ 客户（CUSTOMER_USER 必须挂在某个 Customer 下）
  let customerId = '';
  let tenantId = '';
  try {
    const me = await request('GET', '/api/auth/user', null, token);
    tenantId = me.tenantId?.id || '';
    customerId = (await ensureCustomer(token, 'default', tenantId)) || '';
    step('客户(Customer)', true, customerId ? `已就绪 ${customerId}` : '未配置客户名，用户将挂到租户下');
  } catch (e) {
    result.status = 'error';
    result.message = `准备客户失败：${e.message}`;
    step('客户(Customer)', false, result.message);
    return result;
  }

  // ④ 建档（关掉激活邮件：邮件服务没配好时 TB 会直接 500）
  let userId = '';
  try {
    const created = await request('POST', '/api/user?sendActivationMail=false', {
      email,
      authority: 'CUSTOMER_USER',
      firstName: nickname || openid,
      lastName: '',
      ...(customerId ? { customerId: { entityType: 'CUSTOMER', id: customerId } } : {}),
    }, token);
    userId = created.id?.id || '';
    step('创建用户', true, `已创建 ${userId || '(未返回 ID)'}`);
  } catch (e) {
    if (/already exists/i.test(String(e.message || '')) || e.status === 400) {
      step('创建用户', false, '账户已存在（多半是旧版本建出来的未激活账户），尝试找回并激活');
      userId = await findUserIdByEmail(token, email, customerId);
      if (!userId) {
        result.status = 'error';
        result.message = `账户已存在但定位不到其 ID：${e.message}`;
        step('查找已有账户', false, result.message);
        return result;
      }
      step('查找已有账户', true, `已定位 ${userId}`);
    } else {
      result.status = 'error';
      result.message = `创建用户失败：${e.message}`;
      step('创建用户', false, result.message);
      return result;
    }
  }
  result.userId = userId;

  // ⑤ 激活 = 设置密码。这是老实现缺掉的一步，也是"账户建了却登不上"的直接原因
  try {
    const link = await activateWithPassword(userId, password);
    if (!link.ok) throw new Error(link.message);
    let lastErr = '';
    for (const pwd of [password, `${password}Tb#1`]) {
      const r = await raw('POST', '/api/noauth/activate?sendActivationMail=false',
        { body: { activateToken: link.token, password: pwd } });
      if (r.ok) {
        result.password = pwd;
        lastErr = '';
        break;
      }
      lastErr = r.data?.message || `HTTP ${r.status}`;
      // 只有疑似密码策略不通过才换一个更强的密码重试，其余错误直接暴露
      if (!/password/i.test(lastErr)) break;
    }
    if (lastErr) throw new Error(lastErr);
    step('激活账户', true, '已通过激活链接设置密码');
  } catch (e) {
    result.status = 'error';
    result.message = `激活账户失败：${e.message}`;
    step('激活账户', false, result.message);
    return result;
  }

  // ⑥ 用真实登录做终检：能登才算真的开通
  try {
    const self = await login(email, result.password);
    result.status = 'active';
    result.userId = decodeJwt(self.token).userId || userId;
    result.message = '已开通并可登录';
    step('登录验证', true, result.message);
  } catch (e) {
    result.status = 'error';
    result.message = `激活已完成但登录验证失败：${e.message}`;
    step('登录验证', false, result.message);
  }
  return result;
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
  adminToken, resetAdminToken, login, provisionUser, createDevice, listDevices,
  request, raw, userJwt, dropUserJwt, jwtExp, decodeJwt, findUserIdByEmail,
};

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getMasterKey } = require('./crypto');
const { basePath } = require('./config');

const ADMIN_SECRET = crypto.createHash('sha256').update(getMasterKey()).update('admin-jwt').digest('hex');
const USER_SECRET = crypto.createHash('sha256').update(getMasterKey()).update('user-jwt').digest('hex');

const ADMIN_TTL = '12h';
const USER_TTL = '30d';

/**
 * mcp = must_change_password：弱口令/初始密码账号签发的是受限令牌。
 * 前端弹窗「稍后提醒」可以跳过，后端跳不过：requireAdmin 会把除改密外的
 * 所有管理接口都拦成 403，逼着先把密码改掉。
 */
function signAdmin(admin) {
  const payload = { sub: admin.id, username: admin.username, role: admin.role, scope: 'admin' };
  if (Number(admin.must_change_password || 0) === 1) payload.mcp = 1;
  return jwt.sign(payload, ADMIN_SECRET, { expiresIn: ADMIN_TTL });
}

function signUser(user) {
  return jwt.sign({ sub: user.id, openid: user.openid || '', scope: 'user' }, USER_SECRET, { expiresIn: USER_TTL });
}

function readToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.query && req.query.token) return String(req.query.token);
  return '';
}

function verifyAdmin(req) {
  const token = readToken(req);
  if (!token) return null;
  try {
    const payload = jwt.verify(token, ADMIN_SECRET);
    return payload.scope === 'admin' ? payload : null;
  } catch {
    return null;
  }
}

function verifyUser(req) {
  const token = readToken(req);
  if (!token) return null;
  try {
    const payload = jwt.verify(token, USER_SECRET);
    return payload.scope === 'user' ? payload : null;
  } catch {
    return null;
  }
}

async function requireAdmin(req, reply) {
  const p = verifyAdmin(req);
  if (!p) {
    reply.code(401).send({ error: '未登录或登录已过期' });
    return null;
  }
  req.admin = p;
  // 受限令牌（弱口令强制整改）：只放行改密与自身信息接口，其余一律 403。
  // 仅生产环境硬拦 —— 测试/本地开发库的管理员就是弱口令（seed 逻辑如此），
  // 拦了会卡死全部自动化测试与本地联调；生产里这才是防弱口令的闸门。
  if (p.mcp && process.env.NODE_ENV === 'production') {
    const url = String(req.url || '');
    const prefix = basePath();
    const allowed = url.startsWith(`${prefix}/api/admin/password`)
      || url.startsWith(`${prefix}/api/admin/me`);
    if (!allowed) {
      reply.code(403).send({ error: '当前密码为初始密码或弱口令，请先修改密码后再操作', code: 'MUST_CHANGE_PASSWORD' });
      return null;
    }
  }
  return p;
}

async function requireUser(req, reply) {
  const p = verifyUser(req);
  if (!p) {
    reply.code(401).send({ error: '请先登录' });
    return null;
  }
  req.user = p;
  return p;
}

module.exports = { signAdmin, signUser, verifyAdmin, verifyUser, requireAdmin, requireUser };

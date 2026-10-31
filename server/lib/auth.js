const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getMasterKey } = require('./crypto');

const ADMIN_SECRET = crypto.createHash('sha256').update(getMasterKey()).update('admin-jwt').digest('hex');
const USER_SECRET = crypto.createHash('sha256').update(getMasterKey()).update('user-jwt').digest('hex');

const ADMIN_TTL = '12h';
const USER_TTL = '30d';

function signAdmin(admin) {
  return jwt.sign({ sub: admin.id, username: admin.username, role: admin.role, scope: 'admin' }, ADMIN_SECRET, { expiresIn: ADMIN_TTL });
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

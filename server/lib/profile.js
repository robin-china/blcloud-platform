/**
 * 用户资料（昵称 / 头像）的统一校验与写入。
 *
 * 网页端「账户中心」和软件端 /user/profile 都要改资料，规则必须一致：
 * 改过之后置 profile_custom=1，微信下次登录不再把用户自己设的名字覆盖回去。
 * 注意：对外 user 对象绝不能带 tb_username / tb_password（内部打通凭据），
 * 这里用 publicUser 白名单输出，别直接把 SELECT * 的结果丢给客户端。
 */
const db = require('../db');

const MAX_NICKNAME = 24;
const MAX_AVATAR = 500;

function cleanText(s, max) {
  let t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const chars = [...t]; // 按码点计数，避免 emoji 被算成两个字符
  if (chars.length > max) t = chars.slice(0, max).join('');
  return t;
}

function safeAvatar(a) {
  const v = String(a == null ? '' : a).trim();
  if (!v) return { ok: true, value: '' };
  if (v.length > MAX_AVATAR) return { ok: false, error: '头像地址过长（最多 500 字符）' };
  if (/javascript:|vbscript:|["'<>`]/i.test(v)) return { ok: false, error: '头像地址包含非法字符' };
  const ok = /^https?:\/\//i.test(v) || /^\/(?!\/)/.test(v)
    || /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v);
  if (!ok) return { ok: false, error: '头像只支持 http(s) 链接、站内路径或图片 data URL' };
  return { ok: true, value: v };
}

/** 校验一份待更新的资料，返回可直接写库的字段 */
function normalize(input) {
  const b = input || {};
  const errors = [];
  const value = {};
  if (b.nickname !== undefined) {
    const n = cleanText(b.nickname, MAX_NICKNAME);
    if (!n) errors.push('昵称不能为空');
    value.nickname = n;
  }
  if (b.avatar !== undefined) {
    const a = safeAvatar(b.avatar);
    if (!a.ok) errors.push(a.error);
    else value.avatar = a.value;
  }
  if (!Object.keys(value).length) errors.push('没有需要更新的资料');
  return { ok: errors.length === 0, errors, value };
}

/** 对用户端 / 软件端安全的字段白名单 */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    openid: u.openid,
    nickname: u.nickname,
    avatar: u.avatar,
    phone: u.phone || '',
    points: u.points || 0,
    balance: u.balance || 0,
    tb_status: u.tb_status || 'none',
    profile_custom: Number(u.profile_custom || 0),
    created_at: u.created_at,
  };
}

/** 用户自行修改：置 profile_custom=1，之后微信登录不再覆盖 */
function updateByUser(userId, input) {
  const r = normalize(input);
  if (!r.ok) return r;
  const sets = [];
  const args = [];
  for (const k of ['nickname', 'avatar']) {
    if (r.value[k] !== undefined) { sets.push(`${k} = ?`); args.push(r.value[k]); }
  }
  sets.push('profile_custom = 1');
  args.push(Number(userId));
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return { ok: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId))) };
}

/**
 * 微信登录时同步昵称/头像。
 * 三条硬规则：
 *  - 用户手动改过（profile_custom=1）就完全不动；
 *  - 微信没返回的值不清空已有资料（服务号未关注时 getUserInfo 常返回空）；
 *  - 值不合法（脏 URL）宁可不同步，也不能写进库。
 */
function syncFromWechat(user, profile = {}) {
  if (!user || Number(user.profile_custom || 0) === 1) return false;
  const sets = [];
  const args = [];
  const nn = cleanText(profile.nickname, MAX_NICKNAME);
  const av = safeAvatar(profile.avatar);
  if (nn && nn !== user.nickname) { sets.push('nickname = ?'); args.push(nn); }
  if (av.ok && av.value && av.value !== user.avatar) { sets.push('avatar = ?'); args.push(av.value); }
  if (!sets.length) return false;
  args.push(Number(user.id));
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return true;
}

module.exports = { normalize, publicUser, updateByUser, syncFromWechat, cleanText, safeAvatar };

/**
 * 用户资料（昵称 / 头像）的统一校验与写入。
 *
 * 网页端「账户中心」和软件端 /user/profile 都要改资料，规则必须一致：
 * 改过之后置 profile_custom=1，微信下次登录不再把用户自己设的名字覆盖回去。
 * 注意：对外 user 对象绝不能带 tb_username / tb_password（内部打通凭据），
 * 这里用 publicUser 白名单输出，别直接把 SELECT * 的结果丢给客户端。
 *
 * 头像：库里存 `preset:01` 短标识（内置卡通头像）或自定义链接；
 * publicUser 把标识展开成 data URI 再对外，软件端离线也能显示。
 * 微信没给头像时按 openid 稳定分配一张内置头像。
 */
const db = require('../db');
const avatars = require('./avatars');

const MAX_NICKNAME = 24;
// 内置头像只存 10 字符的 preset 标识；放宽上限是为了让「自定义图片 data URL」也能用
const MAX_AVATAR = 4000;

function cleanText(s, max) {
  let t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const chars = [...t]; // 按码点计数，避免 emoji 被算成两个字符
  if (chars.length > max) t = chars.slice(0, max).join('');
  return t;
}

function safeAvatar(a) {
  const v = String(a == null ? '' : a).trim();
  if (!v) return { ok: true, value: '' };
  if (v.length > MAX_AVATAR) return { ok: false, error: `头像地址过长（最多 ${MAX_AVATAR} 字符）` };
  if (/javascript:|vbscript:|["'<>`]/i.test(v)) return { ok: false, error: '头像地址包含非法字符' };
  // 内置卡通头像：库里只存短标识，必须命中预设表，防止任意 preset:XX 写进来
  if (/^preset:/i.test(v)) {
    return avatars.isPreset(v)
      ? { ok: true, value: v }
      : { ok: false, error: '内置头像不存在，请从列表中选择' };
  }
  const ok = /^https?:\/\//i.test(v) || /^\/(?!\/)/.test(v)
    || /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(v);
  if (!ok) return { ok: false, error: '头像只支持内置头像、http(s) 链接、站内路径或图片 data URL' };
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
    // 预设头像展开成 data URI，软件端 / 网页端拿到即可直接渲染，无需再取图
    avatar: avatars.toDisplay(u.avatar),
    // 原值回传给账户中心，用来高亮当前选中的内置头像（自定义链接时为空）
    avatar_preset: avatars.isPreset(u.avatar) ? u.avatar : '',
    phone: u.phone || '',
    points: u.points || 0,
    balance: u.balance || 0,
    tb_status: u.tb_status || 'none',
    // 用户端顶栏据此显隐「我的收益」等代理商功能；非代理商一律不下发
    agent_status: u.agent_status || '',
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
  const wxAvatar = av.ok && av.value && av.value !== user.avatar ? av.value : '';
  if (nn && nn !== user.nickname) { sets.push('nickname = ?'); args.push(nn); }
  if (wxAvatar) { sets.push('avatar = ?'); args.push(wxAvatar); }
  // 微信没返回头像（服务号未关注时很常见）且用户目前也没有头像：
  // 分配一张内置卡通头像，别让前台一直挂字母占位。按 openid 稳定，重登不会乱跳。
  if (!wxAvatar && !String(user.avatar || '').trim()) {
    sets.push('avatar = ?');
    args.push(avatars.defaultValue(user.openid || user.id));
  }
  if (!sets.length) return false;
  args.push(Number(user.id));
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return true;
}

module.exports = {
  normalize, publicUser, updateByUser, syncFromWechat, cleanText, safeAvatar,
  defaultAvatar: avatars.defaultValue,
};

const crypto = require('crypto');
const db = require('../db');
const { now } = require('./util');

/**
 * 一次性登录票据（handoff ticket）。
 *
 * 用途：把「某个已经是登录态的渠道」换成网页登录态，而不把真令牌塞进 URL。
 * 目前两个来源：
 *   - 软件端「用户中心」跳转（/api/open/v1/auth/handoff，需要客户端签名）
 *   - 微信公众号网页授权回调（/api/wechat/oauth/callback，微信内免扫码）
 * 兑换入口统一是 POST /api/portal/handoff。
 *
 * 规则：
 *   - 只能换一次（used 置 1）；
 *   - 默认 5 分钟过期；
 *   - 同一用户只保留最近一张有效票，旧票在被点开前就作废，
 *     免得用户在软件里点了三次「用户中心」，三个链接都能进。
 */
const PAGES = new Set(['account', 'licenses', 'devices', 'orders', 'space', 'earnings', 'shop', 'blcloud']);

function issue(userId, opts = {}) {
  const ttlMs = Number(opts.ttlMs) || 5 * 60 * 1000;
  db.prepare('DELETE FROM handoff_tickets WHERE user_id = ? AND used = 0').run(userId);
  const code = 'ho_' + crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO handoff_tickets (code, user_id, app_id, machine_id, used, expires_at, created_at) VALUES (?,?,?,?,0,?,?)')
    .run(code, userId, opts.appId || null, String(opts.machineId || ''), new Date(Date.now() + ttlMs).toISOString(), now());
  return code;
}

/** `to` 只接受白名单页面名，避免被当成任意跳转（开放重定向） */
function page(raw, fallback = 'account') {
  const v = String(raw || '').trim();
  return PAGES.has(v) ? v : fallback;
}

module.exports = { issue, page, PAGES };

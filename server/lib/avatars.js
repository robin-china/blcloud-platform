/**
 * 服务端头像封装。唯一来源是 public/assets/avatars.js（UMD，前端 <script> 加载同一份）。
 *
 * 库里存短标识 `preset:01`，对外接口一律展开成 data:image/svg+xml;base64,...：
 * 网页端直接 <img src>，软件端拿到就能显示（离线也一样），不必再回源取图。
 * 用户自定义的 http(s) / 站内路径 / 图片 data URI 原样透传。
 */
const presets = require('../../public/assets/avatars.js');

const PRESET_RE = /^preset:(\d{2})$/;

function isPreset(v) {
  const s = String(v == null ? '' : v);
  return PRESET_RE.test(s) && !!presets.byValue(s);
}

/** 对外展示值；非预设（含空值、自定义链接）原样返回 */
function toDisplay(v) {
  const s = String(v == null ? '' : v);
  const p = presets.byValue(s);
  return p ? p.dataUri : s;
}

/** 微信没给头像时，按 openid 稳定分配一张内置卡通头像 */
function defaultValue(seed) {
  return presets.defaultValue(seed);
}

module.exports = { PRESETS: presets.PRESETS, PRESET_RE, isPreset, toDisplay, defaultValue };

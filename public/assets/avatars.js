/* 内置卡通头像：网页端与服务端共用同一份定义（UMD，既能 <script src> 也能 require）。
 *
 * 数据库里只存短标识 `preset:01`，对外接口把标识展开成 data URI，
 * 软件端拿到就能直接 <img src>，离线也能显示，不需要再回服务器取图。
 * 改动这份文件时前后端自动同步，不要另建一份 SVG 清单。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AvatarPresets = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SKIN = '#FFD9B8';

  // 每个变体只改背景、发色和发型；脸/五官共用一套，风格统一。
  function face(o) {
    var hair = o.hair;
    var back = '';
    var front = '';
    if (o.style === 'cap') {
      front = '<path d="M21 42 Q48 6 75 42 Z" fill="' + hair + '"/>'
        + '<path d="M18 41 Q48 33 78 41 L78 47 Q48 39 18 47 Z" fill="#1E293B" opacity=".65"/>';
    } else if (o.style === 'buns') {
      back = '<circle cx="21" cy="34" r="12" fill="' + hair + '"/>'
        + '<circle cx="75" cy="34" r="12" fill="' + hair + '"/>';
      front = '<path d="M22 44 Q24 18 48 18 Q72 18 74 44 Q61 31 48 31 Q35 31 22 44 Z" fill="' + hair + '"/>';
    } else if (o.style === 'bob') {
      back = '<path d="M18 38 Q18 12 48 12 Q78 12 78 38 L78 66 Q70 54 70 40 L26 40 Q26 54 18 66 Z" fill="' + hair + '"/>';
      front = '<path d="M22 42 Q26 26 48 26 Q70 26 74 42 Q61 32 48 32 Q35 32 22 42 Z" fill="' + hair + '"/>';
    } else if (o.style === 'curl') {
      back = '<circle cx="29" cy="27" r="12" fill="' + hair + '"/>'
        + '<circle cx="48" cy="21" r="13" fill="' + hair + '"/>'
        + '<circle cx="67" cy="27" r="12" fill="' + hair + '"/>';
      front = '<path d="M22 43 Q23 27 48 27 Q73 27 74 43 Q61 33 48 33 Q35 33 22 43 Z" fill="' + hair + '"/>';
    } else if (o.style === 'spiky') {
      front = '<path d="M19 43 L27 18 L36 32 L48 12 L60 32 L69 18 L77 43 Q48 30 19 43 Z" fill="' + hair + '"/>';
    } else { // short / glasses 共用短发
      front = '<path d="M22 43 Q22 17 48 17 Q74 17 74 43 Q61 29 48 29 Q35 29 22 43 Z" fill="' + hair + '"/>';
    }
    var glasses = o.style === 'glasses'
      ? '<g fill="none" stroke="' + hair + '" stroke-width="3" stroke-linecap="round">'
        + '<circle cx="38" cy="53" r="8"/><circle cx="58" cy="53" r="8"/><path d="M46 53 H50"/></g>'
      : '';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">'
      + '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
      + '<stop offset="0" stop-color="' + o.bg1 + '"/><stop offset="1" stop-color="' + o.bg2 + '"/>'
      + '</linearGradient></defs>'
      + '<rect width="96" height="96" rx="48" fill="url(#bg)"/>'
      + back
      + '<ellipse cx="48" cy="54" rx="25" ry="27" fill="' + SKIN + '"/>'
      + front
      + '<ellipse cx="30" cy="61" rx="5" ry="3" fill="#F87171" opacity=".45"/>'
      + '<ellipse cx="66" cy="61" rx="5" ry="3" fill="#F87171" opacity=".45"/>'
      + '<circle cx="38" cy="53" r="3.1" fill="#1F2937"/>'
      + '<circle cx="58" cy="53" r="3.1" fill="#1F2937"/>'
      + '<path d="M41 66 Q48 72 55 66" fill="none" stroke="#B45309" stroke-width="2.6" stroke-linecap="round"/>'
      + glasses
      + '</svg>';
  }

  var DEFS = [
    { id: '01', name: '蓝帽少年', bg1: '#DBEAFE', bg2: '#93C5FD', hair: '#2563EB', style: 'cap' },
    { id: '02', name: '樱花妹妹', bg1: '#FCE7F3', bg2: '#F9A8D4', hair: '#BE185D', style: 'bob' },
    { id: '03', name: '薄荷同学', bg1: '#D1FAE5', bg2: '#6EE7B7', hair: '#047857', style: 'short' },
    { id: '04', name: '暖橙卷卷', bg1: '#FEF3C7', bg2: '#FCD34D', hair: '#B45309', style: 'curl' },
    { id: '05', name: '紫薯双丸', bg1: '#EDE9FE', bg2: '#C4B5FD', hair: '#6D28D9', style: 'buns' },
    { id: '06', name: '眼镜仔', bg1: '#E0F2FE', bg2: '#7DD3FC', hair: '#334155', style: 'glasses' },
    { id: '07', name: '珊瑚刺头', bg1: '#FFE4E6', bg2: '#FDA4AF', hair: '#E11D48', style: 'spiky' },
    { id: '08', name: '青柠短发', bg1: '#ECFCCB', bg2: '#BEF264', hair: '#3F6212', style: 'short' },
  ];

  function toDataUri(svg) {
    var s = String(svg).replace(/\s+/g, ' ').trim();
    if (typeof Buffer !== 'undefined') {
      return 'data:image/svg+xml;base64,' + Buffer.from(s, 'utf8').toString('base64');
    }
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(s)));
  }

  var PRESETS = DEFS.map(function (d) {
    var svg = face(d);
    return { id: d.id, name: d.name, value: 'preset:' + d.id, svg: svg, dataUri: toDataUri(svg) };
  });
  var BY_VALUE = {};
  PRESETS.forEach(function (p) { BY_VALUE[p.value] = p; });

  // 同一 openid 每次都落到同一张，避免用户重登后头像乱跳
  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h;
  }
  function defaultId(seed) { return PRESETS[hash(String(seed || '')) % PRESETS.length].id; }
  function defaultValue(seed) { return 'preset:' + defaultId(seed); }

  return {
    PRESETS: PRESETS,
    byValue: function (v) { return BY_VALUE[String(v || '')] || null; },
    defaultId: defaultId,
    defaultValue: defaultValue,
    toDataUri: toDataUri,
  };
});

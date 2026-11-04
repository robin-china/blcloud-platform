(function () {
  const TOKEN_KEY = 'admin_token';
  const USER_TOKEN_KEY = 'user_token';

  /**
   * 部署基础路径，由页面 URL 自动推断，无需配置。
   *   /admin/             → ''            （根路径部署）
   *   /platform/admin/    → '/platform'   （子路径部署）
   * 后端通过 BASE_PATH 环境变量保持一致。
   */
  function basePath() {
    const m = location.pathname.match(/^(.*?)\/(admin|user)(\/|$)/);
    return m ? m[1] : '';
  }
  const BASE = basePath();
  const abs = (url) => (/^\//.test(url) ? BASE + url : url);

  function tokenKey(scope) {
    return scope === 'user' ? USER_TOKEN_KEY : TOKEN_KEY;
  }

  function getToken(scope) {
    return localStorage.getItem(tokenKey(scope)) || '';
  }

  function setToken(scope, v) {
    if (v) localStorage.setItem(tokenKey(scope), v);
    else localStorage.removeItem(tokenKey(scope));
  }

  async function request(scope, method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    const t = getToken(scope);
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(abs(url), { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (res.status === 401) {
      setToken(scope, '');
      if (scope === 'admin' && location.hash !== '#/login') location.hash = '#/login';
      if (scope === 'user' && location.hash !== '#/login') location.hash = '#/login';
    }
    if (!res.ok) {
      const err = new Error(data?.error || data?.message || `请求失败 ${res.status}`);
      err.data = data;
      throw err;
    }
    return data;
  }

  const api = {
    scope: 'admin',
    get(url) { return request(this.scope, 'GET', url); },
    post(url, body) { return request(this.scope, 'POST', url, body ?? {}); },
    del(url) { return request(this.scope, 'DELETE', url); },
    getToken, setToken,
  };

  function toast(msg, type = '') {
    const wrap = document.querySelector('.toast-wrap') || (() => {
      const d = document.createElement('div');
      d.className = 'toast-wrap';
      document.body.appendChild(d);
      return d;
    })();
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  /**
   * 自绘确认框，替代原生 window.confirm。
   *
   * 原生 confirm 在部分环境里是**静默失效**的：WorkBuddy 预览面板、IDE 内置浏览器、
   * 某些企业策略下的 iframe 会直接把 confirm 判定为 false 且不弹任何框。
   * 表现就是「点了删除完全没反应」——既没对话框，也没报错，用户以为删不掉。
   * 所以这里用 DOM 自己画，行为可控，还能带标题/按钮文案。
   *
   * 用法：`if (!(await U.confirm('确定删除？'))) return;`
   */
  function confirmBox(message, opts) {
    const o = typeof opts === 'string' ? { title: opts } : (opts || {});
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'mask ui-confirm';
      // toast-wrap 是 100，普通 mask 是 50；确认框必须盖在抽屉/弹窗之上
      mask.style.zIndex = '200';

      const modal = document.createElement('div');
      modal.className = 'modal';
      modal.style.maxWidth = '420px';

      const head = document.createElement('div');
      head.className = 'modal-head';
      const h3 = document.createElement('h3');
      h3.textContent = o.title || '确认操作';
      head.appendChild(h3);

      const body = document.createElement('div');
      body.className = 'modal-body';
      const text = document.createElement('div');
      text.style.cssText = 'font-size:14px;line-height:1.75;color:var(--text-1);white-space:pre-wrap;word-break:break-word';
      text.textContent = String(message == null ? '' : message);
      body.appendChild(text);

      const foot = document.createElement('div');
      foot.className = 'modal-foot';
      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.textContent = o.cancelText || '取消';
      const ok = document.createElement('button');
      ok.className = 'btn ' + (o.danger === false ? 'primary' : 'danger');
      ok.textContent = o.okText || '确定';
      foot.append(cancel, ok);

      modal.append(head, body, foot);
      mask.appendChild(modal);
      document.body.appendChild(mask);

      let settled = false;
      const done = (val) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey);
        mask.remove();
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        else if (e.key === 'Enter') { e.preventDefault(); done(true); }
      };
      cancel.onclick = () => done(false);
      ok.onclick = () => done(true);
      mask.onclick = (e) => { if (e.target === mask) done(false); };
      document.addEventListener('keydown', onKey);
      setTimeout(() => { try { ok.focus(); } catch { /* 忽略 */ } }, 0);
    });
  }

  /** 统一的失败提示：删除/提交类操作失败时必须让人看见原因，不能静默 */
  function failMsg(e, fallback = '操作失败') {
    const m = (e && (e.message || e.error)) || fallback;
    return /请求失败 401/.test(m) ? '登录已过期，请重新登录' : m;
  }

  const fmt = {
    money(n) {
      const v = Number(n) || 0;
      return `¥${v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
    },
    int(n) {
      return (Number(n) || 0).toLocaleString('zh-CN');
    },
    date(s) {
      if (!s) return '-';
      return String(s).slice(0, 10);
    },
    time(s) {
      if (!s) return '-';
      return String(s).replace('T', ' ').slice(0, 16);
    },
    ago(s) {
      if (!s) return '-';
      const diff = Math.floor((Date.now() - new Date(s).getTime()) / 1000);
      if (diff < 60) return `${diff} 秒前`;
      if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
      if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
      return `${Math.floor(diff / 86400)} 天前`;
    },
  };

  function lineChart(rows, opts = {}) {
    const w = opts.width || 640;
    const h = opts.height || 200;
    const pad = { l: 40, r: 12, t: 12, b: 26 };
    const keys = opts.keys || [{ key: 'value', color: '#2563eb', name: '数值' }];
    if (!rows.length) return '<div class="empty">暂无数据</div>';
    const max = Math.max(...rows.flatMap((r) => keys.map((k) => Number(r[k.key]) || 0)), 1);
    const min = Math.min(...rows.flatMap((r) => keys.map((k) => Number(r[k.key]) || 0)), 0);
    const span = max - min || 1;
    const innerW = w - pad.l - pad.r;
    const innerH = h - pad.t - pad.b;
    const x = (i) => pad.l + (rows.length === 1 ? innerW / 2 : (innerW * i) / (rows.length - 1));
    const y = (v) => pad.t + innerH - ((Number(v || 0) - min) / span) * innerH;
    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const gy = pad.t + (innerH * i) / 4;
      const gv = Math.round(max - (span * i) / 4);
      grid += `<line x1="${pad.l}" y1="${gy}" x2="${w - pad.r}" y2="${gy}" stroke="#eef1f6" stroke-width="1"/>
        <text x="${pad.l - 8}" y="${gy + 4}" text-anchor="end" font-size="11" fill="#8a93a6">${gv}</text>`;
    }
    let paths = '';
    for (const k of keys) {
      const d = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(r[k.key])}`).join(' ');
      const area = `${d} L${x(rows.length - 1)},${pad.t + innerH} L${x(0)},${pad.t + innerH} Z`;
      paths += `<path d="${area}" fill="${k.color}" opacity="0.08"/>
        <path d="${d}" fill="none" stroke="${k.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      rows.forEach((r, i) => {
        paths += `<circle cx="${x(i)}" cy="${y(r[k.key])}" r="2.5" fill="#fff" stroke="${k.color}" stroke-width="2"/>`;
      });
    }
    let labels = '';
    const step = Math.max(1, Math.ceil(rows.length / 7));
    rows.forEach((r, i) => {
      if (i % step === 0 || i === rows.length - 1) {
        labels += `<text x="${x(i)}" y="${h - 6}" text-anchor="middle" font-size="11" fill="#8a93a6">${r.label || r.date || ''}</text>`;
      }
    });
    const legend = keys.map((k) => `<span><i style="background:${k.color}"></i>${k.name}</span>`).join('');
    return `<div class="chart"><svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">${grid}${paths}${labels}</svg>
      <div class="legend">${legend}</div></div>`;
  }

  function barChart(rows, opts = {}) {
    const w = opts.width || 640;
    const h = opts.height || 200;
    const pad = { l: 40, r: 12, t: 12, b: 26 };
    if (!rows.length) return '<div class="empty">暂无数据</div>';
    const max = Math.max(...rows.map((r) => Number(r.value) || 0), 1);
    const innerW = w - pad.l - pad.r;
    const innerH = h - pad.t - pad.b;
    const bw = Math.min(28, (innerW / rows.length) * 0.6);
    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const gy = pad.t + (innerH * i) / 4;
      grid += `<line x1="${pad.l}" y1="${gy}" x2="${w - pad.r}" y2="${gy}" stroke="#eef1f6"/>
        <text x="${pad.l - 8}" y="${gy + 4}" text-anchor="end" font-size="11" fill="#8a93a6">${Math.round(max - (max * i) / 4)}</text>`;
    }
    let bars = '';
    rows.forEach((r, i) => {
      const cx = pad.l + (innerW * (i + 0.5)) / rows.length;
      const bh = ((Number(r.value) || 0) / max) * innerH;
      bars += `<rect x="${cx - bw / 2}" y="${pad.t + innerH - bh}" width="${bw}" height="${bh}" rx="4" fill="${opts.color || '#2563eb'}" opacity="0.85"/>`;
      const step = Math.max(1, Math.ceil(rows.length / 8));
      if (i % step === 0) bars += `<text x="${cx}" y="${h - 6}" text-anchor="middle" font-size="11" fill="#8a93a6">${r.label || r.date || ''}</text>`;
    });
    return `<div class="chart"><svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">${grid}${bars}</svg></div>`;
  }

  function donut(items, opts = {}) {
    const size = opts.size || 160;
    const total = items.reduce((s, i) => s + (Number(i.value) || 0), 0) || 1;
    const r = size / 2 - 10;
    const c = size / 2;
    let acc = 0;
    let segs = '';
    for (const it of items) {
      const frac = (Number(it.value) || 0) / total;
      if (frac <= 0) continue;
      const a0 = acc * Math.PI * 2 - Math.PI / 2;
      acc += frac;
      const a1 = acc * Math.PI * 2 - Math.PI / 2;
      const large = frac > 0.5 ? 1 : 0;
      const x0 = c + r * Math.cos(a0), y0 = c + r * Math.sin(a0);
      const x1 = c + r * Math.cos(a1), y1 = c + r * Math.sin(a1);
      if (frac >= 0.9999) {
        segs += `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${it.color}" stroke-width="18"/>`;
      } else {
        segs += `<path d="M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1}" fill="none" stroke="${it.color}" stroke-width="18"/>`;
      }
    }
    const legend = items.map((i) => `<span><i style="background:${i.color}"></i>${i.name} ${Math.round(((Number(i.value) || 0) / total) * 100)}%</span>`).join('');
    return `<div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap">
      <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${segs}
        <text x="${c}" y="${c - 2}" text-anchor="middle" font-size="18" font-weight="600" fill="#1b2130">${fmt.int(total)}</text>
        <text x="${c}" y="${c + 16}" text-anchor="middle" font-size="11" fill="#8a93a6">合计</text>
      </svg>
      <div class="legend" style="flex-direction:column;gap:6px">${legend}</div></div>`;
  }

  const ICONS = {
    dashboard: '<path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/>',
    box: '<path d="M12 2l9 5v10l-9 5-9-5V7l9-5zm0 2.3L5.5 8 12 11.7 18.5 8 12 4.3zM5 10.2l6 3.3v6.9l-6-3.3v-6.9zm8 10.2v-6.9l6-3.3v6.9l-6 3.3z"/>',
    store: '<path d="M3 6h18l-1.5 12H4.5L3 6zm3 3l1 9h10l1-9H6zM9 3h6v2H9V3z"/>',
    shield: '<path d="M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5l8-3zm-1 13l7-7-1.4-1.4L11 12.2 7.4 8.6 6 10l5 5z"/>',
    order: '<path d="M6 2h9l5 5v15H6V2zm8 1.8V8h4.2L14 3.8zM8 11h8v2H8v-2zm0 4h8v2H8v-2z"/>',
    chart: '<path d="M4 20V10h3v10H4zm6.5 0V4h3v16h-3zM17 20v-7h3v7h-3z"/>',
    users: '<path d="M16 11a4 4 0 100-8 4 4 0 000 8zM8 13a3 3 0 100-6 3 3 0 000 6zm8 2c-2.7 0-5 1.3-5 3v2h10v-2c0-1.7-2.3-3-5-3zM8 15c-3 0-5 1.3-5 3v2h8v-2c0-1.7-2-3-3-3z"/>',
    settings: '<path d="M12 8a4 4 0 100 8 4 4 0 000-8zm9 4l2 1.5-2 3.4-2.4-.9a7.7 7.7 0 01-1.7 1l-.4 2.5h-4l-.4-2.5a7.7 7.7 0 01-1.7-1l-2.4.9-2-3.4L6 12l-2-1.5 2-3.4 2.4.9a7.7 7.7 0 011.7-1l.4-2.5h4l.4 2.5c.6.2 1.2.6 1.7 1l2.4-.9 2 3.4L21 12z"/>',
    plug: '<path d="M16 3v3h-2V3h-4v3H8V3H6v5c0 1.7 1.3 3 3 3h1v3a5 5 0 0010 0v-3h1c1.7 0 3-1.3 3-3V3h-8zM4 14v2h2v-2H4zm16 0v2h2v-2h-2z"/>',
    admin: '<path d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4 0-8 2-8 5v3h16v-3c0-3-4-5-8-5z"/>',
    api: '<path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>',
    download: '<path d="M12 3v10.6l3.3-3.3 1.4 1.4L12 17.4 7.3 12.7l1.4-1.4L12 13.6V3h0zM5 19h14v2H5z"/>',
    bolt: '<path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/>',
    device: '<path d="M4 6h16v10H4V6zm2 2v6h12V8H6zm-1 12h14v2H5z"/>',
    star: '<path d="M12 2l3 6.9 7 .6-5.3 4.6 1.6 6.9L12 17.3 5.7 21l1.6-6.9L2 9.5l7-.6L12 2z"/>',
    key: '<path d="M14 2a6 6 0 00-5.8 7.5L2 16v4h4v-2h2v-2h2l1.5-1.5A6 6 0 1014 2zm2.5 6a2 2 0 110-4 2 2 0 010 4z"/>',
    cloud: '<path d="M7 18h10a4 4 0 00.4-8A6 6 0 006 10.5 3.75 3.75 0 007 18zm-1 2h12a2 2 0 010 4H6a2 2 0 010-4z"/>',
  };

  function svgIcon(name, fallback = 'dashboard') {
    const d = ICONS[name] || ICONS[fallback] || ICONS.dashboard;
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">${d}</svg>`;
  }

  function applySiteSettings(settings) {
    const s = settings || {};
    if (s.theme_color) document.documentElement.style.setProperty('--brand', s.theme_color);
    if (s.site_name) document.title = s.site_name;
    if (s.site_favicon) {
      let link = document.querySelector('link[rel="icon"]');
      if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
      link.href = s.site_favicon;
    }
  }

  /* 内置卡通头像：库里存的是 preset:01 这类短标识，前端展开成 data URI 再给 <img>。
   * 服务端对外接口也会展开，这里主要兜底扫码登录等直接返回原始值的路径。 */
  function avatar(v) {
    const s = String(v == null ? '' : v);
    if (!/^preset:/.test(s)) return s;
    const p = window.AvatarPresets && window.AvatarPresets.byValue(s);
    return p ? p.dataUri : '';
  }
  function avatarPresets() {
    return (window.AvatarPresets && window.AvatarPresets.PRESETS) || [];
  }

  window.U = {
    api, toast, confirm: confirmBox, failMsg, fmt, lineChart, barChart, donut, applySiteSettings,
    icons: ICONS, svgIcon, avatar, avatarPresets, basePath: BASE,
  };
})();

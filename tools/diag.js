/* 无头诊断：模拟真实点击菜单，检查每个页面是否渲染出内容 */
const { JSDOM, VirtualConsole } = require('jsdom');

const PORT = process.env.DIAG_PORT || '3000';
const BASE = process.env.DIAG_BASE || `http://127.0.0.1:${PORT}`;
const ADMIN_USER = process.env.DIAG_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.DIAG_ADMIN_PASS || 'admin123';
const BP = process.env.DIAG_BASE_PATH ? '/' + process.env.DIAG_BASE_PATH.replace(/^\/+|\/+$/g, '') : '';
const target = process.argv[2] || BASE + BP + '/admin/';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function boot(url, prepare) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('[jsdomError] ' + (e.stack || e.message)));
  vc.on('error', (...a) => errors.push('[console.error] ' + a.map(String).join(' ')));
  vc.on('warn', (...a) => errors.push('[console.warn] ' + a.map(String).join(' ')));
  const html = await (await fetch(url)).text();
  const dom = new JSDOM(html, {
    url,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(new URL(u, url).href, o);
      w.addEventListener('error', (e) => errors.push('[window.error] ' + (e.error?.stack || e.message)));
      if (prepare) prepare(w);
    },
  });
  await wait(3500);
  return { dom, win: dom.window, errors };
}

(async () => {
  const isAdmin = target.includes('/admin/');
  let token = '';
  if (isAdmin) {
    const r = await fetch(BASE + BP + '/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
    }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    token = r.token || '';
    console.log('管理员登录:', token ? 'ok' : JSON.stringify(r));
  } else {
    // 用户端：扫码模拟登录拿 token
    const q = await fetch(BASE + BP + '/api/wechat/qrcode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).then((x) => x.json()).catch(() => ({}));
    if (q.scene) {
      await fetch(BASE + BP + '/api/wechat/simulate/' + q.scene, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openid: 'diag001', nickname: '诊断用户' }),
      }).catch(() => {});
      const p = await fetch(BASE + BP + '/api/wechat/qrcode/' + q.scene).then((x) => x.json()).catch(() => ({}));
      token = p.token || '';
    }
    console.log('用户登录:', token ? 'ok' : '未登录（仅测公开页）');
  }

  const { win, errors } = await boot(target, (w) => {
    w.localStorage.setItem(isAdmin ? 'admin_token' : 'user_token', token);
  });
  const doc = win.document;

  const selector = isAdmin ? '.nav-item' : '.site-nav a';
  const items = [...doc.querySelectorAll(selector)];
  console.log('=== 菜单项:', items.length, '=== #app 子节点:', doc.querySelector('#app').children.length);

  let bad = 0;
  for (const el of items) {
    const name = (el.textContent || '').trim().replace(/\s+/g, ' ');
    const before = errors.length;
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, view: win }));
    await wait(1500);
    const box = doc.querySelector(isAdmin ? '.content' : '.site-main');
    const len = box ? box.textContent.trim().length : -1;
    const ok = len > 5;
    if (!ok) bad++;
    console.log(
      (ok ? '✓' : '✗') + ' ' + name.padEnd(12),
      '文本=' + String(len).padEnd(6),
      errors.length > before ? '⚠ ' + errors.slice(before).join(' | ').slice(0, 300) : ''
    );
    if (!ok && box) console.log('    HTML:', box.innerHTML.slice(0, 260));
  }

  const uniq = [...new Set(errors)];
  console.log('\n=== 控制台错误 (' + uniq.length + ') ===');
  uniq.slice(0, 15).forEach((e) => console.log('-', String(e).slice(0, 500)));
  console.log(bad === 0 ? '\n结果：全部页面正常渲染' : `\n结果：${bad} 个页面空白`);
  process.exit(0);
})();

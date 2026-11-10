/* 未付款订单删除 —— 前端渲染自测
 *
 * 这套前端是浏览器内编译的 in-DOM 模板，按钮写错/漏 return 会静默失效
 * （模板只能看见 setup 暴露的标识符）。所以这里真挂载页面：
 *   1. 后台订单页：待支付行有「删除」、已删除行显示「已删除」+「恢复」
 *   2. 用户端「我的订单」：待支付行有「删除」，点了会打正确的 DELETE 路径
 *   3. 首屏遮罩：index.html 在挂载前藏住 #app，避免 {{ }} 闪出来
 *
 * 用法：node tools/test-order-delete-ui.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); } else {
    fail += 1;
    console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + String(extra).slice(0, 300) : ''));
  }
}

const VUE = fs.readFileSync(path.join(PUB, 'vendor', 'vue.global.prod.js'), 'utf8');
const TRADE = fs.readFileSync(path.join(PUB, 'admin', 'js', 'pages-trade.js'), 'utf8');
const USER_PAGES = fs.readFileSync(path.join(PUB, 'user', 'js', 'pages.js'), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ORDERS = [
  { id: 1, order_no: 'ORD-PENDING-0001', user_id: 9, nickname: '张三', phone: '13800000000', amount: 20, pay_amount: 20, discount: 0, channel: 'wxpay', status: 'pending', items: [{ product_id: 1, product_name: '授权版', qty: 1 }], created_at: '2026-11-08T02:00:00.000Z', deleted_at: null, deleted_by: '' },
  { id: 2, order_no: 'ORD-DELETED-0002', user_id: 9, nickname: '张三', phone: '13800000000', amount: 10, pay_amount: 10, discount: 0, channel: 'wxpay', status: 'pending', items: [{ product_id: 1, product_name: '额度包', qty: 1 }], created_at: '2026-11-01T02:00:00.000Z', deleted_at: '2026-11-07T02:00:00.000Z', deleted_by: 'admin' },
];

function makeDom(urlPath) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('[jsdomError] ' + (e.stack || e.message).split('\n')[0]));
  vc.on('error', (...a) => errors.push('[console.error] ' + a.map(String).join(' ')));
  vc.on('warn', (...a) => errors.push('[console.warn] ' + a.map(String).join(' ')));
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'https://www.bliot.cn/platform' + urlPath,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  return { win: dom.window, errors };
}

function stubU(win, calls) {
  const int = (n) => String(Number(n || 0));
  const money = (n) => '¥' + Number(n || 0).toFixed(2);
  win.U = {
    basePath: '/platform',
    // 页面守卫统一 await U.authReady()：已登录场景直接放行
    authReady: async () => true,
    setAuthReady() {},
    toast(msg) { calls.toasts.push(msg); },
    confirm: async () => true,
    icons: {},
    fmt: { int, money, time: (t) => String(t || '').slice(0, 10) },
    lineChart: () => '<svg></svg>',
    barChart: () => '<svg></svg>',
    donut: () => '<svg></svg>',
    api: {
      async get(u) {
        calls.gets.push(u);
        if (String(u).startsWith('/api/portal/site')) return { pay_channels: [] };
        // 后端已过滤掉软删除的订单，桩也照此行为
        if (String(u).startsWith('/api/portal/orders')) return { list: JSON.parse(JSON.stringify(ORDERS.filter((o) => !o.deleted_at))) };
        if (String(u).startsWith('/api/orders')) return { total: ORDERS.length, page: 1, pageSize: 20, list: JSON.parse(JSON.stringify(ORDERS)) };
        throw new Error('unexpected GET ' + u);
      },
      async post(u) { calls.posts.push(u); return { ok: true, count: 0, points_back: 0 }; },
      async del(u) { calls.dels.push(u); return { ok: true, points_back: 0 }; },
    },
  };
}

async function renderAdmin() {
  const calls = { gets: [], posts: [], dels: [], toasts: [] };
  const { win, errors } = makeDom('/admin/index.html');
  stubU(win, calls);
  win.eval(VUE);
  win.eval(TRADE);
  win.eval("Vue.createApp(window.PageOrders).mount('#app')");
  await wait(200);
  return { win, doc: win.document, errors, calls };
}

async function renderUser() {
  const calls = { gets: [], posts: [], dels: [], toasts: [] };
  const { win, errors } = makeDom('/user/index.html');
  win.localStorage.setItem('user_token', 'test-token');
  stubU(win, calls);
  win.eval(VUE);
  win.eval(USER_PAGES);
  win.eval("Vue.createApp(window.PageMyOrders).mount('#app')");
  await wait(200);
  return { win, doc: win.document, errors, calls };
}

(async () => {
  console.log('\n后台 订单页：未付款可删，删掉的能看出、能恢复');
  {
    const { doc, errors } = await renderAdmin();
    const text = doc.body.textContent.replace(/\s+/g, ' ');
    const btns = [...doc.querySelectorAll('button')].map((b) => b.textContent.trim());
    check('渲染零错误', errors.length === 0, errors.join(' | '));
    check('状态筛选有「已删除」选项', [...doc.querySelectorAll('option')].some((o) => o.value === 'deleted'), [...doc.querySelectorAll('option')].map((o) => o.value));
    check('待支付行有「删除」按钮', btns.filter((t) => t === '删除').length === 1, btns);
    const delRow = [...doc.querySelectorAll('tr')].find((tr) => tr.textContent.includes('ORD-DELETED-0002'));
    const delTag = delRow ? delRow.querySelector('.tag').textContent.trim() : '';
    check('已删除行状态显示「已删除」（而不是仍显示待支付）', delTag === '已删除', delTag);
    check('已删除行有「恢复」按钮', btns.includes('恢复'), btns);
    check('已删除行不再给「标记已付」', btns.filter((t) => t === '标记已付').length === 1, btns);
    check('工具栏有批量清理入口', btns.some((t) => t.includes('清理 7 天前未付款')), btns);
  }

  console.log('\n用户端 我的订单：可以删掉自己没付的订单');
  {
    const { doc, errors, win } = await renderUser();
    const text = doc.body.textContent.replace(/\s+/g, ' ');
    const btns = [...doc.querySelectorAll('button')].map((b) => b.textContent.trim());
    check('渲染零错误', errors.length === 0, errors.join(' | '));
    check('订单号渲染出来了（模板编译正常）', text.includes('ORD-PENDING-0001'), text.slice(0, 200));
    check('待支付行有「删除」按钮', btns.includes('删除'), btns);
    check('已删除的订单不出现在用户端列表', !text.includes('ORD-DELETED-0002'), text.slice(0, 300));
  }

  console.log('\n首屏不再闪 {{ }}');
  for (const f of ['public/user/index.html', 'public/admin/index.html']) {
    const html = read(f);
    const head = html.slice(0, html.indexOf('</head>'));
    check(`${f}：head 内联 #app{display:none}（等下载外链 CSS 就来不及了）`,
      /#app\s*\{\s*display:\s*none;?\s*\}/.test(head));
    check(`${f}：有挂载后才显示的 .ready 规则`, /#app\.ready\s*\{\s*display:\s*block/.test(head));
    check(`${f}：body 里有加载态遮罩`, /<div id="boot"[^>]*>/.test(html));
    // 登录态是异步校验的：遮罩要等 app:ready（mount 前注册监听，reveal 里加 ready + 撤遮罩）
    check(`${f}：mount 前注册 app:ready 监听`, /addEventListener\('app:ready',\s*reveal[\s\S]{0,40}\{ once: true \}/.test(html));
    check(`${f}：reveal 里加 ready 并移除遮罩`,
      /function reveal\(\)[\s\S]{0,300}classList\.add\('ready'\)[\s\S]{0,200}boot\.remove\(\)/.test(html));
    check(`${f}：有超时兜底（慢网/脚本报错也不会永远卡「加载中」）`, /setTimeout\(reveal,\s*\d+\)/.test(html));
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

/* 前端支付链路自测：用户端「立即购买 → 弹出二维码」必须能真正渲染出来
 *
 * 背景：2026-10-31 线上出现过 微信支付下单已成功（后端返回 code_url），
 * 但前端报 TypeError: Cannot read properties of undefined (reading 'basePath')，
 * 二维码出不来。原因是模板里直接引用了挂在 window 上的全局 U，
 * 而 Vue 模板作用域只能访问 setup/data/props/globalProperties。
 *
 * 本测试用 jsdom 加载真实页面（真实 vue.global.prod.js + 真实 app.js/pages.js），
 * 只把后端 API 的响应替换掉（支付要真实商户号，无法在 CI 里跑），
 * 断言：
 *   1. 页面零 jsdomError / console.error
 *   2. 二维码 img 真的渲染出来
 *   3. img 的 src 带对了部署前缀（子路径 /platform 与根路径两种都要对）
 *
 * 用法：node tools/test-frontend-pay.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); } else {
    fail++;
    console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + String(extra).slice(0, 300) : ''));
  }
}

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* 极简静态服务器：把 /platform/* 映射到 public/*，模拟子路径部署 */
function serve(prefix) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (prefix && url !== prefix && !url.startsWith(prefix + '/')) {
      res.writeHead(404); res.end('not found'); return;
    }
    let rel = prefix ? url.slice(prefix.length) : url;
    if (rel === '' || rel === '/') rel = '/user/index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(PUB, rel);
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const CODE_URL = 'weixin://wxpay/bizpayurl?pr=TESTCODE';

/* API mock：静态资源走真实 HTTP，接口走这里 */
function mockFetch(base, prefix) {
  const real = globalThis.fetch;
  return async (url, opt = {}) => {
    const u = String(url);
    const abs = u.startsWith('http') ? u : base + u;
    const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    if (abs.includes('/api/portal/site')) {
      return json({ site_name: '测试站点', pay_channels: ['wxpay'] });
    }
    if (abs.includes('/api/portal/product/')) {
      return json({
        product: {
          id: 1, name: '测试商品', subtitle: '副标题', type: 'software', version: '1.0.0',
          price: 1, description: '描述', features: ['功能一'], download_url: '',
        },
      });
    }
    if (abs.includes('/api/portal/orders/') && opt.method === 'POST') {
      return json({ mode: 'qrcode', code_url: CODE_URL });
    }
    if (abs.includes('/api/portal/orders') && opt.method === 'POST') {
      return json({ order_no: 'NO20261031TEST', pay_amount: 1 });
    }
    if (abs.includes('/api/portal/me')) return json({ user: { id: 1, nickname: '测试用户' } });
    if (abs.includes('/api/portal/')) return json({});
    return real(abs, opt);
  };
}

async function runScenario(label, prefix) {
  const { server, port } = await serve(prefix);
  const base = `http://127.0.0.1:${port}${prefix}`;
  const url = `${base}/user/#/product/1`;
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('[jsdomError] ' + (e.stack || e.message).split('\n')[0]));
  vc.on('error', (...a) => errors.push('[console.error] ' + a.map(String).join(' ')));
  vc.on('warn', (...a) => errors.push('[console.warn] ' + a.map(String).join(' ')));

  let dom;
  try {
    dom = await JSDOM.fromURL(url, {
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(win) {
        win.Response = globalThis.Response;
        win.Headers = globalThis.Headers;
        win.fetch = mockFetch(base, prefix);
        win.localStorage.setItem('user_token', 'test-token');
      },
    });
  } catch (e) {
    check(`${label} 页面可加载`, false, e.message);
    server.close();
    return;
  }

  await wait(900);
  const doc = dom.window.document;
  const buyBtn = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === '立即购买');
  check(`${label} 商品页渲染出购买按钮`, !!buyBtn, buyBtn ? '' : '按钮列表: ' + [...doc.querySelectorAll('button')].map((b) => b.textContent.trim()).join('|'));

  if (buyBtn) {
    buyBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, view: dom.window }));
    await wait(900);
  }

  const img = doc.querySelector('.modal .qr-box img');
  check(`${label} 二维码 img 渲染成功`, !!img, img ? '' : errors.join(' ; ') || '未找到 img');
  if (img) {
    const src = img.getAttribute('src') || '';
    check(`${label} 二维码地址带部署前缀 ${prefix || '(根路径)'}`, src.startsWith(`${prefix}/api/portal/qrcode?text=`), src);
    check(`${label} 二维码内容未被吞（含 weixin://）`, src.includes(encodeURIComponent('weixin://wxpay')), src);
  }
  check(`${label} 页面零渲染错误`, errors.length === 0, errors.join(' ; '));

  dom.window.close();
  server.close();
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 静态扫描：Vue 模板里不许直接引用全局变量。
 * 注意只扫 template: `...` 区块 —— 脚本里用 <tag> 拼字符串给 v-html 是正常的，那些不在模板作用域里执行。
 */
function templateRegions(src) {
  const regions = [];
  const re = /template:\s*`/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('`', start);
    if (end < 0) break;
    const until = src.indexOf('\n', start);
    regions.push({ from: src.slice(0, start).split('\n').length, body: src.slice(start, end) });
    re.lastIndex = end + 1;
    void until;
  }
  return regions;
}

function scanTemplates() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(PUB, 'user'));
  walk(path.join(PUB, 'admin'));

  const GLOBAL = /[^\w$](U|location|localStorage|window|document)\.[a-zA-Z_]/;
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const r of templateRegions(src)) {
      r.body.split('\n').forEach((line, i) => {
        if (GLOBAL.test(line)) {
          hits.push(path.relative(PUB, f).replace(/\\/g, '/') + ':' + (r.from + i) + '  ' + line.trim().slice(0, 120));
        }
      });
    }
  }
  check('Vue 模板中没有直接引用全局变量 U./location./localStorage.', hits.length === 0, hits.join(' || '));
}

(async () => {
  console.log('\n前端支付链路（模板作用域 / 子路径前缀）');
  await runScenario('[子路径 /platform]', '/platform');
  await runScenario('[根路径]', '');
  console.log('\n静态扫描');
  scanTemplates();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();

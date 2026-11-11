/* 版本差异组件的 DOM 结构测试（jsdom，不依赖布局）
 *
 * 钉住 2026-11-11 的回归：弹层必须挂在 <body> 下。
 * 原因：组件在「我的空间」里落在 .prod-card 内部，而 .prod-card:hover 有
 * transform: translateY(-2px)。祖先带 transform 时，子元素的 position:fixed
 * 会改成相对该祖先定位 —— 点击按钮必然 hover 卡片，弹层就被塞进卡片里、
 * 随 hover 抖动，还会被 overflow:hidden 裁掉。表现就是「模态框乱跳」。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`  ✗   ${name}${detail ? ' → ' + detail : ''}`); }
}

const ROOT = path.join(__dirname, '..');
const vueCode = fs.readFileSync(path.join(ROOT, 'node_modules/vue/dist/vue.global.prod.js'), 'utf8');
const cmpCode = fs.readFileSync(path.join(ROOT, 'public/assets/compare.js'), 'utf8');

function makeDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div><div id="inline"></div></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://example.com/platform/',
  });
  const w = dom.window;
  w.eval(vueCode);
  w.eval(cmpCode);
  w.U = { basePath: '/platform' };
  return dom;
}

function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  /* ---------------- 1. 模态模式：弹层挂 body，不在卡片里 ---------------- */
  const dom = makeDom();
  const w = dom.window;
  const Vue = w.Vue;
  let vc;
  const app = Vue.createApp({
    template: `<div class="prod-card" style="transform:translateY(-2px)">
        <div class="btn-group actions"><version-compare ref="vc" url="assets/compare/default.html"></version-compare></div>
      </div>`,
  });
  app.component('version-compare', w.VersionCompare);
  const inst = app.mount('#app');
  vc = inst.$refs.vc;
  await tick();

  const btn = w.document.querySelector('.vc-root button');
  ok('默认渲染出「版本差异」按钮', !!btn && /版本差异/.test(btn.textContent));
  ok('未点击时没有弹层', !w.document.querySelector('.mask'));

  btn.click();
  await tick();

  const mask = w.document.querySelector('.mask');
  ok('点击后出现弹层', !!mask);
  ok('弹层挂在 body 下（不受卡片 transform 影响）', mask && mask.parentElement === w.document.body,
    mask ? 'parent=' + (mask.parentElement && mask.parentElement.className) : 'no mask');
  ok('弹层不在 .prod-card 里', mask && !mask.closest('.prod-card'));
  ok('打开时锁定页面滚动', w.document.body.style.overflow === 'hidden');
  ok('弹层高度交给 CSS（iframe 长宽由样式决定）',
    /compare-frame/.test(mask.innerHTML) && /modal wide/.test(mask.innerHTML));

  // 关闭：点 X
  w.document.querySelector('.mask .close-x').click();
  await tick();
  ok('点 × 关闭弹层', !w.document.querySelector('.mask'));
  ok('关闭后恢复页面滚动', w.document.body.style.overflow === '');

  // 关闭：Esc
  btn.click();
  await tick();
  const esc = new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
  w.dispatchEvent(esc);
  await tick();
  ok('Esc 可关闭弹层', !w.document.querySelector('.mask'));

  /* ---------------- 2. 内嵌模式：不产生弹层，根元素撑满 ---------------- */
  const app2 = Vue.createApp({
    template: `<div class="product-detail"><div class="cover"></div><div class="info"></div>
        <version-compare url="assets/compare/default.html" mode="inline"></version-compare></div>`,
  });
  app2.component('version-compare', w.VersionCompare);
  app2.mount('#inline');
  await tick();

  const root = w.document.querySelector('#inline .vc-root');
  ok('内嵌模式根元素带 is-inline', !!root && root.classList.contains('is-inline'));
  ok('内嵌模式不渲染按钮', !w.document.querySelector('#inline .vc-root > button'));
  ok('内嵌模式直接显示 iframe', !!w.document.querySelector('#inline .vc-inline iframe'));
  ok('内嵌模式不产生弹层', !w.document.querySelector('#inline .mask') && !w.document.querySelector('.mask'));

  /* ---------------- 3. 内容地址规范化 ---------------- */
  ok('相对地址补部署前缀', vc.finalUrl === '/platform/assets/compare/default.html', vc.finalUrl);
  const host3 = w.document.createElement('div');
  w.document.body.appendChild(host3);
  const app3 = Vue.createApp({
    template: `<div><version-compare ref="vc" url="javascript:alert(1)"></version-compare></div>`,
  });
  app3.component('version-compare', w.VersionCompare);
  const inst3 = app3.mount(host3);
  await tick();
  ok('伪协议回落到默认页', inst3.$refs.vc.finalUrl === '/platform/assets/compare/default.html', inst3.$refs.vc.finalUrl);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });

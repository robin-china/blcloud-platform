/* 模板市场后台两页的 Vue 模板编译 / 挂载回归
 * 运行：node tools/test-market-ui.js
 *
 * 静态页面用 in-DOM 模板 + 全局 Vue，模板里一个语法错误或 setup 少 return 一个变量，
 * 浏览器里就是「整页空白 / 按钮点不动」，而服务端测试完全照不到。这里用 jsdom 真编译一次。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + String(extra).slice(0, 300) : '')); }
}

const pageCode = read('public/admin/js/pages-market.js');
const adminIndex = read('public/admin/index.html');
const appJs = read('public/admin/js/app.js');
const css = read('public/assets/ui.css');

console.log('\n[1] 静态约定');
ok('页面脚本用 IIFE 包裹', /^\(function \(\) \{/.test(pageCode.trim()) && /\}\)\(\);\s*$/.test(pageCode.trim()));
ok('导出两个页面组件', /window\.PageMarket = \{/.test(pageCode) && /window\.PageMarketOptions = \{/.test(pageCode));
ok('模板不引用全局 U / window / location', !/v-if="U\./.test(pageCode) && !/:src="window\./.test(pageCode) && !/\{\{\s*location\./.test(pageCode));
ok('弹层 teleport 到 body', /<teleport to="body">/.test(pageCode) && /@click\.self="closeEdit"/.test(pageCode));
ok('index.html 注册两个页面', /<page-market v-if="state\.route === 'market'"><\/page-market>/.test(adminIndex)
  && /<page-market-options v-if="state\.route === 'marketOptions'"><\/page-market-options>/.test(adminIndex));
ok('PAGES 数组含 Market / MarketOptions', /'Market', 'MarketOptions'/.test(adminIndex));
ok('菜单含模板市场与模板字典', /key: 'market', name: '模板市场'/.test(appJs) && /key: 'marketOptions', name: '模板字典'/.test(appJs));
ok('字典行样式已定义', /\.dict-row \{/.test(css) && /\.dict-idx \{/.test(css));
ok('私有目录不被 Nginx 静态映射（上线检查提示）', /绝对不要在这里加 alias/.test(read('deploy/nginx-subpath.conf')));

console.log('\n[2] Vue 模板真编译 + 挂载');
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/platform/admin/',
});
const w = dom.window;
w.eval(read('node_modules/vue/dist/vue.global.prod.js'));
const errors = [];
w.U = {
  basePath: '/platform',
  fmt: { int: (n) => String(n || 0) },
  api: {
    // 返回一条真实形态的模板，让表格分支（缩略图 / bytes() / 状态标签）真的渲染一遍，
    // 否则「setup 少 return 一个函数」这类错误只在有数据时才会暴露
    get: async (url) => String(url).startsWith('/api/market/templates')
      ? {
        stats: { templates: 1, online: 1, downloads: 3, purchases: 1, pointsSpent: 20 },
        items: [{
          id: 'tpl_mkt_ui1', name: 'UI 测试模板', industry: '制造业', paperType: '间隙纸',
          description: '一行描述', tags: ['条码'], widthMm: 50, heightMm: 30, dpi: 203, columns: 1,
          price: 20, author: '官方', thumbnailUrl: '/platform/uploads/a.png', status: 'on',
          downloads: 3, version: 2, hasFile: true, fileSize: 2048, fileSha256: 'abcd',
        }],
      }
      : { industries: ['制造业'], paperTypes: ['间隙纸'], sizePresets: [{ label: '50×30mm', widthMm: 50, heightMm: 30 }] },
    post: async () => ({ ok: true }), patch: async () => ({ ok: true }), del: async () => ({ ok: true }),
    getToken: () => 'test-token',
  },
  toast: () => {}, confirm: async () => true, failMsg: (e) => (e && e.message) || '失败',
  icons: {}, svgIcon: () => '', authReady: async () => true,
};
w.fetch = async () => ({ ok: true, json: async () => ({ url: '/platform/uploads/x.png' }) });
w.FormData = class { append() {} };
w.eval(pageCode);

const Vue = w.Vue;
let compiled = 0;
for (const [name, comp] of [['PageMarket', w.PageMarket], ['PageMarketOptions', w.PageMarketOptions]]) {
  try {
    const render = Vue.compile(comp.template);
    ok(name + ' 模板可编译', typeof render === 'function');
    compiled++;
  } catch (e) { ok(name + ' 模板可编译', false, e.message); }
}
ok('两个组件都编译成功', compiled === 2);

const app = Vue.createApp({
  template: '<div><page-market></page-market><page-market-options></page-market-options></div>',
});
app.component('page-market', w.PageMarket);
app.component('page-market-options', w.PageMarketOptions);
app.config.errorHandler = (e) => errors.push(e && e.message);
let inst = null;
try {
  inst = app.mount('#app');
  ok('两页可挂载（setup 无未定义标识符）', !!inst);
} catch (e) {
  ok('两页可挂载（setup 无未定义标识符）', false, e.stack);
}
const html = w.document.body.innerHTML;
ok('渲染出「模板上下架」表格区', html.includes('模板上下架'));
ok('渲染出「枚举字典」页', html.includes('枚举字典'));
ok('渲染出尺寸预设说明', html.includes('尺寸预设'));
ok('首屏渲染时无 Vue 运行时错误', errors.length === 0, errors);

(async () => {
  await new Promise((r) => setTimeout(r, 30));
  const loadedHtml = w.document.body.innerHTML;
  ok('表格行真渲染（bytes/thumb 等 setup 返回值可用）',
    loadedHtml.includes('UI 测试模板') && loadedHtml.includes('2.0 KB'),
    loadedHtml.slice(Math.max(0, loadedHtml.indexOf('UI 测试模板') - 100), loadedHtml.indexOf('UI 测试模板') + 300));
  ok('缩略图地址不重复拼 basePath', loadedHtml.includes('src="/platform/uploads/a.png"'), loadedHtml.match(/src="[^"]*uploads[^"]*"/g));
  ok('异步加载后仍无运行时错误', errors.length === 0, errors);
  console.log(`\n模板市场前端测试：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
})();

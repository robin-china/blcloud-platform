/* 账户中心新页面的 Vue 模板真编译 + 挂载回归
 * 运行：node tools/test-account-ui.js
 *
 * 静态断言查不出「setup 少 return」「模板引用了未定义标识符」这类问题，
 * 这里用 jsdom 真编译两个组件模板并渲染首屏数据。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

const accountCode = read('public/user/js/page-account.js');
const userIndex = read('public/user/index.html');
const css = read('public/assets/ui.css');
const avatarJs = read('public/assets/avatars.js');

console.log('\n[1] 静态约定');
ok('页面脚本用 IIFE 包裹', /\(function \(\) \{/.test(accountCode) && /\}\)\(\);\s*$/.test(accountCode.trim()));
ok('导出 PageAccount 与 PayDialog', /window\.PageAccount = \{/.test(accountCode) && /window\.PayDialog = \{/.test(accountCode));
ok('模板不引用全局 U / location / window', !/\{\{\s*U\./.test(accountCode)
  && !/v-if="location\./.test(accountCode) && !/:src="window\./.test(accountCode));
ok('三个弹层都 teleport 到 body', (accountCode.match(/<teleport to="body">/g) || []).length === 3);
ok('自定义组件标签显式闭合', /<pay-dialog[\s\S]*?><\/pay-dialog>/.test(accountCode));
ok('index.html 引入新页面并注册组件', /js\/page-account\.js/.test(userIndex)
  && /component\('pay-dialog'/.test(userIndex));
ok('CSS 有账户中心与移动端断点', /\.acct \{/.test(css) && /@media \(max-width: 560px\)/.test(css));
ok('PC 端单列账户中心水平居中', /\.acct \{[^}]*max-width:\s*760px;[^}]*margin:\s*0 auto/.test(css), (css.match(/\.acct \{[^}]*\}/) || [''])[0]);
ok('头像库中性别无关的中性默认存在', /id: '00', name: '默认头像'/.test(avatarJs)
  && /function defaultValue\(\) \{ return 'preset:' \+ defaultId\(\); \}/.test(avatarJs));

console.log('\n[2] Vue 模板真编译 + 挂载');
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/platform/user/',
});
const w = dom.window;
w.eval(read('node_modules/vue/dist/vue.global.prod.js'));
w.eval(avatarJs);
const errors = [];
const mockUser = {
  id: 1, publicId: '123456789', nickname: '测试用户', avatar: 'preset:00',
  avatar_preset: 'preset:00', phone: '13800138000', points: 1500,
  profile_custom: 0, created_at: '2026-11-13T00:00:00.000Z',
};
w.U = {
  basePath: '/platform',
  fmt: { int: (n) => String(n || 0), time: () => '2026-11-13 08:00' },
  avatar: (v) => v,
  api: {
    get: async (url) => {
      const u = String(url);
      if (u.startsWith('/api/portal/me')) return { user: mockUser };
      if (u.startsWith('/api/portal/points')) {
        return { list: [{ id: 1, change: 200, balance: 1500, reason: '积分充值（订单 NO1）', created_at: '2026-11-13T01:00:00.000Z' }] };
      }
      if (u.startsWith('/api/portal/site')) return { pay_channels: ['simulate'] };
      if (u.startsWith('/api/portal/orders')) return { list: [] };
      return {};
    },
    post: async () => ({ ok: true }),
    getToken: () => 'test-token',
  },
  toast: () => {}, confirm: async () => true, failMsg: (e) => (e && e.message) || '失败',
  authReady: async () => true, icons: {}, svgIcon: () => '',
};
w.FormData = class { append() {} };
w.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
w.eval(accountCode);

const Vue = w.Vue;
for (const name of ['PayDialog', 'PageAccount']) {
  try {
    const render = Vue.compile(w[name].template);
    ok(name + ' 模板可编译', typeof render === 'function');
  } catch (e) { ok(name + ' 模板可编译', false, e.message); }
}

const app = Vue.createApp({ template: '<div><page-account></page-account></div>' });
app.provide('state', {});
app.component('page-account', w.PageAccount);
app.component('pay-dialog', w.PayDialog);
app.config.errorHandler = (e) => errors.push(e && e.message);
let inst = null;
try {
  inst = app.mount('#app');
  ok('账户中心可挂载（setup 无未定义标识符）', !!inst);
} catch (e) {
  ok('账户中心可挂载（setup 无未定义标识符）', false, e.stack);
}
const html = w.document.body.innerHTML;
ok('渲染出「账户资料」与资料卡', html.includes('账户资料'));
ok('首屏渲染出个人 ID 占位而非 openid', html.includes('个人 ID') && !html.includes('OpenID'));
ok('渲染出上传头像 / 恢复默认按钮', html.includes('上传头像') && html.includes('恢复默认'));
ok('渲染时无 Vue 运行时错误', errors.length === 0, errors);

(async () => {
  await new Promise((r) => setTimeout(r, 30));
  const loaded = w.document.body.innerHTML;
  ok('异步拉资料后显示 9 位个人 ID', loaded.includes('123456789'), loaded.slice(0, 300));
  ok('异步拉资料后手机号脱敏并显示更换按钮', /138\*\*\*\*8000/.test(loaded) && loaded.includes('更换'), loaded.slice(0, 400));
  ok('异步拉资料后显示积分余额与充值/签到按钮',
    (loaded.includes('1,500') || loaded.includes('1500')) && loaded.includes('充值') && loaded.includes('签到'));
  ok('异步拉资料后渲染出积分明细行', loaded.includes('积分充值（订单 NO1）'), loaded.slice(-400));
  ok('异步加载后仍无运行时错误', errors.length === 0, errors);
  console.log(`\n账户中心前端测试：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
})();

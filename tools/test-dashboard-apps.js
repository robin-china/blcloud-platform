/* 管理后台仪表盘「应用接入」区块渲染自测
 *
 * 前端是浏览器内编译的 in-DOM 模板，模板写错会整页白屏，必须真实渲染验证：
 *   1. 页面零 jsdomError / console.error
 *   2. 四张接入指标卡渲染出正确数字
 *   3. 各应用榜单渲染出应用名、在线/用户/授权、今日与累计调用
 *   4. 无接入应用时显示空态文案而不是空白
 *
 * 用法：node tools/test-dashboard-apps.js
 */
const fs = require('fs');
const path = require('path');
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

const VUE = fs.readFileSync(path.join(PUB, 'vendor', 'vue.global.prod.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(PUB, 'admin', 'js', 'pages-dashboard.js'), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fixtures(emptyApps) {
  return {
    '/api/stats/overview': {
      products: { downloads: 0, installs: 0, active_users: 0 },
      today: { downloads: 0, active_users: 0, new_users: 0, api_calls: 0 },
      revenue: { total: 1200, month: 300 },
      devices: { total: 5, online: 2 },
      users: 12, pendingOrders: 1, pendingLicenses: 0,
    },
    '/api/stats/trend': { list: [{ date: '2026-11-07', downloads: 0, installs: 0 }, { date: '2026-11-08', downloads: 0, installs: 0 }] },
    '/api/stats/revenue': { trend: [{ date: '2026-11-08', revenue: 100 }], byChannel: [], topProducts: [] },
    '/api/stats/apps': emptyApps ? {
      apps: { total: 0, active: 0 }, sessions: { online: 0, today_sessions: 0, online_users: 0 },
      calls: { open_today: 0, open_total: 0, device_today: 0, device_total: 0, device_fail_today: 0, total_today: 0, total: 0 },
      updates: { check: 0, success: 0, fail: 0 }, byApp: [], trend: [],
    } : {
      apps: { total: 3, active: 2 },
      sessions: { online: 7, online_users: 5, today_sessions: 9, today_users: 6 },
      calls: { open_today: 1234, open_total: 98765, device_today: 321, device_total: 45678, device_fail_today: 2, total_today: 1555, total: 144443 },
      updates: { check: 12, success: 3, fail: 1 },
      trend: [{ date: '2026-11-07', open: 100, device: 20 }, { date: '2026-11-08', open: 1234, device: 321 }],
      byApp: [
        { id: 1, name: 'LabelGo 桌面端', status: 'active', version: '1.0.21', online: 5, users: 9, licenses: 8, calls: 88000, calls_today: 1200 },
        { id: 2, name: '仓库盘点工具', status: 'disabled', version: '', online: 2, users: 3, licenses: 3, calls: 10765, calls_today: 34 },
      ],
    },
  };
}

async function render(emptyApps) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('[jsdomError] ' + (e.stack || e.message).split('\n')[0]));
  vc.on('error', (...a) => errors.push('[console.error] ' + a.map(String).join(' ')));
  vc.on('warn', (...a) => errors.push('[console.warn] ' + a.map(String).join(' ')));

  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'https://www.bliot.cn/platform/admin/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const win = dom.window;
  const data = fixtures(emptyApps);
  const int = (n) => String(Number(n || 0));
  win.U = {
    basePath: '/platform',
    toast() {},
    confirm: async () => false,
    icons: { box: '', users: '', chart: '', plug: '', device: '', api: '', cloud: '' },
    fmt: { int, money: (n) => '¥' + Number(n || 0).toFixed(2) },
    // 图表只校验调用不抛错，内容由 api.js 的既有测试覆盖
    lineChart: (list) => `<svg class="stub-line" data-n="${(list || []).length}"></svg>`,
    barChart: () => '<svg class="stub-bar"></svg>',
    donut: () => '<svg class="stub-donut"></svg>',
    api: {
      get: async (u) => {
        const key = Object.keys(data).find((k) => String(u).startsWith(k));
        if (!key) throw new Error('unexpected url ' + u);
        return JSON.parse(JSON.stringify(data[key]));
      },
      post: async () => ({ ok: true }),
    },
  };
  win.eval(VUE);
  win.eval(PAGE);
  win.eval("Vue.createApp(window.PageDashboard).mount('#app')");
  await wait(250);
  return { win, doc: win.document, errors };
}

(async () => {
  console.log('\n管理后台 仪表盘 → 应用接入');

  {
    const { doc, errors } = await render(false);
    const text = doc.body.textContent.replace(/\s+/g, ' ');
    check('页面零渲染错误', errors.length === 0, errors.join(' | '));
    check('出现「应用接入」小节', text.includes('应用接入'), text.slice(0, 120));
    check('接入应用 2 / 3', text.includes('2 / 3'), text.slice(0, 400));
    check('在线客户端 7', /在线客户端\s*7/.test(text), text.slice(0, 400));
    check('今日活跃 9 台 · 5 人', text.includes('今日活跃 9 台 · 5 人'), text.slice(0, 500));
    check('今日 API 调用 1555', text.includes('1555'), text.slice(0, 500));
    check('拆分明细 应用 1234 · 设备 321', text.includes('应用 1234 · 设备 321'), text.slice(0, 600));
    check('累计调用 144443', text.includes('144443'), text.slice(0, 600));
    check('设备失败今日 2 次', text.includes('今日设备失败 2 次'), text.slice(0, 600));
    check('榜单渲染应用名', text.includes('LabelGo 桌面端') && text.includes('仓库盘点工具'), text.slice(0, 800));
    check('榜单渲染在线/用户/授权', text.includes('在线 5 · 用户 9 · 授权 8'), text.slice(0, 900));
    check('榜单渲染今日/累计调用', text.includes('今日 1200 / 共 88000'), text.slice(0, 900));
    check('停用应用有标记', text.includes('已停用'), text.slice(0, 900));
    check('升级流水摘要', text.includes('今日升级 检查 12 · 成功 3 · 失败 1'), text.slice(0, 900));
    check('趋势图被调用（14 天补点后数据到位）', doc.querySelectorAll('svg.stub-line').length >= 1, doc.querySelectorAll('svg.stub-line').length);
  }

  {
    const { doc, errors } = await render(true);
    const text = doc.body.textContent.replace(/\s+/g, ' ');
    check('空库也零错误', errors.length === 0, errors.join(' | '));
    check('空态文案', text.includes('还没有接入应用'), text.slice(0, 600));
    check('0 值不显示 NaN/undefined', !/NaN|undefined/.test(text), text.slice(0, 400));
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

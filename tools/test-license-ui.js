/* 授权相关页面真实渲染自测：node tools/test-license-ui.js
 *
 * 背景（2026-11-02）：后台/用户端都新增了「绑定设备」弹窗、后台新增批量发码。
 * 前端是浏览器内编译的模板，模板写错整页白屏，必须真实渲染验证：
 *   1. 后台授权页零错误，设备数可点、弹窗能列出机器、解绑能发出请求
 *   2. 发放弹窗有「数量」字段（批量发码入口）
 *   3. 用户端「我的授权」零错误，能看到绑定数量并自助解绑
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const VUE = fs.readFileSync(path.join(PUB, 'vendor', 'vue.global.prod.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + String(extra).slice(0, 300) : '')); }
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function boot({ pageFile, pageName, url, U, before }) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('[jsdomError] ' + (e.stack || e.message).split('\n')[0]));
  vc.on('error', (...a) => errors.push('[console.error] ' + a.map(String).join(' ')));
  vc.on('warn', (...a) => errors.push('[console.warn] ' + a.map(String).join(' ')));

  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.Response = globalThis.Response;
      win.Headers = globalThis.Headers;
      win.confirm = () => true;
    },
  });
  const win = dom.window;
  win.U = U;
  if (before) before(win);
  win.eval(VUE);
  win.eval(fs.readFileSync(pageFile, 'utf8'));
  win.eval(`Vue.createApp(window.${pageName}).mount('#app')`);
  await wait(250);
  return { win, doc: win.document, errors };
}

function click(win, el) {
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, view: win }));
}

const LICENSE = {
  id: 7, license_key: 'LIC-1A2B3C4D-5E6F7A8B-9C0D1E2F', user_id: 3, product_id: 2,
  product_name: '花盆卫士 PC 客户端', type: 'permanent', max_devices: 2,
  start_at: '2026-10-01T00:00:00.000Z', end_at: null, status: 'active',
  bound_devices: 1, nickname: '李雷', phone: '13800138000',
};
const MACHINE = {
  id: 11, license_id: 7, device_sn: 'MACHINE-A', device_name: '李雷的笔记本',
  last_version: '1.2.0', last_ip: '1.2.3.4', last_seen_at: '2026-11-02T02:00:00.000Z',
  bound_at: '2026-10-01T00:00:00.000Z',
};

(async () => {
  /* ---------------- 后台授权管理 ---------------- */
  console.log('\n后台 授权管理（发放 / 设备解绑 / 批量）');
  {
    const calls = [];
    const U = {
      basePath: '',
      toast() {},
      fmt: { date: () => '2026-11-02', time: () => '2026-11-02 10:00' },
      api: {
        get: async (u) => {
          calls.push(['GET', String(u)]);
          if (String(u).startsWith('/api/licenses/')) return { list: [MACHINE], max_devices: 2 };
          if (String(u).startsWith('/api/licenses')) return { list: [LICENSE], total: 1 };
          return { list: [], total: 0 };
        },
        post: async (u) => { calls.push(['POST', String(u)]); return { ok: true, license_key: 'LIC-AAAA' }; },
        del: async (u) => { calls.push(['DEL', String(u)]); return { ok: true }; },
      },
    };
    const { win, doc, errors } = await boot({
      pageFile: path.join(PUB, 'admin', 'js', 'pages-users.js'),
      pageName: 'PageLicenses', url: 'https://www.bliot.cn/admin/index.html#/licenses', U,
    });
    const text = () => doc.body.textContent || '';
    check('后台授权页零渲染错误', errors.length === 0, errors.join(' ; '));
    check('渲染出授权码', text().includes('LIC-1A2B3C4D'), text().slice(0, 160));
    check('设备数列显示 1 / 2', /1\s*\/\s*2/.test(text()), text().slice(0, 200));

    const devBtn = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === '1 / 2');
    check('设备数可点开弹窗', !!devBtn, [...doc.querySelectorAll('button')].map((b) => b.textContent.trim()).join('|'));
    if (devBtn) {
      click(win, devBtn);
      await wait(200);
      check('弹窗列出机器码', text().includes('MACHINE-A'), text().slice(0, 200));
      check('弹窗显示客户端版本', text().includes('1.2.0'));
      const unbind = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === '解绑');
      check('弹窗里有解绑按钮', !!unbind);
      if (unbind) {
        click(win, unbind);
        await wait(200);
        check('解绑发出 DELETE 请求', calls.some(([m, u]) => m === 'DEL' && u.includes('/api/license-devices/11')), JSON.stringify(calls));
      }
    }

    const createBtn = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === '+ 发放授权');
    check('存在「+ 发放授权」按钮', !!createBtn);
    if (createBtn) {
      click(win, createBtn);
      await wait(250);
      check('发放弹窗有「数量」字段（批量发码入口）', text().includes('数量（大于 1 则批量生成'), text().slice(-300));
    }
    win.close();
  }

  /* ---------------- 用户端我的授权 ---------------- */
  console.log('\n用户端 我的授权（自助解绑）');
  {
    const calls = [];
    const U = {
      basePath: '',
      toast() {},
      fmt: { date: () => '2026-11-02', time: () => '2026-11-02 10:00' },
      api: {
        get: async (u) => {
          calls.push(['GET', String(u)]);
          if (String(u).includes('/devices')) return { list: [MACHINE], max_devices: 2 };
          return { list: [LICENSE] };
        },
        post: async () => ({ ok: true }),
        del: async (u) => { calls.push(['DEL', String(u)]); return { ok: true, freed: 1 }; },
      },
    };
    const { win, doc, errors } = await boot({
      pageFile: path.join(PUB, 'user', 'js', 'pages.js'),
      pageName: 'PageMyLicenses', url: 'https://www.bliot.cn/user/index.html#/licenses', U,
      before: (w) => w.localStorage.setItem('user_token', 'test-token'),
    });
    const text = () => doc.body.textContent || '';
    check('用户端授权页零渲染错误', errors.length === 0, errors.join(' ; '));
    check('显示绑定数量 1 / 2', /1\s*\/\s*2/.test(text()), text().slice(0, 200));
    check('有复制与设备按钮', [...doc.querySelectorAll('button')].some((b) => b.textContent.trim() === '设备'));

    const devBtn = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === '设备');
    if (devBtn) {
      click(win, devBtn);
      await wait(200);
      check('用户能看到自己绑定的机器', text().includes('MACHINE-A'), text().slice(0, 240));
      const unbind = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === '解绑');
      check('用户端有自助解绑按钮', !!unbind);
      if (unbind) {
        click(win, unbind);
        await wait(250);
        check('自助解绑走用户端接口',
          calls.some(([m, u]) => m === 'DEL' && u === '/api/portal/licenses/7/devices/11'), JSON.stringify(calls));
      }
    }
    win.close();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });

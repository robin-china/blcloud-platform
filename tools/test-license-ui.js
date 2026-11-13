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
const POOL_LIC = {
  id: 9, license_key: 'LIC-9F8E7D6C-5B4A3928-17061504', user_id: 0, product_id: 2,
  product_name: '花盆卫士 PC 客户端', type: 'subscription', max_devices: 1,
  start_at: '2026-10-01T00:00:00.000Z', end_at: null, status: 'unassigned',
  bound_devices: 0, batch_no: 'B20261102-AB12', channel: '华东代理', duration_days: 365,
  nickname: null, phone: null,
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
      // 确认框已改为自绘的 U.confirm（原生 confirm 在内嵌浏览器里会被静默禁用），
      // 测试里直接放行即可，不需要真的点按钮
      confirm: () => Promise.resolve(true),
      // 用户端新页面守卫走 U.authReady()（handoff 免登换票竞态），DOM 测试 stub 必须带
      authReady: async () => true,
      failMsg: (e, f) => (e && e.message) || f || '失败',
      fmt: { date: () => '2026-11-02', time: () => '2026-11-02 10:00' },
      avatar: (v) => String(v || ''),
      avatarPresets: () => [],
      api: {
        get: async (u) => {
          calls.push(['GET', String(u)]);
          if (String(u).includes('/batches/') && String(u).includes('/keys')) return { list: [{ license_key: 'LIC-9F8E7D6C-5B4A3928-17061504' }] };
          if (String(u) === '/api/licenses/batches') {
            return { list: [{ batch_no: 'B20261102-AB12', product_name: '花盆卫士 PC 客户端', channel: '华东代理', total: 10, bound: 4, unassigned: 6, revoked: 0, created_at: '2026-11-02T02:00:00.000Z' }] };
          }
          if (String(u).startsWith('/api/licenses/')) return { list: [MACHINE], max_devices: 2 };
          if (String(u).startsWith('/api/licenses')) {
            return { list: [LICENSE, POOL_LIC], total: 2, stats: { bound: 1, unassigned: 1, revoked: 0 } };
          }
          if (String(u).startsWith('/api/users')) {
            return { list: [{ id: 3, nickname: '李雷', phone: '13800138000' }], total: 1 };
          }
          if (String(u).startsWith('/api/products')) {
            return { list: [{ id: 2, name: '花盆卫士 PC 客户端', type: 'software' }], total: 1 };
          }
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

    check('卡密池统计显示未绑定数量', /未绑定（卡密池）\s*1/.test(text()), text().slice(0, 400));
    check('未绑定的码标出「未绑定」', text().includes('未绑定'), text().slice(0, 400));
    check('未绑定的码显示「绑定后起算」', text().includes('绑定后起算'), text().slice(0, 400));
    check('未绑定的码显示批次与渠道', text().includes('B20261102-AB12') && text().includes('华东代理'));

    const createBtn = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === '+ 发放 / 印卡');
    check('存在「+ 发放 / 印卡」按钮', !!createBtn);
    if (createBtn) {
      click(win, createBtn);
      await wait(250);
      check('发放弹窗有「数量」字段（批量发码入口）', text().includes('数量（大于 1 则批量生成'), text().slice(-300));
      check('发放弹窗有「卡密池」选项', text().includes('卡密池（先发码，用户自己绑）'), text().slice(-500));
      const modeSel = doc.querySelector('select');
      check('默认是「指定用户」模式', text().includes('选择用户'));
    }

    const bindBtn = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === '绑定用户');
    check('未绑定的码有「绑定用户」按钮', !!bindBtn, [...doc.querySelectorAll('button')].map((b) => b.textContent.trim()).join('|'));
    if (bindBtn) {
      click(win, bindBtn);
      await wait(200);
      check('打开绑定弹窗', text().includes('绑给哪个用户'), text().slice(-300));
      const ok = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === '绑定');
      if (ok) {
        click(win, ok);
        await wait(200);
        check('绑定发出 POST /api/licenses/9/bind',
          calls.some(([m, u]) => m === 'POST' && u === '/api/licenses/9/bind'), JSON.stringify(calls));
      }
    }

    const batchBtn = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === '批次');
    check('存在「批次」按钮', !!batchBtn, [...doc.querySelectorAll('button')].map((b) => b.textContent.trim()).join('|'));
    if (batchBtn) {
      click(win, batchBtn);
      await wait(250);
      check('批次弹窗列出批次号', text().includes('B20261102-AB12'), text().slice(-400));
      check('批次弹窗显示未领数量', text().includes('未领'));
      check('批次弹窗有「复制未领码」', text().includes('复制未领码'));
    }
    check('存在「导出 CSV」按钮', [...doc.querySelectorAll('button')].some((b) => b.textContent.trim() === '导出 CSV'));
    win.close();
  }

  /* ---------------- 用户端我的授权 ---------------- */
  console.log('\n用户端 我的授权（自助解绑）');
  {
    const calls = [];
    const U = {
      basePath: '',
      toast() {},
      // 确认框已改为自绘的 U.confirm（原生 confirm 在内嵌浏览器里会被静默禁用），
      // 测试里直接放行即可，不需要真的点按钮
      confirm: () => Promise.resolve(true),
      // 用户端新页面守卫走 U.authReady()（handoff 免登换票竞态），DOM 测试 stub 必须带
      authReady: async () => true,
      failMsg: (e, f) => (e && e.message) || f || '失败',
      fmt: { date: () => '2026-11-02', time: () => '2026-11-02 10:00' },
      avatar: (v) => String(v || ''),
      avatarPresets: () => [],
      api: {
        get: async (u) => {
          calls.push(['GET', String(u)]);
          if (String(u).includes('/devices')) return { list: [MACHINE], max_devices: 2 };
          return { list: [LICENSE] };
        },
        post: async (u) => { calls.push(['POST', String(u)]); return { ok: true, already: false }; },
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
    check('有「绑定授权码」入口', text().includes('绑定授权码'), text().slice(0, 300));
    check('绑定输入框存在', !!doc.querySelector('input[placeholder="LIC-XXXX-XXXX-XXXX-XXXX"]'));
    const bindBtnU = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === '绑定');
    check('有绑定按钮', !!bindBtnU);
    if (bindBtnU) {
      const input = doc.querySelector('input[placeholder="LIC-XXXX-XXXX-XXXX-XXXX"]');
      input.value = 'LIC-9F8E7D6C-5B4A3928-17061504';
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      await wait(50);
      click(win, bindBtnU);
      await wait(250);
      check('绑定走用户端接口 /api/portal/licenses/bind',
        calls.some(([m, u]) => m === 'POST' && u === '/api/portal/licenses/bind'), JSON.stringify(calls));
    }

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

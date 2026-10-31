/* 管理后台「接入配置 → 微信支付」页渲染自测
 *
 * 背景（2026-10-31）：新商户号拉不到平台证书，必须支持「微信支付公钥」模式。
 * 后台新增了两个字段（公钥ID / 公钥内容）和一个「验签模式」提示。
 * 前端是浏览器内编译的 in-DOM 模板，模板写错会整页白屏 —— 必须真实渲染验证：
 *   1. 切换「微信支付」标签后页面零错误
 *   2. 公钥字段真的渲染出来
 *   3. 验签模式随配置变化（填了公钥 = 本地验签）
 *   4. 保存时公钥会被提交（公钥是公开信息，不加密、可清空）
 *
 * 用法：node tools/test-admin-settings.js
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
const PAGE = fs.readFileSync(path.join(PUB, 'admin', 'js', 'pages-system.js'), 'utf8');

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* wxpayCfg 为空字符串表示未配公钥（自动下载平台证书模式） */
async function render(wxpayCfg) {
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
    beforeParse(win) {
      win.Response = globalThis.Response;
      win.Headers = globalThis.Headers;
    },
  });
  const win = dom.window;
  const posted = [];
  // 只造页面真正用到的 U：basePath / api / toast
  win.U = {
    basePath: '/platform',
    toast() {},
    api: {
      get: async (u) => {
        if (String(u).includes('/api/settings/integration')) {
          return { config: { wxpay: wxpayCfg, wechat: { enabled: 0 } } };
        }
        return {};
      },
      post: async (u, body) => { posted.push({ url: String(u), body }); return { ok: true }; },
    },
  };
  win.fmt = { ago: () => '', money: (n) => String(n) };
  win.eval(VUE);
  win.eval(PAGE);

  win.eval("Vue.createApp(window.PageIntegration).mount('#app')");
  await wait(200);
  const doc = win.document;
  const tabBtn = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === '微信支付');
  if (tabBtn) tabBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, view: win }));
  await wait(200);
  return { win, doc, errors, posted };
}

(async () => {
  console.log('\n管理后台 接入配置 → 微信支付（公钥模式 / 验签模式提示）');

  // ① 未配公钥：页面应正常渲染并提示「自动下载平台证书」
  {
    const { win, doc, errors } = await render({
      enabled: 1, mchid: '1900000109', appid: 'wxPub', api_v3_key: '******',
      mch_cert_serial: '******', private_key: '******', pub_key_id: '', pub_key: '', notify_url: '',
    });
    check('切换微信支付标签后零渲染错误', errors.length === 0, errors.join(' ; '));
    const html = doc.body.innerHTML;
    check('渲染出「微信支付公钥ID」字段', html.includes('微信支付公钥ID'), html.slice(0, 200));
    check('渲染出「微信支付公钥内容」输入框', html.includes('微信支付公钥内容'));
    const modeInput = [...doc.querySelectorAll('input')].find((i) => i.disabled);
    check('未配公钥时提示「自动下载平台证书」', !!modeInput && modeInput.value === '自动下载平台证书',
      modeInput ? modeInput.value : '未找到模式输入框');
    const hint = doc.body.textContent || '';
    check('页面给出「新商户无法下载平台证书」的说明', /无法下载平台证书/.test(hint), '');
    win.close();
  }

  // ② 已配公钥：模式应变为本地验签，且保存时公钥会被提交
  {
    const pubKey = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhki\n-----END PUBLIC KEY-----';
    const { win, doc, errors, posted } = await render({
      enabled: 1, mchid: '1900000109', appid: 'wxPub', api_v3_key: '******',
      mch_cert_serial: '******', private_key: '******',
      pub_key_id: 'PUB_KEY_ID_0000000000000000000000000001', pub_key: pubKey, notify_url: '',
    });
    check('已配公钥时零渲染错误', errors.length === 0, errors.join(' ; '));
    const modeInput = [...doc.querySelectorAll('input')].find((i) => i.disabled);
    check('已配公钥时提示「微信支付公钥（本地验签）」',
      !!modeInput && modeInput.value === '微信支付公钥（本地验签）', modeInput ? modeInput.value : '未找到');
    const saveBtn = [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存');
    check('存在保存按钮', !!saveBtn, [...doc.querySelectorAll('button')].map((b) => b.textContent.trim()).join('|'));
    if (saveBtn) {
      saveBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, view: win }));
      await wait(200);
    }
    const saved = posted.find((p) => p.url.includes('/api/settings/integration/wxpay'));
    check('保存会把公钥提交上去', !!saved && saved.body.pub_key === pubKey, JSON.stringify(saved && saved.body).slice(0, 200));
    check('保存不会提交掩码值', !!saved && !JSON.stringify(saved.body).includes('****'), JSON.stringify(saved && saved.body).slice(0, 200));
    win.close();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();

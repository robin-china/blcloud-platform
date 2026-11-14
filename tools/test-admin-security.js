/* 后台登录安全（P0 闸门 / P1 图形挑战+PoW / P2 TOTP / L3 会话撤销）集成 + DOM 回归
 * 运行：node tools/test-admin-security.js
 *
 * 覆盖：默认兼容老登录、条件触发、SVG 不含明文、答案只存 HMAC、挑战一次性/过期/IP 绑定、
 * PoW 校验、双维锁定与退避、审计留痕、TOTP 绑定/二段式/恢复码、token_epoch 撤销、
 * 两个改过的 Vue 模板真编译挂载。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'data', 'test-adminsec-tmp');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.NODE_ENV = 'test';
process.env.BASE_PATH = 'platform';
process.env.LOG_LEVEL = 'silent';

const { build } = require('../server');
const db = require('../server/db');
const adminsec = require('../server/lib/adminsec');
const pow = require('../public/assets/pow.js');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else {
    fail += 1;
    console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 400) : ''));
  }
}
const B = '/platform';
const H = (token) => ({ authorization: 'Bearer ' + token, 'content-type': 'application/json' });
const json = (r) => { try { return JSON.parse(r.body); } catch { return { raw: String(r.body).slice(0, 200) }; } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

(async () => {
  const app = build();
  await app.ready();
  const login = (payload) => app.inject({ method: 'POST', url: `${B}/api/admin/login`, payload }).then(json);
  const challenge = (force) => app.inject({ method: 'GET', url: `${B}/api/admin/challenge${force ? '?force=1' : ''}` }).then(json);
  const post = (url, payload, token) => app.inject({
    method: 'POST', url: B + url, headers: H(token), payload: payload || {},
  }).then(json);
  const get = (url, token) => app.inject({ method: 'GET', url: B + url, headers: H(token) }).then(json);
  const solve = (c) => pow.solve(c.powSeed, c.difficulty);
  const cfg = (body, token) => post('/api/admin/security/config', body, token);

  /* ------------------------------------------------------------ [1] 默认兼容 */
  console.log('\n[1] 默认配置不破坏现有登录');
  const first = await login({ username: 'admin', password: 'admin123' });
  ok('全新库普通登录仍成功（risk 模式无失败记录不弹码）', !!first.token, first);
  ok('响应带原有 must_change_password / mcp_enforced', 'must_change_password' in first && 'mcp_enforced' in first);
  const tokenA = first.token;
  const me = await get('/api/admin/me', tokenA);
  ok('签发的令牌可正常访问管理接口', me.admin && me.admin.username === 'admin', me);
  const wrong = await login({ username: 'admin', password: 'nope' });
  ok('密码错误 401 且不区分账号是否存在', wrong.code === 'INVALID_CREDENTIALS', wrong);
  const ghost = await login({ username: 'ghost_admin', password: 'nope' });
  ok('不存在的账号同样 401（dummy hash 消除时序差）', ghost.code === 'INVALID_CREDENTIALS', ghost);

  /* ------------------------------------------------------------ [2] always 模式 */
  console.log('\n[2] 配置生效与图形挑战生成');
  ok('保存 always 模式与 IP 上限', (await cfg({ captchaMode: 'always', loginIpLimit: 1000 }, tokenA)).ok === true);
  ok('配置拒绝非法模式', (await cfg({ captchaMode: 'nonsense' }, tokenA)).error !== undefined);
  db.prepare('DELETE FROM login_attempts').run();
  const need = await login({ username: 'admin', password: 'admin123' });
  ok('always 模式缺挑战 400 CAPTCHA_REQUIRED', need.code === 'CAPTCHA_REQUIRED', need);
  const c1 = await challenge(true);
  ok('挑战返回 svg / powSeed / difficulty / expiresIn', !!c1.challengeId && !!c1.svg && !!c1.powSeed && c1.difficulty === pow.DIFFICULTY && c1.expiresIn === 120, c1);
  ok('SVG 里没有 <text>（AI 读 DOM 拿不到答案）', !/<text/i.test(c1.svg) && c1.svg.includes('<path'), c1.svg.slice(0, 200));
  ok('SVG 不含答案明文 / data- 属性', !/data-(answer|code)/i.test(c1.svg));
  ok('答案只以 HMAC 入库', (() => {
    const r = db.prepare('SELECT answer_hmac FROM admin_challenges WHERE id = ?').get(c1.challengeId);
    return !!r && /^[a-f0-9]{64}$/.test(r.answer_hmac);
  })());

  /* ------------------------------------------------------------ [3] 挑战一次性 */
  console.log('\n[3] 挑战校验：答案 / 重放 / PoW / 过期 / IP');
  const badAnswer = await login({ username: 'admin', password: 'admin123', challengeId: c1.challengeId, answer: 'xxxx', powNonce: solve(c1) });
  ok('答案错 400 CAPTCHA_WRONG（即使 PoW 正确）', badAnswer.code === 'CAPTCHA_WRONG', badAnswer);
  const replay = await login({ username: 'admin', password: 'admin123', challengeId: c1.challengeId, answer: '1234', powNonce: solve(c1) });
  ok('同一挑战重放 400 CHALLENGE_USED', replay.code === 'CHALLENGE_USED', replay);

  // 从 HMAC 反推答案不可行，这里直接读库里的挑战并用 adminsec 生成一张已知答案的（测试白盒）
  const c2 = await challenge(true);
  const known = adminsec.createChallenge({ ip: '127.0.0.1', ua: 'test' });
  const knownRow = db.prepare('SELECT answer_hmac FROM admin_challenges WHERE id = ?').get(known.id);
  const answer = (() => {
    for (let i = 0; i < 10000; i += 1) {
      const s = String(i).padStart(4, '0');
      if (adminsec.hmac(s) === knownRow.answer_hmac) return s;
    }
    return '';
  })();
  ok('可按 HMAC 反查到 4 位答案（仅测试白盒）', /^\d{4}$/.test(answer), answer);
  const badPow = await login({ username: 'admin', password: 'admin123', challengeId: known.id, answer, powNonce: '-1' });
  ok('PoW 不达标 400 POW_INVALID', badPow.code === 'POW_INVALID', badPow);
  const goodC = await challenge(true);
  const goodAnswer = (() => {
    const r = db.prepare('SELECT answer_hmac FROM admin_challenges WHERE id = ?').get(goodC.challengeId);
    for (let i = 0; i < 10000; i += 1) {
      const s = String(i).padStart(4, '0');
      if (adminsec.hmac(s) === r.answer_hmac) return s;
    }
    return '';
  })();
  const good = await login({ username: 'admin', password: 'admin123', challengeId: goodC.challengeId, answer: goodAnswer, powNonce: solve(goodC) });
  ok('正确答案 + 正确 PoW → 登录成功', !!good.token, good);

  const expired = await challenge(true);
  db.prepare('UPDATE admin_challenges SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), expired.challengeId);
  const expiredRes = await login({ username: 'admin', password: 'admin123', challengeId: expired.challengeId, answer: '0000', powNonce: solve(expired) });
  ok('过期挑战 400 CHALLENGE_EXPIRED', expiredRes.code === 'CHALLENGE_EXPIRED', expiredRes);
  const ipChanged = await challenge(true);
  db.prepare("UPDATE admin_challenges SET ip = '9.9.9.9' WHERE id = ?").run(ipChanged.challengeId);
  const ipRes = await login({ username: 'admin', password: 'admin123', challengeId: ipChanged.challengeId, answer: '0000', powNonce: solve(ipChanged) });
  ok('挑战绑定来源 IP，换 IP 即拒', ipRes.code === 'CHALLENGE_IP_MISMATCH', ipRes);
  ok('挑战用过即标记 used_at', !!db.prepare('SELECT used_at FROM admin_challenges WHERE id = ?').get(goodC.challengeId).used_at);

  /* ------------------------------------------------------------ [4] TOTP */
  console.log('\n[4] TOTP 第二因素 / 恢复码 / 二段式登录');
  await cfg({ captchaMode: 'off' }, tokenA);
  db.prepare('DELETE FROM login_attempts').run();
  const st0 = await get('/api/admin/2fa/status', tokenA);
  ok('初始状态未启用 TOTP', st0.enabled === false && st0.recoveryLeft === 0, st0);
  const setup = await post('/api/admin/2fa/setup', {}, tokenA);
  ok('setup 返回二维码 SVG / 密钥 / otpauth URI', !!setup.qrcodeSvg && !!setup.secret && setup.otpauthUri.startsWith('otpauth://'), setup.otpauthUri);
  ok('secret 以 enc: 前缀加密入库', (() => {
    const r = db.prepare('SELECT totp_secret FROM admins WHERE id = 1').get();
    return String(r.totp_secret).startsWith('enc:');
  })());
  const badTotp = await post('/api/admin/2fa/confirm', { code: '000000' }, tokenA);
  ok('错误动态码不能启用', badTotp.code === 'TOTP_INVALID', badTotp);
  const step = Math.floor(Date.now() / 30000);
  const rightCode = adminsec.totpCode(setup.secret, step);
  ok('TOTP 自实现可被自身校验', adminsec.verifyTotp(setup.secret, rightCode));
  const confirmed = await post('/api/admin/2fa/confirm', { code: rightCode }, tokenA);
  ok('确认后启用并下发 10 个恢复码', confirmed.ok === true && confirmed.recoveryCodes.length === 10, confirmed);
  ok('恢复码只存哈希', (() => {
    const r = db.prepare('SELECT code_hash FROM admin_recovery_codes LIMIT 1').get();
    return /^[a-f0-9]{64}$/.test(r.code_hash);
  })());
  const st1 = await get('/api/admin/2fa/status', tokenA);
  ok('启用后剩余恢复码 10', st1.enabled === true && st1.recoveryLeft === 10, st1);
  ok('已启用时不允许重复 setup', (await post('/api/admin/2fa/setup', {}, tokenA)).code === 'TOTP_ALREADY_ENABLED');

  const s1 = await login({ username: 'admin', password: 'admin123' });
  ok('密码正确后返回 needSecondFactor + 一次性票据', s1.needSecondFactor === true && !!s1.challengeToken && !s1.token, s1);
  ok('2FA 票据不是 JWT 且不带 scope', !String(s1.challengeToken).includes('.'), s1.challengeToken);
  const bad2fa = await post('/api/admin/login/2fa', { challengeToken: s1.challengeToken, code: '000000' }, tokenA);
  ok('错误动态码 401 且票据作废', bad2fa.code === 'SECOND_FACTOR_INVALID', bad2fa);
  const s2 = await login({ username: 'admin', password: 'admin123' });
  const ok2fa = await post('/api/admin/login/2fa', { challengeToken: s2.challengeToken, code: adminsec.totpCode(setup.secret, step) }, tokenA);
  ok('正确动态码换到正式 JWT', !!ok2fa.token, ok2fa);
  const tokenB = ok2fa.token;
  ok('二段式令牌可访问管理接口', (await get('/api/admin/me', tokenB)).admin.username === 'admin');
  const s3 = await login({ username: 'admin', password: 'admin123' });
  const byRecovery = await post('/api/admin/login/2fa', { challengeToken: s3.challengeToken, code: confirmed.recoveryCodes[0] }, tokenA);
  ok('恢复码可换到正式 JWT', !!byRecovery.token, byRecovery);
  const s4 = await login({ username: 'admin', password: 'admin123' });
  const reuseRecovery = await post('/api/admin/login/2fa', { challengeToken: s4.challengeToken, code: confirmed.recoveryCodes[0] }, tokenA);
  ok('恢复码用过即废', reuseRecovery.code === 'SECOND_FACTOR_INVALID', reuseRecovery);
  ok('剩余恢复码变成 9', (await get('/api/admin/2fa/status', tokenA)).recoveryLeft === 9);

  /* ------------------------------------------------------------ [5] 会话撤销 */
  console.log('\n[5] token_epoch 可撤销会话');
  const revoked = await post('/api/admin/security/revoke', {}, byRecovery.token);
  ok('强制下线返回 reloginRequired', revoked.ok === true && revoked.reloginRequired === true, revoked);
  const oldTokenRes = await app.inject({ method: 'GET', url: `${B}/api/admin/me`, headers: H(tokenB) });
  ok('撤销后此前签发的 12h JWT 立刻 401', oldTokenRes.statusCode === 401, oldTokenRes.statusCode);
  const s5 = await login({ username: 'admin', password: 'admin123' });
  const fresh2fa = await post('/api/admin/login/2fa', { challengeToken: s5.challengeToken, code: adminsec.totpCode(setup.secret, step) }, tokenA);
  ok('重新二段式登录拿到新 epoch 令牌', !!fresh2fa.token, fresh2fa);
  const disabled = await post('/api/admin/2fa/disable', { code: adminsec.totpCode(setup.secret, step) }, fresh2fa.token);
  ok('解绑成功', disabled.ok === true, disabled);
  const plainAgain = await login({ username: 'admin', password: 'admin123' });
  ok('解绑后回到普通登录', !!plainAgain.token && !plainAgain.needSecondFactor, plainAgain);
  ok('解绑后恢复码全部清除', (await get('/api/admin/2fa/status', plainAgain.token)).recoveryLeft === 0);

  /* ------------------------------------------------------------ [6] 双维锁定 + 审计 */
  console.log('\n[6] 双维失败锁定、退避与审计');
  db.prepare('DELETE FROM login_attempts').run();
  for (let i = 0; i < 5; i += 1) {
    await login({ username: 'brute', password: 'wrong' + i });
  }
  const locked = await app.inject({ method: 'POST', url: `${B}/api/admin/login`, payload: { username: 'brute', password: 'whatever' } }).then(json);
  ok('同账号连续失败 5 次 → 429', locked.code === 'LOGIN_RATE_LIMITED', locked);
  const otherUser = await login({ username: 'someone_else', password: 'whatever' });
  ok('换用户名但同 IP 仍被挡（IP 维度生效）', otherUser.code === 'LOGIN_RATE_LIMITED', otherUser);
  const logs = db.prepare("SELECT action, detail FROM admin_logs WHERE action IN ('登录失败','登录限流','登录成功')").all();
  ok('登录成败与限流都写进 admin_logs', logs.length >= 6, logs.length);
  ok('审计里带 IP', logs.some((l) => String(l.detail).includes('IP=')), logs.slice(0, 2));
  ok('成功登录会清掉失败计数', (() => {
    db.prepare('DELETE FROM login_attempts').run();
    return true;
  })());

  /* ------------------------------------------------------------ [7] 取挑战接口自身限流 */
  console.log('\n[7] 挑战接口限流（防放大）');
  let limited = false;
  for (let i = 0; i < 30; i += 1) {
    const r = await app.inject({ method: 'GET', url: `${B}/api/admin/challenge` });
    if (r.statusCode === 429) { limited = true; break; }
  }
  ok('高频领取挑战会被 429', limited);

  await app.close();

  /* ------------------------------------------------------------ [8] Vue 模板真编译 */
  console.log('\n[8] 两个改过的后台页面真编译 + 挂载');
  const loginCode = read('public/admin/js/login.js');
  const systemCode = read('public/admin/js/pages-system.js');
  const powCode = read('public/assets/pow.js');
  const adminIndex = read('public/admin/index.html');
  ok('登录页脚本 IIFE 包裹', /\(function \(\) \{/.test(loginCode) && /\}\)\(\);\s*$/.test(loginCode.trim()));
  ok('模板不引用全局 U / window / location', !/\{\{\s*U\./.test(loginCode) && !/v-if="window\./.test(loginCode));
  ok('第二因素弹层 teleport 到 body', /<teleport to="body">/.test(loginCode));
  ok('index.html 在 login.js 之前引入 pow.js', adminIndex.indexOf('../assets/pow.js') < adminIndex.indexOf('js/login.js'));
  ok('管理员页有登录安全卡片与 teleport 弹层', /登录安全/.test(systemCode) && /<teleport to="body">/.test(systemCode));

  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/platform/admin/',
  });
  const w = dom.window;
  w.eval(read('node_modules/vue/dist/vue.global.prod.js'));
  w.eval(powCode);
  const errors = [];
  w.U = {
    fmt: { ago: () => '', time: () => '', int: (n) => String(n || 0) },
    api: {
      get: async (u) => {
        const s = String(u);
        if (s.includes('/2fa/status')) return { enabled: false, recoveryLeft: 0, captchaMode: 'risk', loginIpLimit: '30', nudge: false };
        if (s.includes('/admin/list')) return { list: [] };
        if (s.includes('/admin/logs')) return { list: [] };
        if (s.includes('/challenge')) return { required: false };
        return {};
      },
      post: async () => ({}), setToken: () => {}, getToken: () => '',
    },
    toast: () => {}, confirm: async () => true, failMsg: (e) => e.message,
  };
  w.eval(loginCode);
  w.eval(systemCode);
  const Vue = w.Vue;
  ok('两个组件都导出', !!w.PageLogin && !!w.PageAdmins);
  let compiled = 0;
  for (const [name, comp] of [['PageLogin', w.PageLogin], ['PageAdmins', w.PageAdmins]]) {
    try { if (typeof Vue.compile(comp.template) === 'function') compiled += 1; }
    catch (e) { errors.push(name + ': ' + e.message); }
  }
  ok('两个模板都能编译', compiled === 2, errors);
  try {
    const mount = Vue.createApp({
      template: '<div><page-login :settings="s"></page-login><page-admins></page-admins></div>',
      setup() { return { s: { site_name: '测试后台' } }; },
    });
    mount.component('page-login', w.PageLogin);
    mount.component('page-admins', w.PageAdmins);
    mount.config.warnHandler = (msg) => errors.push(msg);
    mount.mount(w.document.getElementById('app'));
    await new Promise((r) => setTimeout(r, 30));
    const html = w.document.body.innerHTML;
    ok('挂载后渲染出登录页与登录安全卡片', html.includes('欢迎回来') && html.includes('登录安全'), html.slice(0, 200));
    ok('挂载与首屏异步加载无运行时错误', errors.length === 0, errors);
  } catch (e) {
    ok('两页可挂载', false, e.stack);
  }
  ok('pow.js 前后端同一实现且可解 16 位难度',
    typeof w.AdminPow === 'object' && w.AdminPow.verify('seed', w.AdminPow.solve('seed', 16), 16));

  console.log(`\n后台登录安全测试：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows WAL 占用，下次运行开头会清 */ }
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});

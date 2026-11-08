/* 微信内置浏览器「免扫码登录」（公众号网页授权）自测
 * 覆盖：未配置回登录页、跳到微信授权页的参数、state 防伪、回调建号、
 *       一次性票据兑换、代理渠道归属、错误分支
 * 运行：node tools/test-wechat-oauth.js
 */
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-wxoauth.db');
for (const s of ['', '-wal', '-shm']) fs.rmSync(DB_FILE + s, { force: true });
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.NODE_ENV = 'test';
process.env.BASE_PATH = 'platform';

const db = require('../server/db');
const { setConfig, getConfig } = require('../server/lib/config');
const { build } = require('../server');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 400) : '')); }
}
const B = '/platform';

/* 微信接口桩：app.inject 不走 fetch，所以这里只影响服务端对微信的调用 */
const realFetch = global.fetch;
let oauthTokenCalled = 0;
const lastWxHeaders = [];
const R = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('api.weixin.qq.com')) lastWxHeaders.push((opts && opts.headers) || {});
  if (u.includes('/snsapi/oauth2/access_token')) {
    oauthTokenCalled += 1;
    if (u.includes('code=badcode')) return R({ errcode: 40029, errmsg: 'invalid code' });
    return R({ access_token: 'AT-OAUTH', openid: 'wx-openid-001', scope: 'snsapi_base', unionid: 'uni-001' });
  }
  if (u.includes('/cgi-bin/token')) return R({ access_token: 'AT-BASE', expires_in: 7200 });
  if (u.includes('/cgi-bin/user/info')) {
    return R({ nickname: '微信昵称', headimgurl: 'https://wx.example/a.png', unionid: 'uni-001' });
  }
  if (u.includes('/snsapi/userinfo')) {
    return R({ nickname: '静默之外的昵称', headimgurl: 'https://wx.example/u.png' });
  }
  return realFetch(url, opts);
};

function stateOf(location) {
  const q = new URL(String(location)).searchParams;
  return q.get('state') || '';
}

(async () => {
  const app = build();
  await app.ready();
  const token = (await app.inject({
    method: 'POST', url: `${B}/api/admin/login`, payload: { username: 'admin', password: 'admin123' },
  })).json().token;
  const H = { authorization: 'Bearer ' + token };

  console.log('\n[1] 未配置服务号：不跳微信，回登录页');
  let r = await app.inject({ method: 'GET', url: `${B}/api/wechat/oauth/start?to=space` });
  check('302 回登录页', r.statusCode === 302, r.statusCode);
  check('带 wxerr=off', /#\/login\?wxerr=off$/.test(r.headers.location || ''), r.headers.location);

  let site = (await app.inject({ method: 'GET', url: `${B}/api/portal/site` })).json();
  check('site 接口告知前端未开通网页授权', site.wechat_oauth === false, site.wechat_oauth);

  console.log('\n[2] 配置服务号后：跳微信授权页');
  setConfig('wechat', {
    enabled: 1, appid: 'wxTESTAPPID', appsecret: 'test-secret-0123456789',
    token: 't', aes_key: 'k', oauth_scope: 'snsapi_base',
  });
  site = (await app.inject({ method: 'GET', url: `${B}/api/portal/site` })).json();
  check('site 接口告知前端已开通', site.wechat_oauth === true, site.wechat_oauth);
  check('下发授权范围', site.wechat_oauth_scope === 'snsapi_base', site.wechat_oauth_scope);

  r = await app.inject({ method: 'GET', url: `${B}/api/wechat/oauth/start?to=licenses&agent=AG4CA8D3AA` });
  const loc = r.headers.location || '';
  check('302 到微信授权页', r.statusCode === 302 && loc.startsWith('https://open.weixin.qq.com/connect/oauth2/authorize'), loc.slice(0, 90));
  const u = new URL(loc);
  check('appid 正确', u.searchParams.get('appid') === 'wxTESTAPPID', u.searchParams.get('appid'));
  check('scope 默认静默', u.searchParams.get('scope') === 'snsapi_base', u.searchParams.get('scope'));
  check('redirect_uri 带子路径且指向回调', /\/platform\/api\/wechat\/oauth\/callback$/.test(decodeURIComponent(u.searchParams.get('redirect_uri') || '')), u.searchParams.get('redirect_uri'));
  check('响应不被缓存', /no-store/.test(String(r.headers['cache-control'] || '')), r.headers['cache-control']);
  const st = stateOf(loc);
  check('state 有签名段', st.includes('.') && st.length > 20, st);

  console.log('\n[3] state 防伪');
  r = await app.inject({ method: 'GET', url: `${B}/api/wechat/oauth/callback?code=ok&state=forged.deadbeef` });
  check('伪造 state → 302 登录页 wxerr=state', r.statusCode === 302 && /wxerr=state/.test(r.headers.location || ''), r.headers.location);
  r = await app.inject({ method: 'GET', url: `${B}/api/wechat/oauth/callback?code=ok&state=${encodeURIComponent(st.slice(0, -2) + 'xx')}` });
  check('篡改签名 → 拒绝', /wxerr=state/.test(r.headers.location || ''), r.headers.location);

  // 先造一个生效中的代理商，state 里的 agent 码才有归属对象
  const agentId = db.prepare(`INSERT INTO users (openid, nickname, agent_code, agent_status, created_at)
    VALUES ('agent-openid', '推广代理', 'AG4CA8D3AA', 'active', ?)`).run(new Date().toISOString()).lastInsertRowid;

  console.log('\n[4] 正常回调：建号 + 一次性票据');
  const empty = (t) => (t || '').split('?')[0];
  r = await app.inject({ method: 'GET', url: `${B}/api/wechat/oauth/callback?code=goodcode&state=${encodeURIComponent(st)}` });
  const back = r.headers.location || '';
  check('302 回用户中心', r.statusCode === 302 && /\/platform\/user\/\?t=ho_/.test(back), back);
  check('落到 state 里指定的页面（#/licenses）', back.endsWith('#/licenses'), back.split('#')[1]);
  check('微信接口被真实调用一次', oauthTokenCalled === 1, oauthTokenCalled);
  // 回归守护：Node 内置 fetch 自动补的请求头会让微信返回空 body（Unexpected end of JSON input），
  // 服务端必须显式写死这些头（详见 docs/踩坑记录.md「微信 API 请求头」条目）
  const h = lastWxHeaders.find((x) => x['Accept-Language']);
  check('对微信的请求显式写死了 Accept-Language（防空响应回归）', !!h && h['Accept-Language'] === 'zh-CN', h);
  check('对微信的请求显式写死了 User-Agent', !!h && !!h['User-Agent'], h);

  const ticket = new URL(back).searchParams.get('t');
  const user = db.prepare("SELECT * FROM users WHERE openid = 'wx-openid-001'").get();
  check('自动创建了用户', !!user, user && user.id);
  check('昵称来自微信', user && user.nickname === '微信昵称', user && user.nickname);
  check('新用户归属到 state 里带的代理商', user && user.agent_id === agentId, { got: user && user.agent_id, want: agentId });

  let ex = await app.inject({ method: 'POST', url: `${B}/api/portal/handoff`, payload: { t: ticket } });
  check('票据能换出网页登录态', ex.statusCode === 200 && !!ex.json().token, ex.body.slice(0, 160));
  check('兑换响应不含物联内部账户', ex.statusCode === 200 && !('tb_username' in ex.json().user) && !('tb_password' in ex.json().user), Object.keys(ex.json().user || {}));

  const again = await app.inject({ method: 'POST', url: `${B}/api/portal/handoff`, payload: { t: ticket } });
  check('同一票据不能二次兑换', again.statusCode === 400, again.statusCode);

  console.log('\n[5] 已存在用户：直接登录，不重复建号');
  const before = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  r = await app.inject({ method: 'GET', url: `${B}/api/wechat/oauth/start?to=space` });
  const st2 = stateOf(r.headers.location || '');
  r = await app.inject({ method: 'GET', url: `${B}/api/wechat/oauth/callback?code=goodcode&state=${encodeURIComponent(st2)}` });
  check('第二次回调仍成功', r.statusCode === 302 && /t=ho_/.test(r.headers.location || ''), r.headers.location);
  check('用户没有被重复创建', db.prepare('SELECT COUNT(*) c FROM users').get().c === before, { before, after: db.prepare('SELECT COUNT(*) c FROM users').get().c });

  console.log('\n[6] 失败分支');
  r = await app.inject({ method: 'GET', url: `${B}/api/wechat/oauth/callback?code=badcode&state=${encodeURIComponent(st2)}` });
  check('code 无效 → wxerr=fail', /wxerr=fail/.test(r.headers.location || ''), r.headers.location);
  r = await app.inject({ method: 'GET', url: `${B}/api/wechat/oauth/callback?state=${encodeURIComponent(st2)}` });
  check('用户取消（无 code）→ wxerr=cancel', /wxerr=cancel/.test(r.headers.location || ''), r.headers.location);

  console.log('\n[7] 授权范围可切换');
  setConfig('wechat', { enabled: 1, appid: 'wxTESTAPPID', appsecret: 'test-secret-0123456789', oauth_scope: 'snsapi_userinfo' });
  r = await app.inject({ method: 'GET', url: `${B}/api/wechat/oauth/start?to=space` });
  check('scope=snsapi_userinfo 生效', new URL(r.headers.location || 'https://x/').searchParams.get('scope') === 'snsapi_userinfo',
    r.headers.location);
  check('配置已持久化', getConfig('wechat').oauth_scope === 'snsapi_userinfo', getConfig('wechat').oauth_scope);

  console.log('\n[8] 非法 to 参数被收敛');
  r = await app.inject({ method: 'GET', url: `${B}/api/wechat/oauth/start?to=https://evil.example/x` });
  const st3 = stateOf(r.headers.location || '');
  const payload = JSON.parse(Buffer.from(st3.split('.')[0], 'base64url').toString('utf8'));
  check('开放重定向被拦（回落 space）', payload.to === 'space', payload.to);

  await app.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

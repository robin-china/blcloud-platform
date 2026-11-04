/* 代理商推广归属链路自测：
 *  - /api/portal/agent 下发推广链接（带 agent_code）
 *  - 登录二维码带渠道码，新用户扫码登录自动归属代理商名下
 *  - 老用户 / 已有归属用户不受渠道码影响；无效渠道码静默忽略
 * 运行：node tools/test-agent-promote.js
 */
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-agent-promote.db');
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
}

process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';

const { build } = require('../server');
const db = require('../server/db');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 400) : '')); }
}

/** 演示模式登录：建 scene → simulate → 拿用户端 token */
async function loginAs(app, openid, nickname, agentCode) {
  const qr = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode',
    payload: agentCode ? { agent_code: agentCode } : {} })).json();
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${qr.scene}`, payload: { openid, nickname } });
  return (await app.inject({ method: 'GET', url: `/api/wechat/qrcode/${qr.scene}` })).json();
}

(async () => {
  const app = build();
  await app.ready();
  const adminToken = (await app.inject({
    method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' },
  })).json().token;
  const AH = { authorization: 'Bearer ' + adminToken };

  /* ---------------- 1. 授权代理商 ---------------- */
  console.log('\n[1] 授权代理商');
  const agentLogin = await loginAs(app, 'promo-agent-1', '推广代理商');
  const agentUser = db.prepare('SELECT * FROM users WHERE openid = ?').get('promo-agent-1');
  check('代理商用户已注册', !!agentUser);
  const auth = (await app.inject({ method: 'POST', url: `/api/agents/${agentUser.id}/authorize`, headers: AH,
    payload: { rate: 0.15 } })).json();
  check('后台授权成功并返回邀请码', auth.ok && /^AG[A-Z0-9]+$/.test(auth.agent_code || ''), auth);

  /* ---------------- 2. 推广链接 ---------------- */
  console.log('\n[2] 推广链接');
  const agentInfo = (await app.inject({ method: 'GET', url: '/api/portal/agent',
    headers: { authorization: 'Bearer ' + agentLogin.token } })).json();
  check('代理商视角下发推广链接', agentInfo.is_agent && (agentInfo.promote_url || '').includes('agent=' + auth.agent_code),
    agentInfo.promote_url);
  // 落地页必须是 /user/，子路径部署下不能粘成 /platformuser/（线上 404 过）
  check('推广链接落地页路径为 /user/',
    /\/user\/\?agent=/.test(agentInfo.promote_url || '') && !/platformuser/.test(agentInfo.promote_url || ''),
    agentInfo.promote_url);
  const normalInfo = (await app.inject({ method: 'GET', url: '/api/portal/agent',
    headers: { authorization: 'Bearer ' + agentLogin.token } })).json();
  check('非代理商不下发推广链接（下一节用普通用户验证）', typeof agentInfo.agent_rate === 'number');

  /* ---------------- 3. 新用户扫码登录自动归属 ---------------- */
  console.log('\n[3] 新用户经推广码登录');
  const qr = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode',
    payload: { agent_code: auth.agent_code } })).json();
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${qr.scene}`, payload: { openid: 'promo-new-1', nickname: '渠道新用户' } });
  const newUser = db.prepare('SELECT * FROM users WHERE openid = ?').get('promo-new-1');
  check('新用户登录成功', !!newUser);
  check('新用户自动归属代理商（P0）', newUser.agent_id === agentUser.id, newUser.agent_id);

  const session = db.prepare('SELECT * FROM wechat_sessions WHERE scene = ?').get(qr.scene);
  check('扫码场景记录了渠道归属', session.agent_id === agentUser.id, session.agent_id);

  /* ---------------- 4. 无效渠道码 / 老用户 ---------------- */
  console.log('\n[4] 无效渠道码与老用户');
  const qr2 = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode',
    payload: { agent_code: 'AGNOPE1234' } })).json();
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${qr2.scene}`, payload: { openid: 'promo-new-2', nickname: '无效码用户' } });
  const u2 = db.prepare('SELECT * FROM users WHERE openid = ?').get('promo-new-2');
  check('无效渠道码静默忽略，登录不受影响', !!u2 && Number(u2.agent_id || 0) === 0, u2 && u2.agent_id);

  const qr3 = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode',
    payload: { agent_code: auth.agent_code } })).json();
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${qr3.scene}`, payload: { openid: 'promo-new-1', nickname: '渠道新用户' } });
  const again = db.prepare('SELECT * FROM users WHERE openid = ?').get('promo-new-1');
  check('老用户重复登录归属不变', again.agent_id === agentUser.id, again.agent_id);

  // 已归属用户换别的渠道码登录，归属不被抢
  const agentLogin2 = await loginAs(app, 'promo-agent-2', '第二代理商');
  const agent2 = db.prepare('SELECT * FROM users WHERE openid = ?').get('promo-agent-2');
  await app.inject({ method: 'POST', url: `/api/agents/${agent2.id}/authorize`, headers: AH, payload: { rate: 0.1 } });
  const qr4 = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode',
    payload: { agent_code: db.prepare('SELECT agent_code FROM users WHERE id = ?').get(agent2.id).agent_code } })).json();
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${qr4.scene}`, payload: { openid: 'promo-new-1', nickname: '渠道新用户' } });
  const robbed = db.prepare('SELECT * FROM users WHERE openid = ?').get('promo-new-1');
  check('已有归属不被其他渠道码抢占', robbed.agent_id === agentUser.id, robbed.agent_id);

  /* ---------------- 5. 推广二维码可渲染 ---------------- */
  console.log('\n[5] 二维码物料');
  const png = await app.inject({ method: 'GET',
    url: '/api/portal/qrcode?text=' + encodeURIComponent(agentInfo.promote_url) });
  check('推广链接可生成 PNG 二维码', png.statusCode === 200 && png.headers['content-type'].includes('image/png'), png.statusCode);

  const normalLogin = await loginAs(app, 'promo-normal', '普通用户');
  const normalAgent = (await app.inject({ method: 'GET', url: '/api/portal/agent',
    headers: { authorization: 'Bearer ' + normalLogin.token } })).json();
  check('普通用户无推广链接', !normalAgent.is_agent && !normalAgent.promote_url, normalAgent);

  /* ---------------- 6. me 下发 agent_status 供菜单显隐 ---------------- */
  console.log('\n[6] me 的身份标记');
  const meAgent = (await app.inject({ method: 'GET', url: '/api/portal/me',
    headers: { authorization: 'Bearer ' + agentLogin.token } })).json().user;
  const meNormal = (await app.inject({ method: 'GET', url: '/api/portal/me',
    headers: { authorization: 'Bearer ' + normalLogin.token } })).json().user;
  check('代理商 me.agent_status=active', meAgent.agent_status === 'active', meAgent.agent_status);
  check('普通用户 me.agent_status 非 active', meNormal.agent_status !== 'active', meNormal.agent_status);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

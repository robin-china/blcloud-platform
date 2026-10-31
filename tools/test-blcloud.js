/* blcloud 端到端自测：密钥 → 额度 → 代理调用 → 统计 → 兑换
 * 无真实设备平台时用 mock 覆盖 services/tb.js 的两个函数即可跑通。
 * 用法：node tools/test-blcloud.js
 */
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-blcloud.db');
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
}
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';

const { build } = require('../server');
const db = require('../server/db');
const tb = require('../server/services/tb');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 200) : ''); }
}

/* ---------- mock 设备平台 ---------- */
const MOCK_DEVICES = [
  { id: { id: 'dev-1' }, name: '花盆卫士-01', type: 'sensor', label: 'A' },
  { id: { id: 'dev-2' }, name: '水泵-01', type: 'pump', label: 'B' },
];
let mockCalls = [];
tb.userJwt = async function (username, password) {
  if (!username || !password) throw new Error('该用户尚未开通 blcloud 物联账户');
  return 'mock.jwt.token';
};
tb.jwtExp = () => Date.now() + 3600000;
tb.dropUserJwt = () => {};
tb.raw = async function (method, path, opts) {
  mockCalls.push({ method, path, query: opts.query || {}, body: opts.body });
  if (path === '/api/auth/user') return { status: 200, ok: true, data: { id: { id: 'u1' } } };
  if (path === '/api/user/devices') {
    return { status: 200, ok: true, data: { data: MOCK_DEVICES, totalPages: 1, hasNext: false } };
  }
  if (path.startsWith('/api/device/') && path.endsWith('/credentials')) {
    return { status: 200, ok: true, data: { credentialsType: 'ACCESS_TOKEN', credentialsId: 'TB-TOKEN-XXX' } };
  }
  if (path.startsWith('/api/device/')) return { status: 200, ok: true, data: MOCK_DEVICES[0] };
  if (path.includes('/values/timeseries')) {
    return { status: 200, ok: true, data: { temperature: [{ ts: Date.now(), value: '26.4' }] } };
  }
  if (path.includes('/values/attributes')) return { status: 200, ok: true, data: [{ key: 'fw', value: '1.2' }] };
  if (path.startsWith('/api/plugins/telemetry/')) return { status: 200, ok: true, data: {} };
  if (path.startsWith('/api/rpc/')) return { status: 200, ok: true, data: { ok: true } };
  if (path === '/api/tenant/devices') return { status: 403, ok: false, data: { message: 'forbidden' } };
  return { status: 404, ok: false, data: { message: 'not found: ' + path } };
};

(async () => {
  const app = build();
  await app.ready();
  const H = (t) => ({ authorization: 'Bearer ' + t });

  console.log('\n[1] 准备用户');
  let r = await app.inject({ method: 'POST', url: '/api/wechat/qrcode', payload: {} });
  const scene = r.json().scene;
  const openid = 'blc' + Math.random().toString(36).slice(2, 8);
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${scene}`, payload: { openid, nickname: 'blcloud 用户' } });
  r = await app.inject({ method: 'GET', url: `/api/wechat/qrcode/${scene}` });
  const token = r.json().token;
  const userId = r.json().user.id;
  check('扫码登录拿到 token', !!token, r.json());
  check('内部账户按 blcloud 规则生成（仅入库，不对外返回）', (() => {
    const row = db.prepare('SELECT tb_username FROM users WHERE id = ?').get(userId);
    const body = JSON.stringify(r.json());
    return String(row.tb_username || '').endsWith('@blcloud.cn') && !body.includes('tb_username') && !body.includes('tb_password');
  })(), { userId });

  console.log('\n[2] 免费额度自动发放');
  r = await app.inject({ method: 'GET', url: '/api/portal/blcloud/overview', headers: H(token) });
  const quota0 = r.json().quota;
  check('首次访问发放免费额度 10000', quota0.total === 10000 && quota0.remaining === 10000, quota0);

  console.log('\n[3] 创建密钥');
  r = await app.inject({ method: 'POST', url: '/api/portal/blcloud/keys', headers: H(token), payload: { name: '测试密钥', quota: 1000 } });
  const secret = r.json().secret;
  const keyId = r.json().key && r.json().key.id;
  check('密钥以 blc_ 开头', String(secret).startsWith('blc_'), secret);
  check('密钥额度分配 1000', r.json().key && r.json().key.quota === 1000, r.json().key);
  r = await app.inject({ method: 'POST', url: '/api/portal/blcloud/keys', headers: H(token), payload: { name: '超额', quota: 999999 } });
  check('超出账户额度被拒绝', r.statusCode === 400, r.json());

  console.log('\n[4] 调用设备接口（代理模式）');
  const K = { 'x-blc-key': secret };
  r = await app.inject({ method: 'GET', url: '/api/blcloud/v1/devices', headers: K });
  check('设备列表返回数据', r.statusCode === 200 && Array.isArray(r.json().data?.data), r.json());
  check('正向转发到 /api/user/devices', mockCalls.some((c) => c.path === '/api/user/devices'), mockCalls.slice(-1));
  check('记账扣减 1 次', r.json().cost === 1, r.json().cost);

  r = await app.inject({ method: 'GET', url: '/api/blcloud/v1/devices/dev-1/telemetry?keys=temperature', headers: K });
  check('遥测读取成功', r.statusCode === 200 && !!r.json().data?.temperature, r.json());

  r = await app.inject({ method: 'GET', url: '/api/blcloud/v1/devices/dev-1/credentials', headers: K });
  check('设备凭据返回', r.statusCode === 200 && r.json().data?.credentialsId === 'TB-TOKEN-XXX', r.json());

  console.log('\n[5] 权限与额度控制');
  r = await app.inject({ method: 'GET', url: '/api/blcloud/v1/devices', headers: {} });
  check('缺少密钥返回 401', r.statusCode === 401 && r.json().code === 'KEY_MISSING', r.json());
  r = await app.inject({ method: 'GET', url: '/api/blcloud/v1/devices', headers: { 'x-blc-key': 'blc_badkey' } });
  check('错误密钥返回 401', r.statusCode === 401 && r.json().code === 'KEY_INVALID', r.json());

  // 只读密钥无法写入
  r = await app.inject({ method: 'POST', url: '/api/portal/blcloud/keys', headers: H(token), payload: { name: '只读', quota: 10, scopes: 'device.read' } });
  const roSecret = r.json().secret;
  r = await app.inject({ method: 'POST', url: '/api/blcloud/v1/devices/dev-1/rpc', headers: { 'x-blc-key': roSecret }, payload: { method: 'reboot' } });
  check('只读密钥写操作被拒 403', r.statusCode === 403 && r.json().code === 'SCOPE_DENIED', r.json());

  // 写入密钥可用
  r = await app.inject({ method: 'POST', url: '/api/portal/blcloud/keys', headers: H(token), payload: { name: '读写', quota: 50, scopes: 'device.read,device.write' } });
  const rwSecret = r.json().secret;
  r = await app.inject({ method: 'POST', url: '/api/blcloud/v1/devices/dev-1/rpc', headers: { 'x-blc-key': rwSecret }, payload: { method: 'reboot', params: {} } });
  check('读写密钥可下发 RPC', r.statusCode === 200 && r.json().cost === 5, r.json());

  // 密钥额度耗尽
  const tiny = (await app.inject({ method: 'POST', url: '/api/portal/blcloud/keys', headers: H(token), payload: { name: '小额', quota: 2, scopes: 'device.read' } })).json().secret;
  await app.inject({ method: 'GET', url: '/api/blcloud/v1/devices', headers: { 'x-blc-key': tiny } });
  await app.inject({ method: 'GET', url: '/api/blcloud/v1/devices', headers: { 'x-blc-key': tiny } });
  r = await app.inject({ method: 'GET', url: '/api/blcloud/v1/devices', headers: { 'x-blc-key': tiny } });
  check('密钥额度耗尽返回 402', r.statusCode === 402 && r.json().code === 'KEY_QUOTA_EXCEEDED', r.json());

  console.log('\n[6] 透传白名单');
  r = await app.inject({ method: 'POST', url: '/api/blcloud/v1/proxy', headers: { 'x-blc-key': rwSecret }, payload: { method: 'GET', path: '/api/admin/users' } });
  check('非白名单路径被拒 403', r.statusCode === 403 && r.json().code === 'PATH_FORBIDDEN', r.json());
  r = await app.inject({ method: 'POST', url: '/api/blcloud/v1/proxy', headers: { 'x-blc-key': rwSecret }, payload: { method: 'GET', path: '/api/tenant/devices' } });
  check('越权路径被设备平台拒绝（403）', r.statusCode === 400 && r.json().code === 'TB_ERROR', r.json());

  console.log('\n[7] 直接签发令牌');
  r = await app.inject({ method: 'POST', url: '/api/blcloud/v1/token', headers: { 'x-blc-key': rwSecret }, payload: {} });
  check('签发成功且扣 10 次', r.statusCode === 200 && r.json().cost === 10 && !!r.json().token, r.json());

  console.log('\n[8] 统计与额度');
  r = await app.inject({ method: 'GET', url: '/api/portal/blcloud/overview', headers: H(token) });
  const ov = r.json();
  check('账户已用额度 > 0', ov.quota.used > 0, ov.quota);
  check('今日调用 > 0', ov.todayCalls > 0, ov.todayCalls);
  check('接口分布有记录', (ov.byEndpoint || []).length > 0, ov.byEndpoint);
  check('趋势数据含今天', (ov.daily || []).some((d) => d.calls > 0), ov.daily);

  console.log('\n[9] 积分兑换额度');
  db.prepare('UPDATE users SET points = 500 WHERE id = ?').run(userId);
  r = await app.inject({ method: 'POST', url: '/api/portal/blcloud/exchange', headers: H(token), payload: { points: 100 } });
  check('兑换 100 积分得 10000 次', r.statusCode === 200 && r.json().gain === 10000, r.json());
  r = await app.inject({ method: 'POST', url: '/api/portal/blcloud/exchange', headers: H(token), payload: { points: 99999 } });
  check('积分不足被拒', r.statusCode === 400, r.json());

  console.log('\n[10] 管理端');
  const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' } });
  const at = login.json().token;
  r = await app.inject({ method: 'GET', url: '/api/admin/blcloud/stats', headers: H(at) });
  check('平台统计返回', r.statusCode === 200 && r.json().keys.total >= 4, r.json().keys);
  r = await app.inject({ method: 'GET', url: '/api/admin/blcloud/keys?q=blcloud', headers: H(at) });
  check('密钥列表可搜索', r.statusCode === 200 && (r.json().list || []).length > 0, r.json());
  r = await app.inject({ method: 'POST', url: '/api/admin/blcloud/quota', headers: H(at), payload: { user_id: userId, delta: 50000, reason: '测试赠送' } });
  check('管理员加额度生效', r.statusCode === 200 && r.json().quota.total >= 60000, r.json().quota);
  r = await app.inject({ method: 'POST', url: `/api/admin/blcloud/keys/${keyId}/status`, headers: H(at), payload: { status: 'revoked' } });
  check('停用密钥成功', r.statusCode === 200 && r.json().key.status === 'revoked', r.json());
  r = await app.inject({ method: 'GET', url: '/api/blcloud/v1/devices', headers: { 'x-blc-key': secret } });
  check('停用后调用被拒 403', r.statusCode === 403 && r.json().code === 'KEY_DISABLED', r.json());
  r = await app.inject({ method: 'GET', url: '/api/admin/blcloud/usage?pageSize=5', headers: H(at) });
  check('调用明细可查', r.statusCode === 200 && (r.json().list || []).length > 0, r.json().total);

  console.log('\n[11] 全局开关');
  r = await app.inject({ method: 'POST', url: '/api/admin/blcloud/settings', headers: H(at), payload: { enabled: false } });
  check('停用开关保存', r.statusCode === 200 && r.json().cfg.enabled === false, r.json().cfg);
  r = await app.inject({ method: 'GET', url: '/api/blcloud/v1/devices', headers: { 'x-blc-key': rwSecret } });
  check('停用后拒绝调用 402', r.statusCode === 402 && r.json().code === 'BLCLOUD_DISABLED', r.json());
  await app.inject({ method: 'POST', url: '/api/admin/blcloud/settings', headers: H(at), payload: { enabled: true } });

  await app.close();
  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('运行异常：', e); process.exit(1); });

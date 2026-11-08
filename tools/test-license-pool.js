/* 卡密池 / 导出对账 / 离线票据自测：node tools/test-license-pool.js
 *
 * 三段能力，都是「渠道卖卡」这条业务线缺的：
 *   1. 卡密池：码可以先印、后绑；绑定那一刻才开始计时
 *   2. 导出 CSV：按筛选条件导出对账
 *   3. 离线票据：Ed25519 签名，客户端离线也能自证授权，改时间骗不过
 * 使用独立测试库 data/test-license-pool.db，不影响正式数据
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-license-pool.db');
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
}
const KEY_FILE = path.join(__dirname, '..', 'data', 'test-offline-key.json');
if (fs.existsSync(KEY_FILE)) fs.rmSync(KEY_FILE, { force: true });

process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.OFFLINE_KEY_PATH = KEY_FILE;

const { build } = require('../server');
const db = require('../server/db');
const offlineKey = require('../server/lib/offlinekey');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 240) : '')); }
}

function signReq(secret, appKey, method, fullPath, bodyObj) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(6).toString('hex');
  const raw = bodyObj && Object.keys(bodyObj).length ? JSON.stringify(bodyObj) : '';
  const sig = crypto.createHmac('sha256', secret)
    .update([appKey, method.toUpperCase(), fullPath, timestamp, nonce, raw].join('\n'))
    .digest('hex');
  const headers = { 'x-app-key': appKey, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-signature': sig };
  if (raw) headers['content-type'] = 'application/json';
  return { headers, body: raw || undefined };
}

async function newUser(app, openid) {
  const scene = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode', payload: {} })).json().scene;
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${scene}`, payload: { openid, nickname: openid } });
  return (await app.inject({ method: 'GET', url: `/api/wechat/qrcode/${scene}` })).json();
}

(async () => {
  const app = build();
  await app.ready();

  const adminToken = (await app.inject({
    method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' },
  })).json().token;
  const AH = { authorization: 'Bearer ' + adminToken };

  const product = db.prepare("SELECT * FROM products WHERE type = 'software' LIMIT 1").get();
  const u1 = await newUser(app, 'pool-u1-' + Math.random().toString(36).slice(2, 6));
  const u2 = await newUser(app, 'pool-u2-' + Math.random().toString(36).slice(2, 6));
  const U1 = { authorization: 'Bearer ' + u1.token };
  const U2 = { authorization: 'Bearer ' + u2.token };

  /* ---------------- 1. 印卡：不指定用户 ---------------- */
  console.log('\n卡密池：先印卡，后绑定');
  const printed = await app.inject({
    method: 'POST', url: '/api/licenses/batch', headers: AH,
    payload: { product_id: product.id, count: 5, type: 'subscription', days: 365, max_devices: 1, channel: '华东代理' },
  });
  const pj = printed.json();
  check('不传 user_id 也能批量生成（卡密池）', printed.statusCode === 200 && pj.count === 5, pj);
  check('返回批次号', /^B\d{8}-[0-9A-F]{4}$/.test(pj.batch_no || ''), pj.batch_no);
  check('标记为卡密池模式', pj.mode === 'pool', pj.mode);

  const poolKey = pj.license_keys[0];
  const poolRow = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(poolKey);
  check('码未分配用户', poolRow.user_id === 0, poolRow.user_id);
  check('状态是 unassigned', poolRow.status === 'unassigned', poolRow.status);
  check('没有到期时间（绑定后起算）', !poolRow.end_at, poolRow.end_at);
  check('记住时长 365 天', poolRow.duration_days === 365, poolRow.duration_days);
  check('渠道写进去了', poolRow.channel === '华东代理', poolRow.channel);

  const listPool = await app.inject({ method: 'GET', url: '/api/licenses?status=unassigned', headers: AH });
  check('列表能按「未绑定」筛出 5 张', listPool.json().total === 5, listPool.json().total);
  check('列表带统计（未绑定数）', listPool.json().stats && listPool.json().stats.unassigned === 5, listPool.json().stats);

  /* ---------------- 2. 未绑定的码不能激活 ---------------- */
  console.log('\n未绑定的码不能直接激活');
  const openApp = (await app.inject({
    method: 'POST', url: '/api/open-apps', headers: AH,
    payload: { name: '卡密池测试应用', product_id: product.id, version: '1.0.0', offline_days: 3 },
  })).json();
  const AK = openApp.app_key;
  const AS = openApp.app_secret;

  const actBody = { license_key: poolKey, machine_id: 'M-A', machine_name: 'PC', version: '1.0.0' };
  const actSign = signReq(AS, AK, 'POST', '/api/open/v1/auth/activate', actBody);
  const actBefore = await app.inject({
    method: 'POST', url: '/api/open/v1/auth/activate', headers: actSign.headers, payload: actBody,
  });
  check('未绑定的码激活被拒（403 LICENSE_UNASSIGNED）',
    actBefore.statusCode === 403 && actBefore.json().code === 'LICENSE_UNASSIGNED', actBefore.json());
  check('拒绝原因告诉用户该怎么做',
    /绑定/.test(actBefore.json().message || actBefore.json().reason_text || ''), actBefore.json().message);

  /* ---------------- 3. 用户自助绑定 ---------------- */
  console.log('\n用户自助绑定卡密');
  const bind1 = await app.inject({
    method: 'POST', url: '/api/portal/licenses/bind', headers: U1,
    payload: { license_key: poolKey.toLowerCase() },
  });
  check('用户端绑定成功（大小写不敏感）', bind1.statusCode === 200 && bind1.json().ok === true, bind1.json());

  const afterBind = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(poolKey);
  check('绑定后归属该用户', afterBind.user_id === u1.user.id, afterBind.user_id);
  check('状态变为 active', afterBind.status === 'active', afterBind.status);
  check('记录绑定方式为自助', afterBind.bound_by === 'self', afterBind.bound_by);
  const startMs = new Date(afterBind.start_at).getTime();
  check('有效期从绑定这一刻起算（±60s）', Math.abs(Date.now() - startMs) < 60000, afterBind.start_at);
  const days = (new Date(afterBind.end_at).getTime() - startMs) / 86400000;
  check('到期时间 = 绑定时间 + 365 天', Math.abs(days - 365) < 0.01, days);

  const myList = await app.inject({ method: 'GET', url: '/api/portal/licenses', headers: U1 });
  check('用户端「我的授权」能看到这张码', myList.json().list.some((l) => l.license_key === poolKey), myList.json().list.length);

  const bindAgain = await app.inject({
    method: 'POST', url: '/api/portal/licenses/bind', headers: U1, payload: { license_key: poolKey },
  });
  check('同一用户重复绑定是幂等的', bindAgain.statusCode === 200 && bindAgain.json().already === true, bindAgain.json());

  const steal = await app.inject({
    method: 'POST', url: '/api/portal/licenses/bind', headers: U2, payload: { license_key: poolKey },
  });
  check('别人抢绑被拒（400）', steal.statusCode === 400, steal.json());
  check('不泄露「这张码存在但属于别人」', /无效或已被使用/.test(steal.json().error || ''), steal.json().error);

  const bogus = await app.inject({
    method: 'POST', url: '/api/portal/licenses/bind', headers: U2, payload: { license_key: 'LIC-00000000-00000000-00000000' },
  });
  check('不存在的码给出同一句提示（防枚举）', /无效或已被使用|不存在/.test(bogus.json().error || ''), bogus.json().error);

  /* ---------------- 4. 管理员把卡绑给用户 ---------------- */
  console.log('\n后台绑定 / 批次管理');
  const secondKey = pj.license_keys[1];
  const secondRow = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(secondKey);
  const adminBind = await app.inject({
    method: 'POST', url: `/api/licenses/${secondRow.id}/bind`, headers: AH, payload: { user_id: u2.user.id },
  });
  check('后台能把卡密绑给指定用户', adminBind.statusCode === 200 && adminBind.json().ok === true, adminBind.json());
  const boundRow = db.prepare('SELECT * FROM licenses WHERE id = ?').get(secondRow.id);
  check('绑定方式记录为后台操作', boundRow.bound_by === 'admin', boundRow.bound_by);
  check('绑定后立即可用于激活（状态 active）', boundRow.status === 'active', boundRow.status);

  const batches = await app.inject({ method: 'GET', url: '/api/licenses/batches', headers: AH });
  const b = batches.json().list.find((x) => x.batch_no === pj.batch_no);
  check('批次统计：总数 5', b && b.total === 5, b);
  check('批次统计：已领 2', b && b.bound === 2, b);
  check('批次统计：未领 3', b && b.unassigned === 3, b);

  const keysOfBatch = await app.inject({
    method: 'GET', url: `/api/licenses/batches/${pj.batch_no}/keys?unbound=1`, headers: AH,
  });
  check('能单独取出未领的码（复制/再导出）', keysOfBatch.json().list.length === 3, keysOfBatch.json().list.length);
  check('取出的码都是未绑定状态', keysOfBatch.json().list.every((x) => x.status === 'unassigned'), keysOfBatch.json().list);

  /* ---------------- 5. 作废整批未领取的码 ---------------- */
  console.log('\n作废批次里没领走的码');
  const revokeBatch = await app.inject({
    method: 'POST', url: `/api/licenses/batches/${pj.batch_no}/revoke`, headers: AH, payload: {},
  });
  check('一次作废 3 张未领取的码', revokeBatch.json().revoked === 3, revokeBatch.json());
  const revokedRow = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(pj.license_keys[3]);
  check('被作废的码状态为 revoked', revokedRow.status === 'revoked', revokedRow.status);
  const useRevoked = await app.inject({
    method: 'POST', url: '/api/portal/licenses/bind', headers: U1, payload: { license_key: pj.license_keys[3] },
  });
  check('作废的码不能再绑定', useRevoked.statusCode === 400 && useRevoked.json().code === 'LICENSE_REVOKED', useRevoked.json());

  const resumePool = await app.inject({ method: 'POST', url: `/api/licenses/${revokedRow.id}/resume`, headers: AH, payload: {} });
  check('恢复后回到「未绑定」而不是「有效」（否则成死卡）', resumePool.json().status === 'unassigned', resumePool.json());

  /* ---------------- 6. 导出 CSV ---------------- */
  console.log('\n导出对账 CSV');
  const csvRes = await app.inject({ method: 'GET', url: `/api/licenses/export.csv?batch_no=${pj.batch_no}`, headers: AH });
  check('导出返回 200', csvRes.statusCode === 200, csvRes.statusCode);
  check('Content-Type 是 CSV', /text\/csv/.test(csvRes.headers['content-type'] || ''), csvRes.headers['content-type']);
  check('带下载文件名', /attachment; filename="licenses-\d{8}\.csv"/.test(csvRes.headers['content-disposition'] || ''),
    csvRes.headers['content-disposition']);
  const csv = csvRes.body;
  check('带 UTF-8 BOM（Excel 双击不乱码）', csv.charCodeAt(0) === 0xFEFF, csv.charCodeAt(0).toString(16));
  const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
  check('表头含授权码/批次/渠道/状态', /授权码/.test(lines[0]) && /批次/.test(lines[0]) && /渠道/.test(lines[0]) && /状态/.test(lines[0]), lines[0]);
  check('行数 = 表头 + 5 张码', lines.length === 6, lines.length);
  check('导出的确实是这一批', lines.slice(1).every((l) => l.includes(pj.batch_no)), lines.slice(0, 3));
  check('未绑定的码状态写成中文「未绑定」', lines.some((l) => l.includes('未绑定')), lines.slice(1, 3));

  const csvNoAuth = await app.inject({ method: 'GET', url: '/api/licenses/export.csv' });
  check('未登录不能导出（401）', csvNoAuth.statusCode === 401, csvNoAuth.statusCode);

  /* CSV 里以 = 开头的单元格要被转义，否则 Excel 会当公式执行 */
  db.prepare('UPDATE licenses SET remark = ? WHERE license_key = ?').run('=1+1', poolKey);
  const csv2 = (await app.inject({ method: 'GET', url: `/api/licenses/export.csv?q=${encodeURIComponent(poolKey)}`, headers: AH })).body;
  check('Excel 公式注入被转义（=1+1 → 前缀单引号）', csv2.includes("'=1+1"), csv2.slice(-200));

  /* ---------------- 7. 离线票据 ---------------- */
  console.log('\n离线票据（Ed25519）');
  const actBody2 = { license_key: poolKey, machine_id: 'M-A', machine_name: 'PC', version: '1.0.0' };
  const s2 = signReq(AS, AK, 'POST', '/api/open/v1/auth/activate', actBody2);
  const act = await app.inject({ method: 'POST', url: '/api/open/v1/auth/activate', headers: s2.headers, payload: actBody2 });
  check('绑定后的码可以正常激活', act.statusCode === 200 && act.json().valid === true, act.json());
  const CH = { authorization: 'Bearer ' + act.json().access_token };

  const ticketRes = await app.inject({ method: 'POST', url: '/api/open/v1/license/ticket', headers: CH, payload: {} });
  const tk = ticketRes.json();
  check('拿到票据', ticketRes.statusCode === 200 && /^v1\.[\w-]+\.[\w-]+$/.test(tk.ticket || ''), tk);
  check('声明算法为 Ed25519', tk.alg === 'Ed25519', tk.alg);
  check('带 kid 便于客户端固定公钥', /^[0-9a-f]{16}$/.test(tk.kid || ''), tk.kid);

  const v = offlineKey.verify(tk.ticket, tk.public_key);
  check('票据验签通过', v.ok === true, v);
  check('票据里的机器码与激活时一致', v.ok && v.payload.machine_id === 'M-A', v.payload);
  check('票据带 offline_days=3', v.ok && v.payload.offline_days === 3, v.payload);
  check('票据 exp ≈ 签发 + 3 天', v.ok && Math.abs((v.payload.exp - v.payload.iat) - 3 * 86400) < 5,
    v.ok ? [v.payload.iat, v.payload.exp] : v);

  /* 篡改 payload：把 exp 改成十年后 —— 没有私钥就过不了验签 */
  const parts = tk.ticket.split('.');
  const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  payload.exp = payload.exp + 3650 * 86400;
  const forgedBody = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const forged = `v1.${forgedBody}.${parts[2]}`;
  check('改掉 exp 后验签失败（改时间骗不过）', offlineKey.verify(forged, tk.public_key).ok === false, offlineKey.verify(forged, tk.public_key));

  const pubRes = await app.inject({
    method: 'GET', url: '/api/open/v1/app/pubkey', headers: signReq(AS, AK, 'GET', '/api/open/v1/app/pubkey').headers,
  });
  check('应用签名可取到验签公钥', pubRes.json().public_key === tk.public_key, pubRes.json().kid);
  check('公钥接口的 kid 与票据一致', pubRes.json().kid === tk.kid, [pubRes.json().kid, tk.kid]);
  const pubNoAuth = await app.inject({ method: 'GET', url: '/api/open/v1/app/pubkey' });
  check('取公钥也要应用签名（401）', pubNoAuth.statusCode === 401, pubNoAuth.statusCode);

  /* offline_days = 0 的授权：票据只覆盖本次会话 */
  const zeroApp = (await app.inject({
    method: 'POST', url: '/api/open-apps', headers: AH,
    payload: { name: '强制联网应用', product_id: product.id, version: '1.0.0', offline_days: 0 },
  })).json();
  db.prepare('UPDATE licenses SET max_devices = 5 WHERE license_key = ?').run(poolKey);
  const zb = { license_key: poolKey, machine_id: 'M-ZERO', machine_name: 'PC', version: '1.0.0' };
  const zs = signReq(zeroApp.app_secret, zeroApp.app_key, 'POST', '/api/open/v1/auth/activate', zb);
  const zact = await app.inject({ method: 'POST', url: '/api/open/v1/auth/activate', headers: zs.headers, payload: zb });
  check('offline_days=0 的应用也能激活', zact.statusCode === 200, zact.json());
  const zt = (await app.inject({
    method: 'POST', url: '/api/open/v1/license/ticket',
    headers: { authorization: 'Bearer ' + zact.json().access_token }, payload: {},
  })).json();
  check('offline_days=0 时票据只覆盖会话（不是 0 秒）',
    zt.payload && zt.payload.exp - zt.payload.iat > 60 && zt.payload.exp - zt.payload.iat <= 2 * 3600 + 5,
    zt.payload && [zt.payload.iat, zt.payload.exp]);

  /* 吊销后不能再换票据 */
  await app.inject({ method: 'POST', url: `/api/licenses/${db.prepare('SELECT id FROM licenses WHERE license_key = ?').get(poolKey).id}/revoke`, headers: AH, payload: {} });
  const tkAfter = await app.inject({ method: 'POST', url: '/api/open/v1/license/ticket', headers: CH, payload: {} });
  check('吊销后票据接口立刻拒绝', tkAfter.statusCode === 401 || tkAfter.statusCode === 403, tkAfter.json());

  const auditCount = db.prepare("SELECT COUNT(*) AS c FROM admin_logs WHERE action IN ('批量发放授权','绑定卡密','作废卡密批次','导出授权清单')").get().c;
  check('印卡/绑定/作废/导出都写了审计', auditCount >= 4, auditCount);

  await app.close();
  try {
    for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm', KEY_FILE]) {
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
  } catch { /* 清理失败不影响结论 */ }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });

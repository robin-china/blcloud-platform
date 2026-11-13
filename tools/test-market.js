/* 模板市场（P1 + P3 + P4）集成自测
 * 运行：node tools/test-market.js
 *
 * 覆盖：枚举字典即时生效、4 维筛选 / 4 排序 / (sortKey,id) 游标不漏不重、
 * 列表详情不泄 fileUrl、北京日切签到幂等、新用户 +200、兑换事务原子扣分、
 * 已购归账号且重复下载不扣分（downloads 累加）、5 分钟一次性短链过期/重放、
 * Bearer + x-nonce 强制、机器码不一致、下架/缺文件不发货、有已购禁止删除。
 */
const fs = require('fs');
const path = require('path');

const TMP = path.join(__dirname, '..', 'data', 'test-market-tmp');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.MARKET_DIR = path.join(TMP, 'market');
process.env.UPDATES_DIR = path.join(TMP, 'updates');
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.NODE_ENV = 'test';
process.env.BASE_PATH = 'platform';

const { build } = require('../server');
const db = require('../server/db');
const market = require('../server/lib/market');
const pointsLib = require('../server/lib/points');
const { chinaDay } = require('../server/lib/util');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else {
    fail++;
    console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 400) : ''));
  }
}

const B = '/platform';
const OPEN = B + '/api/open/v1';
const t = new Date().toISOString();
const future = () => new Date(Date.now() + 86400000).toISOString();
let nonceSeq = 0;
const nonce = () => `mkt-n-${++nonceSeq}-${Math.random().toString(36).slice(2, 8)}`;

function json(res) {
  try { return JSON.parse(res.body); } catch { return { raw: String(res.body).slice(0, 200) }; }
}

function multipart(filename, content) {
  const boundary = '----mkt' + Date.now() + Math.random().toString(36).slice(2, 6);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, Buffer.from(content), tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

(async () => {
  /* ---------------------------------------------------------------- 造数据 */
  const appKey = 'ak_market_test';
  db.prepare(`INSERT INTO open_apps (app_key, app_secret, name, status, public_auth, offline_days, created_at)
    VALUES (?,?,?,?,1,7,?)`).run(appKey, 'secret_market_test', 'LabelGo 模板市场测试', 'active', t);
  const appId = db.prepare('SELECT id FROM open_apps WHERE app_key = ?').get(appKey).id;
  const userId = db.prepare(`INSERT INTO users (openid, nickname, points, status, created_at, last_login_at)
    VALUES (?,?,?,?,?,?)`).run('mkt_user_1', '模板市场测试用户', 200, 'active', t, t).lastInsertRowid;
  db.prepare(`INSERT INTO client_sessions
    (token, refresh_token, app_id, user_id, machine_id, status, expires_at, refresh_expires_at, last_seen_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run('mkt-token-1', 'mkt-refresh-1', appId, userId, 'M-1', 'active', future(), future(), t, t);
  db.prepare(`INSERT INTO client_sessions
    (token, app_id, user_id, machine_id, status, expires_at, last_seen_at, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run('mkt-token-2', appId, userId, 'M-2', 'active', future(), t, t);

  const app = build();
  await app.ready();
  const adminToken = json(await app.inject({ method: 'POST', url: `${B}/api/admin/login`, payload: { username: 'admin', password: 'admin123' } })).token;
  const AH = { authorization: 'Bearer ' + adminToken, 'content-type': 'application/json' };
  const PUB = { 'x-app-key': appKey };
  const bearer = (token, withNonce = true) => {
    const h = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
    if (withNonce) h['x-nonce'] = nonce();
    return h;
  };

  /* ---------------------------------------------------------------- [1] 枚举 */
  console.log('\n[1] 枚举字典与 meta');
  const meta0 = json(await app.inject({ method: 'GET', url: `${OPEN}/market/meta`, headers: PUB }));
  ok('默认 9 个行业', meta0.industries.length === 9, meta0.industries);
  ok('默认 3 种纸型', meta0.paperTypes.length === 3, meta0.paperTypes);
  ok('尺寸预设 4 条', meta0.sizePresets.length === 4, meta0.sizePresets);
  ok('meta 带 4 种排序与默认 limit=50', meta0.sorts.length === 4 && meta0.defaultLimit === 50, meta0.sorts);
  ok('meta 声明北京时间', meta0.timezone === 'Asia/Shanghai');
  const optRes = json(await app.inject({
    method: 'POST', url: `${B}/api/market/options`, headers: AH,
    payload: { industries: ['测试行业A', '测试行业B'], paperTypes: ['间隙纸', '连续纸'], sizePresets: [{ label: '30×20', widthMm: 30, heightMm: 20 }] },
  }));
  ok('字典保存成功', optRes.ok === true && optRes.industries === 2, optRes);
  const meta1 = json(await app.inject({ method: 'GET', url: `${OPEN}/market/meta`, headers: PUB }));
  ok('后台改完 meta 立即生效（无需发客户端版本）', meta1.industries.join() === '测试行业A,测试行业B', meta1.industries);
  ok('尺寸预设按对象下发', meta1.sizePresets[0].widthMm === 30, meta1.sizePresets);

  /* ---------------------------------------------------------------- [2] 建模板 */
  console.log('\n[2] 模板增改查 + 私有文件上传');
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const r = json(await app.inject({
      method: 'POST', url: `${B}/api/market/templates`, headers: AH,
      payload: {
        name: `测试模板 ${String(i).padStart(2, '0')}`,
        industry: i % 2 ? '测试行业B' : '测试行业A',
        paper_type: i % 3 === 0 ? '连续纸' : '间隙纸',
        width_mm: i % 2 ? 50 : 30, height_mm: i % 2 ? 30 : 20,
        dpi: 203, columns: 1, price: i % 4 === 0 ? 0 : (i + 1) * 10,
        author: '官方', description: i % 5 === 0 ? '条码标签 示例' : '普通模板',
        tags: i % 5 === 0 ? ['条码', '示例'] : ['通用'],
      },
    }));
    if (r.item && r.item.id) ids.push(r.item.id);
  }
  ok('成功创建 12 个模板', ids.length === 12, ids.length);
  ok('新建模板 price/status/version 默认值正确', (() => {
    const row = db.prepare('SELECT * FROM market_templates WHERE id = ?').get(ids[1]);
    return row.status === 'on' && row.version === 1 && row.downloads === 0;
  })());

  const up = multipart('demo.blls', 'ENCRYPTED-BLLS-CONTENT-001');
  const upRes = await app.inject({
    method: 'POST', url: `${B}/api/market/templates/${ids[0]}/file`,
    headers: { authorization: 'Bearer ' + adminToken, 'content-type': up.contentType }, payload: up.body,
  });
  const upJson = json(upRes);
  ok('.blls 上传成功并算 sha256', upRes.statusCode === 200 && upJson.fileSha256 && upJson.fileSize === Buffer.byteLength('ENCRYPTED-BLLS-CONTENT-001'), upJson);
  ok('文件落在私有目录而非 uploads/', fs.existsSync(path.join(market.ROOT, `${ids[0]}.blls`)));
  const badUp = multipart('evil.exe', 'x');
  const badRes = json(await app.inject({
    method: 'POST', url: `${B}/api/market/templates/${ids[1]}/file`,
    headers: { authorization: 'Bearer ' + adminToken, 'content-type': badUp.contentType }, payload: badUp.body,
  }));
  ok('非 .blls 被拒', badRes.code === 'FILE_TYPE_INVALID', badRes);
  const sha = upJson.fileSha256;

  /* ---------------------------------------------------------------- [3] 列表游标 */
  console.log('\n[3] 列表：筛选 / 排序 / 游标不漏不重');
  const seen = [];
  let cursor = '';
  let pages = 0;
  let hasMore = true;
  while (hasMore && pages < 10) {
    const url = `${OPEN}/market/list?limit=5${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
    const r = json(await app.inject({ method: 'GET', url, headers: PUB }));
    if (!r.items) { ok('第 ' + (pages + 1) + ' 页返回 items', false, r); break; }
    seen.push(...r.items.map((x) => x.id));
    cursor = r.nextCursor || '';
    hasMore = !!r.hasMore;
    pages++;
  }
  ok('12 条分 3 页拉完', pages === 3 && seen.length === 12, { pages, count: seen.length });
  ok('游标翻页无重复', new Set(seen).size === 12, { unique: new Set(seen).size });
  ok('游标翻页无漏项', ids.every((id) => seen.includes(id)));
  const defList = json(await app.inject({ method: 'GET', url: `${OPEN}/market/list`, headers: PUB }));
  ok('默认排序 = downloads_desc 且默认 limit=50', defList.sort === 'downloads_desc' && defList.limit === 50 && defList.items.length === 12, defList);
  const first = json(await app.inject({ method: 'GET', url: `${OPEN}/market/list?limit=3`, headers: PUB }));
  ok('列表不返回 fileUrl / file_path', !JSON.stringify(first).includes('fileUrl') && !JSON.stringify(first).includes('file_path'));
  ok('列表返回 fileSha256 供展示', first.items[0].fileSha256 !== undefined, Object.keys(first.items[0]));

  const detail = json(await app.inject({ method: 'GET', url: `${OPEN}/market/detail/${ids[0]}`, headers: PUB }));
  ok('详情字段完整且无 fileUrl', detail.id === ids[0] && detail.fileSha256 === sha && !JSON.stringify(detail).includes('fileUrl'), detail);
  const noDetail = json(await app.inject({ method: 'GET', url: `${OPEN}/market/detail/nope`, headers: PUB }));
  ok('不存在的模板 404', noDetail.code === 'TEMPLATE_NOT_FOUND', noDetail);

  const f1 = json(await app.inject({ method: 'GET', url: `${OPEN}/market/list?industry=${encodeURIComponent('测试行业A')}`, headers: PUB }));
  ok('按行业筛选', f1.items.length === 6 && f1.items.every((x) => x.industry === '测试行业A'), f1.items.length);
  const f2 = json(await app.inject({ method: 'GET', url: `${OPEN}/market/list?paperType=${encodeURIComponent('连续纸')}`, headers: PUB }));
  ok('按纸型筛选', f2.items.length === 4, f2.items.length);
  const f3 = json(await app.inject({ method: 'GET', url: `${OPEN}/market/list?widthMm=50&heightMm=30`, headers: PUB }));
  ok('按宽高精确筛选', f3.items.length === 6, f3.items.length);
  const f4 = json(await app.inject({ method: 'GET', url: `${OPEN}/market/list?q=${encodeURIComponent('条码')}`, headers: PUB }));
  ok('关键词命中 name/tags/description', f4.items.length >= 3, f4.items.length);
  const asc = json(await app.inject({ method: 'GET', url: `${OPEN}/market/list?sort=price_asc`, headers: PUB }));
  const desc = json(await app.inject({ method: 'GET', url: `${OPEN}/market/list?sort=price_desc`, headers: PUB }));
  ok('price_asc 升序', asc.items.every((x, i, a) => !i || a[i - 1].price <= x.price), asc.items.map((x) => x.price));
  ok('price_desc 降序', desc.items.every((x, i, a) => !i || a[i - 1].price >= x.price), desc.items.map((x) => x.price));
  const newest = json(await app.inject({ method: 'GET', url: `${OPEN}/market/list?sort=newest&limit=4`, headers: PUB }));
  ok('newest 排序可翻页且有 nextCursor', newest.items.length === 4 && !!newest.nextCursor, newest.nextCursor);
  const sameCur = json(await app.inject({ method: 'GET', url: `${OPEN}/market/list?sort=newest&limit=4&cursor=${encodeURIComponent(newest.nextCursor)}`, headers: PUB }));
  ok('同条件游标续页不重复', sameCur.items.every((x) => !newest.items.some((y) => y.id === x.id)), sameCur.items.map((x) => x.id));
  const crossCur = json(await app.inject({ method: 'GET', url: `${OPEN}/market/list?sort=price_asc&cursor=${encodeURIComponent(newest.nextCursor)}`, headers: PUB }));
  ok('换排序复用旧游标被拒', crossCur.code === 'CURSOR_INVALID', crossCur);
  const tampered = newest.nextCursor.slice(0, -2) + 'zz';
  const tamperedRes = json(await app.inject({ method: 'GET', url: `${OPEN}/market/list?sort=newest&cursor=${encodeURIComponent(tampered)}`, headers: PUB }));
  ok('篡改游标被拒', tamperedRes.code === 'CURSOR_INVALID', tamperedRes);
  const mineAnon = json(await app.inject({ method: 'GET', url: `${OPEN}/market/list?mine=true`, headers: PUB }));
  ok('mine=true 未登录 401', mineAnon.code === 'UNAUTHORIZED', mineAnon);

  /* ---------------------------------------------------------------- [4] 积分 / 签到 */
  console.log('\n[4] 积分单一真相源与北京时间签到');
  ok('北京时间日切：UTC 16:30 属于次日', chinaDay('2026-11-12T16:30:00.000Z') === '2026-11-13');
  ok('北京时间日切：UTC 15:30 仍属当日', chinaDay('2026-11-12T15:30:00.000Z') === '2026-11-12');
  const c0 = json(await app.inject({ method: 'GET', url: `${OPEN}/user/credits`, headers: bearer('mkt-token-1', false) }));
  ok('credits 返回真实余额 200', c0.balance === 200, c0);
  const s1 = json(await app.inject({ method: 'POST', url: `${OPEN}/user/signin`, headers: bearer('mkt-token-1'), payload: {} }));
  ok('首次签到 +10', s1.ok && s1.gain === 10 && s1.balance === 210, s1);
  const s2 = json(await app.inject({ method: 'POST', url: `${OPEN}/user/signin`, headers: bearer('mkt-token-1'), payload: {} }));
  ok('同日重复签到幂等（不报错、不加分）', s2.ok && s2.already === true && s2.balance === 210, s2);
  ok('签到流水余额与 users.points 一致', pointsLib.balance(userId) === 210);
  // 网页端签到走同一个 helper，不能因为入口不同再领一次
  const userJwt = require('../server/lib/auth').signUser({ id: userId, openid: 'mkt_user_1' });
  const webSignin = await app.inject({
    method: 'POST', url: `${B}/api/portal/signin`,
    headers: { authorization: 'Bearer ' + userJwt, 'content-type': 'application/json' }, payload: {},
  });
  ok('网页端复用同一幂等判定', webSignin.statusCode === 400 && json(webSignin).code === 'ALREADY_SIGNED', json(webSignin));
  ok('北京时间日期写入响应', /^\d{4}-\d{2}-\d{2}$/.test(s1.date), s1.date);

  const newUser = await require('../server/routes/wechat').ensureUser('mkt_fresh_openid', { nickname: '新用户' });
  ok('新用户注册赠送 200 分', pointsLib.balance(newUser.user.id) === 200, pointsLib.balance(newUser.user.id));
  ok('赠送写入 points_logs 流水', !!db.prepare("SELECT 1 FROM points_logs WHERE user_id=? AND reason='新用户注册'").get(newUser.user.id));

  /* ---------------------------------------------------------------- [5] 兑换 */
  console.log('\n[5] 兑换：Bearer+nonce / 原子扣分 / 已购免扣');
  const noNonce = json(await app.inject({
    method: 'POST', url: `${OPEN}/market/redeem`,
    headers: bearer('mkt-token-1', false), payload: { template_id: ids[0], machine_code: 'M-1' },
  }));
  ok('写接口缺 x-nonce 401 NONCE_REQUIRED', noNonce.code === 'NONCE_REQUIRED', noNonce);
  const reusedN = nonce();
  const reusedH = { authorization: 'Bearer mkt-token-1', 'content-type': 'application/json', 'x-nonce': reusedN };
  // 用不存在的模板：第一次请求只记录 nonce，不产生任何兑换副作用
  await app.inject({ method: 'POST', url: `${OPEN}/market/redeem`, headers: reusedH, payload: { template_id: 'tpl_not_exist', machine_code: 'M-1' } });
  const reused = json(await app.inject({ method: 'POST', url: `${OPEN}/market/redeem`, headers: reusedH, payload: { template_id: ids[0], machine_code: 'M-1' } }));
  ok('nonce 重放 401 NONCE_REUSED', reused.code === 'NONCE_REUSED', reused);
  const mismatch = json(await app.inject({
    method: 'POST', url: `${OPEN}/market/redeem`, headers: bearer('mkt-token-1'),
    payload: { template_id: ids[0], machine_code: 'M-2' },
  }));
  ok('机器码与会话不一致 403 MACHINE_MISMATCH', mismatch.code === 'MACHINE_MISMATCH', mismatch);
  const noMachine = json(await app.inject({
    method: 'POST', url: `${OPEN}/market/redeem`, headers: bearer('mkt-token-1'), payload: { template_id: ids[0] },
  }));
  ok('缺 machine_code 400 MACHINE_REQUIRED', noMachine.code === 'MACHINE_REQUIRED', noMachine);

  // 付费模板（ids[1] = 20 分）先上传文件
  const up2 = multipart('b.blls', 'SECOND-BLLS-FILE');
  await app.inject({ method: 'POST', url: `${B}/api/market/templates/${ids[1]}/file`, headers: { authorization: 'Bearer ' + adminToken, 'content-type': up2.contentType }, payload: up2.body });
  const before = pointsLib.balance(userId);
  const buy = json(await app.inject({
    method: 'POST', url: `${OPEN}/market/redeem`, headers: bearer('mkt-token-1'),
    payload: { template_id: ids[1], machine_code: 'M-1' },
  }));
  ok('兑换成功返回 downloadUrl + sha256 + 扣后余额', buy.ok && buy.downloadUrl && buy.fileSha256 && buy.balance === before - 20, buy);
  ok('downloadUrl 带子路径前缀', buy.downloadUrl.includes('/platform/api/open/v1/market/download'), buy.downloadUrl);
  ok('扣分写流水且余额一致', pointsLib.balance(userId) === before - 20);
  ok('已购记录归 user_id', !!db.prepare('SELECT 1 FROM market_purchases WHERE user_id=? AND template_id=?').get(userId, ids[1]));
  const owned = json(await app.inject({ method: 'GET', url: `${OPEN}/market/owned`, headers: bearer('mkt-token-1', false) }));
  ok('/market/owned 返回已购 id', owned.templateIds.includes(ids[1]), owned);
  const mineList = json(await app.inject({ method: 'GET', url: `${OPEN}/market/list?mine=true`, headers: { ...PUB, authorization: 'Bearer mkt-token-1' } }));
  ok('mine=true 只返回已购', mineList.items.length === 1 && mineList.items[0].id === ids[1], mineList.items.map((x) => x.id));
  // 换一台机器（另一个会话、同一账号）仍算已购，不重复扣分
  const again = json(await app.inject({
    method: 'POST', url: `${OPEN}/market/redeem`, headers: bearer('mkt-token-2'),
    payload: { template_id: ids[1], machine_code: 'M-2' },
  }));
  ok('换机重复兑换：already=true 且不扣分', again.ok && again.already === true && again.balance === before - 20, again);
  const dlCount = db.prepare('SELECT downloads FROM market_templates WHERE id=?').get(ids[1]).downloads;
  ok('重复下载 downloads 累加（用户拍板）', dlCount === 2, dlCount);

  const freeBuy = json(await app.inject({
    method: 'POST', url: `${OPEN}/market/redeem`, headers: bearer('mkt-token-1'),
    payload: { template_id: ids[0], machine_code: 'M-1' },
  }));
  ok('免费模板兑换不扣分', freeBuy.ok && freeBuy.balance === before - 20, freeBuy);
  const missing = json(await app.inject({
    method: 'POST', url: `${OPEN}/market/redeem`, headers: bearer('mkt-token-1'),
    payload: { template_id: ids[2], machine_code: 'M-1' },
  }));
  ok('缺 .blls 文件不扣也不发货', missing.code === 'TEMPLATE_FILE_MISSING' && pointsLib.balance(userId) === before - 20, missing);
  ok('缺文件时未写已购', !db.prepare('SELECT 1 FROM market_purchases WHERE user_id=? AND template_id=?').get(userId, ids[2]));

  db.prepare('UPDATE users SET points = 5 WHERE id = ?').run(userId);
  // ids[3] 先补一份文件，确保测的是「余额不足」而不是「缺文件」
  const up3 = multipart('c.blls', 'THIRD-BLLS');
  await app.inject({ method: 'POST', url: `${B}/api/market/templates/${ids[3]}/file`, headers: { authorization: 'Bearer ' + adminToken, 'content-type': up3.contentType }, payload: up3.body });
  const poor2 = json(await app.inject({
    method: 'POST', url: `${OPEN}/market/redeem`, headers: bearer('mkt-token-1'),
    payload: { template_id: ids[3], machine_code: 'M-1' },
  }));
  ok('积分不足 402 且不扣成负数', poor2.code === 'INSUFFICIENT_CREDITS' && pointsLib.balance(userId) === 5, poor2);
  ok('积分不足未写已购/未发短链', !db.prepare('SELECT 1 FROM market_purchases WHERE user_id=? AND template_id=?').get(userId, ids[3]));

  /* ---------------------------------------------------------------- [6] 短链 */
  console.log('\n[6] 一次性 5 分钟短链');
  const u = new URL(buy.downloadUrl);
  const dlPath = u.pathname + u.search;
  const dl1 = await app.inject({ method: 'GET', url: dlPath });
  ok('首次下载 200 且内容正确', dl1.statusCode === 200 && String(dl1.payload) === 'SECOND-BLLS-FILE', { status: dl1.statusCode, body: String(dl1.payload).slice(0, 60) });
  ok('下发 X-File-Sha256 / 禁缓存', !!dl1.headers['x-file-sha256'] && dl1.headers['cache-control'] === 'no-store', dl1.headers);
  const dl2 = json(await app.inject({ method: 'GET', url: dlPath }));
  ok('短链重放 410 LINK_USED', dl2.code === 'LINK_USED', dl2);
  const fake = json(await app.inject({ method: 'GET', url: `${OPEN}/market/download?token=abc.def` }));
  ok('伪造短链 400 LINK_INVALID', fake.code === 'LINK_INVALID', fake);
  // 把另一次兑换签出的短链改成过期，验证 TTL
  const expiredRes = json(await app.inject({
    method: 'POST', url: `${OPEN}/market/redeem`, headers: bearer('mkt-token-2'),
    payload: { template_id: ids[1], machine_code: 'M-2' },
  }));
  const expiredUrl = new URL(expiredRes.downloadUrl);
  const tokenParam = new URLSearchParams(expiredUrl.search).get('token');
  const payloadPart = tokenParam.split('.')[0];
  const p = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  db.prepare('UPDATE market_download_links SET expires_at = ? WHERE jti = ?').run(new Date(Date.now() - 1000).toISOString(), p.j);
  const expired = json(await app.inject({ method: 'GET', url: expiredUrl.pathname + expiredUrl.search }));
  ok('过期短链 410 LINK_EXPIRED', expired.code === 'LINK_EXPIRED', expired);
  ok('短链绑定 template+user+machine', p.t === ids[1] && p.u === userId && p.m === 'M-2', p);
  ok('短链 TTL = 300 秒', Math.round((p.e - Date.now()) / 1000) <= 300 && Math.round((p.e - Date.now()) / 1000) > 290, p.e);

  /* ---------------------------------------------------------------- [7] 下架 / 删除保护 */
  console.log('\n[7] 上下架与删除保护');
  const offRes = json(await app.inject({ method: 'PATCH', url: `${B}/api/market/templates/${ids[1]}`, headers: AH, payload: { status: 'off' } }));
  ok('下架成功且 version 自增', offRes.item.status === 'off' && offRes.item.version > 1, offRes.item.version);
  const offDetail = json(await app.inject({ method: 'GET', url: `${OPEN}/market/detail/${ids[1]}`, headers: PUB }));
  ok('下架后详情 404', offDetail.code === 'TEMPLATE_NOT_FOUND', offDetail);
  const offRedeem = json(await app.inject({
    method: 'POST', url: `${OPEN}/market/redeem`, headers: bearer('mkt-token-1'),
    payload: { template_id: ids[1], machine_code: 'M-1' },
  }));
  ok('下架后兑换 403 TEMPLATE_OFFLINE', offRedeem.code === 'TEMPLATE_OFFLINE', offRedeem);
  const delBought = json(await app.inject({ method: 'DELETE', url: `${B}/api/market/templates/${ids[1]}`, headers: AH }));
  ok('有已购记录的模板禁止删除', delBought.code === 'TEMPLATE_HAS_PURCHASES', delBought);
  const delFree = json(await app.inject({ method: 'DELETE', url: `${B}/api/market/templates/${ids[11]}`, headers: AH }));
  ok('无已购模板可删除', delFree.ok === true, delFree);
  const st = json(await app.inject({ method: 'GET', url: `${B}/api/market/templates`, headers: AH }));
  ok('后台统计带模板数/下载数/兑换数', st.stats.templates === 11 && st.stats.purchases === 2 && st.stats.downloads >= 4, st.stats);
  ok('后台列表带 hasFile 且不含对外 URL', st.items.find((x) => x.id === ids[0]).hasFile === true);

  /* ---------------------------------------------------------------- [8] 鉴权口径 */
  console.log('\n[8] 公开读与后台接口的鉴权边界');
  const noKey = json(await app.inject({ method: 'GET', url: `${OPEN}/market/meta` }));
  ok('公开读缺 x-app-key 401', noKey.code === 'UNAUTHORIZED' || noKey.code === 'APP_SIGN_INVALID', noKey);
  const adminNoToken = await app.inject({ method: 'GET', url: `${B}/api/market/templates` });
  ok('后台接口未登录 401', adminNoToken.statusCode === 401, adminNoToken.statusCode);
  const badBearer = json(await app.inject({ method: 'GET', url: `${OPEN}/user/credits`, headers: { authorization: 'Bearer nope' } }));
  ok('失效 Bearer 401', badBearer.code === 'UNAUTHORIZED', badBearer);

  /* ---------------------------------------------------------------- [9] 已购丢弃 */
  console.log('\n[9] 已购丢弃：幂等 / 不返积分 / 作废短链 / 解除删除保护');
  const DISCARD = (id) => `${OPEN}/market/owned/${encodeURIComponent(id)}/discard`;
  const discard = (id, opts = {}) => app.inject({
    method: 'POST', url: DISCARD(id),
    headers: bearer(opts.token || 'mkt-token-1', opts.nonce !== false),
    payload: { machine_code: opts.machine || 'M-1' },
  }).then(json);
  const hasBought = (id, uid = userId) => !!db.prepare('SELECT 1 FROM market_purchases WHERE user_id=? AND template_id=?').get(uid, id);

  const dNoBearerRes = await app.inject({
    method: 'POST', url: DISCARD(ids[1]),
    headers: { 'x-nonce': nonce(), 'content-type': 'application/json' }, payload: { machine_code: 'M-1' },
  });
  ok('丢弃未登录 401', dNoBearerRes.statusCode === 401, dNoBearerRes.statusCode);
  const dNoNonce = json(await app.inject({
    method: 'POST', url: DISCARD(ids[1]), headers: bearer('mkt-token-1', false), payload: { machine_code: 'M-1' },
  }));
  ok('丢弃缺 x-nonce 401 NONCE_REQUIRED', dNoNonce.code === 'NONCE_REQUIRED', dNoNonce);
  const dReusedN = nonce();
  const dReusedH = { authorization: 'Bearer mkt-token-1', 'content-type': 'application/json', 'x-nonce': dReusedN };
  await app.inject({ method: 'POST', url: DISCARD('tpl_never'), headers: dReusedH, payload: { machine_code: 'M-1' } });
  const dReused = json(await app.inject({ method: 'POST', url: DISCARD(ids[1]), headers: dReusedH, payload: { machine_code: 'M-1' } }));
  ok('丢弃 nonce 重放 401 NONCE_REUSED', dReused.code === 'NONCE_REUSED', dReused);
  const dNoMachine = json(await app.inject({
    method: 'POST', url: DISCARD(ids[1]), headers: bearer('mkt-token-1'), payload: {},
  }));
  ok('丢弃缺 machine_code 400 MACHINE_REQUIRED', dNoMachine.code === 'MACHINE_REQUIRED', dNoMachine);
  ok('缺机器码时未解除绑定', hasBought(ids[1]));
  const dMismatch = await discard(ids[1], { machine: 'M-2' });
  ok('丢弃机器码不一致 403 MACHINE_MISMATCH', dMismatch.code === 'MACHINE_MISMATCH', dMismatch);
  ok('机器码不一致时未解除绑定', hasBought(ids[1]));

  const userId2 = db.prepare(`INSERT INTO users (openid, nickname, points, status, created_at, last_login_at)
    VALUES (?,?,?,?,?,?)`).run('mkt_user_2', '丢弃测试用户2', 200, 'active', t, t).lastInsertRowid;
  db.prepare(`INSERT INTO client_sessions
    (token, app_id, user_id, machine_id, status, expires_at, last_seen_at, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run('mkt-token-3', appId, userId2, 'M-3', 'active', future(), t, t);
  const dOther = await discard(ids[1], { token: 'mkt-token-3', machine: 'M-3' });
  ok('他人不能解绑我的已购 discarded:false', dOther.ok && dOther.discarded === false, dOther);
  ok('他人请求后我的已购仍在', hasBought(ids[1]));
  const dNever = await discard(ids[2]);
  ok('未购模板丢弃幂等 ok:true / discarded:false', dNever.ok === true && dNever.discarded === false, dNever);
  ok('不存在的模板也幂等', (await discard('tpl_never_404')).discarded === false);

  const balBefore = pointsLib.balance(userId);
  const d1 = await discard(ids[1]);
  ok('丢弃已购 discarded:true + serverTime', d1.ok && d1.discarded === true && !!d1.serverTime, d1);
  ok('已购行被删除', !hasBought(ids[1]));
  ok('不返还积分', pointsLib.balance(userId) === balBefore, { before: balBefore, after: pointsLib.balance(userId) });
  const ownedAfter = json(await app.inject({ method: 'GET', url: `${OPEN}/market/owned`, headers: bearer('mkt-token-1', false) }));
  ok('/market/owned 不再含该模板', !ownedAfter.templateIds.includes(ids[1]), ownedAfter);
  ok('不影响其它已购模板', ownedAfter.templateIds.includes(ids[0]), ownedAfter);
  const tpl1 = db.prepare('SELECT * FROM market_templates WHERE id = ?').get(ids[1]);
  ok('服务端 .blls 文件未被删除', !!tpl1.file_path && fs.existsSync(path.join(market.ROOT, tpl1.file_path)));
  const d2 = await discard(ids[1]);
  ok('重复丢弃幂等 discarded:false', d2.ok && d2.discarded === false, d2);

  // 丢弃前签发的 5 分钟短链必须作废，否则「丢弃」只是从列表里藏起来
  const fresh = json(await app.inject({
    method: 'POST', url: `${OPEN}/market/redeem`, headers: bearer('mkt-token-1'),
    payload: { template_id: ids[0], machine_code: 'M-1' },
  }));
  const freshUrl = new URL(fresh.downloadUrl);
  const dFree = await discard(ids[0]);
  ok('丢弃免费模板同样生效', dFree.discarded === true, dFree);
  const linkAfter = json(await app.inject({ method: 'GET', url: freshUrl.pathname + freshUrl.search }));
  ok('丢弃前签发的短链作废 404 LINK_NOT_FOUND', linkAfter.code === 'LINK_NOT_FOUND', linkAfter);

  // 重新上架 + 补足积分 → 再兑换应重新扣分（回到「未拥有」状态）
  db.prepare('UPDATE users SET points = 100 WHERE id = ?').run(userId);
  await app.inject({ method: 'PATCH', url: `${B}/api/market/templates/${ids[1]}`, headers: AH, payload: { status: 'on' } });
  const rebuy = json(await app.inject({
    method: 'POST', url: `${OPEN}/market/redeem`, headers: bearer('mkt-token-1'),
    payload: { template_id: ids[1], machine_code: 'M-1' },
  }));
  ok('丢弃后重新兑换会重新扣分', rebuy.ok && rebuy.already === false && rebuy.balance === 80, rebuy);
  const d3 = await discard(ids[1]);
  ok('重新兑换后可再次丢弃', d3.discarded === true, d3);
  const delAfter = json(await app.inject({ method: 'DELETE', url: `${B}/api/market/templates/${ids[1]}`, headers: AH }));
  ok('丢弃后后台可删除该模板（解除删除保护）', delAfter.ok === true, delAfter);

  await app.close();
  console.log(`\n模板市场测试：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
  // Windows 下 better-sqlite3 的连接可能还占着 -wal 文件，删不掉不影响结果；
  // 下次运行开头会先清一遍，别让清理动作把全绿的测试报成异常。
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});

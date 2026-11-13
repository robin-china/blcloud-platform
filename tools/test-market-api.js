/* 模板市场 API 上架 + 600dpi + 扩展功能菜单 集成自测
 * 运行：node tools/test-market-api.js
 *
 * 覆盖：dpi 允许集/字典下发、菜单分组与页面注册、密钥 hash 存储与吊销、
 * 鉴权（缺/错/停用/nonce 重放/限流）、external_id 幂等、默认待审、
 * 运营下架后重跑不偷偷上线、字典强校验、fileBase64/multipart 两种文件通道
 * 与 sha256 比对、跨密钥越权、响应不泄文件路径、调用日志与留存策略。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TMP = path.join(__dirname, '..', 'data', 'test-market-api-tmp');
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
const ADMIN = B + '/api/market';
const API = B + '/api/market/v1';
const t = new Date().toISOString();
let nonceSeq = 0;
const nonce = () => `mktapi-n-${++nonceSeq}-${crypto.randomBytes(4).toString('hex')}`;
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function json(res) {
  try { return JSON.parse(res.body); } catch { return { raw: String(res.body).slice(0, 200) }; }
}
function multipart(filename, content) {
  const boundary = '----mktapi' + Date.now() + crypto.randomBytes(3).toString('hex');
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, Buffer.from(content), tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
const sha = (s) => crypto.createHash('sha256').update(Buffer.from(s)).digest('hex');

const keyH = (k, extra = {}) => ({
  'x-market-key': k, 'x-nonce': nonce(), 'content-type': 'application/json', ...extra,
});

(async () => {
  const appKey = 'ak_market_api_test';
  db.prepare(`INSERT INTO open_apps (app_key, app_secret, name, status, public_auth, offline_days, created_at)
    VALUES (?,?,?,?,1,7,?)`).run(appKey, 'secret_market_api', 'API 上架测试', 'active', t);

  const app = build();
  await app.ready();
  const login = json(await app.inject({
    method: 'POST', url: `${B}/api/admin/login`, payload: { username: 'admin', password: 'admin123' },
  }));
  const AH = { authorization: 'Bearer ' + login.token, 'content-type': 'application/json' };
  const PUB = { 'x-app-key': appKey };

  /* ------------------------------------------------------------ [1] 600dpi */
  console.log('\n[1] 打印分辨率 600dpi 与字典');
  const meta0 = json(await app.inject({ method: 'GET', url: `${OPEN}/market/meta`, headers: PUB }));
  ok('meta 下发 dpis 且含 600', Array.isArray(meta0.dpis) && meta0.dpis.includes(600)
    && meta0.dpis.length === 3, meta0.dpis);
  const t600 = json(await app.inject({
    method: 'POST', url: `${ADMIN}/templates`, headers: AH,
    payload: { name: '600dpi 模板', width_mm: 50, height_mm: 30, dpi: 600 },
  }));
  ok('后台可创建 600dpi 模板', t600.ok === true && t600.item.dpi === 600, t600);
  const t400 = json(await app.inject({
    method: 'POST', url: `${ADMIN}/templates`, headers: AH,
    payload: { name: '非法 dpi', width_mm: 50, height_mm: 30, dpi: 400 },
  }));
  ok('400dpi 被拒（PARAM_INVALID）', t400.code === 'PARAM_INVALID', t400);
  const savedDict = json(await app.inject({
    method: 'POST', url: `${ADMIN}/options`, headers: AH,
    payload: { industries: ['制造业'], paperTypes: ['间隙纸'], sizePresets: [{ label: '50×30mm', widthMm: 50, heightMm: 30 }], dpis: [203, 600] },
  }));
  ok('保存字典可裁剪 dpis', JSON.stringify(savedDict.dpis) === '[203,600]', savedDict);
  const meta1 = json(await app.inject({ method: 'GET', url: `${OPEN}/market/meta`, headers: PUB }));
  ok('meta 实时反映字典裁剪', JSON.stringify(meta1.dpis) === '[203,600]', meta1.dpis);
  await app.inject({
    method: 'POST', url: `${ADMIN}/options`, headers: AH,
    payload: { industries: meta0.industries, paperTypes: meta0.paperTypes, sizePresets: meta0.sizePresets, dpis: [203, 300, 600] },
  });
  const meta2 = json(await app.inject({ method: 'GET', url: `${OPEN}/market/meta`, headers: PUB }));
  ok('恢复三项全开', meta2.dpis.length === 3 && meta2.dpis.includes(600), meta2.dpis);
  // 老后台页不传 dpis 时不能把配置抹掉
  await app.inject({
    method: 'POST', url: `${ADMIN}/options`, headers: AH,
    payload: { industries: meta0.industries, paperTypes: meta0.paperTypes, sizePresets: meta0.sizePresets, dpis: [300, 600] },
  });
  await app.inject({
    method: 'POST', url: `${ADMIN}/options`, headers: AH,
    payload: { industries: meta0.industries, paperTypes: meta0.paperTypes, sizePresets: meta0.sizePresets },
  });
  const meta3 = json(await app.inject({ method: 'GET', url: `${OPEN}/market/meta`, headers: PUB }));
  ok('旧版请求不传 dpis 时保留原配置', JSON.stringify(meta3.dpis) === '[300,600]', meta3.dpis);
  await app.inject({
    method: 'POST', url: `${ADMIN}/options`, headers: AH,
    payload: { industries: meta0.industries, paperTypes: meta0.paperTypes, sizePresets: meta0.sizePresets, dpis: [203, 300, 600] },
  });

  /* ------------------------------------------------------------ [2] 菜单 */
  console.log('\n[2] 扩展功能分组与页面注册');
  const appJs = read('public/admin/js/app.js');
  const adminIndex = read('public/admin/index.html');
  const pageCode = read('public/admin/js/pages-market.js');
  ok('存在独立「扩展功能」分组', /group: '扩展功能'/.test(appJs));
  ok('三个 LabelGo 页面都在该分组', /group: '扩展功能'[\s\S]{0,400}name: 'LabelGo模板市场'[\s\S]{0,300}name: 'LabelGo模板字典'[\s\S]{0,300}name: 'LabelGo模板API上架'/.test(appJs));
  ok('产品运营里已移走模板市场', /group: '产品运营'[\s\S]*?\n    },[\s\S]*?group: '扩展功能'/.test(appJs)
    && !/group: '产品运营'[\s\S]{0,500}name: '模板市场'/.test(appJs));
  ok('index.html 注册 page-market-api', /<page-market-api v-if="state\.route === 'marketApi'"><\/page-market-api>/.test(adminIndex));
  ok('PAGES 含 MarketApi', /'MarketOptions', 'MarketApi'/.test(adminIndex));
  ok('导出 PageMarketApi 组件', /window\.PageMarketApi = \{/.test(pageCode));
  ok('模板表单 dpi 下拉来自字典', /v-for="d in opts\.dpis"/.test(pageCode));
  ok('字典页有 600 dpi 勾选项', /DEFAULT_DPIS = \[203, 300, 600\]/.test(pageCode) && /v-for="d in allDpis"/.test(pageCode));
  ok('后台列表展示 API 来源与待审', /API 投稿/.test(pageCode) && /apiPending/.test(pageCode));

  /* ------------------------------------------------------------ [3] 密钥 */
  console.log('\n[3] 上架密钥生命周期');
  const noAdmin = await app.inject({ method: 'GET', url: `${ADMIN}/api-keys` });
  ok('密钥列表需管理员登录', noAdmin.statusCode === 401, noAdmin.statusCode);
  const created = json(await app.inject({
    method: 'POST', url: `${ADMIN}/api-keys`, headers: AH, payload: { name: '官方批量脚本' },
  }));
  const keyA = created.plainKey;
  ok('创建返回明文密钥（mkt_ 前缀）', created.ok === true && /^mkt_/.test(keyA || '') && created.autoPublish === 0, created.id);
  ok('库里只存 hash，不存明文', db.prepare('SELECT COUNT(*) AS c FROM market_api_keys WHERE key_hash = ?').get(keyA).c === 0);
  const listKeys = json(await app.inject({ method: 'GET', url: `${ADMIN}/api-keys`, headers: AH }));
  ok('列表不回明文、只回前缀', listKeys.items.length === 1 && !JSON.stringify(listKeys).includes(keyA)
    && listKeys.items[0].key_prefix === created.keyPrefix, listKeys.items[0]);
  const keyBResp = json(await app.inject({
    method: 'POST', url: `${ADMIN}/api-keys`, headers: AH, payload: { name: '可信直上脚本', autoPublish: true },
  }));
  const keyB = keyBResp.plainKey;
  ok('可创建自动上架密钥', keyBResp.autoPublish === 1, keyBResp.autoPublish);
  const keyCResp = json(await app.inject({
    method: 'POST', url: `${ADMIN}/api-keys`, headers: AH, payload: { name: '即将停用' },
  }));
  const keyC = keyCResp.plainKey;
  const idC = keyCResp.id;
  ok('密钥 C 已创建', !!keyC, keyCResp.id);

  /* ------------------------------------------------------------ [4] 鉴权 */
  console.log('\n[4] 鉴权与防重放');
  const body0 = { externalId: 'ext-001', name: '仓储货架标签', industry: '制造业', paperType: '间隙纸', widthMm: 50, heightMm: 30, dpi: 203, price: 20 };
  const noKey = json(await app.inject({ method: 'POST', url: `${API}/templates`, headers: { 'x-nonce': nonce(), 'content-type': 'application/json' }, payload: body0 }));
  ok('缺 X-Market-Key 401 MARKET_KEY_REQUIRED', noKey.code === 'MARKET_KEY_REQUIRED', noKey);
  const badKey = json(await app.inject({ method: 'POST', url: `${API}/templates`, headers: keyH('mkt_not_a_real_key'), payload: body0 }));
  ok('错误密钥 401 MARKET_KEY_INVALID', badKey.code === 'MARKET_KEY_INVALID', badKey);
  const noNonce = json(await app.inject({
    method: 'POST', url: `${API}/templates`, headers: { 'x-market-key': keyA, 'content-type': 'application/json' }, payload: body0,
  }));
  ok('写请求缺 X-Nonce 401 NONCE_REQUIRED', noNonce.code === 'NONCE_REQUIRED', noNonce);
  const reusedN = nonce();
  await app.inject({ method: 'POST', url: `${API}/templates`, headers: { 'x-market-key': keyA, 'x-nonce': reusedN, 'content-type': 'application/json' }, payload: { ...body0, externalId: 'ext-reuse-probe' } });
  const reused = json(await app.inject({
    method: 'POST', url: `${API}/templates`, headers: { 'x-market-key': keyA, 'x-nonce': reusedN, 'content-type': 'application/json' }, payload: body0,
  }));
  ok('nonce 重放 401 NONCE_REUSED', reused.code === 'NONCE_REUSED', reused);
  await app.inject({ method: 'PATCH', url: `${ADMIN}/api-keys/${idC}`, headers: AH, payload: { status: 'disabled' } });
  const disabled = json(await app.inject({ method: 'POST', url: `${API}/templates`, headers: keyH(keyC), payload: body0 }));
  ok('停用密钥 403 MARKET_KEY_DISABLED', disabled.code === 'MARKET_KEY_DISABLED', disabled);

  /* ------------------------------------------------------------ [5] 上架 */
  console.log('\n[5] 创建 / 待审 / 幂等 / 状态保护');
  const p1 = json(await app.inject({ method: 'POST', url: `${API}/templates`, headers: keyH(keyA), payload: body0 }));
  ok('首次创建成功', p1.ok === true && p1.created === true && p1.item.id, p1);
  ok('默认待审：status=off 且 needsReview', p1.item.status === 'off' && p1.needsReview === true, p1.item);
  ok('响应不含 file_path / fileUrl', !/file_path|fileUrl|downloadUrl/.test(JSON.stringify(p1)), p1);
  const id1 = p1.item.id;
  const v1 = p1.item.version;
  const listAfter = json(await app.inject({ method: 'GET', url: `${OPEN}/market/list`, headers: PUB }));
  ok('待审模板客户端不可见', !(listAfter.items || []).some((x) => x.id === id1), listAfter.items.map((x) => x.id));
  const p2 = json(await app.inject({ method: 'POST', url: `${API}/templates`, headers: keyH(keyA), payload: body0 }));
  ok('同 externalId 重放不新建、no-op', p2.ok === true && p2.created === false && p2.changed === false && p2.item.id === id1, p2);
  ok('no-op 不推进 version', p2.item.version === v1, [v1, p2.item.version]);
  ok('库里只有一条同幂等键记录', db.prepare("SELECT COUNT(*) AS c FROM market_templates WHERE source='api' AND external_id='ext-001'").get().c === 1);
  const q1 = json(await app.inject({ method: 'GET', url: `${API}/templates?externalId=ext-001`, headers: { 'x-market-key': keyA } }));
  ok('按幂等键可查状态', q1.found === true && q1.item.id === id1, q1);
  const q2 = json(await app.inject({ method: 'GET', url: `${API}/templates?externalId=nope`, headers: { 'x-market-key': keyA } }));
  ok('查不到返回 found:false 而非 404', q2.found === false, q2);
  const missing = json(await app.inject({ method: 'GET', url: `${API}/templates`, headers: { 'x-market-key': keyA } }));
  ok('查询缺 externalId 400', missing.code === 'EXTERNAL_ID_REQUIRED', missing);

  const noExt = json(await app.inject({ method: 'POST', url: `${API}/templates`, headers: keyH(keyA), payload: { ...body0, externalId: '' } }));
  ok('上架缺 externalId 400', noExt.code === 'EXTERNAL_ID_REQUIRED', noExt);
  const badIndustry = json(await app.inject({ method: 'POST', url: `${API}/templates`, headers: keyH(keyA), payload: { ...body0, externalId: 'ext-bad-1', industry: '不存在的行业' } }));
  ok('字典外行业被拒', badIndustry.code === 'PARAM_INVALID' && /字典/.test(badIndustry.error || ''), badIndustry);
  const badDpi = json(await app.inject({ method: 'POST', url: `${API}/templates`, headers: keyH(keyA), payload: { ...body0, externalId: 'ext-bad-2', dpi: 400 } }));
  ok('非法 dpi 被拒', badDpi.code === 'PARAM_INVALID', badDpi);
  const badSize = json(await app.inject({ method: 'POST', url: `${API}/templates`, headers: keyH(keyA), payload: { ...body0, externalId: 'ext-bad-3', widthMm: 0 } }));
  ok('尺寸为 0 被拒', badSize.code === 'PARAM_INVALID', badSize);

  await app.inject({ method: 'PATCH', url: `${ADMIN}/templates/${id1}`, headers: AH, payload: { status: 'on' } });
  const p3 = json(await app.inject({ method: 'POST', url: `${API}/templates`, headers: keyH(keyA), payload: { ...body0, price: 30 } }));
  ok('元数据变更才推进 version', p3.changed === true && p3.item.version > v1, [v1, p3.item.version]);
  ok('更新保留已上架 status', p3.item.status === 'on', p3.item.status);
  await app.inject({ method: 'PATCH', url: `${ADMIN}/templates/${id1}`, headers: AH, payload: { status: 'off' } });
  const p4 = json(await app.inject({ method: 'POST', url: `${API}/templates`, headers: keyH(keyA), payload: { ...body0, price: 30 } }));
  ok('运营下架后脚本重跑不偷偷上线', p4.item.status === 'off', p4.item.status);

  const pB = json(await app.inject({
    method: 'POST', url: `${API}/templates`, headers: keyH(keyB),
    payload: { ...body0, externalId: 'ext-auto-1', name: '自动上架模板' },
  }));
  ok('auto_publish=1 直接上架', pB.item.status === 'on' && pB.needsReview === false, pB.item);
  const listAuto = json(await app.inject({ method: 'GET', url: `${OPEN}/market/list`, headers: PUB }));
  ok('自动上架模板客户端可见', (listAuto.items || []).some((x) => x.id === pB.item.id), listAuto.items.map((x) => x.id));

  /* ------------------------------------------------------------ [6] 文件 */
  console.log('\n[6] 文件通道与 sha256 比对');
  const content = 'BLLS-API-FILE-ONE';
  const pFile = json(await app.inject({
    method: 'POST', url: `${API}/templates`, headers: keyH(keyA),
    payload: { ...body0, price: 30, externalId: 'ext-001', fileBase64: Buffer.from(content).toString('base64'), fileSha256: sha(content) },
  }));
  ok('fileBase64 + sha 一致时写入成功', pFile.ok === true && pFile.item.hasFile === true && pFile.item.fileSha256 === sha(content), pFile.item);
  ok('私有目录确有文件', fs.existsSync(path.join(market.ROOT, `${id1}.blls`)));
  ok('文件响应仍不含路径', !/file_path|fileUrl|\.blls/.test(JSON.stringify(pFile)), pFile);
  const badSha = json(await app.inject({
    method: 'POST', url: `${API}/templates`, headers: keyH(keyA),
    payload: { ...body0, price: 30, externalId: 'ext-001', fileBase64: Buffer.from(content).toString('base64'), fileSha256: sha('WRONG') },
  }));
  ok('sha 不符 400 FILE_SHA_MISMATCH', badSha.code === 'FILE_SHA_MISMATCH', badSha);
  ok('sha 不符时不覆盖已有文件', fs.readFileSync(path.join(market.ROOT, `${id1}.blls`), 'utf8') === content);

  const content2 = 'BLLS-API-FILE-TWO';
  const up = multipart('tpl.blls', content2);
  const upRes = json(await app.inject({
    method: 'POST', url: `${API}/templates/${id1}/file`,
    headers: { 'x-market-key': keyA, 'x-nonce': nonce(), 'x-file-sha256': sha(content2), 'content-type': up.contentType },
    payload: up.body,
  }));
  ok('multipart 覆盖文件成功', upRes.ok === true && upRes.item.fileSha256 === sha(content2), upRes);
  ok('覆盖后 version 推进', upRes.item.version > pFile.item.version, [pFile.item.version, upRes.item.version]);
  const upBad = json(await app.inject({
    method: 'POST', url: `${API}/templates/${id1}/file`,
    headers: { 'x-market-key': keyA, 'x-nonce': nonce(), 'x-file-sha256': sha('WRONG'), 'content-type': up.contentType },
    payload: up.body,
  }));
  ok('multipart sha 不符被拒', upBad.code === 'FILE_SHA_MISMATCH', upBad);
  const upCross = json(await app.inject({
    method: 'POST', url: `${API}/templates/${id1}/file`,
    headers: { 'x-market-key': keyB, 'x-nonce': nonce(), 'content-type': up.contentType },
    payload: up.body,
  }));
  ok('跨密钥改别人模板 403', upCross.code === 'TEMPLATE_FORBIDDEN', upCross);
  const badExt = multipart('evil.exe', content2);
  const extRes = json(await app.inject({
    method: 'POST', url: `${API}/templates/${id1}/file`,
    headers: { 'x-market-key': keyA, 'x-nonce': nonce(), 'content-type': badExt.contentType },
    payload: badExt.body,
  }));
  ok('非 .blls 文件被拒', extRes.code === 'FILE_TYPE_INVALID', extRes);
  const adminCreatedId = t600.item.id;
  const crossAdmin = json(await app.inject({
    method: 'POST', url: `${API}/templates/${adminCreatedId}/file`,
    headers: { 'x-market-key': keyA, 'x-nonce': nonce(), 'content-type': up.contentType },
    payload: up.body,
  }));
  ok('API 不能改后台人工建的模板', crossAdmin.code === 'TEMPLATE_FORBIDDEN', crossAdmin);

  /* ------------------------------------------------------------ [7] 日志与运维 */
  console.log('\n[7] 调用日志 / 留存 / 字典边界');
  const logs = json(await app.inject({ method: 'GET', url: `${ADMIN}/api-keys`, headers: AH }));
  ok('后台能查到调用日志', (logs.logs || []).length > 10, (logs.logs || []).length);
  ok('日志含失败码与幂等键', (logs.logs || []).some((l) => l.code === 'FILE_SHA_MISMATCH')
    && (logs.logs || []).some((l) => l.external_id === 'ext-001'), logs.logs.slice(0, 3));
  ok('日志不含明文密钥', !JSON.stringify(logs).includes(keyA));
  const retention = read('server/lib/retention.js');
  ok('调用日志纳入 30 天滚动清理', /key: 'market_api_logs'[\s\S]{0,120}days: 30/.test(retention));
  const schema = read('server/db/schema.sql');
  ok('密钥表与日志表已建表', /CREATE TABLE IF NOT EXISTS market_api_keys/.test(schema)
    && /CREATE TABLE IF NOT EXISTS market_api_logs/.test(schema));
  ok('幂等唯一索引按 (source, api_key_id, external_id)', /idx_market_tpl_external[\s\S]{0,120}api_key_id, external_id/.test(read('server/db/index.js')));
  ok('后台可看到 API 投稿来源与待审计数', /source/.test(read('server/lib/market.js')) && /apiPending/.test(read('server/lib/market.js')));

  /* 限流放最后：打满后这个密钥就不能再用了 */
  let limited = false;
  for (let i = 0; i < 125; i++) {
    const r = await app.inject({ method: 'GET', url: `${API}/templates?externalId=ext-001`, headers: { 'x-market-key': keyC } });
    if (r.statusCode === 403) { ok('停用密钥始终 403（限流不覆盖鉴权）', true); break; }
  }
  for (let i = 0; i < 125; i++) {
    const r = await app.inject({ method: 'GET', url: `${API}/templates?externalId=ext-001`, headers: { 'x-market-key': keyA } });
    if (r.statusCode === 429) { limited = true; break; }
  }
  ok('单密钥 120 次/分钟限流生效', limited);

  await app.close();
  console.log(`\nAPI 上架 / 600dpi / 扩展功能测试：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows WAL 占用不影响结果 */ }
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});

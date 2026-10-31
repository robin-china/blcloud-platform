/**
 * 微信服务号回调回归测试
 *
 * 重点覆盖一个线上踩过的坑：微信 POST 的是 XML，Fastify 默认只解析 JSON，
 * body parser 阶段就返回 415，handler 完全没执行 —— 表现为「二维码能扫、
 * 手机有反应、网页永远不跳转」，且服务端不留任何日志。
 *
 * 这里按微信真实报文格式构造明文与安全(AES)两种回调，验证端到端能完成登录。
 */
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const DB = 'data/test-wechat-cb.db';
const RESULT = path.join(ROOT, 'data', '.wecb-result.json');

const TOKEN = 'TestToken123';
const APPID = 'wxTestAppid0001';
// 微信 EncodingAESKey 是 43 字符 base64（32 字节去掉末尾 =）
const AESKEY = crypto.randomBytes(32).toString('base64').replace(/=/g, '').slice(0, 43);
// 另一把 key，用于测「EncodingAESKey 填错」
const WRONGKEY = crypto.randomBytes(32).toString('base64').replace(/=/g, '').slice(0, 43);

const script = `
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = ${JSON.stringify(ROOT)};

const config = require(path.join(ROOT, 'server', 'lib', 'config.js'));
const { build } = require(path.join(ROOT, 'server', 'index.js'));

const TOKEN = ${JSON.stringify(TOKEN)};
const APPID = ${JSON.stringify(APPID)};
const AESKEY = ${JSON.stringify(AESKEY)};
const WRONGKEY = ${JSON.stringify(WRONGKEY)};

function sha1Of(arr) {
  return crypto.createHash('sha1').update(arr.sort().join('')).digest('hex');
}
function encryptXml(xml, appid, aesKey) {
  const key = Buffer.from(aesKey + '=', 'base64');
  // 用副本而非 subarray 视图，避免 cipher 原地更新 iv 影响后续调用
  const iv = Buffer.from(key.subarray(0, 16));
  const body = Buffer.from(xml, 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
  const plain = Buffer.concat([crypto.randomBytes(16), len, body, Buffer.from(appid, 'utf8')]);
  // 交给 Node 做 PKCS7 填充——与微信实际行为一致，也避免手写填充出错
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  const out = Buffer.concat([c.update(plain), c.final()]).toString('base64');
  // 自验：加密产物必须能被服务端实现解开
  try {
    const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(key.subarray(0, 16)));
    console.log('SELFCHECK equal=' + Buffer.concat([d.update(Buffer.from(out, 'base64')), d.final()]).equals(plain));
  } catch (e) { console.log('SELFCHECK ERR ' + e.message); }
  return out;
}
function scanXml(from, to, scene, subscribe) {
  return '<xml><ToUserName><![CDATA[' + to + ']]></ToUserName>'
    + '<FromUserName><![CDATA[' + from + ']]></FromUserName>'
    + '<CreateTime>' + Math.floor(Date.now() / 1000) + '</CreateTime>'
    + '<MsgType><![CDATA[event]]></MsgType>'
    + '<Event><![CDATA[' + (subscribe ? 'subscribe' : 'SCAN') + ']]></Event>'
    + '<EventKey><![CDATA[' + (subscribe ? 'qrscene_' + scene : scene) + ']]></EventKey>'
    + '<Ticket><![CDATA[TICKET]]></Ticket></xml>';
}

(async () => {
  const out = [];
  const logs = [];
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...a) => { logs.push('LOG ' + a.map(String).join(' ')); };
  console.error = (...a) => { logs.push('ERR ' + a.map(String).join(' ')); };
  const t = (name, ok, extra) => out.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

  config.setConfig('wechat', { enabled: true, appid: APPID, appsecret: 'x', token: TOKEN, aes_key: AESKEY });

  const app = build();
  const db = require(path.join(ROOT, 'server', 'db', 'index.js'));
  // 直接建一条 pending 会话，避免依赖真实微信接口（qrcode 接口在假凭据下会失败）
  const newScene = async () => {
    const scene = Math.random().toString(36).slice(2, 18);
    db.prepare(\`INSERT INTO wechat_sessions (scene, ticket, qrcode_url, status, openid, user_id, created_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?)\`).run(scene, '', '', 'pending', '', null, new Date().toISOString(),
      new Date(Date.now() + 300000).toISOString());
    return scene;
  };
  const sessionStatus = (scene) => {
    const s = db.prepare('SELECT status, user_id FROM wechat_sessions WHERE scene = ?').get(scene);
    return s ? s.status : 'MISSING';
  };

  // ① 服务器配置验证（微信后台点「启用」时发的 GET）
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = 'abc123';
  let r = await app.inject({ method: 'GET', url: '/api/wechat/server', query: { signature: sha1Of([TOKEN, ts, nonce]), timestamp: ts, nonce, echostr: 'HELLO' } });
  t('① 服务器配置验证返回 echostr', r.body === 'HELLO', r.statusCode + ' ' + r.body.slice(0, 40));

  // ② 明文模式回调（XML）—— 415 是这里最典型的失败
  let scene = await newScene();
  r = await app.inject({
    method: 'POST', url: '/api/wechat/server',
    query: { signature: sha1Of([TOKEN, ts, nonce]), timestamp: ts, nonce },
    headers: { 'content-type': 'text/xml' },
    payload: scanXml('oUser001', 'gh_test', scene, false),
  });
  t('② 明文 XML 回调不再 415', r.statusCode === 200, r.statusCode);
  t('② 明文回调完成登录', sessionStatus(scene) === 'confirmed', sessionStatus(scene));

  // ③ 安全模式（AES 加密）回调
  scene = await newScene();
  const inner3 = scanXml('oUser002', 'gh_test', scene, true);
  const enc = encryptXml(inner3, APPID, AESKEY);
  const wechat = require(path.join(ROOT, 'server', 'services', 'wechat.js'));
  let diag;
  try { diag = 'direct=' + (wechat.decryptMessage(enc, AESKEY).xml === inner3); } catch (e) { diag = 'direct=ERR ' + e.message; }
  try {
    const k = Buffer.from(AESKEY + '=', 'base64');
    const d = crypto.createDecipheriv('aes-256-cbc', k, k.subarray(0, 16));
    const dec = Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]);
    console.log('RAWDEC ok len=' + dec.length + ' expectPlain=333');
  } catch (e) { console.log('RAWDEC ERR ' + e.message); }
  console.log('DIAG3 cfgKeyEq=' + (config.getConfig('wechat').aes_key === AESKEY)
    + ' encLen=' + enc.length + ' ' + diag
    + ' parseKeys=' + Object.keys(wechat.parseXml('<xml><Encrypt><![CDATA[' + enc + ']]></Encrypt></xml>')).join(','));
  const encXml = '<xml><ToUserName><![CDATA[gh_test]]></ToUserName><Encrypt><![CDATA[' + enc + ']]></Encrypt></xml>';
  r = await app.inject({
    method: 'POST', url: '/api/wechat/server',
    query: { timestamp: ts, nonce, encrypt_type: 'aes', msg_signature: sha1Of([TOKEN, ts, nonce, enc]), openid: 'oUser002' },
    headers: { 'content-type': 'text/xml' },
    payload: encXml,
  });
  t('③ 安全模式回调不再 415', r.statusCode === 200, r.statusCode);
  t('③ 安全模式解密并完成登录', sessionStatus(scene) === 'confirmed', sessionStatus(scene));

  // ④ msg_signature 错误必须拒绝
  r = await app.inject({
    method: 'POST', url: '/api/wechat/server',
    query: { timestamp: ts, nonce, encrypt_type: 'aes', msg_signature: 'deadbeef' },
    headers: { 'content-type': 'text/xml' },
    payload: '<xml><Encrypt><![CDATA[' + enc + ']]></Encrypt></xml>',
  });
  t('④ msg_signature 错误被拒 403', r.statusCode === 403, r.statusCode);

  // ⑤ EncodingAESKey 填错：不能 500，要返回 success 让微信停止重试，且绝不能误判为已登录
  config.setConfig('wechat', { enabled: true, appid: APPID, appsecret: 'x', token: TOKEN, aes_key: WRONGKEY });
  scene = await newScene();
  const enc2 = encryptXml(scanXml('oUser003', 'gh_test', scene, false), APPID, AESKEY);
  r = await app.inject({
    method: 'POST', url: '/api/wechat/server',
    query: { timestamp: ts, nonce, encrypt_type: 'aes', msg_signature: sha1Of([TOKEN, ts, nonce, enc2]) },
    headers: { 'content-type': 'text/xml' },
    payload: '<xml><Encrypt><![CDATA[' + enc2 + ']]></Encrypt></xml>',
  });
  t('⑤ EncodingAESKey 填错时不崩溃', r.statusCode === 200, r.statusCode);
  t('⑤ EncodingAESKey 填错时不误判为已登录', sessionStatus(scene) === 'pending', sessionStatus(scene));

  // ⑥ 解密出来的 AppId 与本号不符 → 拒绝（防伪造回调）
  config.setConfig('wechat', { enabled: true, appid: APPID, appsecret: 'x', token: TOKEN, aes_key: AESKEY });
  scene = await newScene();
  const enc3 = encryptXml(scanXml('oUser004', 'gh_test', scene, false), 'wxOtherAppid9999', AESKEY);
  r = await app.inject({
    method: 'POST', url: '/api/wechat/server',
    query: { timestamp: ts, nonce, encrypt_type: 'aes', msg_signature: sha1Of([TOKEN, ts, nonce, enc3]) },
    headers: { 'content-type': 'text/xml' },
    payload: '<xml><Encrypt><![CDATA[' + enc3 + ']]></Encrypt></xml>',
  });
  t('⑥ AppId 不符的回调被拒 403', r.statusCode === 403, r.statusCode);
  t('⑥ AppId 不符时不误判为已登录', sessionStatus(scene) === 'pending', sessionStatus(scene));

  // ⑦ 明文模式签名错误必须拒绝
  r = await app.inject({
    method: 'POST', url: '/api/wechat/server',
    query: { signature: 'wrong', timestamp: ts, nonce },
    headers: { 'content-type': 'text/xml' },
    payload: scanXml('oUser005', 'gh_test', 'x', false),
  });
  t('⑦ 明文签名错误被拒 403', r.statusCode === 403, r.statusCode);

  // ⑧ 端到端：回调完成 → 前端轮询拿到 token → 凭 token 能访问用户接口
  scene = await newScene();
  await app.inject({
    method: 'POST', url: '/api/wechat/server',
    query: { signature: sha1Of([TOKEN, ts, nonce]), timestamp: ts, nonce },
    headers: { 'content-type': 'text/xml' },
    payload: scanXml('oE2E0001', 'gh_test', scene, false),
  });
  r = await app.inject({ method: 'GET', url: '/api/wechat/qrcode/' + scene });
  const polled = r.json();
  t('⑧ 轮询返回 confirmed', polled.status === 'confirmed', r.statusCode + ' ' + JSON.stringify(polled).slice(0, 80));
  t('⑧ 轮询返回可用 token', !!polled.token, polled.token ? '有' : '无');
  t('⑧ 轮询不返回 tb 凭据', !('tb_username' in (polled.user || {})) && !('tb_password' in (polled.user || {})),
    'user字段=' + Object.keys(polled.user || {}).join(','));

  if (polled.token) {
    const me = await app.inject({ method: 'GET', url: '/api/portal/me', headers: { authorization: 'Bearer ' + polled.token } });
    const meJson = me.json();
    t('⑨ token 可访问 /api/portal/me', me.statusCode === 200, me.statusCode);
    const meU = meJson.user || {};
    t('⑨ me 返回的是本人 openid', meU.openid === 'oE2E0001', meU.openid || '-');
    t('⑨ me 不泄露 tb 账号密码', !meU.tb_username && !meU.tb_password, 'user字段=' + Object.keys(meU).join(','));
  } else {
    t('⑨ token 可访问 /api/portal/me', false, '上一步没拿到 token');
  }

  // ⑩ 未确认 / 已过期这两种轮询状态
  scene = await newScene();
  r = await app.inject({ method: 'GET', url: '/api/wechat/qrcode/' + scene });
  t('⑩ 未扫码时轮询为 pending', r.json().status === 'pending', JSON.stringify(r.json()));
  db.prepare('INSERT INTO wechat_sessions (scene, ticket, qrcode_url, status, openid, user_id, created_at, expires_at)'
    + ' VALUES (?,?,?,?,?,?,?,?)').run('expiredscene', '', '', 'pending', '', null,
      new Date(Date.now() - 600000).toISOString(), new Date(Date.now() - 300000).toISOString());
  r = await app.inject({ method: 'GET', url: '/api/wechat/qrcode/expiredscene' });
  t('⑩ 过期二维码轮询为 expired', r.json().status === 'expired', JSON.stringify(r.json()));
  r = await app.inject({ method: 'GET', url: '/api/wechat/qrcode/noscene' });
  t('⑩ 不存在的 scene 返回 404', r.statusCode === 404, r.statusCode);

  // ⑪ 同一个已经登录过的用户再次扫码：不能重复建号
  const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  scene = await newScene();
  await app.inject({
    method: 'POST', url: '/api/wechat/server',
    query: { signature: sha1Of([TOKEN, ts, nonce]), timestamp: ts, nonce },
    headers: { 'content-type': 'text/xml' },
    payload: scanXml('oE2E0001', 'gh_test', scene, false),
  });
  const after = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  t('⑪ 重复扫码不重复建号', before === after, before + ' -> ' + after);

  // ⑫ 管理后台「回调诊断」：能看出配置缺口 + 能看到推送记录，且不泄露密钥
  const diagUrl = '/api/admin/wechat/diag';
  r = await app.inject({ method: 'GET', url: diagUrl });
  t('⑫ 诊断接口未授权拒绝', r.statusCode === 401 || r.statusCode === 403, r.statusCode);

  const adminToken = (await app.inject({
    method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' },
  })).json().token;
  const ah = { authorization: 'Bearer ' + adminToken };
  r = await app.inject({ method: 'GET', url: diagUrl, headers: ah });
  const dj = r.json();
  t('⑫ 管理员可读诊断', r.statusCode === 200, r.statusCode);
  t('⑫ 诊断含推送记录', Array.isArray(dj.events) && dj.events.length > 0, '事件数=' + ((dj.events || []).length));
  t('⑫ 诊断记录到扫码成功事件', (dj.events || []).some((e) => e.type === 'login' && e.level === 'ok'),
    (dj.events || []).slice(0, 3).map((e) => e.type + ':' + e.level).join(' | '));
  t('⑫ 诊断记录到解密失败事件', (dj.events || []).some((e) => e.type === 'decrypt' && e.level === 'error'), '-');
  const djStr = JSON.stringify(dj);
  // 泄露要看「值」是否被带出来：has 里出现的只是字段名，不算泄露
  t('⑫ 诊断不泄露密钥原文', !djStr.includes(TOKEN) && !djStr.includes(AESKEY),
    '字段=' + Object.keys(dj).join(','));
  // 注意：子脚本装在模板字面量里，反斜杠转义会在求值阶段被吃掉，
  // 写正则字面量会被转成行注释，这里改用 endsWith
  t('⑫ 诊断给出对外回调地址', String(dj.server_url || '').endsWith('/api/wechat/server'), dj.server_url);

  // ⑬ 清空配置后诊断要能报出缺口。
  // 注意 setConfig 对敏感字段是「留空表示不修改」（防止误清），所以这里直接写库来清空
  const wipe = (partial) => db.prepare('UPDATE settings SET value = ? WHERE key = ?')
    .run(JSON.stringify(partial), 'cfg.wechat');
  wipe({ enabled: 1, appid: APPID, appsecret: 'x', token: TOKEN, aes_key: '' });
  r = await app.inject({ method: 'GET', url: diagUrl, headers: ah });
  const pj = r.json();
  t('⑬ 缺 EncodingAESKey 时诊断报缺口', (pj.problems || []).some((p) => p.includes('EncodingAESKey')),
    JSON.stringify(pj.problems || []));
  wipe({ enabled: 0, appid: '', appsecret: '', token: '', aes_key: '' });
  r = await app.inject({ method: 'GET', url: diagUrl, headers: ah });
  t('⑬ 配置全空时诊断列出所有缺口', (r.json().problems || []).length >= 5, String((r.json().problems || []).length));

  await app.close();
  console.log = origLog; console.error = origErr;
  fs.writeFileSync(${JSON.stringify(RESULT)}, JSON.stringify({ rows: out, logs }));
})().catch((e) => {
  fs.writeFileSync(${JSON.stringify(RESULT)}, JSON.stringify([{ name: '脚本异常', ok: false, extra: e.message + '\\n' + e.stack }]));
  process.exit(0);
});
`;

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  try { fs.unlinkSync(path.join(ROOT, f)); } catch { /* ignore */ }
}
try { fs.unlinkSync(RESULT); } catch { /* ignore */ }

if (process.env.WXCB_DEBUG) {
  // 调试用：子脚本拼好后原样落盘，方便直接 node --check 定位语法问题
  require('fs').writeFileSync(path.join(ROOT, 'data', '.wecb-script.js'), script);
}

try {
  require('child_process').execFileSync(NODE, ['-e', script], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: DB, ADMIN_INIT_PASSWORD: 'admin123' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
} catch (e) {
  // 子进程崩了要把 stderr 打出来，否则只能看到「没有结果文件」这种无效信息
  console.error('子进程执行失败：' + (e.stderr ? e.stderr.toString() : e.message));
  process.exit(1);
}

const { rows, logs } = JSON.parse(fs.readFileSync(RESULT, 'utf8'));
let pass = 0;
let fail = 0;
for (const r of rows) {
  if (r.ok) { pass++; console.log(`  ✓ ${r.name}${r.extra ? '  (' + r.extra + ')' : ''}`); } else { fail++; console.log(`  ✗ ${r.name}  ${r.extra}`); }
}
if (fail) {
  console.log('\n--- 服务端日志 ---');
  logs.forEach((l) => console.log('  ' + l.slice(0, 300)));
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
for (const f of [DB, `${DB}-wal`, `${DB}-shm`, 'data/.wecb-result.json']) {
  try { fs.unlinkSync(path.join(ROOT, f)); } catch { /* ignore */ }
}
process.exit(fail ? 1 : 0);

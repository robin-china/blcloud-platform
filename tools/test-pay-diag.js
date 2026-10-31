/**
 * 微信支付：下单失败的可诊断性回归
 *
 * 线上现象「还没出码就出问题了」——用户端只看到一个 toast，
 * 管理员必须 ssh 上去翻日志。这里固化三件事：
 *   1. 微信的错误码要被翻成「下一步该做什么」，而不是「签名验证失败」
 *   2. 商户私钥被压成一行 / 换行变成字面量 \n 时要能自愈
 *   3. 失败详情要落进 paydiag，且管理后台能读到、不泄露密钥原文
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const DB = 'data/test-pay.db';
const RESULT = path.join(ROOT, 'data', '.paydiag-result.json');

// 在父进程里造好私钥样本再传进去，避免在子脚本模板里玩转义层数
const kp = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const PEM = kp.privateKey;
const PEM_ESCAPED = kp.privateKey.replace(/\n/g, '\\n');
const PEM_ONELINE = kp.privateKey.replace(/\n/g, ' ');
// 私钥正文片段：诊断输出里绝不能出现它
const PEM_MARK = kp.privateKey.split(String.fromCharCode(10))[1].slice(0, 24);

const script = `
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = ${JSON.stringify(ROOT)};
const PEM = ${JSON.stringify(PEM)};
const PEM_ESCAPED = ${JSON.stringify(PEM_ESCAPED)};
const PEM_ONELINE = ${JSON.stringify(PEM_ONELINE)};
const PEM_MARK = ${JSON.stringify(PEM_MARK)};

const config = require(path.join(ROOT, 'server', 'lib', 'config.js'));
const wxpay = require(path.join(ROOT, 'server', 'services', 'wxpay.js'));
const paydiag = require(path.join(ROOT, 'server', 'lib', 'paydiag.js'));
const { build } = require(path.join(ROOT, 'server', 'index.js'));

(async () => {
  const out = [];
  const t = (name, ok, extra) => out.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

  // ① 错误码必须翻译成可执行的建议
  const cases = [
    ['SIGN_ERROR', '签名验证失败', ['证书序列号', '私钥']],
    ['APPID_MCHID_NOT_MATCH', 'appid和mchid不匹配', ['关联']],
    ['NO_AUTH', '商户无该产品权限', ['Native']],
    ['OUT_TRADE_NO_USED', '商户订单号重复', ['重新下单']],
    ['MCH_NOT_EXISTS', '商户号不存在', ['10 位']],
    ['INVALID_REQUEST', '参数错误', ['notify_url']],
  ];
  for (const [code, msg, must] of cases) {
    const s = wxpay.explainPayError(code, msg, 400);
    const ok = must.every((k) => s.includes(k)) && s.includes(code);
    t('① ' + code + ' 有可执行建议', ok, s.slice(0, 70));
  }

  // ② 私钥被压缩/转义时的自愈能力（三种粘贴事故：压成一行、换行变转义符、原始格式）
  const kpFix = (pem) => {
    try {
      const s = crypto.createSign('RSA-SHA256'); s.update('x'); s.sign(wxpay.normalizePrivateKey(pem), 'base64');
      return true;
    } catch { return false; }
  };
  t('② 原始私钥本身可用', kpFix(PEM), '');
  t('② 压成一行的私钥可被修复', kpFix(PEM_ONELINE), '');
  t('② 换行被转成转义符的私钥可被修复', kpFix(PEM_ESCAPED), '');
  t('② 空私钥不报错', wxpay.normalizePrivateKey('') === '', '');
  const fixedPem = wxpay.normalizePrivateKey(PEM_ONELINE);
  t('② 修复后仍是标准 PEM', fixedPem.startsWith('-----BEGIN PRIVATE KEY-----')
    && fixedPem.includes('-----END PRIVATE KEY-----')
    && fixedPem.split(String.fromCharCode(10)).length > 3, '行数=' + fixedPem.split(String.fromCharCode(10)).length);

  // ③ 配置清洗：首尾空格要去掉、序列号转大写、v3 密钥去空格
  config.setConfig('wxpay', { enabled: 1, mchid: '  1900000109  ', appid: ' wxAPPID001 ',
    mch_cert_serial: ' abcd1234 ', api_v3_key: ' 01234567890123456789012345678901 ', private_key: PEM });
  const clean = wxpay.readConfig();
  t('③ 商户号去空格', clean.mchid === '1900000109', JSON.stringify(clean.mchid));
  t('③ AppID 去空格', clean.appid === 'wxAPPID001', JSON.stringify(clean.appid));
  t('③ 证书序列号转大写去空格', clean.mch_cert_serial === 'ABCD1234', JSON.stringify(clean.mch_cert_serial));
  t('③ v3 密钥去空格后仍是 32 位', clean.api_v3_key.length === 32, String(clean.api_v3_key.length));

  // ④ 金额非法时给出可读错误，且不会去调微信
  try {
    await wxpay.nativePrepay({ description: 'x', outTradeNo: 'NOPAY1', amount: 0, notifyUrl: 'https://a.cn/n' });
    t('④ 金额为 0 被拦下', false, '竟然通过了');
  } catch (e) {
    t('④ 金额为 0 被拦下', e.message.includes('金额'), e.message.slice(0, 50));
  }

  // ⑤ 失败详情进 paydiag（模拟一次下单失败：把 key 换成不可用的）
  paydiag.list(30).forEach(() => {});
  const diagUrl = '/api/admin/pay/diag';
  const app = build();
  const adminToken = (await app.inject({ method: 'POST', url: '/api/admin/login',
    payload: { username: 'admin', password: 'admin123' } })).json().token;
  const ah = { authorization: 'Bearer ' + adminToken };

  config.setConfig('wxpay', { enabled: 1, mchid: '1900000109', appid: 'wxAPPID001',
    mch_cert_serial: 'ABCD1234', api_v3_key: '01234567890123456789012345678901', private_key: 'not-a-real-key' });
  let done = false;
  for (let i = 0; i < 1 && !done; i++) {
    try {
      await wxpay.nativePrepay({ description: '测试', outTradeNo: 'DIAGFAIL1', amount: 0.01, notifyUrl: 'https://www.bliot.cn/platform/api/pay/notify/wxpay' });
    } catch (e) { done = true; }
  }
  const evs = paydiag.list(30);
  t('⑤ 下单失败写入 paydiag', evs.some((e) => e.type === 'prepay' && e.level === 'error'),
    evs.slice(0, 2).map((e) => e.type + ':' + e.level).join(','));

  // ⑥ 管理后台可读诊断，且不泄露密钥原文
  let r = await app.inject({ method: 'GET', url: diagUrl });
  t('⑥ 未授权拒绝', r.statusCode === 401 || r.statusCode === 403, r.statusCode);
  r = await app.inject({ method: 'GET', url: diagUrl, headers: ah });
  const dj = r.json();
  t('⑥ 管理员可读', r.statusCode === 200, r.statusCode);
  t('⑥ 含事件记录', (dj.events || []).length > 0, String((dj.events || []).length));
  const s = JSON.stringify(dj);
  // 'PRIVATE KEY' 只是提示语里的标记，真正要防的是密钥正文被带出来
  const leaked = ['01234567890123456789012345678901', 'wxAPPID001', 'not-a-real-key', PEM_MARK]
    .filter((v) => s.includes(v));
  t('⑥ 不泄露私钥/v3密钥/AppID 原文', leaked.length === 0, '命中=' + leaked.join(','));
  t('⑥ 只给商户号后 4 位', dj.mchid_tail === '0109' && !s.includes('1900000109'), dj.mchid_tail);

  // ⑦ 把 v3 密钥长度写错时，诊断要报出来
  config.setConfig('wxpay', { api_v3_key: '12345' });
  r = await app.inject({ method: 'GET', url: diagUrl, headers: ah });
  t('⑦ v3 密钥长度错误被报出', (r.json().problems || []).some((p) => p.includes('32 位')),
    JSON.stringify(r.json().problems || []));

  await app.close();
  fs.writeFileSync(${JSON.stringify(RESULT)}, JSON.stringify(out));
})().catch((e) => {
  fs.writeFileSync(${JSON.stringify(RESULT)}, JSON.stringify([{ name: '脚本异常', ok: false, extra: e.message + '\\n' + e.stack }]));
  process.exit(0);
});
`;

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  try { fs.unlinkSync(path.join(ROOT, f)); } catch { /* ignore */ }
}
try { fs.unlinkSync(RESULT); } catch { /* ignore */ }

try {
  require('child_process').execFileSync(NODE, ['-e', script], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: DB, ADMIN_INIT_PASSWORD: 'admin123' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
} catch (e) {
  console.error('子进程执行失败：' + (e.stderr ? e.stderr.toString() : e.message));
  process.exit(1);
}

const rows = JSON.parse(fs.readFileSync(RESULT, 'utf8'));
let pass = 0;
let fail = 0;
for (const r of rows) {
  if (r.ok) { pass++; console.log(`  ✓ ${r.name}${r.extra ? '  (' + r.extra + ')' : ''}`); } else { fail++; console.log(`  ✗ ${r.name}  ${r.extra}`); }
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
for (const f of [DB, `${DB}-wal`, `${DB}-shm`, 'data/.paydiag-result.json']) {
  try { fs.unlinkSync(path.join(ROOT, f)); } catch { /* ignore */ }
}
process.exit(fail ? 1 : 0);

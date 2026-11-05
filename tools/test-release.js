/* 桌面客户端更新包（清单 / 静态托管 / 发布）自测
 * 运行：node tools/test-release.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-release.db');
for (const s of ['', '-wal', '-shm']) fs.rmSync(DB_FILE + s, { force: true });
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.NODE_ENV = 'test';
const UPDATES = path.join(__dirname, '..', 'data', 'test-release-updates');
fs.rmSync(UPDATES, { recursive: true, force: true });
fs.mkdirSync(UPDATES, { recursive: true });
process.env.UPDATES_DIR = UPDATES;
// 生产就是子路径部署，测试也按真实形态跑，否则 url 拼接的 bug 测不出来
process.env.BASE_PATH = 'platform';

const { build } = require('../server');
const release = require('../server/lib/release');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 500) : '')); }
}

const B = '/platform';

function mp(parts) {
  const b = '----blcloudtest' + Date.now() + crypto.randomBytes(4).toString('hex');
  const chunks = [];
  for (const p of parts) {
    if (p.file) {
      chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
      chunks.push(p.file);
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${b}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}

let APP = null;
let AUTH = {};
function publish(parts) {
  const body = mp(parts);
  return APP.inject({
    method: 'POST', url: `${B}/api/releases/publish`,
    headers: { ...AUTH, ...body.headers }, payload: body.payload,
  });
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

(async () => {
  const app = build();
  await app.ready();
  const token = (await app.inject({
    method: 'POST', url: `${B}/api/admin/login`, payload: { username: 'admin', password: 'admin123' },
  })).json().token;
  const H = { authorization: 'Bearer ' + token };
  APP = app;
  AUTH = H;

  console.log('\n[1] 版本号比较');
  check('1.0.21 > 1.0.20', release.cmpVersion('1.0.21', '1.0.20') === 1);
  check('1.0.9 < 1.0.10', release.cmpVersion('1.0.9', '1.0.10') === -1);
  check('1.2 == 1.2.0.0', release.cmpVersion('1.2', '1.2.0.0') === 0);
  check('正式版 > 预发布', release.cmpVersion('1.0.21', '1.0.21-beta.1') === 1);
  check('校验非法版本', !release.validVersion('../../etc') && !release.validVersion('abc'));

  console.log('\n[2] 发布全量包');
  const full20 = crypto.randomBytes(150 * 1024);
  let r = await publish([
      { name: 'product', value: 'LabelGo' },
      { name: 'version', value: '1.0.20' },
      { name: 'platform', value: 'win32' },
      { name: 'arch', value: 'x64' },
      { name: 'changelog', value: '- 上一版' },
      { name: 'file', filename: 'LabelGo-1.0.20-full.zip', file: full20 },
    ]);
  check('发布 1.0.20 成功', r.statusCode === 200, r.body.slice(0, 300));

  const full21 = crypto.randomBytes(220 * 1024);
  const delta21 = crypto.randomBytes(32 * 1024);
  r = await publish([
      { name: 'product', value: 'LabelGo' },
      { name: 'version', value: '1.0.21' },
      { name: 'channel', value: 'stable' },
      { name: 'platform', value: 'win32' },
      { name: 'arch', value: 'x64' },
      { name: 'min_version', value: '1.0.0' },
      { name: 'changelog', value: '- 修复共享打印机被误判离线\n- 新增 600dpi 支持' },
      { name: 'rollout', value: '100' },
      { name: 'file', filename: 'LabelGo-1.0.21-full.zip', file: full21 },
      { name: 'delta', filename: 'LabelGo-1.0.21-from-1.0.20.pkg', file: delta21 },
      { name: 'from', value: '1.0.20' },
    ]);
  const pub = r.json();
  check('发布 1.0.21（全量+增量）成功', r.statusCode === 200, r.body.slice(0, 400));
  check('落盘到 版本目录', fs.existsSync(path.join(UPDATES, '1.0.21', 'LabelGo-1.0.21-full.zip')));
  check('增量包落盘', fs.existsSync(path.join(UPDATES, '1.0.21', 'LabelGo-1.0.21-from-1.0.20.pkg')));
  check('sha256 与文件一致', pub.release.full_sha256 === sha(full21) && pub.release.full_size === full21.length);

  console.log('\n[3] 清单接口（客户端视角）');
  r = await app.inject({
    method: 'GET',
    url: `${B}/api/open/v1/app/version?product=LabelGo&version=1.0.20&platform=win32&arch=x64&channel=stable&machine=BLBT-AAAA-BBBB`,
  });
  const m = r.json();
  check('200 + JSON', r.statusCode === 200 && /application\/json/.test(r.headers['content-type']), r.headers);
  check('no-cache', r.headers['cache-control'] === 'no-cache', r.headers['cache-control']);
  check('latest=1.0.21', m.latest === '1.0.21', m);
  check('mandatory=false', m.mandatory === false, m.mandatory);
  check('minVersion=1.0.0', m.minVersion === '1.0.0', m.minVersion);
  check('changelog 保留换行', String(m.changelog).includes('\n'));
  check('full.url 绝对地址且带子路径', m.full.url === `http://localhost:80/platform/updates/1.0.21/LabelGo-1.0.21-full.zip`, m.full.url);
  check('full.sha256 小写十六进制', /^[0-9a-f]{64}$/.test(m.full.sha256) && m.full.sha256 === sha(full21));
  check('full.size 字节数', m.full.size === full21.length, m.full.size);
  check('delta[0].from=1.0.20', m.delta.length === 1 && m.delta[0].from === '1.0.20', m.delta);
  check('delta url 绝对地址', m.delta[0].url.endsWith('/updates/1.0.21/LabelGo-1.0.21-from-1.0.20.pkg'));
  check('delta 校验值正确', m.delta[0].sha256 === sha(delta21) && m.delta[0].size === delta21.length);

  r = await app.inject({ method: 'GET', url: `${B}/api/open/v1/app/version?product=LabelGo&version=1.0.21` });
  const latest = r.json();
  check('已是最新：无 full/delta', r.statusCode === 200 && !latest.full && !latest.delta, latest);
  check('已是最新：latest=1.0.21', latest.latest === '1.0.21');

  r = await app.inject({ method: 'GET', url: `${B}/api/open/v1/app/version?product=LabelGo` });
  check('不带版本号 → 直接给最新（便于排查）', r.json().latest === '1.0.21');

  console.log('\n[4] 静态下载 / Range / 目录不列');
  const fileUrlPath = `${B}/updates/1.0.21/LabelGo-1.0.21-full.zip`;
  r = await app.inject({ method: 'HEAD', url: fileUrlPath });
  check('HEAD 200', r.statusCode === 200, r.statusCode);
  check('Content-Length 正确', Number(r.headers['content-length']) === full21.length, r.headers['content-length']);
  check('Accept-Ranges: bytes', r.headers['accept-ranges'] === 'bytes', r.headers['accept-ranges']);
  check('长缓存 immutable', /immutable/.test(r.headers['cache-control'] || ''), r.headers['cache-control']);
  check('Content-Type octet-stream', /application\/octet-stream/.test(r.headers['content-type'] || ''), r.headers['content-type']);

  r = await app.inject({ method: 'GET', url: fileUrlPath, headers: { range: 'bytes=0-1023' } });
  check('Range 请求返回 206', r.statusCode === 206, r.statusCode);
  check('Range 长度 1024', r.rawPayload.length === 1024, r.rawPayload.length);
  check('Range 内容正确', r.rawPayload.equals(full21.subarray(0, 1024)));
  check('Content-Range 正确', r.headers['content-range'] === `bytes 0-1023/${full21.length}`, r.headers['content-range']);

  r = await app.inject({ method: 'GET', url: fileUrlPath });
  check('完整下载字节数一致', r.rawPayload.length === full21.length);
  check('下载内容 sha256 与清单一致', sha(r.rawPayload) === m.full.sha256);

  r = await app.inject({ method: 'GET', url: `${B}/updates/1.0.21/` });
  check('目录不可列（403/404）', r.statusCode === 403 || r.statusCode === 404, r.statusCode);
  r = await app.inject({ method: 'GET', url: `${B}/updates/` });
  check('根目录不可列', r.statusCode === 403 || r.statusCode === 404, r.statusCode);
  r = await app.inject({ method: 'GET', url: `${B}/updates/%2e%2e/%2e%2e/.appsecret` });
  check('路径穿越被拦', r.statusCode === 403 || r.statusCode === 404, r.statusCode);

  console.log('\n[5] latest.json 兜底');
  const latestFile = path.join(UPDATES, 'latest.json');
  check('文件已生成', fs.existsSync(latestFile));
  const latestBody = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
  check('latest=1.0.21', latestBody.latest === '1.0.21');
  check('url 是绝对地址', /^http:\/\/.+\/platform\/updates\/1\.0\.21\//.test(latestBody.full.url), latestBody.full.url);
  r = await app.inject({ method: 'GET', url: `${B}/updates/latest.json` });
  check('latest.json 可访问且 no-cache',
    r.statusCode === 200 && r.headers['cache-control'] === 'no-cache' && r.json().latest === '1.0.21',
    { s: r.statusCode, c: r.headers['cache-control'] });

  console.log('\n[6] 灰度 / 强制 / 上下线');
  const recId = pub.release.id;
  r = await app.inject({
    method: 'PATCH', url: `${B}/api/releases/${recId}`, headers: H, payload: { rollout: 0 },
  });
  check('设 rollout=0 成功', r.statusCode === 200, r.body);
  r = await app.inject({ method: 'GET', url: `${B}/api/open/v1/app/version?product=LabelGo&version=1.0.20&machine=M1` });
  check('rollout=0 → 不下发该版本', r.json().latest === '1.0.20', r.json());

  await app.inject({ method: 'PATCH', url: `${B}/api/releases/${recId}`, headers: H, payload: { rollout: 100, min_version: '1.0.21' } });
  r = await app.inject({ method: 'GET', url: `${B}/api/open/v1/app/version?product=LabelGo&version=1.0.20&machine=M1` });
  check('min_version 高于当前 → mandatory', r.json().mandatory === true, r.json());

  await app.inject({ method: 'PATCH', url: `${B}/api/releases/${recId}`, headers: H, payload: { enabled: false, min_version: '1.0.0' } });
  r = await app.inject({ method: 'GET', url: `${B}/api/open/v1/app/version?product=LabelGo&version=1.0.20&machine=M1` });
  check('停用后不提示更新', r.json().latest === '1.0.20', r.json());
  const afterDisable = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
  check('停用后 latest.json 回退到 1.0.20', afterDisable.latest === '1.0.20', afterDisable.latest);
  await app.inject({ method: 'PATCH', url: `${B}/api/releases/${recId}`, headers: H, payload: { enabled: true } });

  console.log('\n[7] 校验 / 删除');
  r = await app.inject({ method: 'POST', url: `${B}/api/releases/${recId}/verify`, headers: H });
  check('校验接口通过', r.json().ok === true, r.body.slice(0, 300));

  const badFile = path.join(UPDATES, '1.0.21', 'LabelGo-1.0.21-full.zip');
  const keep = fs.readFileSync(badFile);
  fs.writeFileSync(badFile, Buffer.concat([keep, Buffer.from('tampered')]));
  r = await app.inject({ method: 'POST', url: `${B}/api/releases/${recId}/verify`, headers: H });
  check('文件被改动 → 校验失败', r.json().ok === false, r.body.slice(0, 200));
  fs.writeFileSync(badFile, keep);

  r = await app.inject({ method: 'DELETE', url: `${B}/api/releases/${recId}?files=1`, headers: H });
  check('删除记录+文件', r.statusCode === 200 && !fs.existsSync(badFile), r.body);
  r = await app.inject({ method: 'GET', url: fileUrlPath });
  check('删除后下载 404', r.statusCode === 404, r.statusCode);

  console.log('\n[8] 参数守卫 / 兼容性');
  r = await publish([
      { name: 'product', value: 'LabelGo' },
      { name: 'version', value: '../../etc' },
      { name: 'file', filename: 'x.zip', file: Buffer.from('x') },
    ]);
  check('非法版本号 400', r.statusCode === 400, r.body);

  r = await publish([
      { name: 'product', value: 'LabelGo' },
      { name: 'version', value: '1.0.30' },
      { name: 'file', filename: 'evil.html', file: Buffer.from('<script>') },
    ]);
  check('不允许的扩展名 400', r.statusCode === 400, r.body);

  r = await publish([
      { name: 'product', value: 'LabelGo' },
      { name: 'version', value: '1.0.30' },
      { name: 'delta', filename: 'a.pkg', file: Buffer.from('d') },
      { name: 'from', value: '1.0.20' },
    ]);
  check('首次发布只给增量包 → 400', r.statusCode === 400, r.body);

  // 老客户端（不带 product、走签名）仍走原逻辑：没有签名就是 401，而不是被清单模式抢走
  r = await app.inject({ method: 'GET', url: `${B}/api/open/v1/app/version` });
  check('不带 product 且无签名 → 401（旧行为不变）', r.statusCode === 401, r.statusCode);

  // 无发布记录的产品：不能报错，客户端按「已是最新」处理
  r = await app.inject({ method: 'GET', url: `${B}/api/open/v1/app/version?product=Nobody&version=2.0.0` });
  check('没有发布记录 → 200 且无更新', r.statusCode === 200 && r.json().latest === '2.0.0', r.body);


  console.log('\n[多产品]');
  r = await publish([
    { name: 'product', value: 'TestPad' },
    { name: 'version', value: '2.1.0' },
    { name: 'file', filename: 'TestPad-2.1.0-full.zip', file: Buffer.from('testpad-full') },
    { name: 'changelog', value: '- TestPad 首发版' },
  ]);
  check('发布第二个产品 200', r.statusCode === 200, r.body.slice(0, 200));

  r = await app.inject({ method: 'GET', url: `${B}/api/open/v1/app/version?product=TestPad&version=2.0.0` });
  check('TestPad 清单独立返回且有更新',
    r.statusCode === 200 && r.json().latest === '2.1.0' && r.json().update_available === true,
    r.body.slice(0, 200));
  r = await app.inject({ method: 'GET', url: `${B}/api/open/v1/app/version?product=LabelGo&version=1.0.20` });
  check('LabelGo 清单不受第二个产品影响（product 正确、latest 不会串到 TestPad）',
    r.json().product === 'LabelGo' && r.json().latest !== '2.1.0',
    { product: r.json().product, latest: r.json().latest });

  const padLatest = path.join(UPDATES, 'TestPad', 'latest.json');
  check('TestPad/latest.json 存在且 product=TestPad',
    fs.existsSync(padLatest) && JSON.parse(fs.readFileSync(padLatest, 'utf8')).product === 'TestPad');
  check('根 latest.json 仍是默认产品',
    JSON.parse(fs.readFileSync(path.join(UPDATES, 'latest.json'), 'utf8')).product === 'LabelGo');
  const idx = JSON.parse(fs.readFileSync(path.join(UPDATES, 'products.json'), 'utf8'));
  check('products.json 索引含全部产品',
    idx.products.map((p) => p.product).sort().join() === 'LabelGo,TestPad', idx.products);
  check('索引里的清单地址是绝对地址',
    idx.products.every((p) => /^https?:\/\/.+\/updates\/.+\/latest\.json$/.test(p.manifest_url)), idx.products);

  r = await app.inject({ method: 'GET', url: `${B}/api/releases?product=TestPad`, headers: AUTH });
  check('列表按产品筛选', r.statusCode === 200 && r.json().list.length >= 1
    && r.json().list.every((x) => x.product === 'TestPad'), r.statusCode);
  check('筛选时 products 仍返回全量', r.json().products.length === 2, r.json().products);
  check('total_all_size 统计所有产品', r.json().total_all_size >= r.json().total_size, r.json());

  r = await app.inject({ method: 'POST', url: `${B}/api/releases/latest.json`, headers: AUTH });
  check('重建清单回显每产品文件数', r.statusCode === 200 && (r.json().files || []).length >= 4,
    (r.body || '').slice(0, 200));


  console.log('\n[升级记录]');
  const MAN = `${B}/api/open/v1/app/version?product=TestPad&version=2.0.0&machine=BLBT-TEST-0001&platform=win32&arch=x64`;
  r = await app.inject({ method: 'GET', url: MAN });
  check('清单带 report_url', /\/api\/open\/v1\/app\/update-report$/.test(r.json().report_url || ''), r.json().report_url);

  await app.inject({ method: 'GET', url: MAN }); // 同一机器重复查一次
  let ups = await app.inject({ method: 'GET', url: `${B}/api/releases/updates?product=TestPad`, headers: AUTH });
  check('清单命中落记录且 10 分钟内去重（同一机器同目标只一条）',
    ups.json().list.filter((x) => x.action === 'check' && x.machine === 'BLBT-TEST-0001').length === 1,
    ups.json().list.filter((x) => x.action === 'check').map((x) => [x.machine, x.from_version]));

  r = await app.inject({
    method: 'POST', url: `${B}/api/open/v1/app/update-report`,
    payload: { product: 'TestPad', machine: 'BLBT-TEST-0001', from: '2.0.0', to: '2.1.0', status: 'success' },
  });
  check('升级成功上报 200', r.statusCode === 200 && r.json().action === 'success', r.body);

  r = await app.inject({
    method: 'POST', url: `${B}/api/open/v1/app/update-report`,
    payload: { product: 'TestPad', machine: 'BLBT-TEST-0002', from: '2.0.0', to: '2.1.0', status: 'fail', note: '磁盘空间不足' },
  });
  check('升级失败上报 200', r.statusCode === 200 && r.json().action === 'fail', r.body);

  r = await app.inject({ method: 'POST', url: `${B}/api/open/v1/app/update-report`, payload: {} });
  check('上报缺 product → 400', r.statusCode === 400, r.statusCode);

  ups = await app.inject({ method: 'GET', url: `${B}/api/releases/updates?product=TestPad`, headers: AUTH });
  check('汇总里有成功与失败', ups.json().summary.success >= 1 && ups.json().summary.fail >= 1, ups.json().summary);
  check('涉及机器数去重', ups.json().summary.machines >= 2, ups.json().summary);
  check('失败记录带原因', ups.json().list.some((x) => x.action === 'fail' && /磁盘/.test(x.note)), ups.json().list[0]);

  // 没有新版本时不该刷记录
  await app.inject({ method: 'GET', url: `${B}/api/open/v1/app/version?product=Nobody&version=9.9.9&machine=BLBT-X` });
  ups = await app.inject({ method: 'GET', url: `${B}/api/releases/updates?product=Nobody`, headers: AUTH });
  check('已是最新时不产生记录', ups.json().list.length === 0, ups.json().summary);

  // 后台筛选动作
  ups = await app.inject({ method: 'GET', url: `${B}/api/releases/updates?product=TestPad&action=fail`, headers: AUTH });
  check('按动作筛选只看失败', ups.json().list.every((x) => x.action === 'fail') && ups.json().list.length >= 1, ups.json().list.length);

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  await app.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

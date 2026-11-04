/* 子路径部署自测：验证 BASE_PATH=platform 时全套路径正确，且根路径部署不受影响
 * 用法：node tools/test-subpath.js
 * 使用独立测试库，不影响正式数据
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const NODE = process.execPath;
const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 240) : '')); }
}

// 在子进程里跑，因为 BASE_PATH 在模块加载时就要确定。
// 结果写临时文件而不是走 stdout —— Fastify 的请求日志会混进 stdout，不好解析。
function probe(dbFile, env) {
  const outFile = path.join(ROOT, 'data', `.subpath-${path.basename(dbFile, '.db')}.json`);
  fs.rmSync(outFile, { force: true });
  const script = `
    const fs = require('fs');
    const { build } = require(${JSON.stringify(path.join(ROOT, 'server', 'index.js'))});
    (async () => {
      const app = build();
      const out = {};
      for (const p of ${JSON.stringify(PATHS)}) {
        const r = await app.inject({ method: 'GET', url: p });
        out[p] = r.statusCode;
      }
      // 目录型 URL 无斜杠必须 301 补斜杠且保留查询参数（否则相对路径资源全 404，线上踩过）
      const BP = process.env.BASE_PATH ? '/' + process.env.BASE_PATH : '';
      const r1 = await app.inject({ method: 'GET', url: BP + '/admin?next=/x' });
      out.__adminNoSlash = r1.statusCode + ' ' + (r1.headers.location || '');
      const r2 = await app.inject({ method: 'GET', url: BP + '/user?agent=AG4CA8D3AA' });
      out.__userNoSlash = r2.statusCode + ' ' + (r2.headers.location || '');
      const l = await app.inject({ method: 'POST', url: ${JSON.stringify(env.LOGIN_URL)}, payload: { username: 'admin', password: 'admin123' } });
      out.__login = l.statusCode;
      const { baseUrl } = require(${JSON.stringify(path.join(ROOT, 'server', 'services', 'pay.js'))});
      out.__baseUrl = baseUrl({ headers: { host: 'www.bliot.cn', 'x-forwarded-proto': 'https' } });
      // 对外链接统一走 publicUrl：手写 basePath() + 'user/' 会拼出 /platformuser/（线上 404 过）
      const cfg = require(${JSON.stringify(path.join(ROOT, 'server', 'lib', 'config.js'))});
      const fakeReq = { headers: { host: 'www.bliot.cn', 'x-forwarded-proto': 'https' } };
      out.__promote = cfg.publicUrl(fakeReq, '/user/?agent=AG4CA8D3AA');
      out.__promoteNoSlash = cfg.publicUrl(fakeReq, 'user/?agent=AG4CA8D3AA');
      fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(out));
      await app.close();
      process.exit(0);
    })().catch(e => { fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ __error: e.message })); process.exit(1); });
  `;
  try {
    execFileSync(NODE, ['-e', script], {
      cwd: ROOT,
      env: { ...process.env, DB_PATH: dbFile, ADMIN_INIT_PASSWORD: 'admin123', ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch (e) { /* 子进程写文件失败时由下面的读取负责报错 */ }
  const raw = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '{}';
  fs.rmSync(outFile, { force: true });
  const parsed = JSON.parse(raw);
  if (parsed.__error) throw new Error(parsed.__error);
  return parsed;
}

const PATHS = [
  '/api/health', '/platform/api/health',
  '/admin/', '/platform/admin/',
  '/user/', '/platform/user/',
  '/assets/api.js', '/platform/assets/api.js',
  '/vendor/vue.global.prod.js', '/platform/vendor/vue.global.prod.js',
];

function clean(f) { for (const s of ['', '-wal', '-shm']) fs.rmSync(f + s, { force: true }); }

console.log('[1] 子路径部署 BASE_PATH=platform');
const db1 = path.join(ROOT, 'data', 'test-subpath.db');
clean(db1);
const sub = probe(db1, { BASE_PATH: 'platform', LOGIN_URL: '/platform/api/admin/login' });
check('/platform/api/health 可访问', sub['/platform/api/health'] === 200, sub['/platform/api/health']);
check('/platform/admin/ 可访问', sub['/platform/admin/'] === 200, sub['/platform/admin/']);
check('/platform/user/ 可访问', sub['/platform/user/'] === 200, sub['/platform/user/']);
check('/platform/assets/api.js 可访问', sub['/platform/assets/api.js'] === 200, sub['/platform/assets/api.js']);
check('/platform/vendor/vue.global.prod.js 可访问', sub['/platform/vendor/vue.global.prod.js'] === 200);
check('子路径下登录接口可用', sub.__login === 200, sub.__login);
check('未加前缀的 /api/health 应 404', sub['/api/health'] === 404, sub['/api/health']);
check('未加前缀的 /admin/ 应 404', sub['/admin/'] === 404, sub['/admin/']);
check('回调地址自动带上 /platform', sub.__baseUrl === 'https://www.bliot.cn/platform', sub.__baseUrl);
check('推广链接带 /platform/user/（不粘成 platformuser）',
  sub.__promote === 'https://www.bliot.cn/platform/user/?agent=AG4CA8D3AA', sub.__promote);
check('publicUrl 自动补前导斜杠',
  sub.__promoteNoSlash === 'https://www.bliot.cn/platform/user/?agent=AG4CA8D3AA', sub.__promoteNoSlash);

console.log('\n[2] 根路径部署（不设 BASE_PATH，向后兼容）');
const db2 = path.join(ROOT, 'data', 'test-rootpath.db');
clean(db2);
const root = probe(db2, { BASE_PATH: '', LOGIN_URL: '/api/admin/login' });
check('/api/health 可访问', root['/api/health'] === 200, root['/api/health']);
check('/admin/ 可访问', root['/admin/'] === 200, root['/admin/']);
check('/user/ 可访问', root['/user/'] === 200, root['/user/']);
check('/assets/api.js 可访问', root['/assets/api.js'] === 200, root['/assets/api.js']);
check('根路径下登录接口可用', root.__login === 200, root.__login);
check('根路径下 /platform/... 应 404', root['/platform/api/health'] === 404, root['/platform/api/health']);
check('回调地址不带多余前缀', root.__baseUrl === 'https://www.bliot.cn', root.__baseUrl);
check('根路径下推广链接为 /user/?agent=',
  root.__promote === 'https://www.bliot.cn/user/?agent=AG4CA8D3AA', root.__promote);

console.log('\n[2.5] 无斜杠目录 URL 必须 301 补斜杠（相对路径资源全 404 的根因）');
check('/platform/admin → 301 保留查询参数',
  sub.__adminNoSlash === '301 /platform/admin/?next=/x', sub.__adminNoSlash);
check('/platform/user?agent= → 301 保留查询参数',
  sub.__userNoSlash === '301 /platform/user/?agent=AG4CA8D3AA', sub.__userNoSlash);
check('根路径 /admin → 301 /admin/?next=/x（本来就对）',
  root.__adminNoSlash === '301 /admin/?next=/x', root.__adminNoSlash);
check('根路径 /user?agent= → 301 /user/?agent=',
  root.__userNoSlash === '301 /user/?agent=AG4CA8D3AA', root.__userNoSlash);

console.log('\n[3] 前端基础路径推断（与后端保持一致）');
const m = (p) => { const x = p.match(/^(.*?)\/(admin|user)(\/|$)/); return x ? x[1] : ''; };
check('/admin/ → 推断为空', m('/admin/') === '', m('/admin/'));
check('/platform/admin/ → 推断为 /platform', m('/platform/admin/') === '/platform', m('/platform/admin/'));
check('/platform/user/ → 推断为 /platform', m('/platform/user/') === '/platform', m('/platform/user/'));
check('/user/#/orders 也能识别', m('/platform/user/') === '/platform', m('/platform/user/'));

console.log('\n[4] HTML 资源已改为相对路径（两种部署都能加载）');
const adminHtml = fs.readFileSync(path.join(ROOT, 'public', 'admin', 'index.html'), 'utf8');
const userHtml = fs.readFileSync(path.join(ROOT, 'public', 'user', 'index.html'), 'utf8');
check('admin/index.html 无绝对路径脚本', !/src="\/(vendor|assets|admin)\//.test(adminHtml));
check('admin/index.html 用 ../assets 引用样式', adminHtml.includes('href="../assets/ui.css"'));
check('user/index.html 无绝对路径脚本', !/src="\/(vendor|assets|user)\//.test(userHtml));
check('user/index.html 用 ../assets 引用样式', userHtml.includes('href="../assets/ui.css"'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

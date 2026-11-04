/* 账套备份 / 恢复 / 演示数据清理自测
 * 运行：node tools/test-backup.js
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-backup.db');
for (const s of ['', '-wal', '-shm']) fs.rmSync(DB_FILE + s, { force: true });
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.NODE_ENV = 'test';
// 备份/暂存目录改道，避免测试清空真实备份（cleanZips 会删掉目录内所有 zip）
const TEST_BACKUP_DIR = path.join(__dirname, '..', 'data', 'test-backup-zips');
const TEST_RESTORE_DIR = path.join(__dirname, '..', 'data', 'test-backup-restore');
for (const d of [TEST_BACKUP_DIR, TEST_RESTORE_DIR]) {
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
}
process.env.BACKUP_DIR = TEST_BACKUP_DIR;
process.env.RESTORE_DIR = TEST_RESTORE_DIR;

const { build } = require('../server');
const db = require('../server/db');
const { createZip, readZip } = require('../server/lib/zip');
const backup = require('../server/lib/backup');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 400) : '')); }
}

function mp(field, filename, buf) {
  const boundary = '----blcloudtest' + Date.now();
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n`
    + 'Content-Type: application/zip\r\n\r\n'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, buf, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function cleanZips() {
  try {
    for (const b of backup.list()) backup.remove(b.name);
  } catch { /* ignore */ }
}

(async () => {
  const app = build();
  await app.ready();
  const token = (await app.inject({
    method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' },
  })).json().token;
  const H = { authorization: 'Bearer ' + token };

  /* ---------------- 1. zip 读写 ---------------- */
  console.log('\n[1] ZIP 读写（无第三方依赖）');
  const bin = Buffer.from([0, 1, 2, 255, 254, 0, 128]);
  const zipBuf = createZip([
    { name: 'a.txt', data: Buffer.from('hello 账套') },
    { name: 'dir/b.bin', data: bin },
    { name: '中文/说明.txt', data: Buffer.from('中文文件名') },
  ]);
  const parsed = readZip(zipBuf);
  check('zip 可解析 3 个条目', parsed.size === 3, parsed.size);
  check('文本内容一致', parsed.get('a.txt').toString('utf8') === 'hello 账套');
  check('二进制内容一致', Buffer.compare(parsed.get('dir/b.bin'), bin) === 0);
  check('中文文件名与内容一致', parsed.get('中文/说明.txt').toString('utf8') === '中文文件名');
  let rejected = false;
  try { createZip([{ name: '../evil.txt', data: Buffer.from('x') }]); } catch { rejected = true; }
  check('拒绝路径穿越条目', rejected);
  let badZip = false;
  try { readZip(Buffer.from('not a zip file at all')); } catch { badZip = true; }
  check('非 zip 数据被拒绝', badZip);

  /* ---------------- 2. 造业务数据 ---------------- */
  console.log('\n[2] 造业务数据');
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO users (openid, nickname, created_at) VALUES ('bk-u1','备份测试用户',?)").run(ts);
  const uid = db.prepare("SELECT id FROM users WHERE openid = 'bk-u1'").get().id;
  db.prepare(`INSERT INTO products (type,name,price,status,created_at,updated_at)
    VALUES ('software','备份测试商品',9,'on',?,?)`).run(ts, ts);
  const pid = db.prepare("SELECT id FROM products WHERE name = '备份测试商品'").get().id;
  db.prepare(`INSERT INTO orders (order_no,user_id,amount,pay_amount,status,items,created_at)
    VALUES ('NO-BACKUP-1',?,9,9,'paid','[]',?)`).run(uid, ts);
  db.prepare(`INSERT INTO licenses (license_key,user_id,product_id,type,start_at,status,created_at)
    VALUES ('LIC-BACKUP-1',?,?,'permanent',?,'active',?)`).run(uid, pid, ts, ts);
  check('测试数据已写入', db.prepare('SELECT COUNT(*) c FROM users').get().c >= 1);

  /* ---------------- 3. 创建备份 ---------------- */
  console.log('\n[3] 创建备份');
  cleanZips();
  const created = (await app.inject({ method: 'POST', url: '/api/backup/create', headers: H, payload: { note: '自测备份' } })).json();
  check('备份创建成功', created.ok && /^blcloud-\d{8}-\d{6}\.zip$/.test(created.name || ''), created);
  check('备份包内行数 > 0', created.rows > 0, created.rows);
  const zipPath = path.join(backup.BACKUP_DIR, created.name);
  check('备份文件已落盘', fs.existsSync(zipPath));
  const pkg = readZip(fs.readFileSync(zipPath));
  check('包内包含 app.db 与 manifest.json', pkg.has('app.db') && pkg.has('manifest.json'));
  check('包内包含加密主密钥 .appsecret', pkg.has('.appsecret'));
  const mf = JSON.parse(pkg.get('manifest.json').toString('utf8'));
  check('manifest 标记了数据量与校验和', mf.db && mf.db.rows > 0 && /^[a-f0-9]{64}$/.test(mf.db.sha256));

  const listRes = (await app.inject({ method: 'GET', url: '/api/backup/list', headers: H })).json();
  check('备份列表可读', (listRes.list || []).some((b) => b.name === created.name));
  check('列表带 manifest 摘要', !!(listRes.list[0] && listRes.list[0].manifest), listRes.list[0]);

  const dl = await app.inject({ method: 'GET', url: '/api/backup/download/' + created.name, headers: H });
  check('下载接口返回 zip', dl.statusCode === 200 && dl.headers['content-type'] === 'application/zip');
  check('下载内容以 PK 开头', dl.rawPayload.slice(0, 2).toString() === 'PK');
  check('下载头带 attachment', /attachment/.test(String(dl.headers['content-disposition'] || '')));

  const noAuth = await app.inject({ method: 'GET', url: '/api/backup/download/' + created.name });
  check('未登录不能下载备份', noAuth.statusCode === 401);
  const traversal = await app.inject({ method: 'GET', url: '/api/backup/download/..%2F..%2Fapp.db', headers: H });
  check('非法文件名被拒', traversal.statusCode === 404);

  /* ---------------- 4. 恢复（原地覆盖） ---------------- */
  console.log('\n[4] 恢复');
  // 造「恢复前」的差异：删掉用户和订单
  db.prepare("DELETE FROM orders WHERE order_no = 'NO-BACKUP-1'").run();
  db.prepare('DELETE FROM users WHERE openid = ?').run('bk-u1');
  check('破坏后用户已消失', !db.prepare("SELECT 1 FROM users WHERE openid = 'bk-u1'").get());

  const form1 = mp('file', created.name, dl.rawPayload);
  const upload = await app.inject({
    method: 'POST', url: '/api/backup/restore', headers: { ...H, ...form1.headers }, payload: form1.payload,
  });
  const staged = upload.json();
  check('上传备份包通过校验', upload.statusCode === 200 && staged.ok && !!staged.token, staged);
  check('校验结果带表清单', Array.isArray(staged.tables) && staged.tables.includes('users'));

  const wrongConfirm = await app.inject({
    method: 'POST', url: '/api/backup/restore/apply', headers: H, payload: { token: staged.token, confirm: 'yes' },
  });
  check('未输入 RESTORE 不能恢复', wrongConfirm.statusCode === 400);

  const applied = (await app.inject({
    method: 'POST', url: '/api/backup/restore/apply', headers: H, payload: { token: staged.token, confirm: 'RESTORE' },
  })).json();
  check('恢复执行成功', applied.ok && applied.rows > 0, applied);
  check('用户已恢复', !!db.prepare("SELECT 1 FROM users WHERE openid = 'bk-u1'").get());
  check('订单已恢复', !!db.prepare("SELECT 1 FROM orders WHERE order_no = 'NO-BACKUP-1'").get());
  check('授权已恢复', !!db.prepare("SELECT 1 FROM licenses WHERE license_key = 'LIC-BACKUP-1'").get());
  check('恢复前自动备份已生成', /^pre-restore-/.test(applied.pre_backup || ''), applied.pre_backup);
  const reused = await app.inject({
    method: 'POST', url: '/api/backup/restore/apply', headers: H, payload: { token: staged.token, confirm: 'RESTORE' },
  });
  check('同一暂存包不能重复使用', reused.statusCode === 500);

  const junkForm = mp('file', 'bad.zip', Buffer.from('garbage'));
  const junk = await app.inject({
    method: 'POST', url: '/api/backup/restore', headers: { ...H, ...junkForm.headers }, payload: junkForm.payload,
  });
  check('垃圾文件被拒绝', junk.statusCode === 400);

  // 旧备份 + 新列：恢复不能因列数不符失败
  db.exec("ALTER TABLE users ADD COLUMN zz_new_col TEXT DEFAULT ''");
  const form2 = mp('file', created.name, dl.rawPayload);
  const upload2 = await app.inject({
    method: 'POST', url: '/api/backup/restore', headers: { ...H, ...form2.headers }, payload: form2.payload,
  });
  const staged2 = upload2.json();
  const applied2 = (await app.inject({
    method: 'POST', url: '/api/backup/restore/apply', headers: H, payload: { token: staged2.token, confirm: 'RESTORE' },
  })).json();
  check('备份缺列时恢复仍成功（新列走默认值）', applied2.ok && !!db.prepare("SELECT 1 FROM users WHERE openid = 'bk-u1'").get(), applied2);

  /* ---------------- 5. 清理演示数据 ---------------- */
  console.log('\n[5] 清理演示数据');
  const preview = (await app.inject({ method: 'GET', url: '/api/maintenance/purge/preview', headers: H })).json();
  check('预览返回分组', Array.isArray(preview.groups) && preview.groups.length >= 5);
  const userGroup = (preview.groups || []).find((g) => g.key === 'users');
  check('预览带行数', userGroup && userGroup.rows >= 1, userGroup);

  const beforeAdmins = db.prepare('SELECT COUNT(*) c FROM admins').get().c;
  const beforeSettings = db.prepare('SELECT COUNT(*) c FROM settings').get().c;
  const beforeProducts = db.prepare('SELECT COUNT(*) c FROM products').get().c;

  const badPurge = await app.inject({
    method: 'POST', url: '/api/maintenance/purge', headers: H, payload: { groups: ['users'], confirm: 'x' },
  });
  check('未确认不能清理', badPurge.statusCode === 400);

  const purged = (await app.inject({
    method: 'POST', url: '/api/maintenance/purge', headers: H,
    payload: { groups: ['transactions', 'licenses', 'agents', 'devices', 'users', 'logs', 'stats'], confirm: '清除', backup: true },
  })).json();
  check('清理执行成功', purged.ok && purged.total > 0, purged);
  check('用户已清空', db.prepare('SELECT COUNT(*) c FROM users').get().c === 0);
  check('订单已清空', db.prepare('SELECT COUNT(*) c FROM orders').get().c === 0);
  check('授权已清空', db.prepare('SELECT COUNT(*) c FROM licenses').get().c === 0);
  check('管理员未被删除', db.prepare('SELECT COUNT(*) c FROM admins').get().c === beforeAdmins);
  check('站点配置未被删除', db.prepare('SELECT COUNT(*) c FROM settings').get().c === beforeSettings);
  check('商品目录保留（未勾选）', db.prepare('SELECT COUNT(*) c FROM products').get().c === beforeProducts);
  check('清理前自动备份已生成', /^pre-purge-/.test(purged.backup || ''), purged.backup);

  // 清空用户后，管理后台仍可用（不能把系统清成不能登录）
  const stillOk = await app.inject({ method: 'GET', url: '/api/admin/me', headers: H });
  check('清理后管理员仍可访问后台', stillOk.statusCode === 200);
  const health = await app.inject({ method: 'GET', url: '/api/health' });
  check('清理后健康检查正常', health.statusCode === 200);

  /* ---------------- 6. 清理后重启不复活演示数据 ---------------- */
  console.log('\n[6] 清理后重启不复活演示数据');
  const { execFileSync } = require('child_process');
  const probe = execFileSync(process.execPath, ['-e',
    "const db=require('./server/db');"
    + "console.log(JSON.stringify({stats:db.prepare('SELECT COUNT(*) c FROM stats_daily').get().c,"
    + "products:db.prepare('SELECT COUNT(*) c FROM products').get().c}));",
  ], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH: DB_FILE, LOG_LEVEL: 'silent' },
    encoding: 'utf8',
  });
  const after = JSON.parse(probe.trim().split('\n').pop());
  check('重启后演示统计不会被重新种入', after.stats === 0, after);
  check('重启后商品目录不变（seed 不会补回）', after.products === beforeProducts, after);

  /* ---------------- 7. 概览 ---------------- */
  console.log('\n[7] 概览');
  const summary = (await app.inject({ method: 'GET', url: '/api/backup/summary', headers: H })).json();
  check('概览返回数据库大小', summary.db_bytes > 0, summary.db_bytes);
  check('概览标记主密钥存在', summary.has_appsecret === true);
  check('概览统计备份份数', summary.backup_count >= 2, summary.backup_count);

  await app.close();

  /* ---------------- 8. 后台接线（静态） ---------------- */
  console.log('\n[8] 后台页面接线');
  const ROOT = path.join(__dirname, '..');
  const pageJs = fs.readFileSync(path.join(ROOT, 'public', 'admin', 'js', 'pages-backup.js'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(ROOT, 'public', 'admin', 'index.html'), 'utf8');
  const adminApp = fs.readFileSync(path.join(ROOT, 'public', 'admin', 'js', 'app.js'), 'utf8');
  const tmpl = pageJs.split('template: `')[1] ? pageJs.split('template: `')[1].split('`,')[0] : '';
  check('页面脚本已挂到 index.html', adminHtml.includes('js/pages-backup.js'));
  check('页面组件已注册并渲染', adminHtml.includes("'Backup'") && adminHtml.includes('page-backup'));
  check('侧边栏有入口', /key: 'backup'/.test(adminApp));
  check('模板不直接引用全局 U（Vue 模板作用域限制）', !/\bU\./.test(tmpl));
  check('模板没有自闭合自定义组件', !/<page-[a-z-]+\s*\/>/.test(tmpl));
  check('恢复前必须输入 RESTORE', pageJs.includes("restoreConfirm.toUpperCase() !== 'RESTORE'"));
  check('清理前必须输入「清除」', pageJs.includes("purgeConfirm !== '清除'"));

  /* ---------------- 9. 页面真实渲染（jsdom + Vue 生产包） ---------------- */
  console.log('\n[9] 后台页面可挂载');
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>',
    { runScripts: 'outside-only', url: 'http://localhost/admin/' });
  const w = dom.window;
  w.eval(fs.readFileSync(path.join(ROOT, 'public', 'vendor', 'vue.global.prod.js'), 'utf8'));
  w.U = {
    basePath: '',
    fmt: { money: (n) => String(n) },
    toast() {},
    api: {
      get: async (url) => (url.includes('preview') ? { groups: [] } : (url.includes('list') ? { list: [] } : { tables: {} })),
      post: async () => ({}),
      del: async () => ({}),
      getToken: () => '',
    },
  };
  w.eval(pageJs);
  let rendered = '';
  let mountErr = '';
  try {
    w.Vue.createApp(w.PageBackup).mount(w.document.getElementById('app'));
    await new Promise((r) => setTimeout(r, 60));
    rendered = w.document.body.innerHTML;
  } catch (e) { mountErr = e.message; }
  check('组件挂载无异常', !mountErr, mountErr);
  check('渲染出备份区块', rendered.includes('账套备份'), rendered.slice(0, 120));
  check('渲染出恢复区块', rendered.includes('从备份恢复'));
  check('渲染出清理区块', rendered.includes('清理演示'));

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});

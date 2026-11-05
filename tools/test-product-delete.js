/* 商品删除 / 演示数据不复活 / 确认框不依赖原生 confirm 自测
 * 运行：node tools/test-product-delete.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-product-delete.db');
for (const s of ['', '-wal', '-shm']) fs.rmSync(DB_FILE + s, { force: true });
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.NODE_ENV = 'test';

const { build } = require('../server');
const db = require('../server/db');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 400) : '')); }
}

const ROOT = path.join(__dirname, '..');

(async () => {
  const app = build();
  await app.ready();
  const token = (await app.inject({
    method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' },
  })).json().token;
  const H = { authorization: 'Bearer ' + token };

  console.log('\n[1] 全新库会种演示商品');
  const seeded = (await app.inject({ method: 'GET', url: '/api/products', headers: H })).json();
  check('全新库种了 4 个演示商品', seeded.list.length === 4, seeded.list.map((p) => p.name));
  const prod = seeded.list.find((p) => p.type === 'software');
  check('能拿到软件类商品', !!prod, seeded.list.map((p) => p.type));

  console.log('\n[2] 商品被授权引用时，删除要明确说明原因而不是静默失败');
  const uid = db.prepare("INSERT INTO users (openid, nickname, created_at) VALUES ('del-user', '删除测试', ?)")
    .run(new Date().toISOString()).lastInsertRowid;
  const key = 'LIC-DELETE-TEST-0001';
  db.prepare(`INSERT INTO licenses (license_key, user_id, product_id, type, max_devices, start_at, status, created_at)
    VALUES (?,?,?,'permanent',1,?,'active',?)`).run(key, uid, prod.id, new Date().toISOString(), new Date().toISOString());

  const blocked = await app.inject({ method: 'DELETE', url: `/api/products/${prod.id}`, headers: H });
  const bb = blocked.json();
  check('返回 409 而不是 200', blocked.statusCode === 409, blocked.statusCode);
  check('错误码为 PRODUCT_IN_USE', bb.code === 'PRODUCT_IN_USE', bb.code);
  check('给出了阻塞原因（授权张数）', bb.blockers && bb.blockers.licenses === 1, bb.blockers);
  check('提示了可先下架', typeof bb.hint === 'string' && bb.hint.includes('下架'), bb.hint);
  check('商品没有被删掉', !!db.prepare('SELECT 1 FROM products WHERE id = ?').get(prod.id));

  console.log('\n[3] 强制删除会作废授权并解除引用');
  const forced = await app.inject({ method: 'DELETE', url: `/api/products/${prod.id}?force=1`, headers: H });
  const fr = forced.json();
  check('强制删除成功', forced.statusCode === 200 && fr.ok, forced.statusCode);
  check('作废了 1 张授权', fr.revoked === 1, fr);
  check('商品已删除', !db.prepare('SELECT 1 FROM products WHERE id = ?').get(prod.id));
  check('授权变为 revoked', db.prepare('SELECT status FROM licenses WHERE license_key = ?').get(key).status === 'revoked');

  console.log('\n[4] 无引用商品直接删除（不打扰用户）');
  const another = (await app.inject({ method: 'GET', url: '/api/products', headers: H })).json().list[0];
  const plain = await app.inject({ method: 'DELETE', url: `/api/products/${another.id}`, headers: H });
  check('直接删除返回 200', plain.statusCode === 200 && plain.json().ok, plain.statusCode);
  const repeat = await app.inject({ method: 'DELETE', url: `/api/products/${another.id}`, headers: H });
  check('重复删除幂等', repeat.statusCode === 200 && repeat.json().already === true, repeat.json());

  // 浏览器真实请求形态：声明 application/json 但没有 body。
  // Fastify 默认会回 400 FST_ERR_CTP_EMPTY_JSON_BODY（线上「删除按钮全报 BadRequest」就是这个）
  const jsonDel = await app.inject({
    method: 'DELETE', url: `/api/products/${another.id}`,
    headers: { ...H, 'content-type': 'application/json' },
  });
  check('空 body + JSON 头的 DELETE 不再 400', jsonDel.statusCode === 200, jsonDel.body);

  console.log('\n[5] 软件应用绑定商品时同样要挡住');
  const p2 = (await app.inject({ method: 'GET', url: '/api/products', headers: H })).json().list[0];
  db.prepare(`INSERT INTO open_apps (app_key, app_secret, name, product_id, status, created_at)
    VALUES ('AK-DEL-TEST','SK-DEL-TEST','删除测试应用',?,'active',?)`).run(p2.id, new Date().toISOString());
  const appBlocked = await app.inject({ method: 'DELETE', url: `/api/products/${p2.id}`, headers: H });
  check('应用绑定时返回 409', appBlocked.statusCode === 409, appBlocked.statusCode);
  check('指出是哪个应用', (appBlocked.json().blockers.open_app || {}).name === '删除测试应用', appBlocked.json().blockers);
  const appForced = (await app.inject({ method: 'DELETE', url: `/api/products/${p2.id}?force=1`, headers: H })).json();
  check('强制删除解绑了应用', appForced.detachedApps === 1, appForced);
  check('应用本身保留、只解除绑定',
    !!db.prepare('SELECT id FROM open_apps WHERE app_key = ?').get('AK-DEL-TEST')
    && db.prepare('SELECT product_id FROM open_apps WHERE app_key = ?').get('AK-DEL-TEST').product_id === null);

  console.log('\n[6] 删光商品后重启，演示数据不能复活');
  for (const p of (await app.inject({ method: 'GET', url: '/api/products', headers: H })).json().list) {
    await app.inject({ method: 'DELETE', url: `/api/products/${p.id}?force=1`, headers: H });
  }
  check('当前商品为空', db.prepare('SELECT COUNT(*) c FROM products').get().c === 0);
  // 统计也一起清掉：管理员在「备份恢复 → 清理」里勾「统计」就是删这两张表的数据
  db.prepare('DELETE FROM stats_daily').run();
  check('统计已清空', db.prepare('SELECT COUNT(*) c FROM stats_daily').get().c === 0);
  await app.close();

  // 子进程重新载入 server/db：同一份库文件、非全新库 → 不应再种演示商品
  const out = execFileSync(process.execPath, ['-e', `
    process.env.DB_PATH = ${JSON.stringify(DB_FILE)};
    process.env.NODE_ENV = 'test';
    const db = require(${JSON.stringify(path.join(ROOT, 'server', 'db'))});
    const n = db.prepare('SELECT COUNT(*) c FROM products').get().c;
    const s = db.prepare('SELECT COUNT(*) c FROM stats_daily').get().c;
    process.stdout.write(JSON.stringify({ products: n, stats: s }));
  `], { encoding: 'utf8' });
  const after = JSON.parse(out.trim().split('\n').pop());
  check('重启后商品仍为 0（不复活）', after.products === 0, after);
  check('重启后演示统计也没回来', after.stats === 0, after);

  console.log('\n[7] 前端不再依赖原生 confirm（内嵌浏览器里会被静默禁用）');
  const apiJs = fs.readFileSync(path.join(ROOT, 'public', 'assets', 'api.js'), 'utf8');
  check('提供 U.confirm', /confirm:\s*confirmBox/.test(apiJs));
  check('U.confirm 返回 Promise 且自绘 DOM', /function confirmBox\(/.test(apiJs) && /new Promise/.test(apiJs));
  check('提供统一失败提示 U.failMsg', /failMsg/.test(apiJs));
  const frontFiles = [
    'public/admin/js/pages-agents.js', 'public/admin/js/pages-backup.js', 'public/admin/js/pages-blcloud.js',
    'public/admin/js/pages-openapi.js', 'public/admin/js/pages-plans.js', 'public/admin/js/pages-products.js',
    'public/admin/js/pages-system.js', 'public/admin/js/pages-trade.js', 'public/admin/js/pages-users.js',
    'public/user/js/pages-blcloud.js', 'public/user/js/pages.js',
  ];
  const leftovers = [];
  for (const f of frontFiles) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    // 排除 U.confirm 自身与 restoreConfirm/purgeConfirm 这类变量名
    if (/(^|[^.\w])confirm\(/.test(src.replace(/U\.confirm\(/g, ''))) leftovers.push(f);
    if (!/await U\.confirm\(/.test(src)) leftovers.push(f + '（未使用 U.confirm）');
  }
  check('所有确认框都走 U.confirm', leftovers.length === 0, leftovers);

  console.log('\n[8] 商品页删除失败必须能看到原因');
  const prodJs = fs.readFileSync(path.join(ROOT, 'public/admin/js/pages-products.js'), 'utf8');
  check('409 时弹二次确认而不是静默返回', /PRODUCT_IN_USE/.test(prodJs) && /force=1/.test(prodJs));
  check('兜底错误提示存在', /U\.failMsg\(e, '删除失败'\)/.test(prodJs));

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

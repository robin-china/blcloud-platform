/* 演示统计清零自测
 * 覆盖：种子不再造假、清零接口、销量按真实订单重算、趋势清空、重启不复活
 * 运行：node tools/test-stats-reset.js
 */
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-statsreset.db');
for (const s of ['', '-wal', '-shm']) fs.rmSync(DB_FILE + s, { force: true });
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.NODE_ENV = 'test';
process.env.BASE_PATH = 'platform';

const db = require('../server/db');
const { build } = require('../server');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 400) : '')); }
}
const B = '/platform';

(async () => {
  const app = build();
  await app.ready();
  const token = (await app.inject({
    method: 'POST', url: `${B}/api/admin/login`, payload: { username: 'admin', password: 'admin123' },
  })).json().token;
  const H = { authorization: 'Bearer ' + token };

  console.log('\n[1] 新库种子不再带假统计');
  const seeded = db.prepare('SELECT id, name, total_downloads, total_installs, active_users, total_sales FROM products').all();
  check('演示商品仍然会种（无统计数字）', seeded.length === 4, seeded.length);
  check('种子的下载/安装/活跃/销量全为 0',
    seeded.every((p) => !p.total_downloads && !p.total_installs && !p.active_users && !p.total_sales),
    seeded);
  check('新库不再种 14 天假趋势', db.prepare('SELECT COUNT(*) c FROM stats_daily').get().c === 0);

  console.log('\n[2] 老库里的假数字（模拟线上）');
  const p1 = seeded[0];
  const p2 = seeded[1];
  db.prepare('UPDATE products SET total_downloads = 12840, total_installs = 8932, active_users = 5210, total_sales = 2130 WHERE id = ?').run(p1.id);
  db.prepare('UPDATE products SET total_downloads = 0, total_installs = 3120, active_users = 2870, total_sales = 3120 WHERE id = ?').run(p2.id);
  for (let i = 0; i < 5; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    db.prepare('INSERT INTO stats_daily (date, downloads, installs, active_users) VALUES (?,?,?,?)').run(d, 268, 193, 1100);
  }
  check('已写入 5 行假趋势', db.prepare('SELECT COUNT(*) c FROM stats_daily').get().c === 5);

  // 一条真实已支付订单：p2 买 2 台
  const uid = db.prepare("INSERT INTO users (openid, nickname, created_at) VALUES ('stats-u1', '真实买家', ?)")
    .run(new Date().toISOString()).lastInsertRowid;
  db.prepare(`INSERT INTO orders (order_no, user_id, amount, pay_amount, status, items, created_at, paid_at)
    VALUES ('SO-STATS-1', ?, 798, 798, 'paid', ?, ?, ?)`)
    .run(uid, JSON.stringify([{ product_id: p2.id, product_name: p2.name, qty: 2 }]),
      new Date().toISOString(), new Date().toISOString());

  console.log('\n[3] 清零接口');
  const r = await app.inject({ method: 'POST', url: `${B}/api/stats/reset`, headers: H, payload: { real_sales: true } });
  check('接口 200', r.statusCode === 200, r.body.slice(0, 200));
  const body = r.json();
  check('返回前后对比', body.before && body.after && body.before.d > 0, body.before);

  const after = db.prepare('SELECT id, total_downloads, total_installs, active_users, total_sales FROM products ORDER BY id').all();
  check('下载/安装/活跃全部归零',
    after.every((p) => p.total_downloads === 0 && p.total_installs === 0 && p.active_users === 0), after);
  const salesP2 = after.find((p) => p.id === p2.id).total_sales;
  check('销量按已支付订单重算（2 台）', salesP2 === 2, salesP2);
  check('没卖过的商品销量为 0', after.find((p) => p.id === p1.id).total_sales === 0,
    after.find((p) => p.id === p1.id).total_sales);
  check('趋势清空', db.prepare('SELECT COUNT(*) c FROM stats_daily').get().c === 0,
    db.prepare('SELECT COUNT(*) c FROM stats_daily').get().c);

  console.log('\n[4] 概览接口不再返回假数');
  const ov = (await app.inject({ method: 'GET', url: `${B}/api/stats/overview`, headers: H })).json();
  check('概览下载为 0', ov.products.downloads === 0, ov.products);
  check('概览安装为 0', ov.products.installs === 0, ov.products);
  check('概览活跃为 0', ov.products.active_users === 0, ov.products);
  check('今日下载为 0（趋势已清）', ov.today.downloads === 0, ov.today);

  console.log('\n[5] 彻底归零模式（real_sales=false）');
  const r2 = await app.inject({ method: 'POST', url: `${B}/api/stats/reset`, headers: H, payload: { real_sales: false } });
  check('接口 200', r2.statusCode === 200, r2.body.slice(0, 160));
  const salesAll = db.prepare('SELECT IFNULL(SUM(total_sales),0) s FROM products').get().s;
  check('销量也归零', salesAll === 0, salesAll);

  console.log('\n[6] 只读身份不能清');
  const r3 = await app.inject({ method: 'POST', url: `${B}/api/stats/reset`, payload: {} });
  check('不带令牌 401', r3.statusCode === 401, r3.statusCode);

  console.log('\n[7] 清理后重启不复活');
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e',
    "const db=require('./server/db');"
    + "console.log(JSON.stringify({s:db.prepare('SELECT COUNT(*) c FROM stats_daily').get().c}));",
  ], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH: DB_FILE, LOG_LEVEL: 'silent' },
    encoding: 'utf8',
  });
  const restarted = JSON.parse(out.trim().split('\n').pop());
  check('重启后趋势仍为空', restarted.s === 0, restarted);

  await app.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

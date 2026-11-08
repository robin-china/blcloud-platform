/* 未付款订单删除（用户端 / 后台）自测
 * 运行：node tools/test-order-delete.js
 *
 * 重点守的是「钱不能丢」：订单只是软删除，用户事后扫码付款的回调
 * 必须还能命中并自动恢复，否则等于钱收了、订单没了。
 */
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-order-delete.db');
for (const s of ['', '-wal', '-shm']) fs.rmSync(DB_FILE + s, { force: true });
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.NODE_ENV = 'test';

const { build } = require('../server');
const db = require('../server/db');
const auth = require('../server/lib/auth');
const { markPaid } = require('../server/services/pay');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 400) : '')); }
}

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function makeOrder(uid, { status = 'pending', discount = 0, payAmount = 10, createdAt = iso() } = {}) {
  const no = 'ORD' + Math.random().toString(36).slice(2, 10).toUpperCase();
  const info = db.prepare(`INSERT INTO orders
    (order_no, user_id, amount, pay_amount, discount, channel, status, items, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(no, uid, payAmount + discount, payAmount, discount, 'wxpay', status,
      JSON.stringify([{ product_id: 0, product_name: '测试商品', qty: 1, price: payAmount }]), createdAt);
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
}

(async () => {
  const app = build();
  await app.ready();
  const adminToken = (await app.inject({
    method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' },
  })).json().token;
  const H = { authorization: 'Bearer ' + adminToken };

  const u1 = db.prepare("INSERT INTO users (openid, nickname, points, created_at) VALUES ('od-u1', '订单甲', 0, ?)").run(iso()).lastInsertRowid;
  const u2 = db.prepare("INSERT INTO users (openid, nickname, points, created_at) VALUES ('od-u2', '订单乙', 0, ?)").run(iso()).lastInsertRowid;
  const U1 = { authorization: 'Bearer ' + auth.signUser({ id: u1, openid: 'od-u1' }) };
  const U2 = { authorization: 'Bearer ' + auth.signUser({ id: u2, openid: 'od-u2' }) };

  console.log('\n[1] 用户能删掉自己挂着没付的订单');
  const o1 = makeOrder(u1, { discount: 5, payAmount: 10 });
  let r = await app.inject({ method: 'DELETE', url: `/api/portal/orders/${o1.order_no}`, headers: U1 });
  const b1 = r.json();
  check('删除成功', r.statusCode === 200 && b1.ok, [r.statusCode, b1]);
  check('退回抵扣积分 500', b1.points_back === 500, b1);
  check('用户积分已到账', db.prepare('SELECT points FROM users WHERE id = ?').get(u1).points === 500,
    db.prepare('SELECT points FROM users WHERE id = ?').get(u1));
  check('留了积分流水', !!db.prepare("SELECT 1 FROM points_logs WHERE user_id = ? AND reason LIKE '%删除订单%'").get(u1));
  const after1 = db.prepare('SELECT * FROM orders WHERE id = ?').get(o1.id);
  check('记录没有被真删（软删除）', !!after1, after1);
  check('deleted_by = user', after1.deleted_by === 'user', after1.deleted_by);
  let list = (await app.inject({ method: 'GET', url: '/api/portal/orders', headers: U1 })).json().list;
  check('用户订单列表里看不到它了', !list.some((o) => o.id === o1.id), list.map((o) => o.order_no));
  r = await app.inject({ method: 'DELETE', url: `/api/portal/orders/${o1.order_no}`, headers: U1 });
  check('重复删除是幂等的（不报错）', r.statusCode === 200 && r.json().already === true, r.json());

  console.log('\n[2] 不该删的不让删');
  const paid = makeOrder(u1, { status: 'paid' });
  r = await app.inject({ method: 'DELETE', url: `/api/portal/orders/${paid.order_no}`, headers: U1 });
  check('已支付订单 → 400', r.statusCode === 400, [r.statusCode, r.json()]);
  check('提示走退款流程', /退款/.test(r.json().error || ''), r.json());
  const other = makeOrder(u2);
  r = await app.inject({ method: 'DELETE', url: `/api/portal/orders/${other.order_no}`, headers: U1 });
  check('别人的订单 → 404', r.statusCode === 404, r.statusCode);
  check('别人的订单没被删', !db.prepare('SELECT deleted_at FROM orders WHERE id = ?').get(other.id).deleted_at);

  console.log('\n[3] 后台列表：删掉的不再挂着，但查得到');
  const o3 = makeOrder(u1);
  await app.inject({ method: 'DELETE', url: `/api/portal/orders/${o3.order_no}`, headers: U1 });
  let al = (await app.inject({ method: 'GET', url: '/api/orders', headers: H })).json();
  check('默认列表不含已删除', !al.list.some((o) => o.id === o3.id), al.list.map((o) => o.order_no));
  check('默认列表仍含正常订单', al.list.some((o) => o.id === other.id), al.list.length);
  const pend = (await app.inject({ method: 'GET', url: '/api/orders?status=pending', headers: H })).json();
  check('筛「待支付」时也不含已删除', !pend.list.some((o) => o.id === o3.id), pend.list.map((o) => o.order_no));
  const del = (await app.inject({ method: 'GET', url: '/api/orders?status=deleted', headers: H })).json();
  check('筛「已删除」能查出来', del.list.some((o) => o.id === o3.id), del.list.map((o) => o.order_no));
  check('已删除的带 deleted_at', del.list.every((o) => !!o.deleted_at), del.list.map((o) => o.deleted_at));

  console.log('\n[4] 后台删除 + 审计 + 恢复');
  const o4 = makeOrder(u2, { discount: 2, payAmount: 8 });
  r = await app.inject({ method: 'DELETE', url: `/api/orders/${o4.id}`, headers: H });
  const b4 = r.json();
  check('后台删除成功', r.statusCode === 200 && b4.ok, [r.statusCode, b4]);
  check('退回了用户抵扣积分', b4.points_back === 200, b4);
  check('deleted_by = admin', db.prepare('SELECT deleted_by FROM orders WHERE id = ?').get(o4.id).deleted_by === 'admin');
  check('写了后台审计日志', !!db.prepare("SELECT 1 FROM admin_logs WHERE action = 'order.delete' AND detail LIKE ?").get(`%${o4.order_no}%`));
  r = await app.inject({ method: 'POST', url: `/api/orders/${o4.id}/restore`, headers: H });
  check('恢复成功', r.statusCode === 200 && r.json().ok, r.json());
  check('deleted_at 已清空', !db.prepare('SELECT deleted_at FROM orders WHERE id = ?').get(o4.id).deleted_at);
  const u2list = (await app.inject({ method: 'GET', url: '/api/portal/orders', headers: U2 })).json().list;
  check('恢复后用户端又能看到', u2list.some((o) => o.id === o4.id), u2list.map((o) => o.order_no));

  console.log('\n[5] 批量清理只动「N 天前」的老订单');
  const oldOne = makeOrder(u1, { createdAt: iso(-10 * 86400000) });
  const freshOne = makeOrder(u1, { createdAt: iso() });
  r = await app.inject({ method: 'POST', url: '/api/orders/purge-pending', headers: H, payload: { days: 7 } });
  const b5 = r.json();
  check('清理了 1 条', b5.count === 1, b5);
  check('老订单被清', !!db.prepare('SELECT deleted_at FROM orders WHERE id = ?').get(oldOne.id).deleted_at);
  check('新订单没被动', !db.prepare('SELECT deleted_at FROM orders WHERE id = ?').get(freshOne.id).deleted_at);
  check('写了审计日志', !!db.prepare("SELECT 1 FROM admin_logs WHERE action = 'order.purge'").get());

  console.log('\n[6] 已删除的订单收到支付回调必须复活（否则钱白收）');
  const o6 = makeOrder(u1, { payAmount: 12 });
  await app.inject({ method: 'DELETE', url: `/api/portal/orders/${o6.order_no}`, headers: U1 });
  check('删除后用户端看不到', !(await app.inject({ method: 'GET', url: '/api/portal/orders', headers: U1 })).json().list.some((o) => o.id === o6.id));
  const paidRes = markPaid(o6.order_no, 'wx-trade-001', 'wxpay', '{}', 12);
  check('markPaid 成功处理', paidRes && paidRes.status === 'paid', paidRes && paidRes.status);
  const revived = db.prepare('SELECT * FROM orders WHERE id = ?').get(o6.id);
  check('deleted_at 被清空', !revived.deleted_at, revived.deleted_at);
  check('状态变成已支付', revived.status === 'paid', revived.status);
  check('用户端重新能看到这笔已付款订单', (await app.inject({ method: 'GET', url: '/api/portal/orders', headers: U1 })).json().list.some((o) => o.id === o6.id));

  console.log('\n[7] 仪表盘「待付款」不再把删掉的算进去');
  const ov = (await app.inject({ method: 'GET', url: '/api/stats/overview', headers: H })).json();
  const dbPending = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status='pending' AND deleted_at IS NULL").get().c;
  check('待付款数与有效 pending 一致', ov.pendingOrders === dbPending, [ov.pendingOrders, dbPending]);
  const rawPending = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status='pending'").get().c;
  check('库里确实有已删除的 pending（说明在用软删除）', rawPending > dbPending, [rawPending, dbPending]);

  console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
  await app.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

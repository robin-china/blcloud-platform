/* 生成演示数据：用户、订单、授权、硬件、统计趋势
 * 用法：node tools/seed-demo.js
 * 默认写入 data/app.db；想先试运行到副本库：DB_PATH=data/demo.db node tools/seed-demo.js
 */
const db = require('../server/db');

const now = Date.now();
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString();
const rand = (n) => Math.floor(Math.random() * n);

function main() {
  const products = db.prepare('SELECT id, name, price, type FROM products').all();
  if (!products.length) {
    console.log('没有产品数据，请先启动一次服务让种子数据写入');
    return;
  }

  const tx = db.transaction(() => {
    // 1. 用户
    const nicknames = ['李雷', '韩梅梅', '张伟', '王芳', '刘强', '陈晨', '赵敏', '孙浩'];
    const userIds = [];
    for (let i = 0; i < nicknames.length; i++) {
      const openid = `demo${String(i + 1).padStart(3, '0')}`;
      const created = now - rand(30) * DAY;
      const exist = db.prepare('SELECT id FROM users WHERE openid = ?').get(openid);
      if (exist) { userIds.push(exist.id); continue; }
      const info = db.prepare(
        `INSERT INTO users (openid, nickname, avatar, phone, points, status, created_at, last_login_at, tb_username, tb_password, tb_status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        openid, nicknames[i], '', '138' + String(10000000 + rand(8999999)),
        rand(2000), 'active', iso(created), iso(now - rand(3) * DAY),
        `${openid}@tb.cn`, openid, 'active'
      );
      userIds.push(Number(info.lastInsertRowid));
    }

    // 2. 订单 + 授权 + 硬件 + 支付流水
    const channels = ['wxpay', 'alipay', 'wxpay', 'simulate'];
    let orderCount = 0, licenseCount = 0, deviceCount = 0;
    const insOrder = db.prepare(
      `INSERT INTO orders (order_no, user_id, amount, pay_amount, channel, status, items, remark, paid_at, trade_no, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    const insLicense = db.prepare(
      `INSERT INTO licenses (license_key, user_id, product_id, type, max_devices, start_at, end_at, status, order_id, remark, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    const insDevice = db.prepare(
      `INSERT INTO devices (user_id, product_id, sn, name, status, last_seen_at, bound_at) VALUES (?,?,?,?,?,?,?)`
    );
    const insPayment = db.prepare(
      `INSERT INTO payments (order_no, channel, trade_no, amount, status, created_at) VALUES (?,?,?,?,?,?)`
    );

    for (let d = 29; d >= 0; d--) {
      const t = now - d * DAY;
      const n = rand(4) + 1;
      for (let k = 0; k < n; k++) {
        const p = products[rand(products.length)];
        const uid = userIds[rand(userIds.length)];
        const qty = Math.random() > 0.8 ? 2 : 1;
        const amount = Number((Number(p.price || 0) * qty).toFixed(2));
        const channel = channels[rand(channels.length)];
        const no = 'D' + String(t).slice(-8) + String(orderCount).padStart(3, '0');
        const items = JSON.stringify([{ product_id: p.id, name: p.name, price: p.price, qty }]);

        const oi = insOrder.run(no, uid, amount, amount, channel, 'paid', items, '演示订单', iso(t), 'DEMO' + no, iso(t));
        const oid = Number(oi.lastInsertRowid);
        orderCount++;
        insPayment.run(no, channel, 'DEMO' + no, amount, 'success', iso(t));

        if (p.type === 'hardware') {
          const sn = 'SN' + String(oid).padStart(6, '0') + Math.random().toString(36).slice(2, 6).toUpperCase();
          const online = Math.random() > 0.3;
          insDevice.run(uid, p.id, sn, p.name, online ? 'online' : 'offline', online ? iso(t) : null, iso(t));
          deviceCount++;
        } else {
          for (let q = 0; q < qty; q++) {
            insLicense.run(
              'DEMO-' + Math.random().toString(36).slice(2, 10).toUpperCase(),
              uid, p.id, 'subscription', 1, iso(t), iso(t + 365 * DAY), 'active', oid, '演示授权', iso(t)
            );
            licenseCount++;
          }
        }
      }
    }

    // 3. 每日统计
    db.prepare('DELETE FROM stats_daily').run();
    const insStat = db.prepare(
      `INSERT INTO stats_daily (date, downloads, installs, active_users, new_users, revenue, api_calls)
       VALUES (?,?,?,?,?,?,?)`
    );
    for (let d = 29; d >= 0; d--) {
      insStat.run(
        iso(now - d * DAY).slice(0, 10),
        80 + rand(260), 40 + rand(150), 30 + rand(120), rand(20),
        Number((Math.random() * 2600).toFixed(2)), 400 + rand(3000)
      );
    }

    // 4. 更新产品累计值
    for (const p of products) {
      const sold = db.prepare('SELECT COUNT(*) c FROM licenses WHERE product_id = ?').get(p.id).c;
      db.prepare('UPDATE products SET total_sales = ?, total_downloads = ?, total_installs = ?, active_users = ? WHERE id = ?')
        .run(sold, sold * 8 + rand(300), sold * 5 + rand(200), Math.floor(sold * 1.4) + rand(60), p.id);
    }

    return { orderCount, licenseCount, deviceCount, userCount: userIds.length };
  });

  const r = tx();
  console.log(
    `演示数据生成完成：订单 ${r.orderCount}、授权 ${r.licenseCount}、硬件 ${r.deviceCount}、用户 ${r.userCount}、统计 30 天`
  );
}

if (require.main === module) main();

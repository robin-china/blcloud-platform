const db = require('../db');
const { now, today } = require('./util');

/**
 * 结算/清理「演示统计」。
 *
 * 背景：早期为了让仪表盘不空着，种子数据里塞了一批假的下载/安装/活跃数字，
 * 还编了 14 天趋势曲线。上线见客户时这些数字必须消失——它们既不是真实数据，
 * 也没法解释来源。这个模块提供一次性清零 + 之后按真实事件累积的能力。
 *
 * 清零原则：
 *  - 下载 / 安装 / 活跃：没有任何真实事件表可以回算，直接归 0，之后靠
 *    portal 下载、客户端上报、stats/track 逐步累积；
 *  - 销量：真实订单里能算出来，默认按已支付订单重算（不会把真卖出去的抹掉）；
 *  - trends（stats_daily）：整表清空，趋势图从今天起是真实曲线。
 */
function salesFromOrders() {
  const map = new Map();
  const rows = db.prepare("SELECT items FROM orders WHERE status = 'paid'").all();
  for (const r of rows) {
    let items = [];
    try { items = JSON.parse(r.items || '[]'); } catch { continue; }
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const id = Number(it && (it.product_id || it.id));
      if (!id) continue; // 套餐订单 product_id=0，不计入商品销量
      map.set(id, (map.get(id) || 0) + (Number(it.qty) || 1));
    }
  }
  return map;
}

/**
 * @param {object} opts
 * @param {boolean} opts.realSales  true=销量按已支付订单重算（默认）；false=销量也归零
 * @param {boolean} opts.dropTrend  true=清空 stats_daily（默认）
 */
function reset(opts = {}) {
  const realSales = opts.realSales !== false;
  const dropTrend = opts.dropTrend !== false;
  const sales = realSales ? salesFromOrders() : new Map();
  const t = now();

  const run = db.transaction(() => {
    const before = db.prepare(`SELECT
      IFNULL(SUM(total_downloads),0) d, IFNULL(SUM(total_installs),0) i,
      IFNULL(SUM(active_users),0) a, IFNULL(SUM(total_sales),0) s
      FROM products`).get();

    // 先全部归零，再把真实销量写回：避免「表里没有的商品」残留旧假数
    db.prepare('UPDATE products SET total_downloads = 0, total_installs = 0, active_users = 0, total_sales = 0, updated_at = ?').run(t);
    const upd = db.prepare('UPDATE products SET total_sales = ? WHERE id = ?');
    for (const [id, qty] of sales) upd.run(qty, id);

    // 版本级下载计数同样是历史演示值
    try { db.prepare('UPDATE product_versions SET downloads = 0').run(); } catch { /* 老库无此列时忽略 */ }

    let trend = 0;
    if (dropTrend) trend = db.prepare('DELETE FROM stats_daily').run().changes;

    // 清理标记：以后重启不会再种一次假数据（新库也不会）
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)').run('seed_stats_done', '1', t);
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)').run('fake_stats_cleared_at', t, t);

    return {
      before,
      after: db.prepare(`SELECT
        IFNULL(SUM(total_downloads),0) d, IFNULL(SUM(total_installs),0) i,
        IFNULL(SUM(active_users),0) a, IFNULL(SUM(total_sales),0) s
        FROM products`).get(),
      sales_rebuilt: realSales ? sales.size : 0,
      trend_rows_removed: trend,
      today: today(),
    };
  });

  return run();
}

module.exports = { reset, salesFromOrders };

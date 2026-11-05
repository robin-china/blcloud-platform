#!/usr/bin/env node
/* 命令行清零「演示统计」数字（后台首页「清零演示统计」的等价入口）
 *
 * 清什么：
 *   products.total_downloads / total_installs / active_users  → 0
 *   product_versions.downloads                                → 0
 *   stats_daily（仪表盘趋势曲线）                              → 全部删除，从今天起只记真实事件
 *   销量 total_sales                                          → 默认按已支付订单重算（--zero-sales 则也归零）
 *
 * 不做：不动用户、订单、授权、商品本身，所以可以放心在生产跑。
 *
 * 用法：
 *   node tools/clear-stats.js                 # 预览，不写库
 *   node tools/clear-stats.js --yes           # 执行（销量按真实订单重算）
 *   node tools/clear-stats.js --yes --zero-sales   # 销量也归零
 *   node tools/clear-stats.js --db=/opt/blcloud/data/app.db --yes
 */
const path = require('path');

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const getArg = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};

if (getArg('db')) process.env.DB_PATH = path.resolve(getArg('db'));

const db = require('../server/db');
const statsreset = require('../server/lib/statsreset');

const realSales = !has('zero-sales');
const before = db.prepare(`SELECT
  IFNULL(SUM(total_downloads),0) d, IFNULL(SUM(total_installs),0) i,
  IFNULL(SUM(active_users),0) a, IFNULL(SUM(total_sales),0) s FROM products`).get();
const trend = db.prepare('SELECT COUNT(*) c FROM stats_daily').get().c;
const sales = realSales ? statsreset.salesFromOrders() : new Map();

console.log(`\n  数据库: ${process.env.DB_PATH || 'data/app.db'}`);
console.log(`  商品累计: 下载 ${before.d} / 安装 ${before.i} / 活跃 ${before.a} / 销量 ${before.s}`);
console.log(`  趋势行数: ${trend}`);
console.log(`  销量处理: ${realSales ? `按已支付订单重算（${sales.size} 个商品有真实销量）` : '一并归零'}`);

if (!has('yes')) {
  console.log('\n  这是预览，未写库。确认无误后加 --yes 执行。\n');
  process.exit(0);
}

const r = statsreset.reset({ realSales, dropTrend: true });
console.log(`\n  已清零：下载 ${r.before.d} → ${r.after.d}，安装 ${r.before.i} → ${r.after.i}，`
  + `活跃 ${r.before.a} → ${r.after.a}，销量 ${r.before.s} → ${r.after.s}`);
console.log(`  清空趋势 ${r.trend_rows_removed} 行；重启不会再种演示数字。\n`);

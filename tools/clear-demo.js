#!/usr/bin/env node
/* 命令行清理演示数据（后台「系统维护 → 数据清理」的等价入口）
 *
 * 服务器上不方便开浏览器、或要在部署前清空测试数据时用。
 * 执行前会自动生成一份 pre-purge 备份，删错了能退回。
 *
 * 用法：
 *   node tools/clear-demo.js                      # 只预览，不删
 *   node tools/clear-demo.js --yes                # 清理默认分组（全部业务数据，保留管理员/配置/商品）
 *   node tools/clear-demo.js --groups=transactions,licenses --yes
 *   node tools/clear-demo.js --db=data/app.db --yes
 */
const path = require('path');

const args = process.argv.slice(2);
const getArg = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
};

if (getArg('db')) process.env.DB_PATH = path.resolve(getArg('db'));

// 默认：清交易、授权、佣金、设备、用户、日志、统计；保留管理员、站点/接入配置、商品与套餐
const DEFAULT_GROUPS = ['transactions', 'licenses', 'agents', 'devices', 'users', 'logs', 'stats'];
const groups = (getArg('groups') || DEFAULT_GROUPS.join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);

const purge = require('../server/lib/purge');

const preview = purge.preview();
console.log(`\n  数据库: ${process.env.DB_PATH || 'data/app.db'}`);
console.log('  清理范围:');
let chosenRows = 0;
for (const g of preview.groups) {
  const on = groups.includes(g.key);
  if (on) chosenRows += g.rows;
  console.log(`    ${on ? '\u2713' : ' '} ${g.name.padEnd(14, ' ')} ${String(g.rows).padStart(6)} 行   ${g.desc}`);
}
console.log(`\n  将删除 ${chosenRows} 行；管理员、站点与接入配置、套餐档位、商品目录不受影响（除非显式勾选 catalog）。`);

if (!args.includes('--yes')) {
  console.log('\n  这是预演。确认执行请加 --yes。\n');
  process.exit(0);
}

try {
  const res = purge.purge(groups, { backup: true });
  console.log(`\n  ✓ 已删除 ${res.total} 行`);
  for (const [t, n] of Object.entries(res.deleted)) {
    if (n) console.log(`      ${t.padEnd(20, ' ')} ${n}`);
  }
  console.log(`\n  清理前备份: ${res.backup || '（未备份）'}`);
  console.log(`  VACUUM: ${res.vacuumed ? '已完成，磁盘已回收' : '跳过'}\n`);
} catch (e) {
  console.error(`\n  ✗ 清理失败（已回滚）: ${e.message}\n`);
  process.exit(1);
}

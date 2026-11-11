/* 演示数据 / 业务数据清理
 *
 * 只做「删行」，永远不删表、不删管理员、不删站点配置 —— 清理完系统必须还能登录、还能用。
 * 分组是给后台勾选用的；选择「用户账号」会自动连带清空它衍生的订单、授权、佣金、设备，
 * 否则会留下一堆指向不存在用户的孤儿数据。
 *
 * 调用方（路由 / 命令行）负责二次确认与自动备份；本模块只保证：
 *  - 单事务执行，失败整体回滚
 *  - 只删除显式勾选的表
 *  - 删完重置自增序列并 VACUUM，把磁盘空间真正收回来
 */
const { now } = require('./util');

const GROUPS = [
  {
    key: 'transactions', name: '订单与支付',
    desc: '订单、支付流水、积分变动',
    tables: ['payments', 'orders', 'points_logs'],
  },
  {
    key: 'licenses', name: '授权与设备绑定',
    desc: '授权码、绑定机器、软件端会话、到期提醒',
    tables: ['license_reminders', 'license_devices', 'client_sessions', 'licenses'],
  },
  {
    key: 'agents', name: '代理商佣金与提现',
    desc: '佣金账本、提现单（不改变用户的代理商身份）',
    tables: ['agent_commissions', 'withdrawals'],
  },
  {
    key: 'devices', name: '硬件台账与 API 密钥',
    desc: '设备台账、API 密钥、调用记录',
    tables: ['devices', 'api_keys', 'api_usage', 'blcloud_keys', 'blcloud_usage'],
  },
  {
    key: 'users', name: '用户账号',
    desc: 'C 端用户（自动连带清空其订单、授权、佣金、设备）',
    tables: ['users'],
    implies: ['transactions', 'licenses', 'agents', 'devices'],
  },
  {
    key: 'flows', name: '升级与鉴权流水',
    desc: '客户端升级记录、开放接口鉴权流水（纯流水，不影响任何业务状态）',
    tables: ['app_update_log', 'open_auth_log'],
  },
  {
    key: 'logs', name: '日志与会话',
    desc: '后台操作日志、登录尝试、扫码会话、短信码、一次性票据',
    tables: ['admin_logs', 'login_attempts', 'api_nonces', 'wechat_sessions', 'sms_codes', 'handoff_tickets'],
  },
  {
    key: 'stats', name: '统计数据',
    desc: '日统计（演示曲线的来源）',
    tables: ['stats_daily'],
  },
  {
    key: 'catalog', name: '商品目录',
    desc: '上架商品与版本记录；已售授权保留，但订单里的商品详情会失去对应商品',
    tables: ['product_versions', 'products'],
  },
  {
    key: 'apps', name: '软件端接入应用',
    desc: '开放接入应用的 AppKey/AppSecret 与该应用专属套餐档位（删除后旧客户端立刻无法登录，通用模板档位保留）',
    tables: ['open_apps'],
    alsoPlans: true,
  },
];

// 删除顺序：先子后父，纯粹为了日志可读与潜在外键，SQLite 这里没有声明外键
const ORDER = [
  'license_reminders', 'license_devices', 'client_sessions', 'licenses',
  'agent_commissions', 'withdrawals', 'points_logs', 'payments', 'orders',
  'devices', 'api_usage', 'api_keys', 'blcloud_usage', 'blcloud_keys', 'users',
  'wechat_sessions', 'sms_codes', 'handoff_tickets', 'api_nonces', 'login_attempts',
  'admin_logs', 'app_update_log', 'open_auth_log', 'stats_daily', 'product_versions', 'products', 'open_apps',
];

function conn() {
  return require('../db');
}

function byKey(key) {
  return GROUPS.find((g) => g.key === key) || null;
}

/** 勾选的组 → 展开 implies 后的组列表 */
function expand(keys) {
  const set = new Set();
  for (const k of keys || []) {
    const g = byKey(k);
    if (!g) continue;
    set.add(g.key);
    for (const dep of g.implies || []) set.add(dep);
  }
  return GROUPS.filter((g) => set.has(g.key));
}

function tablesOf(groups) {
  const set = new Set();
  for (const g of groups) for (const t of g.tables) set.add(t);
  return ORDER.filter((t) => set.has(t));
}

function countsOf(d, tables) {
  const out = {};
  for (const t of tables) {
    try { out[t] = d.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c; } catch { out[t] = 0; }
  }
  return out;
}

/** 预览：每组的表与行数，供后台确认页展示 */
function preview() {
  const d = conn();
  const all = tablesOf(GROUPS);
  const counts = countsOf(d, all);
  const groups = GROUPS.map((g) => {
    let rows = g.tables.reduce((s, t) => s + (counts[t] || 0), 0);
    let appPlans = 0;
    if (g.alsoPlans) {
      try { appPlans = d.prepare('SELECT COUNT(*) AS c FROM plans WHERE app_id IS NOT NULL').get().c; } catch { appPlans = 0; }
      rows += appPlans;
    }
    return {
      key: g.key, name: g.name, desc: g.desc,
      implies: g.implies || [],
      rows,
      tables: g.tables.map((t) => ({ table: t, rows: counts[t] || 0 }))
        .concat(appPlans ? [{ table: 'plans(应用专属档位)', rows: appPlans }] : []),
    };
  });
  return {
    groups,
    totals: { rows: Object.values(counts).reduce((s, c) => s + c, 0), tables: all.length },
  };
}

/**
 * 执行清理
 * @param {string[]} keys 组 key
 * @param {{ backup?: boolean, vacuum?: boolean }} opts
 */
function purge(keys, opts = {}) {
  const backup = require('./backup');
  const d = conn();
  const groups = expand(keys);
  if (!groups.length) throw new Error('请至少选择一项要清理的数据');
  const tables = tablesOf(groups);
  if (!tables.length) throw new Error('没有可清理的表');

  const before = countsOf(d, tables);
  // 先备份再删：这是「清空了才发现删错」的唯一退路
  const pkg = opts.backup === false ? null : backup.createPackage({
    note: `清理前自动备份（${groups.map((g) => g.name).join('、')}）`,
    prefix: 'pre-purge',
  });

  const deleted = {};
  let appPlans = 0;
  const dropAppPlans = groups.some((g) => g.alsoPlans);
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const t of tables) {
      const info = d.prepare(`DELETE FROM "${t}"`).run();
      deleted[t] = info.changes;
      try { d.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(t); } catch { /* 无自增序列的表 */ }
    }
    // 删掉软件应用后，它专属的套餐档位不能再留着当孤儿（通用模板 app_id IS NULL 必须保留）
    if (dropAppPlans) {
      appPlans = d.prepare('DELETE FROM plans WHERE app_id IS NOT NULL').run().changes;
      if (appPlans) deleted.plans_app_scope = appPlans;
    }
    // 打了「演示数据只种一次」的标记：否则下次启动 seed() 发现商品/统计为空，
    // 会把这批演示数据原样塞回来 —— 用户会认为「根本没删掉」。
    const mark = d.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)');
    if (tables.includes('products')) mark.run('seed_products_done', '1', now());
    if (tables.includes('stats_daily')) mark.run('seed_stats_done', '1', now());
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    throw e;
  }

  let vacuumed = false;
  if (opts.vacuum !== false) {
    try { d.exec('VACUUM'); vacuumed = true; } catch { /* 磁盘紧张时可能失败，不影响数据 */ }
  }

  return {
    at: now(),
    groups: groups.map((g) => ({ key: g.key, name: g.name })),
    deleted,
    total: Object.values(deleted).reduce((s, c) => s + c, 0),
    before,
    backup: pkg ? pkg.name : '',
    vacuumed,
  };
}

module.exports = { GROUPS, ORDER, expand, tablesOf, preview, purge };

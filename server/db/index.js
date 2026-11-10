const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { now, hashPassword, verifyPassword, randomPassword } = require('../lib/util');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(process.env.DB_PATH || path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * schema.sql 里同时含 CREATE TABLE 与 CREATE INDEX。
 * 旧库升级时，新增列（如 licenses.app_id）是由下面的 ensureColumn() 补的；
 * 若在「建表阶段」就执行 `CREATE INDEX ... ON licenses(app_id)`，SQLite 会抛
 * "no such column: app_id"，require('../db') 直接失败 → 进程起不来 → Nginx 502。
 * 所以先把索引语句挑出来，等所有列补齐后再统一执行。
 * （schema.sql 的索引均为单行语句，按行过滤即可。）
 */
const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const indexLines = [];
const ddlLines = [];
for (const line of schemaText.split('\n')) {
  if (/^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(line)) indexLines.push(line);
  else ddlLines.push(line);
}
/**
 * 是不是「全新数据库」——在建表之前判断，之后 products 表一定存在。
 * 演示商品 / 演示统计这类种子数据只在全新库种一次：
 * 之前用「表为空」判断，导致用户删光商品后一重启又全回来（以为是删不掉）。
 * 现在再加一道「必须是从未建过表的新文件」，双保险。
 */
const isFreshDb = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'products'").get();
db.exec(ddlLines.join('\n'));

/**
 * 旧库 plans 表的 code 是列级 UNIQUE，全站只能存在一套档位。
 * 多软件产品上架后，每个产品都要有自己的 free / member，必须改成 (app_id, code) 唯一。
 * SQLite 删不掉列级 UNIQUE 自动索引，只能重建表；plans 表数据量极小、无外键引用，
 * 用事务一次性完成。以表结构判定是否已迁移，重复启动幂等。
 */
function migratePlansScope() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'plans'").get();
  if (!row || !/code\s+TEXT\s+UNIQUE/i.test(row.sql || '')) return; // 新库或已迁移
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    // schema.sql 可能已在旧表上建了同名表达式索引；先摘掉，否则 RENAME 后它仍挂在
    // plans_legacy 上，后面的 CREATE INDEX IF NOT EXISTS 会被跳过，新表反而没有唯一约束。
    db.exec('DROP INDEX IF EXISTS idx_plans_app_code');
    db.exec('ALTER TABLE plans RENAME TO plans_legacy');
    db.exec(`CREATE TABLE plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id INTEGER,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      tier INTEGER DEFAULT 0,
      billing TEXT DEFAULT 'period',
      price REAL DEFAULT 0,
      original_price REAL DEFAULT 0,
      period_days INTEGER DEFAULT 365,
      online_required INTEGER DEFAULT 1,
      offline_days INTEGER DEFAULT 0,
      max_devices INTEGER DEFAULT 1,
      seats INTEGER DEFAULT 1,
      features TEXT DEFAULT '[]',
      status TEXT DEFAULT 'on',
      sort INTEGER DEFAULT 0,
      remark TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.exec(`INSERT INTO plans (id,app_id,code,name,tier,billing,price,original_price,period_days,
      online_required,offline_days,max_devices,seats,features,status,sort,remark,created_at,updated_at)
      SELECT id,app_id,code,name,tier,billing,price,original_price,period_days,
      online_required,offline_days,max_devices,seats,features,status,sort,remark,created_at,updated_at
      FROM plans_legacy`);
    db.exec('DROP TABLE plans_legacy');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_app_code ON plans(IFNULL(app_id, 0), code)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_plans_tier ON plans(tier)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_plans_app ON plans(app_id)');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
migratePlansScope();

// 轻量迁移：为已存在的旧库补充新增列
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}
ensureColumn('license_devices', 'machine_id', 'machine_id TEXT DEFAULT \'\'');
ensureColumn('license_devices', 'app_id', 'app_id INTEGER');
ensureColumn('license_devices', 'last_ip', 'last_ip TEXT DEFAULT \'\'');
ensureColumn('license_devices', 'last_version', 'last_version TEXT DEFAULT \'\'');
ensureColumn('license_devices', 'last_seen_at', 'last_seen_at TEXT');
ensureColumn('open_apps', 'version', 'version TEXT DEFAULT \'\'');
ensureColumn('open_apps', 'download_url', 'download_url TEXT DEFAULT \'\'');
ensureColumn('open_apps', 'release_note', 'release_note TEXT DEFAULT \'\'');
ensureColumn('users', 'blcloud_quota', 'blcloud_quota INTEGER DEFAULT 0');
ensureColumn('users', 'blcloud_used', 'blcloud_used INTEGER DEFAULT 0');
ensureColumn('admins', 'must_change_password', 'must_change_password INTEGER DEFAULT 0');
// 额度包商品发放多少「次」必须能显式配置：早先是从商品描述里正则猜「N 万次」，
// 描述写不出这个数字时就会按默认值发，配错了用户买到的额度与页面标称不符
ensureColumn('products', 'quota', 'quota INTEGER DEFAULT 0');
// 版本差异内容地址：产品详情内嵌与「我的空间」卡片按钮共用同一份 HTML（缺省
// /assets/compare/default.html）。空值 = 用默认页；支持站内相对路径或 https 外链
ensureColumn('products', 'compare_url', "compare_url TEXT DEFAULT ''");
// 发货结果落到订单上：付了钱到底发了什么（授权码 / 额度），必须用户和管理员都看得到
ensureColumn('orders', 'deliver_result', 'deliver_result TEXT DEFAULT \'\'');
// 物联账户开通失败的原因存下来：否则管理员只能看到一个「待激活」，不知道卡在哪一步
ensureColumn('users', 'tb_message', 'tb_message TEXT DEFAULT \'\'');
// 卡密池：渠道要先印卡、客户后注册，码必须能「先发出去、后绑定账号」。
// user_id 保持 NOT NULL（SQLite 改列要重建表，风险大），用 0 表示未分配；
// status = 'unassigned' 的码在绑定前不允许激活。
ensureColumn('licenses', 'batch_no', 'batch_no TEXT DEFAULT \'\'');
ensureColumn('licenses', 'channel', 'channel TEXT DEFAULT \'\'');
ensureColumn('licenses', 'bound_at', 'bound_at TEXT DEFAULT \'\'');
ensureColumn('licenses', 'bound_by', 'bound_by TEXT DEFAULT \'\'');
// 卡密池有效期从「绑定/首次激活」起算，而不是印卡那天；
// 所以要单独记住这张码的时长，否则三个月前印的卡白丢三个月。
ensureColumn('licenses', 'duration_days', 'duration_days INTEGER DEFAULT 0');
// 套餐档位：plan_id 供后台查配置，plan_code 是快照（后台改套餐名/改价不能改写已售授权）。
// 离线票据里带的就是 plan_code + features，客户端不依赖服务端自增 ID。
ensureColumn('licenses', 'plan_id', 'plan_id INTEGER');
ensureColumn('wechat_sessions', 'agent_id', 'agent_id INTEGER DEFAULT 0');
ensureColumn('licenses', 'plan_code', "plan_code TEXT DEFAULT ''");
// 订单区分「新购 / 升级 / 续费」：升级与续费都不发新码，只改原授权。
ensureColumn('orders', 'kind', "kind TEXT DEFAULT 'purchase'");
ensureColumn('orders', 'ref_license_id', 'ref_license_id INTEGER');
ensureColumn('orders', 'plan_id', 'plan_id INTEGER');
// 未付款订单允许用户/管理员清掉，但只做软删除：二维码可能已经发出去了，
// 用户事后扫码付钱时回调必须还能找到这笔订单（markPaid 会顺手复活它）。
ensureColumn('orders', 'deleted_at', 'deleted_at TEXT');
ensureColumn('orders', 'deleted_by', "deleted_by TEXT DEFAULT ''");
// 代理商：手动授权身份 + 名下用户归属。agent_code 是邀请码，注册/自助绑定时用。
ensureColumn('users', 'agent_id', 'agent_id INTEGER DEFAULT 0');
ensureColumn('users', 'agent_rate', 'agent_rate REAL');
ensureColumn('users', 'agent_status', "agent_status TEXT DEFAULT 'none'");
ensureColumn('users', 'agent_code', "agent_code TEXT DEFAULT ''");
// 套餐授权归属应用（跨产品不可通用）；用户手动改过资料后不再被微信资料覆盖
ensureColumn('licenses', 'app_id', 'app_id INTEGER');
ensureColumn('orders', 'app_id', 'app_id INTEGER');
ensureColumn('users', 'profile_custom', 'profile_custom INTEGER DEFAULT 0');
// 数量配额（标签库 30 / Excel 100 行这类量化权益，随票据签名下发）
ensureColumn('plans', 'limits', "limits TEXT DEFAULT '{}'");
// 应用的功能码白名单：登记后套餐表单变勾选、未知 token 保存直接报错
ensureColumn('open_apps', 'feature_schema', "feature_schema TEXT DEFAULT '[]'");
// 订阅到期降级痕迹：降级到 free 档的时刻 + 原档位 code
ensureColumn('licenses', 'downgraded_from', "downgraded_from TEXT DEFAULT ''");
ensureColumn('licenses', 'downgraded_at', "downgraded_at TEXT DEFAULT ''");
db.exec('CREATE INDEX IF NOT EXISTS idx_licenses_app ON licenses(app_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_plans_app ON plans(app_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_license_devices_machine ON license_devices(machine_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_licenses_batch ON licenses(batch_no)');
db.exec('CREATE INDEX IF NOT EXISTS idx_users_agent ON users(agent_id)');
ensureColumn('agent_commissions', 'kind', "kind TEXT DEFAULT 'commission'");
// 所有列补齐后才执行 schema.sql 的索引（见文件顶部说明）。
// 旧库升级时这一步必须晚于 ensureColumn，否则会因引用尚不存在的列而中断启动。
db.exec(indexLines.join('\n'));

// 常见弱口令：命中即强制登录后修改密码
const WEAK_PASSWORDS = ['admin123', 'admin', '123456', '12345678', 'admin888', 'password', 'root', 'test123'];

const DEFAULT_SETTINGS = {
  site_name: '智联物联管理平台',
  site_short_name: '智联物联',
  site_logo: '',
  site_favicon: '',
  site_icp: '',
  site_copyright: '© 2026 智联物联 · 保留所有权利',
  site_contact: '',
  site_description: '软硬件一体化管理与授权分发平台',
  theme_color: '#2563eb',
  theme_mode: 'light',
  user_points_signin: '10',
  pay_simulate: '0',
  blcloud_enabled: '1',
  blcloud_free_quota: '10000',
  blcloud_credits_per_point: '100',
  blcloud_daily_limit: '0',
  // 到期前第几天提醒（逗号分隔）；佣金账期天数；最低提现金额；升级是否按剩余天数折算差价
  renew_remind_days: '7,3,1',
  agent_settle_days: '7',
  agent_withdraw_min: '10',
  upgrade_proration: '1',
};

function seed() {
  const adminCount = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
  if (adminCount === 0) {
    const initPwd = process.env.ADMIN_INIT_PASSWORD || randomPassword(14);
    db.prepare(
      'INSERT INTO admins (username, password_hash, name, role, status, must_change_password, created_at) VALUES (?,?,?,?,?,1,?)'
    ).run('admin', hashPassword(initPwd), '超级管理员', 'super', 'active', now());
    try {
      fs.writeFileSync(
        path.join(DATA_DIR, 'admin-init-password.txt'),
        `初始管理员账号: admin\n初始密码: ${initPwd}\n请登录后立即修改密码，并删除本文件。\n`,
        { mode: 0o600 }
      );
    } catch { /* 忽略写入失败 */ }
    console.log(`\n  [首次初始化] 管理员账号: admin`);
    console.log(`  [首次初始化] 初始密码: ${initPwd}`);
    console.log(`  [首次初始化] 已写入 data/admin-init-password.txt，登录后请立即修改\n`);
  }
  const setStmt = db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?,?,?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setStmt.run(k, v, now());

  // 存量弱口令账号：强制下次登录修改密码（仅检查尚未标记的，避免每次启动重复计算）
  for (const a of db.prepare('SELECT id, password_hash FROM admins WHERE IFNULL(must_change_password, 0) = 0').all()) {
    if (WEAK_PASSWORDS.some((p) => verifyPassword(p, a.password_hash))) {
      db.prepare('UPDATE admins SET must_change_password = 1 WHERE id = ?').run(a.id);
    }
  }

  // 演示数据只种一次：清空商品或统计后重启，不能又被 seed() 悄悄塞回来。
  // 用 settings 里的标记（清理不会删 settings）而不是「表为空」来判断。
  const seeded = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  const markSeeded = (k) => db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)').run(k, '1', now());

  const productCount = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  if (isFreshDb && productCount === 0 && !seeded('seed_products_done')) {
    const samples = [
      {
        type: 'software', name: '智联桌面客户端', subtitle: '跨平台设备管理中台',
        description: '面向 Windows / macOS 的统一设备接入与数据采集客户端，支持离线缓存与自动升级。',
        price: 199, original_price: 299, category: '软件', version: '2.4.1',
        // 统计数字一律从 0 开始：演示样本只保留商品信息，
        // 下载/安装/活跃/销量都由真实事件累积（假数字上线一见客户就露馅）
        total_downloads: 0, total_installs: 0, active_users: 0, total_sales: 0,
      },
      {
        type: 'hardware', name: '花盆卫士 Pro', subtitle: '土壤与环境的智能监测终端',
        description: '内置温湿度、光照与土壤湿度传感器，Wi-Fi 直连 ThingsBoard，支持自动灌溉联动。',
        price: 399, original_price: 499, category: '硬件', version: 'HW-2.0',
        total_downloads: 0, total_installs: 0, active_users: 0, total_sales: 0, stock: 860,
      },
      {
        type: 'hardware', name: '智能水泵控制器', subtitle: '远程灌溉与定时策略执行器',
        description: '支持云端策略下发、流量统计与干烧保护，配合花盆卫士实现全自动灌溉。',
        price: 459, original_price: 559, category: '硬件', version: 'HW-1.5',
        total_downloads: 0, total_installs: 0, active_users: 0, total_sales: 0, stock: 420,
      },
      {
        type: 'service', name: 'API 调用额度包', subtitle: '10 万次设备数据接口',
        description: '适用于自有系统集成，按调用次数扣减，有效期 12 个月。',
        price: 99, original_price: 129, category: '服务', version: 'API-100K',
        total_downloads: 0, total_installs: 0, active_users: 0, total_sales: 0,
      },
    ];
    const stmt = db.prepare(`INSERT INTO products
      (type, name, subtitle, description, category, price, original_price, version,
       total_downloads, total_installs, active_users, total_sales, stock, status, sort, created_at, updated_at)
      VALUES (@type,@name,@subtitle,@description,@category,@price,@original_price,@version,
       @total_downloads,@total_installs,@active_users,@total_sales,@stock,'on',0,@t,@t)`);
    for (const p of samples) stmt.run({ stock: 0, ...p, t: now() });
  }
  markSeeded('seed_products_done');

  // 五档「通用模板」套餐：app_id = NULL，只作为复制到具体软件产品的底稿，不直接售卖。
  // 多产品上架后在「产品运营 → 套餐档位」选中产品、点「从模板复制」生成该产品专属档位；
  // 运行时下单/激活只认带 app_id 的档位。价格/周期/权益都是占位值，上线前按实际改。
  const planCount = db.prepare('SELECT COUNT(*) AS c FROM plans').get().c;
  if (planCount === 0) {
    const defaults = [
      { code: 'free', name: '在线免费版', tier: 0, billing: 'free', price: 0, period_days: 0,
        online_required: 1, offline_days: 0, max_devices: 1, seats: 1,
        features: ['basic.view', 'device.read'] },
      { code: 'member', name: '在线会员版', tier: 10, billing: 'period', price: 99, original_price: 129,
        period_days: 365, online_required: 1, offline_days: 3, max_devices: 2, seats: 1,
        features: ['basic.view', 'device.read', 'data.export', 'sync.cloud'] },
      { code: 'pro', name: '在线高级会员版', tier: 20, billing: 'period', price: 299, original_price: 399,
        period_days: 365, online_required: 1, offline_days: 7, max_devices: 5, seats: 1,
        features: ['basic.view', 'device.read', 'data.export', 'sync.cloud', 'advanced.report', 'api.access'] },
      { code: 'enterprise', name: '离线企业版', tier: 30, billing: 'period', price: 1999,
        period_days: 365, online_required: 0, offline_days: 90, max_devices: 10, seats: 10,
        features: ['basic.view', 'device.read', 'data.export', 'sync.cloud', 'advanced.report',
          'api.access', 'offline.mode', 'device.write'] },
      { code: 'enterprise_dist', name: '离线企业分布式版', tier: 40, billing: 'period', price: 6999,
        period_days: 365, online_required: 0, offline_days: 365, max_devices: 50, seats: 100,
        features: ['basic.view', 'device.read', 'data.export', 'sync.cloud', 'advanced.report',
          'api.access', 'offline.mode', 'device.write', 'distributed.seats'] },
    ];
    const stmt = db.prepare(`INSERT INTO plans
      (app_id, code, name, tier, billing, price, original_price, period_days, online_required,
       offline_days, max_devices, seats, features, status, sort, remark, created_at, updated_at)
      VALUES (NULL, @code, @name, @tier, @billing, @price, @original_price, @period_days,
        @online_required, @offline_days, @max_devices, @seats, @features, 'on', @sort, '', @t, @t)`);
    defaults.forEach((p, i) => stmt.run({
      ...p, sort: 100 - i * 10, features: JSON.stringify(p.features),
      original_price: p.original_price || 0, t: now(),
    }));
  }

  // 仪表盘趋势不再造假：早期版本会种一条 14 天的演示曲线，导致客户看到
  // 与真实业务无关的下载/收入数字。现在 stats_daily 只由真实事件写入；
  // 需要清掉历史假数据用后台「清零演示统计」或 tools/clear-stats.js。
  markSeeded('seed_stats_done');
}

seed();

module.exports = db;

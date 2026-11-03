const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { now, hashPassword, verifyPassword, randomPassword } = require('../lib/util');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(process.env.DB_PATH || path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

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
ensureColumn('licenses', 'plan_code', "plan_code TEXT DEFAULT ''");
// 订单区分「新购 / 升级 / 续费」：升级与续费都不发新码，只改原授权。
ensureColumn('orders', 'kind', "kind TEXT DEFAULT 'purchase'");
ensureColumn('orders', 'ref_license_id', 'ref_license_id INTEGER');
ensureColumn('orders', 'plan_id', 'plan_id INTEGER');
// 代理商：手动授权身份 + 名下用户归属。agent_code 是邀请码，注册/自助绑定时用。
ensureColumn('users', 'agent_id', 'agent_id INTEGER DEFAULT 0');
ensureColumn('users', 'agent_rate', 'agent_rate REAL');
ensureColumn('users', 'agent_status', "agent_status TEXT DEFAULT 'none'");
ensureColumn('users', 'agent_code', "agent_code TEXT DEFAULT ''");
db.exec('CREATE INDEX IF NOT EXISTS idx_license_devices_machine ON license_devices(machine_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_licenses_batch ON licenses(batch_no)');
db.exec('CREATE INDEX IF NOT EXISTS idx_users_agent ON users(agent_id)');
ensureColumn('agent_commissions', 'kind', "kind TEXT DEFAULT 'commission'");

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

  const productCount = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  if (productCount === 0) {
    const samples = [
      {
        type: 'software', name: '智联桌面客户端', subtitle: '跨平台设备管理中台',
        description: '面向 Windows / macOS 的统一设备接入与数据采集客户端，支持离线缓存与自动升级。',
        price: 199, original_price: 299, category: '软件', version: '2.4.1',
        total_downloads: 12840, total_installs: 8932, active_users: 5210, total_sales: 2130,
      },
      {
        type: 'hardware', name: '花盆卫士 Pro', subtitle: '土壤与环境的智能监测终端',
        description: '内置温湿度、光照与土壤湿度传感器，Wi-Fi 直连 ThingsBoard，支持自动灌溉联动。',
        price: 399, original_price: 499, category: '硬件', version: 'HW-2.0',
        total_downloads: 0, total_installs: 3120, active_users: 2870, total_sales: 3120, stock: 860,
      },
      {
        type: 'hardware', name: '智能水泵控制器', subtitle: '远程灌溉与定时策略执行器',
        description: '支持云端策略下发、流量统计与干烧保护，配合花盆卫士实现全自动灌溉。',
        price: 459, original_price: 559, category: '硬件', version: 'HW-1.5',
        total_downloads: 0, total_installs: 1450, active_users: 1230, total_sales: 1450, stock: 420,
      },
      {
        type: 'service', name: 'API 调用额度包', subtitle: '10 万次设备数据接口',
        description: '适用于自有系统集成，按调用次数扣减，有效期 12 个月。',
        price: 99, original_price: 129, category: '服务', version: 'API-100K',
        total_downloads: 0, total_installs: 0, active_users: 320, total_sales: 640,
      },
    ];
    const stmt = db.prepare(`INSERT INTO products
      (type, name, subtitle, description, category, price, original_price, version,
       total_downloads, total_installs, active_users, total_sales, stock, status, sort, created_at, updated_at)
      VALUES (@type,@name,@subtitle,@description,@category,@price,@original_price,@version,
       @total_downloads,@total_installs,@active_users,@total_sales,@stock,'on',0,@t,@t)`);
    for (const p of samples) stmt.run({ stock: 0, ...p, t: now() });
  }

  // 五档默认套餐。价格/周期/权益都是占位值，上线前到「产品运营 → 套餐档位」按实际改；
  // 导出 JSON 可纳入版本管理，运行时始终以本表为准。
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

  const dayCount = db.prepare('SELECT COUNT(*) AS c FROM stats_daily').get().c;
  if (dayCount === 0) {
    const stmt = db.prepare(`INSERT OR IGNORE INTO stats_daily
      (date, downloads, installs, active_users, new_users, revenue, api_calls) VALUES (?,?,?,?,?,?,?)`);
    const base = [120, 145, 132, 168, 190, 176, 205, 231, 214, 248, 262, 239, 271, 288];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const date = d.toISOString().slice(0, 10);
      const k = 13 - i;
      stmt.run(
        date,
        base[k] + ((k * 37) % 60),
        Math.round((base[k] + ((k * 37) % 60)) * 0.72),
        800 + ((k * 53) % 420),
        20 + ((k * 17) % 40),
        Math.round((1800 + ((k * 271) % 5200)) * 100) / 100,
        3000 + ((k * 421) % 9000)
      );
    }
  }
}

seed();

module.exports = db;

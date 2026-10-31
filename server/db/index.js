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
db.exec('CREATE INDEX IF NOT EXISTS idx_license_devices_machine ON license_devices(machine_id)');

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

-- 管理员
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT DEFAULT '',
  role TEXT DEFAULT 'admin',
  status TEXT DEFAULT 'active',
  last_login_at TEXT,
  created_at TEXT NOT NULL
);

-- 站点与集成配置（key-value，敏感值以 enc: 前缀加密存储）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT
);

-- C 端用户
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openid TEXT UNIQUE,
  unionid TEXT,
  nickname TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  phone TEXT UNIQUE,
  points INTEGER DEFAULT 0,
  balance REAL DEFAULT 0,
  status TEXT DEFAULT 'active',
  tb_username TEXT,
  tb_password TEXT,
  tb_user_id TEXT,
  tb_customer_id TEXT,
  tb_status TEXT DEFAULT 'none',
  remark TEXT DEFAULT '',
  last_login_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);

-- 产品（software / hardware / service）
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'software',
  name TEXT NOT NULL,
  subtitle TEXT DEFAULT '',
  description TEXT DEFAULT '',
  category TEXT DEFAULT '',
  price REAL DEFAULT 0,
  original_price REAL DEFAULT 0,
  icon TEXT DEFAULT '',
  images TEXT DEFAULT '[]',
  features TEXT DEFAULT '[]',
  version TEXT DEFAULT '1.0.0',
  download_url TEXT DEFAULT '',
  file_size TEXT DEFAULT '',
  stock INTEGER DEFAULT 0,
  total_downloads INTEGER DEFAULT 0,
  total_installs INTEGER DEFAULT 0,
  active_users INTEGER DEFAULT 0,
  total_sales INTEGER DEFAULT 0,
  is_official INTEGER DEFAULT 1,
  status TEXT DEFAULT 'off',
  sort INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 产品版本
CREATE TABLE IF NOT EXISTS product_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  version TEXT NOT NULL,
  changelog TEXT DEFAULT '',
  download_url TEXT DEFAULT '',
  file_size TEXT DEFAULT '',
  downloads INTEGER DEFAULT 0,
  released_at TEXT NOT NULL
);

-- 授权
CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  type TEXT DEFAULT 'permanent',
  max_devices INTEGER DEFAULT 1,
  start_at TEXT NOT NULL,
  end_at TEXT,
  status TEXT DEFAULT 'active',
  order_id INTEGER,
  remark TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_licenses_user ON licenses(user_id);

CREATE TABLE IF NOT EXISTS license_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL,
  device_sn TEXT NOT NULL,
  device_name TEXT DEFAULT '',
  machine_id TEXT DEFAULT '',
  app_id INTEGER,
  last_ip TEXT DEFAULT '',
  last_version TEXT DEFAULT '',
  last_seen_at TEXT,
  bound_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_license_devices_license ON license_devices(license_id);

-- 硬件台账
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  product_id INTEGER,
  sn TEXT UNIQUE NOT NULL,
  name TEXT DEFAULT '',
  model TEXT DEFAULT '',
  tb_device_id TEXT DEFAULT '',
  tb_token TEXT DEFAULT '',
  status TEXT DEFAULT 'offline',
  last_seen_at TEXT,
  bound_at TEXT
);

-- 订单
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  pay_amount REAL NOT NULL,
  discount REAL DEFAULT 0,
  channel TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  trade_no TEXT DEFAULT '',
  items TEXT DEFAULT '[]',
  remark TEXT DEFAULT '',
  paid_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

-- 支付流水
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL,
  channel TEXT NOT NULL,
  trade_no TEXT DEFAULT '',
  amount REAL NOT NULL,
  status TEXT DEFAULT 'success',
  raw TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

-- 积分流水
CREATE TABLE IF NOT EXISTS points_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  change INTEGER NOT NULL,
  balance INTEGER NOT NULL,
  reason TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

-- 日统计
CREATE TABLE IF NOT EXISTS stats_daily (
  date TEXT PRIMARY KEY,
  downloads INTEGER DEFAULT 0,
  installs INTEGER DEFAULT 0,
  active_users INTEGER DEFAULT 0,
  new_users INTEGER DEFAULT 0,
  revenue REAL DEFAULT 0,
  api_calls INTEGER DEFAULT 0
);

-- API 密钥与消费
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  name TEXT DEFAULT '',
  quota INTEGER DEFAULT 0,
  used INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  api_key TEXT DEFAULT '',
  endpoint TEXT DEFAULT '',
  calls INTEGER DEFAULT 1,
  date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_usage_date ON api_usage(date);

-- blcloud API 密钥（用户凭此直接访问设备 API，调用计入额度）
CREATE TABLE IF NOT EXISTS blcloud_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  key_name TEXT DEFAULT '',
  key_prefix TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  mode TEXT DEFAULT 'proxy',
  scopes TEXT DEFAULT 'device.read,device.write',
  quota INTEGER DEFAULT 0,
  used INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  last_ip TEXT DEFAULT '',
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blcloud_keys_user ON blcloud_keys(user_id);

-- blcloud 调用明细
CREATE TABLE IF NOT EXISTS blcloud_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  key_id INTEGER,
  endpoint TEXT DEFAULT '',
  path TEXT DEFAULT '',
  method TEXT DEFAULT '',
  cost INTEGER DEFAULT 1,
  status INTEGER DEFAULT 200,
  ok INTEGER DEFAULT 1,
  message TEXT DEFAULT '',
  ts TEXT NOT NULL,
  date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blcloud_usage_user ON blcloud_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_blcloud_usage_date ON blcloud_usage(date);
CREATE INDEX IF NOT EXISTS idx_blcloud_usage_key ON blcloud_usage(key_id);

-- 微信扫码登录会话
CREATE TABLE IF NOT EXISTS wechat_sessions (
  scene TEXT PRIMARY KEY,
  ticket TEXT DEFAULT '',
  qrcode_url TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  openid TEXT DEFAULT '',
  user_id INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- 短信验证码
CREATE TABLE IF NOT EXISTS sms_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  code TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  expires_at TEXT NOT NULL
);

-- 操作日志
CREATE TABLE IF NOT EXISTS admin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  admin_name TEXT DEFAULT '',
  action TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

-- 开放接入应用（软件端凭证）
CREATE TABLE IF NOT EXISTS open_apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_key TEXT UNIQUE NOT NULL,
  app_secret TEXT NOT NULL,
  name TEXT NOT NULL,
  product_id INTEGER,
  status TEXT DEFAULT 'active',
  offline_days INTEGER DEFAULT 0,
  version TEXT DEFAULT '',
  download_url TEXT DEFAULT '',
  release_note TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

-- 软件端登录会话
CREATE TABLE IF NOT EXISTS client_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  refresh_token TEXT UNIQUE,
  app_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  license_id INTEGER,
  machine_id TEXT DEFAULT '',
  device_name TEXT DEFAULT '',
  app_version TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  expires_at TEXT NOT NULL,
  refresh_expires_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_sessions_user ON client_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_client_sessions_license ON client_sessions(license_id);
CREATE INDEX IF NOT EXISTS idx_client_sessions_app ON client_sessions(app_id);

-- 登录尝试记录（用于爆破锁定）
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  ip TEXT DEFAULT '',
  success INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_user ON login_attempts(username, created_at);

-- HMAC nonce 去重（防请求重放）
CREATE TABLE IF NOT EXISTS api_nonces (
  app_key TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_key, nonce)
);

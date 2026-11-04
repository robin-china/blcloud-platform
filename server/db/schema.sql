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
  -- 用户手动改过昵称/头像后置 1：之后微信登录不再覆盖用户自己设的资料
  profile_custom INTEGER DEFAULT 0,
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
  -- 套餐授权归属的软件端应用（open_apps.id）。NULL = 历史「不限应用」授权，保持兼容；
  -- 新发的套餐授权一律带 app_id，激活时按此校验，A 软件的码不能在 B 软件上用。
  app_id INTEGER,
  product_id INTEGER NOT NULL,
  type TEXT DEFAULT 'permanent',
  max_devices INTEGER DEFAULT 1,
  start_at TEXT NOT NULL,
  end_at TEXT,
  status TEXT DEFAULT 'active',
  order_id INTEGER,
  -- 订阅到期降级：置为该应用 free 档的时间与原档位 code，客户端据此提示「已降级」而不是「功能莫名消失」
  downgraded_from TEXT DEFAULT '',
  downgraded_at TEXT DEFAULT '',
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
  -- 套餐订单归属的软件端应用，便于发货时把授权绑定到正确产品、以及按产品统计
  app_id INTEGER,
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
  -- 代理商渠道归属：登录页带 ?agent=CODE 时由前端随 qrcode 请求传入，
  -- 新用户扫码登录成功即归到该代理商名下
  agent_id INTEGER DEFAULT 0,
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
  -- 功能码白名单 [{token,label}]：登记后，套餐表单的功能权限从自由文本变成勾选，
  -- 保存时未知 token 直接报错 —— 拼错一个字符不再是「静默少一个功能」。
  feature_schema TEXT DEFAULT '[]',
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

-- 软件端 → 浏览器的一次性免登票据
--
-- 客户端已经用 access_token 登录过了，用户点「用户中心」不该在浏览器里再扫一次码。
-- 但 access_token 不能直接塞进 URL（会被浏览历史、代理日志、Referer 带走），
-- 所以换一个 5 分钟、用一次就作废的 code：URL 里只有这个 code，换完即焚。
CREATE TABLE IF NOT EXISTS handoff_tickets (
  code TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  app_id INTEGER,
  machine_id TEXT DEFAULT '',
  used INTEGER DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoff_user ON handoff_tickets(user_id);

-- 套餐档位：按「软件端接入应用」分组，每个软件产品可以有自己的一套等级。
-- app_id → open_apps.id；NULL 表示通用模板档位（只用于复制到具体产品，不直接售卖）。
-- 同一 code 允许在不同产品下重复（每个产品都可以有 free / member），
-- 所以唯一性用 (IFNULL(app_id,0), code) 表达式索引，而不是列级 UNIQUE。
-- 运行时以本表为准；plans.json 只作导入/导出的版本化载体，不参与请求链路。
CREATE TABLE IF NOT EXISTS plans (
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
  -- 数量配额（JSON 对象）：features 只能表达「有/没有」，「标签库 30 个 / Excel 100 行」这类
  -- 量化权益放这里，随离线票据一起签名下发
  limits TEXT DEFAULT '{}',
  status TEXT DEFAULT 'on',
  sort INTEGER DEFAULT 0,
  remark TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_app_code ON plans(IFNULL(app_id, 0), code);
CREATE INDEX IF NOT EXISTS idx_plans_tier ON plans(tier);
CREATE INDEX IF NOT EXISTS idx_plans_app ON plans(app_id);
CREATE INDEX IF NOT EXISTS idx_licenses_app ON licenses(app_id);

-- 代理商佣金账本。status: pending(账期内) → settled(可提现) → withdrawn(已提现)
-- 退款时置 reversed；已提现后才退款的另记一条负数 adjustment，从后续可提现里扣。
CREATE TABLE IF NOT EXISTS agent_commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  order_no TEXT NOT NULL,
  agent_user_id INTEGER NOT NULL,
  buyer_user_id INTEGER NOT NULL,
  base_amount REAL NOT NULL,
  rate REAL NOT NULL,
  amount REAL NOT NULL,
  kind TEXT DEFAULT 'commission',
  status TEXT DEFAULT 'pending',
  available_at TEXT,
  withdrawal_id INTEGER,
  remark TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(order_id, agent_user_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_comm_agent ON agent_commissions(agent_user_id, status);
CREATE INDEX IF NOT EXISTS idx_comm_order ON agent_commissions(order_id);

-- 提现单。一期走人工审核/线下打款，二期接「商家转账到零钱」后把 channel 换成 wxpay_transfer
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  withdrawal_no TEXT UNIQUE NOT NULL,
  agent_user_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  channel TEXT DEFAULT 'manual',
  status TEXT DEFAULT 'pending',
  pay_account TEXT DEFAULT '',
  wx_bill_no TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  reviewed_by TEXT DEFAULT '',
  reviewed_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_withdraw_agent ON withdrawals(agent_user_id, status);

-- 到期提醒去重表：同一张授权同一档剩余天数只提醒一次
CREATE TABLE IF NOT EXISTS license_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  days_left INTEGER NOT NULL,
  end_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(license_id, days_left)
);
CREATE INDEX IF NOT EXISTS idx_remind_user ON license_reminders(user_id);


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
  -- 额度包商品发放的 API 调用次数（运行时 ensureColumn 同步保证旧库也有）
  quota INTEGER DEFAULT 0,
  -- 版本差异内容（产品详情内嵌 + 我的空间卡片按钮共用，缺省 /assets/compare/default.html）
  compare_url TEXT DEFAULT '',
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
  created_at TEXT NOT NULL,
  -- 软删除：用户/管理员可以清掉未付款订单，但不能真删记录 ——
  -- 二维码可能已经发出去了，用户事后扫码付钱，回调找不到订单就是丢钱。
  -- 所以只标记「谁在什么时候删的」，列表过滤掉，回调仍能命中并复活。
  deleted_at TEXT,
  deleted_by TEXT DEFAULT ''
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


-- 桌面客户端更新包清单（LabelGo 等 Electron 端）
-- 与 ThingsBoard OTA 完全无关：包在文件系统里（data/updates），nginx 直出；
-- 这张表只记元数据，接口按 machine/版本实时算「该不该给他更新」。
-- 文件名带版本号，所以同版本重复发布是替换，不是新增。
CREATE TABLE IF NOT EXISTS app_release (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  channel TEXT DEFAULT 'stable',
  platform TEXT DEFAULT 'win32',
  arch TEXT DEFAULT 'x64',
  version TEXT NOT NULL,
  -- 相对 updates 根目录的路径，如 1.0.21/LabelGo-1.0.21-full.zip
  -- 存相对路径而不是整条 URL：换域名/换部署路径后旧记录不会指向死链
  full_path TEXT DEFAULT '',
  -- 需要走 CDN 或对象存储时才填；留空则由接口按请求域名现拼绝对地址
  full_url TEXT DEFAULT '',
  full_sha256 TEXT DEFAULT '',
  full_size INTEGER DEFAULT 0,
  -- 增量包数组：[{from, path, sha256, size}]
  delta_json TEXT DEFAULT '[]',
  mandatory INTEGER DEFAULT 0,
  min_version TEXT DEFAULT '',
  changelog TEXT DEFAULT '',
  -- 灰度比例 0-100：按 machine 哈希分桶，100=全量，0=暂停
  rollout INTEGER DEFAULT 100,
  published_at TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_release_ver ON app_release(product, channel, platform, arch, version);
CREATE INDEX IF NOT EXISTS idx_app_release_pick ON app_release(product, channel, platform, arch, enabled);

-- 客户端升级事件流水：谁、什么时候、从哪个版本升到哪个版本
-- check   = 清单命中（这台机器被告知有新版，但还没确认升级成功）
-- success = 客户端升级成功后回调上报
-- fail    = 客户端升级失败（note 里带原因）
CREATE TABLE IF NOT EXISTS app_update_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  channel TEXT DEFAULT 'stable',
  platform TEXT DEFAULT '',
  arch TEXT DEFAULT '',
  machine TEXT DEFAULT '',
  from_version TEXT DEFAULT '',
  to_version TEXT DEFAULT '',
  action TEXT DEFAULT 'check',
  ip TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  note TEXT DEFAULT '',
  -- 升级结果上报细分字段（2026-11-10 契约 v2）
  result_code INTEGER DEFAULT 0,
  stage TEXT DEFAULT '',
  duration_ms INTEGER DEFAULT 0,
  elevated INTEGER DEFAULT 0,
  os_info TEXT DEFAULT '',
  client_at TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_update_log_pick ON app_update_log(product, created_at);
CREATE INDEX IF NOT EXISTS idx_app_update_log_machine ON app_update_log(machine, product);

-- ---------------------------------------------------------------------------
-- 发售前保护（2026-11-11，与 LabelGo 对接单 v1.0 对齐）
-- ---------------------------------------------------------------------------

-- 开放接口鉴权模式流水：双模期用来看「旧 HMAC 是否已归零」，
-- 归零后才能关旧通道。只记模式与状态，不记 body（里面可能有授权码）。
CREATE TABLE IF NOT EXISTS open_auth_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT DEFAULT '',
  method TEXT DEFAULT '',
  auth_mode TEXT DEFAULT '',
  app_key TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  status INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_open_auth_log_at ON open_auth_log(created_at);
CREATE INDEX IF NOT EXISTS idx_open_auth_mode ON open_auth_log(auth_mode, created_at);

-- 换票序号：每台机器 + 每张授权一条。
-- seq 递增、epoch 在「停票」时 +1 —— 停票后下一张票的 epoch 变了，
-- 旧票即使没到期也验不过（客户端按 epoch 拒绝），比只靠 exp 更硬。
CREATE TABLE IF NOT EXISTS license_ticket_seq (
  license_id INTEGER NOT NULL,
  machine_code TEXT NOT NULL,
  seq INTEGER DEFAULT 0,
  epoch INTEGER DEFAULT 1,
  build_hash TEXT DEFAULT '',
  last_ticket_id TEXT DEFAULT '',
  issued_at TEXT DEFAULT '',
  expires_at TEXT DEFAULT '',
  stopped_at TEXT DEFAULT '',
  stop_reason TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (license_id, machine_code)
);

-- 机器台账：machine_code ↔ 客户 ↔ 授权 ↔ 构建/版本/渠道/产品 ↔ 换票序号。
-- 按 (machine_code, license_id) 覆盖去重，一台机器换绑多张码是两行。
CREATE TABLE IF NOT EXISTS machine_ledger (
  machine_code TEXT NOT NULL,
  license_id INTEGER NOT NULL DEFAULT 0,
  customer_id INTEGER DEFAULT 0,
  app_id INTEGER DEFAULT 0,
  product TEXT DEFAULT '',
  channel TEXT DEFAULT '',
  sku TEXT DEFAULT '',
  build_hash TEXT DEFAULT '',
  version TEXT DEFAULT '',
  seq INTEGER DEFAULT 0,
  ticket_epoch INTEGER DEFAULT 1,
  first_seen_at TEXT DEFAULT '',
  last_seen_at TEXT DEFAULT '',
  PRIMARY KEY (machine_code, license_id)
);
CREATE INDEX IF NOT EXISTS idx_machine_ledger_last ON machine_ledger(last_seen_at);

-- ---------------------------------------------------------------------------
-- 模板市场（2026-11-13，对接 LabelGo 客户端「云端模板市场」）
-- 安全边界：file_path 只存私有目录里的相对文件名，任何对外接口都不得返回它，
-- 也不返回 fileUrl；模板文件只能经「兑换 → 一次性短链」由后端读出。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS market_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT DEFAULT '',
  description TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  width_mm REAL DEFAULT 0,
  height_mm REAL DEFAULT 0,
  paper_type TEXT DEFAULT '',
  dpi INTEGER DEFAULT 203,
  columns INTEGER DEFAULT 1,
  price INTEGER DEFAULT 0,
  author TEXT DEFAULT '',
  thumbnail_url TEXT DEFAULT '',
  file_path TEXT DEFAULT '',
  file_sha256 TEXT DEFAULT '',
  file_size INTEGER DEFAULT 0,
  version INTEGER DEFAULT 1,
  status TEXT DEFAULT 'on',
  downloads INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 游标分页靠 (sortKey, id) 联合条件，索引第一列必须是 status（筛选恒带 status='on'）
CREATE INDEX IF NOT EXISTS idx_market_tpl_hot ON market_templates(status, downloads DESC, id);
CREATE INDEX IF NOT EXISTS idx_market_tpl_new ON market_templates(status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_market_tpl_price ON market_templates(status, price, id);
CREATE INDEX IF NOT EXISTS idx_market_tpl_filter ON market_templates(status, industry, paper_type, width_mm, height_mm);

-- 已购归「账号」不归机器：换机/重装不该丢已购模板。
-- machine_code 只记录首次兑换的机器，用于防刷与排障，不参与归属唯一键。
CREATE TABLE IF NOT EXISTS market_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  template_id TEXT NOT NULL,
  order_id TEXT NOT NULL UNIQUE,
  machine_code TEXT DEFAULT '',
  price INTEGER DEFAULT 0,
  purchased_at TEXT NOT NULL,
  UNIQUE(user_id, template_id)
);
CREATE INDEX IF NOT EXISTS idx_market_purchase_user ON market_purchases(user_id, purchased_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_purchase_tpl ON market_purchases(template_id);

-- 枚举字典：kind = industry | paper_type | size_preset。
-- size_preset 的 value 是一段 JSON {label,widthMm,heightMm}，其余两种是纯文本。
-- 运营在后台改完立刻影响 /market/meta，不需要发客户端版本。
CREATE TABLE IF NOT EXISTS market_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  sort INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(kind, value)
);
CREATE INDEX IF NOT EXISTS idx_market_options_kind ON market_options(kind, sort, id);

-- 一次性下载短链：短链本身是无状态 HMAC，但「用过一次就废」必须有状态。
-- jti 落库，下载时 UPDATE ... WHERE used_at='' 抢占，并发请求只有一个能拿到文件。
CREATE TABLE IF NOT EXISTS market_download_links (
  jti TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  machine_code TEXT DEFAULT '',
  expires_at TEXT NOT NULL,
  used_at TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_link_exp ON market_download_links(expires_at);

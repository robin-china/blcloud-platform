const fs = require('fs');
const path = require('path');
const db = require('../db');
const { now, hashPassword, verifyPassword } = require('../lib/util');
const { signAdmin, requireAdmin } = require('../lib/auth');
const { basePath, getSetting, setSetting, allSettings, getConfig, setConfig, getConfigMasked, DEFAULTS } = require('../lib/config');
const tb = require('../services/tb');
const wxpay = require('../services/wxpay');
const paydiag = require('../lib/paydiag');
const tbdiag = require('../lib/tbdiag');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 失败计数窗口
const LOGIN_MAX_FAIL = 5;               // 窗口内最大失败次数

function clientIp(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
}

function recentFailures(username) {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS).toISOString();
  return db.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE username = ? AND success = 0 AND created_at > ?')
    .get(String(username || ''), since).c;
}

function recordAttempt(username, ip, success) {
  try {
    db.prepare('INSERT INTO login_attempts (username, ip, success, created_at) VALUES (?,?,?,?)')
      .run(String(username || ''), String(ip || ''), success ? 1 : 0, now());
  } catch { /* 审计失败不影响主流程 */ }
}

function clearAttempts(username) {
  try {
    db.prepare('DELETE FROM login_attempts WHERE username = ?').run(String(username || ''));
  } catch { /* ignore */ }
}

const { logAdmin } = require('../lib/adminlog');

module.exports = async function adminRoutes(app) {
  app.post('/api/admin/login', async (req, reply) => {
    const { username, password } = req.body || {};
    const ip = clientIp(req);
    if (recentFailures(username) >= LOGIN_MAX_FAIL) {
      return reply.code(429).send({ error: '登录失败次数过多，请 15 分钟后重试' });
    }
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || ''));
    if (!admin || !verifyPassword(String(password || ''), admin.password_hash)) {
      recordAttempt(username, ip, false);
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    if (admin.status !== 'active') return reply.code(403).send({ error: '账号已停用' });
    clearAttempts(username);
    db.prepare('UPDATE admins SET last_login_at = ? WHERE id = ?').run(now(), admin.id);
    return {
      token: signAdmin(admin),
      must_change_password: Number(admin.must_change_password || 0) === 1,
      // 生产环境后端会硬拦受限令牌（requireAdmin），前端据此不给「稍后提醒」出口；
      // 测试/本地开发不拦，弹窗可跳过，否则本地联调每次都要改密码
      mcp_enforced: process.env.NODE_ENV === 'production',
      admin: { id: admin.id, username: admin.username, name: admin.name, role: admin.role },
    };
  });

  app.get('/api/admin/me', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const admin = db.prepare('SELECT id, username, name, role, last_login_at FROM admins WHERE id = ?').get(req.admin.sub);
    return { admin };
  });

  app.post('/api/admin/password', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const { oldPassword, newPassword } = req.body || {};
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.sub);
    if (!verifyPassword(String(oldPassword || ''), admin.password_hash)) {
      return reply.code(400).send({ error: '原密码不正确' });
    }
    if (String(newPassword || '').length < 8) return reply.code(400).send({ error: '新密码至少 8 位' });
    db.prepare('UPDATE admins SET password_hash = ?, must_change_password = 0 WHERE id = ?')
      .run(hashPassword(String(newPassword || '')), admin.id);
    logAdmin(req, '修改密码');
    // 重新签发完整令牌：登录时发的可能是受限令牌（mcp），改完密码必须换掉，
    // 否则这个账号接下来所有管理接口仍被 403 挡着
    const fresh = db.prepare('SELECT * FROM admins WHERE id = ?').get(admin.id);
    return { ok: true, token: signAdmin(fresh) };
  });

  app.get('/api/admin/list', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { list: db.prepare('SELECT id, username, name, role, status, last_login_at, created_at FROM admins ORDER BY id').all() };
  });

  app.post('/api/admin/create', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const { username, password, name, role } = req.body || {};
    if (!username || !password) return reply.code(400).send({ error: '用户名和密码必填' });
    // 新建账号也守同样的强度线：不然从这里造出弱口令，登录时又要强制整改
    if (String(password).length < 8) return reply.code(400).send({ error: '密码至少 8 位' });
    const exists = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
    if (exists) return reply.code(400).send({ error: '用户名已存在' });
    db.prepare('INSERT INTO admins (username, password_hash, name, role, status, created_at) VALUES (?,?,?,?,?,?)')
      .run(username, hashPassword(String(password)), name || username, role || 'admin', 'active', now());
    logAdmin(req, '新增管理员', username);
    return { ok: true };
  });

  app.post('/api/admin/:id/update', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = Number(req.params.id);
    const { name, role, status, password } = req.body || {};
    if (password) {
      if (String(password).length < 8) return reply.code(400).send({ error: '密码至少 8 位' });
      // 重置密码后必须清掉强制整改标记，否则旧标记会让新密码账号也被 403 卡住
      db.prepare('UPDATE admins SET password_hash = ?, must_change_password = 0 WHERE id = ?')
        .run(hashPassword(String(password)), id);
    }
    db.prepare('UPDATE admins SET name = COALESCE(?, name), role = COALESCE(?, role), status = COALESCE(?, status) WHERE id = ?')
      .run(name || null, role || null, status || null, id);
    return { ok: true };
  });

  app.delete('/api/admin/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = Number(req.params.id);
    if (id === req.admin.sub) return reply.code(400).send({ error: '不能删除当前登录账号' });
    db.prepare('DELETE FROM admins WHERE id = ?').run(id);
    return { ok: true };
  });

  app.get('/api/settings', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const all = allSettings();
    const site = {};
    for (const [k, v] of Object.entries(all)) if (!k.startsWith('cfg.')) site[k] = v;
    return { settings: site };
  });

  app.post('/api/settings', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const patch = req.body || {};
    // 生产环境禁改演示开关：dev_simulate / pay_simulate 打开就是「任意 openid
    // 登录 + 0 元支付」后门。lib/config.js 的 devMode() 生产下已无条件返回 false，
    // 这里再拦一道写入，避免配置表里留着误导性的「已开启」状态。
    const denyKeys = process.env.NODE_ENV === 'production' ? ['dev_simulate', 'pay_simulate'] : [];
    for (const [k, v] of Object.entries(patch)) {
      if (k.startsWith('cfg.')) continue;
      if (denyKeys.includes(k)) {
        return reply.code(400).send({ error: `生产环境不允许修改 ${k}（演示后门开关）` });
      }
      setSetting(k, v);
    }
    logAdmin(req, '更新站点设置');
    return { ok: true };
  });

  app.get('/api/settings/integration', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const out = {};
    for (const name of Object.keys(DEFAULTS)) out[name] = getConfigMasked(name);
    return { config: out };
  });

  app.get('/api/settings/integration/:name', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { config: getConfigMasked(req.params.name) };
  });

  app.post('/api/settings/integration/:name', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const name = req.params.name;
    if (!DEFAULTS[name]) return reply.code(400).send({ error: '未知配置' });
    const cfg = setConfig(name, req.body || {});
    // 改了物联地址或管理员密码，缓存的令牌必须立刻作废，
    // 否则接下来一整天都在用旧令牌，管理员会以为「改了没生效」
    if (name === 'tb') tb.resetAdminToken();
    logAdmin(req, '更新接入配置', name);
    return { ok: true, config: getConfigMasked(name), enabled: cfg.enabled };
  });

  app.post('/api/upload', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: '未收到文件' });
    // 扩展名白名单（图标/图片上传）：svg 会被浏览器当页面渲染（存储型 XSS），
    // html/js 同理，一律不收。上游用不上但传了也只报错，不会落盘
    const ext = path.extname(data.filename || '').toLowerCase();
    const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
    if (!ALLOWED_EXT.has(ext)) {
      return reply.code(400).send({ error: `不支持的文件类型「${ext || '未知'}」，仅支持 jpg / jpeg / png / webp / gif` });
    }
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const target = path.join(UPLOAD_DIR, name);
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(target);
      data.file.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });
    return { url: `${basePath()}/uploads/${name}` };
  });

  app.post('/api/settings/integration/test/wxpay', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    try {
      const r = await wxpay.testConfig();
      paydiag.push('ok', 'selftest', `配置自检通过（${r.message}）`);
      return { ok: true, message: r.message };
    } catch (e) {
      paydiag.push('error', 'selftest', `配置自检失败：${e.message}`);
      const extra = getConfig('wxpay').platform_cert
        ? '（当前配置了手动平台证书，不代表线上可用，建议清空后重测）' : '';
      const hint = /平台证书|RESOURCE_NOT_EXISTS/.test(e.message) && !getConfig('wxpay').pub_key
        ? '（建议改为「微信支付公钥」模式：商户平台 → API安全 → 申请微信支付公钥，填到本页后重测）' : '';
      return reply.code(400).send({ error: `微信支付配置不可用：${e.message}${extra}${hint}` });
    }
  });

  // 管理后台「支付诊断」：不出码时先看这里，它留着微信返回的真实错误码
  app.get('/api/admin/pay/diag', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const cfg = wxpay.readConfig();
    const problems = [];
    if (!cfg.enabled) problems.push('「微信支付」开关没打开');
    if (!cfg.mchid) problems.push('未填商户号 MCHID');
    if (!/^\d{8,12}$/.test(cfg.mchid || '')) problems.push(`商户号格式不像 10 位数字（当前"${cfg.mchid}"）`);
    if (!cfg.appid) problems.push('未填应用 AppID（必须是已与该商户号关联的 AppID）');
    if (!cfg.mch_cert_serial) problems.push('未填商户 API 证书序列号（不是平台证书序列号）');
    if (!cfg.private_key) problems.push('未填商户私钥（apiclient_key.pem 的完整内容）');
    if (!cfg.api_v3_key) problems.push('未填 API v3 密钥（商户平台自行设置的 32 位字符串）');
    else if (cfg.api_v3_key.length !== 32) {
      problems.push(`API v3 密钥长度应为 32 位，当前 ${cfg.api_v3_key.length} 位`);
    }
    if (cfg.notify_url && !/^https?:\/\//.test(cfg.notify_url)) {
      problems.push(`手动填的回调地址不是合法 URL：${cfg.notify_url}`);
    }
    const mode = wxpay.verifyMode();
    const events = paydiag.list(20);
    // 配比检查只能看出「有没有填」，看不出「填的对不对」；
    // 真正卡住用户的是最近一次下单失败，必须直接在最上面点出来
    const lastFail = events.find((e) => e.level === 'error' && e.type === 'prepay');
    if (lastFail) problems.unshift(`最近一次下单失败：${lastFail.detail}`);
    const lastNotifyFail = events.find((e) => e.level === 'error' && e.type === 'notify');
    if (lastNotifyFail) problems.push(`最近一次支付回调处理失败：${lastNotifyFail.detail}`);
    // 回调失败最常见的原因是「新商户号拉不到平台证书」，这条必须直接点名该做什么
    if (/平台证书|RESOURCE_NOT_EXISTS|验签公钥/.test(lastNotifyFail ? lastNotifyFail.detail : '') && mode === 'auto') {
      problems.unshift('该商户号已不支持下载平台证书：请到 商户平台 → 账户中心 → API安全 → 申请「微信支付公钥」，'
        + '把「微信支付公钥ID」与「公钥内容」填到本页「微信支付公钥」两项后保存，回调即可本地验签成功');
    }
    return {
      enabled: !!cfg.enabled,
      mode, // pubkey=微信支付公钥 / cert=手动平台证书 / auto=自动下载平台证书
      pub_key_id: cfg.pub_key_id || '',
      has: {
        mchid: !!cfg.mchid, appid: !!cfg.appid, mch_cert_serial: !!cfg.mch_cert_serial,
        private_key: !!cfg.private_key, api_v3_key: !!cfg.api_v3_key,
        pub_key: !!cfg.pub_key,
      },
      mchid_tail: cfg.mchid ? cfg.mchid.slice(-4) : '',
      key_len: cfg.api_v3_key ? cfg.api_v3_key.length : 0,
      notify_url: cfg.notify_url || '(未填，按当前站点自动拼接)',
      problems,
      events,
    };
  });

  // 「测试连接」只验管理员登录远远不够：开通失败多半卡在 Customer 或激活环节，
  // 所以这里把开通流程的前置步骤全跑一遍，哪一步挂了就直接报在哪一步
  app.post('/api/settings/integration/test/tb', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const cfg = getConfig('tb');
    const steps = [];
    const step = (name, ok, detail) => {
      steps.push({ name, ok, detail: String(detail || '') });
      tbdiag.push(ok ? 'info' : 'error', 'test', `${name}：${detail}`);
    };
    if (!cfg.enabled) {
      step('检查开关', false, '「启用」开关没打开，用户扫码登录时根本不会触发开通');
      return reply.code(400).send({ error: 'blcloud 物联未启用：请打开右上角「启用」开关并保存', steps });
    }
    if (!cfg.base_url) {
      step('检查配置', false, '平台地址为空');
      return reply.code(400).send({ error: '未填写 blcloud 物联平台地址', steps });
    }
    step('检查配置', true, `地址 ${cfg.base_url}，邮箱后缀 ${cfg.email_suffix || '@blcloud.cn'}`);
    let token = '';
    try {
      token = await tb.adminToken(true);
      step('管理员登录', true, '已取得令牌');
    } catch (e) {
      step('管理员登录', false, e.message);
      return reply.code(400).send({ error: `管理员登录失败：${e.message}（检查平台地址与管理员账号密码）`, steps });
    }
    let customerId = '';
    try {
      const me = await tb.request('GET', '/api/auth/user', null, token);
      step('读取租户信息', true, `${me.email || ''}（${me.authority || '未知权限'}）`);
      customerId = (await tb.ensureCustomer(token, 'default', me.tenantId?.id || '')) || '';
      step('客户(Customer)', true, customerId ? `已就绪 ${customerId}` : '未创建，用户将挂到租户下');
      return { ok: true, message: `连接成功：${me.email || '已认证'}`, steps, customer_id: customerId };
    } catch (e) {
      step('客户(Customer)', false, e.message);
      return reply.code(400).send({ error: `准备客户失败：${e.message}`, steps });
    }
  });

  // 管理后台「开通诊断」：账户一直是「待激活」时先看这里
  app.get('/api/admin/tb/diag', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const cfg = getConfig('tb');
    const problems = [];
    if (!cfg.enabled) problems.push('blcloud 物联「启用」开关没打开 —— 用户扫码登录时不会触发开通，账户会一直停在「待激活」');
    if (!cfg.base_url) problems.push('未填写平台地址');
    else if (!/^https?:\/\//.test(cfg.base_url)) problems.push(`平台地址缺少 http(s):// 前缀（当前"${cfg.base_url}"）`);
    if (!cfg.username || !cfg.password) problems.push('未填写物联平台管理员账号/密码');
    const byStatus = db.prepare("SELECT IFNULL(tb_status,'none') AS s, COUNT(*) AS c FROM users GROUP BY s").all();
    const failed = db.prepare("SELECT id, nickname, openid, tb_username, tb_status, tb_message FROM users WHERE tb_status <> 'active' ORDER BY id DESC LIMIT 20").all();
    const events = tbdiag.list(20);
    const lastFail = events.find((e) => e.level === 'error');
    if (lastFail) problems.unshift(`最近一次开通失败：${lastFail.detail}`);
    return {
      enabled: !!cfg.enabled,
      base_url: cfg.base_url || '',
      email_suffix: cfg.email_suffix || '@blcloud.cn',
      default_customer: cfg.default_customer || '',
      has_admin: !!(cfg.username && cfg.password),
      by_status: byStatus,
      pending_users: failed,
      problems,
      events,
    };
  });

  app.get('/api/admin/logs', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    return { list: db.prepare('SELECT * FROM admin_logs ORDER BY id DESC LIMIT ?').all(limit) };
  });
};

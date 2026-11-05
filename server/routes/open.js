/* 软件端开放接口 /api/open/v1/*
 * 两类鉴权：
 *  1) 应用级：X-App-Key + X-Timestamp + X-Nonce + X-Signature（HMAC-SHA256），用于激活、登录等无用户态接口
 *  2) 用户级：Authorization: Bearer <access_token>，登录后访问个人数据
 */
const db = require('../db');
const crypto = require('crypto');
const { now, today, genScene, genCode } = require('../lib/util');
const { getConfig, basePath, publicUrl } = require('../lib/config');
const { verifySignature, issueSession, requireClient, getSession, getSessionState, touchSession, revokeSession } = require('../lib/openauth');
const wechatService = require('../services/wechat');
const { ensureUser } = require('../routes/wechat');
const offlineKey = require('../lib/offlinekey');
const bindSvc = require('../lib/licensebind');
const plans = require('../lib/plans');
const profileLib = require('../lib/profile');
const handoff = require('../lib/handoff');
const avatars = require('../lib/avatars');
const release = require('../lib/release');

const ACCESS_TTL_MS = 2 * 60 * 60 * 1000;

function track(userId, apiKey, endpoint) {
  const date = today();
  db.prepare('INSERT INTO stats_daily (date, api_calls) VALUES (?,1) ON CONFLICT(date) DO UPDATE SET api_calls = api_calls + 1').run(date);
  db.prepare('INSERT INTO api_usage (user_id, api_key, endpoint, calls, date) VALUES (?,?,?,1,?)')
    .run(userId || 0, String(apiKey || ''), endpoint, date);
}

function clientIp(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || '');
}

/**
 * 对外可访问的站点根地址（含子路径前缀）。
 *
 * 生产是 `www.bliot.cn/platform/` 这种子路径部署，写死域名换环境就废，
 * 所以按请求头现拼：反代下取 x-forwarded-proto / x-forwarded-host（TRUST_PROXY=1 已开）。
 */
function publicBase(req) {
  // trustProxy 打开时 req.protocol 已经取了反代透传的真实协议；本地直连时它就是 http。
  // 不要硬默认 https —— 本机自测会生成一个根本打不开的链接。
  const proto =
    String(req.protocol || req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http'
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
  return `${proto}://${host}${basePath()}`
}

/* 应用签名守卫 */
async function withApp(req, reply) {
  const r = verifySignature(req);
  if (!r.ok) {
    reply.code(401).send({ error: r.error, code: 'APP_SIGN_INVALID' });
    return null;
  }
  req.app = r.app;
  return r.app;
}

/* 许可证状态判定 */
function licenseState(lic) {
  if (!lic) return { valid: false, reason: '授权不存在', code: 'LICENSE_NOT_FOUND' };
  if (lic.status === 'revoked') return { valid: false, reason: '授权已被吊销', code: 'LICENSE_REVOKED' };
  // 卡密池里的码还没绑账号：要说清楚「登录后绑定」，否则用户只会看到「授权未激活」
  if (lic.status === 'unassigned' || !lic.user_id) {
    return { valid: false, reason: '该授权码尚未绑定账号，请登录后在「我的授权」中绑定', code: 'LICENSE_UNASSIGNED' };
  }
  if (lic.status !== 'active') return { valid: false, reason: '授权未激活', code: 'LICENSE_INACTIVE' };
  if (lic.end_at && new Date(lic.end_at).getTime() < Date.now()) {
    return { valid: false, reason: '授权已过期', code: 'LICENSE_EXPIRED' };
  }
  return { valid: true };
}

function licensePayload(lic) {
  const product = db.prepare('SELECT id, name, type, version, icon FROM products WHERE id = ?').get(lic.product_id);
  const ent = plans.licenseEntitlement(lic);
  const bound = db.prepare('SELECT COUNT(*) AS c FROM license_devices WHERE license_id = ?').get(lic.id).c;
  return {
    license_key: lic.license_key,
    license_id: lic.id,
    app_id: lic.app_id || ent.app_id || null,
    product_id: lic.product_id,
    // 套餐授权 product_id=0（schema 该列 NOT NULL），JOIN 不到商品时
    // 用档位绑定的上架商品名兜底，再回退档位名
    product_name: product ? product.name : (ent.product_name || ent.plan_name || '套餐授权'),
    product_type: product ? product.type : '',
    type: lic.type,
    start_at: lic.start_at,
    end_at: lic.end_at,
    status: lic.status,
    max_devices: lic.max_devices,
    bound_devices: bound,
    plan: ent.plan_code,
    entitlement: ent,
    // 权益内容哈希：心跳比对用，客户端不必整包 diff
    entitlement_version: plans.entitlementVersion(lic),
    // 订阅到期被服务端降到 free 档时记录；客户端据此提示「订阅到期已降级」，而不是功能静默消失
    downgraded_from: lic.downgraded_from || '',
    downgraded_at: lic.downgraded_at || '',
  };
}

function userPayload(u) {
  return {
    id: u.id,
    openid: u.openid,
    nickname: u.nickname,
    // 内置卡通头像展开成 data URI，软件端拿到即可渲染，不需要再回源取图
    avatar: avatars.toDisplay(u.avatar),
    avatar_preset: avatars.isPreset(u.avatar) ? u.avatar : '',
    phone: u.phone || '',
    points: u.points || 0,
    balance: u.balance || 0,
    tb_status: u.tb_status || 'none',
  };
}

function bindMachine(lic, machineId, opts = {}) {
  const exist = db.prepare('SELECT * FROM license_devices WHERE license_id = ? AND device_sn = ?').get(lic.id, machineId);
  if (exist) {
    db.prepare('UPDATE license_devices SET last_seen_at = ?, last_ip = ?, last_version = ?, machine_id = ?, app_id = ? WHERE id = ?')
      .run(now(), opts.ip || '', opts.version || '', machineId, opts.appId || null, exist.id);
    return { ok: true, reused: true };
  }
  const count = db.prepare('SELECT COUNT(*) AS c FROM license_devices WHERE license_id = ?').get(lic.id).c;
  if (count >= (lic.max_devices || 1)) {
    return { ok: false, reason: '已超出授权允许的机器数量', code: 'MACHINE_LIMIT' };
  }
  db.prepare(`INSERT INTO license_devices (license_id, device_sn, device_name, machine_id, app_id, last_ip, last_version, last_seen_at, bound_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(lic.id, machineId, opts.name || '', machineId, opts.appId || null, opts.ip || '', opts.version || '', now(), now());
  return { ok: true, reused: false };
}

module.exports = async function openRoutes(app) {
  /* ---------------- 应用信息 ---------------- */

  /* 客户端升级结果上报（不鉴权，和清单接口一致）
   * 客户端下载并安装完新版本后调用一次，后台才有「谁真的升级成功/失败」的记录。
   * 只写流水，不改任何业务状态，所以即使被刷也只是一张表变大；前端后台可随时清理。
   */
  app.post('/api/open/v1/app/update-report', async (req, reply) => {
    const b = req.body || {};
    const product = String(b.product || '').trim().slice(0, 64);
    if (!product) return reply.code(400).send({ error: '缺少 product' });
    const status = String(b.status || b.action || 'success').toLowerCase();
    const action = status === 'fail' || status === 'failed' || status === 'error' ? 'fail' : 'success';
    try {
      const rec = release.logUpdate({
        product,
        channel: b.channel,
        platform: b.platform,
        arch: b.arch,
        machine: b.machine,
        from: b.from || b.from_version || b.version,
        to: b.to || b.to_version || b.target || '',
        action,
        note: b.note || b.error || b.message || '',
        ip: req.ip,
        ua: (req.headers || {})['user-agent'],
      });
      return { ok: true, id: rec.id, action };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.get('/api/open/v1/app/version', async (req, reply) => {
    const q = req.query || {};

    /* 更新清单模式（桌面客户端每启动轮询）：?product=LabelGo&version=1.0.20
     *
     * 这条分支**不鉴权**，理由：
     *  - 客户端在用户登录前就要检查更新，弹阻断窗时手里还没有令牌；
     *  - 清单里没有机密信息，包本身还有 sha256 兜底；
     *  - 若走签名，密钥随安装包分发，等于没有鉴权，只是把「下载 404」换成「401」。
     * 老客户端不带 product（走 X-App-Key 签名拿离线宽限/档位）的行为保持不变。
     */
    if (q.product) {
      // 清单要实时：客户端每次启动都来问，缓存住就会出现「发了版半小时没人收到」
      reply.header('Cache-Control', 'no-cache');
      const opts = {
        product: q.product,
        channel: q.channel,
        platform: q.platform,
        arch: q.arch,
        current: q.version,
        machine: q.machine,
      };
      const body = release.manifest(opts, publicUrl(req, '/').replace(/\/+$/, ''));
      // 命中了新版才记一条：后台「升级记录」可见哪些机器还在旧版本。
      // 记录失败绝不能影响客户端检查更新（包都拿到了，日志写不进去是运维问题）。
      if (body && body.update_available) {
        try { release.logCheck(body, opts, req); } catch { /* ignore */ }
      }
      return body;
    }

    if (!(await withApp(req, reply))) return;
    const a = req.app;
    track(0, a.app_key, 'app.version');
    return {
      // 客户端手里只有 app_key，而 /user/licenses 可能返回全产品列表；
      // 不带 id 就没法判断哪张码属于自己 —— 必须一起下发
      id: a.id,
      app_key: a.app_key,
      name: a.name,
      version: a.version || '',
      download_url: a.download_url || '',
      release_note: a.release_note || '',
      // 离线宽限天数必须下发，否则「后台配了宽限、客户端根本不知道」，
      // 断网策略只能各自写死。0 = 必须联网校验。
      offline_days: Number(a.offline_days || 0),
      // 只下发本应用的档位：每个软件产品有自己的一套等级，不能把别家价格混进来
      plan_catalog: plans.listForApp(a.id, true).map((p) => ({
        app_id: p.app_id || null, product_id: p.product_id || null,
        code: p.code, name: p.name, tier: p.tier, billing: p.billing,
        price: p.price, period_days: p.period_days, offline_days: p.offline_days,
        max_devices: p.max_devices, seats: p.seats, features: p.features,
        // 数量配额：features 只是布尔量，表达不了「标签库 30 / Excel 100 行」
        limits: p.limits || {},
      })),
      force_update: false,
      server_time: now(),
    };
  });

  /**
   * 离线票据验签公钥。客户端应当把它**内置在安装包里**并固定（pinning）：
   * 运行时从网络拉公钥等于把验签交给中间人决定，这个接口只在排障时对照 kid 用。
   */
  app.get('/api/open/v1/app/pubkey', async (req, reply) => {
    if (!(await withApp(req, reply))) return;
    return offlineKey.publicKey();
  });

  /* ---------------- 激活 ---------------- */

  app.post('/api/open/v1/auth/activate', async (req, reply) => {
    if (!(await withApp(req, reply))) return;
    const b = req.body || {};
    const key = String(b.license_key || '').trim();
    const machineId = String(b.machine_id || b.machine || '').trim();
    if (!key) return reply.code(400).send({ error: '缺少 license_key', code: 'PARAM_MISSING' });
    if (!machineId) return reply.code(400).send({ error: '缺少 machine_id', code: 'PARAM_MISSING' });

    let lic = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(key);
    // 过期订阅先降级到 free 档再判状态：老用户拿过期码重新激活，得到的是「已降级」而不是死胡同
    lic = plans.settleExpiry(lic);
    const st = licenseState(lic);
    if (!st.valid) return reply.code(403).send({ valid: false, ...st });

    // 三层匹配：授权归属 app_id、档位归属 app_id、老商品授权按 product_id。
    // 历史「不限应用」的授权（app_id=NULL + 通用模板档位）继续放行，不锁死老客户。
    if (!plans.licenseMatchesApp(lic, req.app)) {
      return reply.code(403).send({ valid: false, reason: '授权与当前软件产品不匹配', code: 'PRODUCT_MISMATCH' });
    }

    const bound = bindMachine(lic, machineId, {
      name: b.machine_name || b.device_name || '',
      version: b.version || '',
      ip: clientIp(req),
      appId: req.app.id,
    });
    if (!bound.ok) return reply.code(409).send({ valid: false, reason: bound.reason, code: bound.code });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lic.user_id);
    if (!user) return reply.code(404).send({ error: '授权所属用户不存在', code: 'USER_NOT_FOUND' });

    const token = issueSession({
      app: req.app,
      user,
      licenseId: lic.id,
      machineId,
      deviceName: b.machine_name || '',
      appVersion: b.version || '',
      ip: clientIp(req),
    });
    track(user.id, req.app.app_key, 'auth.activate');

    return {
      valid: true,
      ...token,
      user: userPayload(user),
      license: licensePayload(lic),
      server_time: now(),
    };
  });

  /* ---------------- 扫码登录 ---------------- */

  app.post('/api/open/v1/auth/qrcode', async (req, reply) => {
    if (!(await withApp(req, reply))) return;
    const cfg = getConfig('wechat');
    const scene = genScene();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    let mode = 'simulate';
    let qrcodeUrl = '';
    let url = '';
    if (cfg.enabled && cfg.appid && cfg.appsecret) {
      try {
        const qr = await wechatService.createQrScene(scene, 300);
        qrcodeUrl = qr.qrcodeUrl;
        url = qr.url;
        mode = 'wechat';
      } catch (e) {
        mode = 'simulate';
      }
    }
    db.prepare('INSERT INTO wechat_sessions (scene, ticket, qrcode_url, status, openid, user_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(scene, '', qrcodeUrl, 'pending', '', null, now(), expiresAt);
    track(0, req.app.app_key, 'auth.qrcode');
    // simulate 时没有真二维码，但客户端仍要画点东西出来（否则界面只能报错）。
    // 拿 scene 当内容：扫出来是一串文本，登不了录，但流程和提示都对得上。
    return { scene, mode, qrcode_url: qrcodeUrl || scene, url, expires_at: expiresAt };
  });

  app.get('/api/open/v1/auth/qrcode/:scene', async (req, reply) => {
    const s = db.prepare('SELECT * FROM wechat_sessions WHERE scene = ?').get(String(req.params.scene || ''));
    if (!s) return reply.code(404).send({ error: '二维码已失效', code: 'SCENE_NOT_FOUND' });
    if (s.status === 'pending') {
      if (new Date(s.expires_at).getTime() < Date.now()) return { status: 'expired' };
      return { status: 'pending' };
    }
    if (s.status === 'confirmed' && s.user_id) {
      const appKey = String(req.query.app_key || '');
      const appRow = db.prepare('SELECT * FROM open_apps WHERE app_key = ?').get(appKey);
      if (!appRow) return { status: 'confirmed', need_app_key: true };
      if (appRow.status !== 'active') return reply.code(401).send({ error: '应用已停用', code: 'APP_DISABLED' });
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
      const machineId = String(req.query.machine_id || '');
      // 软件端扫码进来时就知道是哪个应用，按需补发该产品专属免费档授权码，
      // 用户不必先去网页「我的空间」领码才能激活
      plans.ensureFreeLicense(user.id, appRow.id);
      // 登录即挑出该产品下的「当前生效」授权（tier 最高且未过期），顺手把这台机器绑上去：
      // 扫码登录的用户多数只有一张码，之前还要再走一次 activate 才算登录完成
      const best = plans.bestLicenseForApp(user.id, appRow);
      let licenseOut = null;
      let licenseId = null;
      let bindError = null;
      if (best) {
        if (machineId) {
          const bound = bindMachine(best, machineId, {
            name: String(req.query.machine_name || ''),
            version: String(req.query.version || ''),
            ip: clientIp(req),
            appId: appRow.id,
          });
          if (bound.ok) {
            licenseId = best.id;
            licenseOut = licensePayload(best);
          } else {
            // 机器超限时仍完成登录（可去网页解绑），只是会话不带授权
            bindError = { code: bound.code, reason: bound.reason };
          }
        } else {
          licenseId = best.id;
          licenseOut = licensePayload(best);
        }
      }
      const token = issueSession({
        app: appRow, user, licenseId, machineId,
        deviceName: String(req.query.machine_name || ''),
        appVersion: String(req.query.version || ''),
        ip: clientIp(req),
      });
      track(user.id, appRow.app_key, 'auth.qrcode.login');
      const out = { status: 'confirmed', ...token, user: userPayload(user) };
      if (licenseOut) out.license = licenseOut;
      if (bindError) out.license_bind_error = bindError;
      return out;
    }
    return { status: s.status };
  });

  /* ---------------- 软件端 → 浏览器免登（用户中心） ---------------- */

  /**
   * 生成一个打开「用户中心」的一次性链接。
   *
   * 为什么不让客户端把 access_token 拼进 URL：
   * 1. 会留在浏览历史、代理日志、Referer 里，等于把 2 小时的令牌帖在公告板上；
   * 2. 网页端用的是另一套 JWT（localStorage user_token），access_token 在那边根本不认。
   * 所以这里发一个 5 分钟、用一次即焚的 code，由 /api/portal/handoff 换成网页登录态。
   *
   * `to` 只接受白名单里的页面名，避免被当成任意跳转（开放重定向）。
   */
  app.post('/api/open/v1/auth/handoff', async (req, reply) => {
    const s = await requireClient(req, reply);
    if (!s) return;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
    if (!user) return reply.code(404).send({ error: '用户不存在', code: 'USER_NOT_FOUND' });
    if (user.status && user.status !== 'active') {
      return reply.code(403).send({ error: '账号已被停用，请联系客服', code: 'USER_DISABLED' });
    }

    const to = handoff.page((req.body || {}).to, 'account');

    // to=space 时可带 app=<app_key>：客户端「升级套餐」按钮直接落到用户自己的那张产品卡片，
    // 而不是扔进「我的空间」让用户自己找。app_key 必须真实存在，防任意参数注入 URL。
    let appParam = '';
    if (to === 'space') {
      const ak = String((req.body || {}).app || '').trim();
      if (ak) {
        const a = db.prepare('SELECT id, app_key FROM open_apps WHERE app_key = ?').get(ak);
        if (a) appParam = '?app=' + encodeURIComponent(ak);
      }
    }

    // 票据签发抽到 lib/handoff.js：微信网页授权回调也要用同一套规则
    // （只能换一次、5 分钟过期、同用户仅保留最近一张）
    const ttlMs = 5 * 60 * 1000;
    const code = handoff.issue(user.id, { appId: s.app_id || null, machineId: s.machine_id || '', ttlMs });

    track(user.id, s.app_id, 'auth.handoff');
    return {
      url: `${publicBase(req)}/user/?t=${code}#/${to}${appParam}`,
      page: to,
      app: appParam ? String((req.body || {}).app || '').trim() : '',
      expires_in: Math.floor(ttlMs / 1000),
      user: userPayload(user),
    };
  });

  /* ---------------- 手机号登录 ---------------- */

  app.post('/api/open/v1/auth/sms/send', async (req, reply) => {
    if (!(await withApp(req, reply))) return;
    const phone = String((req.body || {}).phone || '').trim();
    if (!/^1\d{10}$/.test(phone)) return reply.code(400).send({ error: '手机号格式不正确', code: 'PARAM_INVALID' });
    const code = genCode(6);
    db.prepare('INSERT INTO sms_codes (phone, code, used, expires_at) VALUES (?,?,0,?)')
      .run(phone, code, new Date(Date.now() + 5 * 60 * 1000).toISOString());
    track(0, req.app.app_key, 'auth.sms.send');
    return { ok: true, expires_in: 300, dev_code: code };
  });

  app.post('/api/open/v1/auth/login/phone', async (req, reply) => {
    if (!(await withApp(req, reply))) return;
    const { phone, code } = req.body || {};
    const p = String(phone || '').trim();
    if (!/^1\d{10}$/.test(p)) return reply.code(400).send({ error: '手机号格式不正确', code: 'PARAM_INVALID' });
    const row = db.prepare('SELECT * FROM sms_codes WHERE phone = ? AND used = 0 ORDER BY id DESC LIMIT 1').get(p);
    if (!row || row.code !== String(code || '')) return reply.code(400).send({ error: '验证码错误', code: 'CODE_INVALID' });
    if (new Date(row.expires_at).getTime() < Date.now()) return reply.code(400).send({ error: '验证码已过期', code: 'CODE_EXPIRED' });
    db.prepare('UPDATE sms_codes SET used = 1 WHERE id = ?').run(row.id);

    let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(p);
    if (!user) {
      const { user: created } = await ensureUser(`p_${p}`, { nickname: `用户${p.slice(-4)}` });
      db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(p, created.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(created.id);
    }

    const token = issueSession({
      app: req.app, user,
      machineId: String((req.body || {}).machine_id || ''),
      deviceName: String((req.body || {}).machine_name || ''),
      appVersion: String((req.body || {}).version || ''),
      ip: clientIp(req),
    });
    plans.ensureFreeLicense(user.id, req.app.id);
    track(user.id, req.app.app_key, 'auth.login.phone');
    return { ...token, user: userPayload(user), is_new: false };
  });

  /* ---------------- 令牌维护 ---------------- */

  app.post('/api/open/v1/auth/refresh', async (req, reply) => {
    const rt = String((req.body || {}).refresh_token || '');
    const s = db.prepare('SELECT * FROM client_sessions WHERE refresh_token = ?').get(rt);
    if (!s || s.status !== 'active') return reply.code(401).send({ error: '刷新令牌无效', code: 'REFRESH_INVALID' });
    if (new Date(s.refresh_expires_at).getTime() < Date.now()) {
      return reply.code(401).send({ error: '刷新令牌已过期，请重新登录', code: 'REFRESH_EXPIRED' });
    }
    const app = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(s.app_id);
    if (!app || app.status !== 'active') return reply.code(401).send({ error: '应用已停用', code: 'APP_DISABLED' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
    revokeSession(s.token);
    const token = issueSession({
      app, user, licenseId: s.license_id, machineId: s.machine_id,
      deviceName: s.device_name, appVersion: s.app_version, ip: clientIp(req),
    });
    return { ...token, user: userPayload(user) };
  });

  app.post('/api/open/v1/auth/logout', async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    revokeSession(req.session.token);
    return { ok: true };
  });

  /* ---------------- 用户资料 ---------------- */

  app.get('/api/open/v1/user/profile', async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    touchSession(req.session, clientIp(req));
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user_id);
    track(user.id, req.app.app_key, 'user.profile');
    // 实时读库：用户在网页端改了昵称/头像，软件端下次取资料就能同步到
    return { user: userPayload(user), session_expires_at: req.session.expires_at };
  });

  /** 软件端也能改昵称 / 头像，与网页端共用同一套校验与 profile_custom 标记 */
  app.post('/api/open/v1/user/profile', async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    const r = profileLib.updateByUser(req.session.user_id, req.body || {});
    if (!r.ok) return reply.code(400).send({ error: r.errors.join('；') });
    track(req.session.user_id, req.app.app_key, 'user.profile.update');
    return { ok: true, user: userPayload(db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user_id)) };
  });

  /**
   * 用户授权列表。
   * 传 app_key 时只返回该软件产品下可用的授权，并标出 effective: true（判定顺序
   * tier 高 → end_at 晚 → id 大，与扫码登录选码一致）—— 客户端据此知道用哪张码。
   * 不传则返回全部（兼容老客户端），但同样会先做过期降级收敛。
   */
  app.get('/api/open/v1/user/licenses', async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    touchSession(req.session, clientIp(req));
    const uid = req.session.user_id;
    track(uid, req.app.app_key, 'user.licenses');
    const appKey = String(req.query.app_key || '').trim();
    if (appKey) {
      let scopeApp = req.app;
      if (appKey !== req.app.app_key) {
        const other = db.prepare('SELECT * FROM open_apps WHERE app_key = ?').get(appKey);
        if (other) scopeApp = other;
      }
      const ranked = plans.usableLicenses(uid, scopeApp);
      let effectiveSet = false;
      return {
        app: { id: scopeApp.id, app_key: scopeApp.app_key, name: scopeApp.name },
        list: ranked.map(({ lic }) => {
          const valid = plans.isLicenseLive(lic);
          const effective = valid && !effectiveSet;
          if (effective) effectiveSet = true;
          return { ...licensePayload(lic), valid, effective };
        }),
      };
    }
    const rows = db.prepare('SELECT * FROM licenses WHERE user_id = ? ORDER BY id DESC').all(uid);
    return {
      list: rows.map((l) => {
        const lic = plans.settleExpiry(l);
        return { ...licensePayload(lic), valid: plans.isLicenseLive(lic) };
      }),
    };
  });

  app.get('/api/open/v1/user/devices', async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    touchSession(req.session, clientIp(req));
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user_id);
    const cfg = getConfig('tb');
    const list = db.prepare(`SELECT d.*, p.name AS product_name, p.icon FROM devices d
      LEFT JOIN products p ON p.id = d.product_id WHERE d.user_id = ? ORDER BY d.id DESC`).all(req.session.user_id);
    track(req.session.user_id, req.app.app_key, 'user.devices');
    return {
      tb: {
        url: cfg.base_url || '',
        enabled: !!cfg.enabled,
        status: user.tb_status || 'none',
        note: '设备直连使用每台设备的 tb_token（MQTT 用户名）；账户级访问请使用 blcloud API 密钥',
      },
      list: list.map((d) => ({
        id: d.id, sn: d.sn, name: d.name, product_id: d.product_id, product_name: d.product_name,
        status: d.status, tb_device_id: d.tb_device_id || '', tb_token: d.tb_token || '',
        last_seen_at: d.last_seen_at, bound_at: d.bound_at,
      })),
    };
  });

  /* ---------------- 授权校验 / 心跳 / 解绑 ---------------- */

  app.post('/api/open/v1/license/verify', async (req, reply) => {
    const b = req.body || {};
    let appRow = null;
    let lic = null;
    let machineId = String(b.machine_id || b.device_sn || '').trim();
    const tokenSt = getSessionState(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    // 令牌被作废（解绑 / 吊销 / 后台踢下线）时要直说，别让客户端去猜是不是过期
    if (tokenSt.code === 'SESSION_REVOKED') {
      return reply.code(403).send({ valid: false, reason: '该机器已被解绑或授权已吊销，请重新激活', code: 'SESSION_REVOKED' });
    }
    const tokenSess = tokenSt.session;

    if (tokenSess) {
      appRow = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(tokenSess.app_id);
      if (!machineId) machineId = tokenSess.machine_id || '';
      if (tokenSess.license_id) {
        lic = db.prepare('SELECT * FROM licenses WHERE id = ?').get(tokenSess.license_id);
      }
      touchSession(tokenSess, clientIp(req));
    } else {
      const r = verifySignature(req);
      if (!r.ok) return reply.code(401).send({ error: r.error, code: 'APP_SIGN_INVALID' });
      appRow = r.app;
      if (!b.license_key) return reply.code(400).send({ error: '缺少 license_key', code: 'PARAM_MISSING' });
      lic = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(String(b.license_key).trim());
    }

    // 过期订阅先收敛（降到 free 档）：verify 是客户端最常走的校验口，降级要在这里生效
    lic = plans.settleExpiry(lic);
    const st = licenseState(lic);
    if (!st.valid) return reply.code(403).send({ valid: false, ...st });
    if (!plans.licenseMatchesApp(lic, appRow)) {
      return reply.code(403).send({ valid: false, reason: '授权与当前软件产品不匹配', code: 'PRODUCT_MISMATCH' });
    }

    let boundInfo = null;
    if (machineId) {
      const d = db.prepare('SELECT * FROM license_devices WHERE license_id = ? AND device_sn = ?').get(lic.id, machineId);
      if (!d) {
        return reply.code(403).send({ valid: false, reason: '该机器未激活此授权', code: 'MACHINE_NOT_BOUND' });
      }
      db.prepare('UPDATE license_devices SET last_seen_at = ?, last_ip = ?, last_version = ? WHERE id = ?')
        .run(now(), clientIp(req), String(b.version || ''), d.id);
      boundInfo = { machine_id: machineId, bound_at: d.bound_at };
    }

    const user = db.prepare('SELECT id, nickname, avatar FROM users WHERE id = ?').get(lic.user_id);
    track(lic.user_id, appRow.app_key, 'license.verify');
    return {
      valid: true,
      license: licensePayload(lic),
      user: user ? { id: user.id, nickname: user.nickname, avatar: avatars.toDisplay(user.avatar) } : null,
      machine: boundInfo,
      server_time: now(),
    };
  });

  app.post('/api/open/v1/license/heartbeat', async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    const b = req.body || {};
    touchSession(req.session, clientIp(req));
    let lic = req.session.license_id ? db.prepare('SELECT * FROM licenses WHERE id = ?').get(req.session.license_id) : null;
    if (!lic && b.license_key) lic = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(String(b.license_key).trim());
    const payload = { valid: false, server_time: now() };
    if (!lic) return { ...payload, reason: '会话未绑定授权', code: 'LICENSE_NOT_BOUND' };
    // 订阅到期在这里显式降级：客户端下次心跳就能拿到「已降级为 free 档 + downgraded_from」，
    // 而不是静默丢功能、用户以为软件坏了去打客服
    lic = plans.settleExpiry(lic);
    const st = licenseState(lic);
    if (!st.valid) return { valid: false, reason: st.reason, code: st.code, server_time: now() };

    if (req.session.machine_id) {
      // 必须确认这台机器仍然绑在这张授权上：后台/用户自助解绑之后，
      // 老令牌不能继续 valid=true —— 否则「解绑」只是清了个名单，
      // 占着名额的客户端还能照常用下去。
      const bound = db.prepare('SELECT id FROM license_devices WHERE license_id = ? AND device_sn = ?')
        .get(lic.id, req.session.machine_id);
      if (!bound) {
        return { valid: false, reason: '该机器已解绑此授权，请重新激活', code: 'MACHINE_NOT_BOUND', server_time: now() };
      }
      db.prepare('UPDATE license_devices SET last_seen_at = ?, last_version = ? WHERE id = ?')
        .run(now(), String(b.version || ''), bound.id);
    }
    db.prepare('UPDATE client_sessions SET app_version = ? WHERE id = ?').run(String(b.version || req.session.app_version || ''), req.session.id);
    track(req.session.user_id, req.app.app_key, 'license.heartbeat');
    // 心跳带 entitlement_version：客户端上次拿到的版本号与服务端比对，
    // 变了才需要重新解析 license payload，不用每次心跳整包 diff
    const licPayload = licensePayload(lic);
    const reported = String(b.entitlement_version || '');
    return {
      valid: true,
      license: licPayload,
      entitlement_version: licPayload.entitlement_version,
      // true = 权益变了（升级/降级/改配置），false = 没变，null = 客户端没上报版本
      entitlement_changed: reported ? reported !== licPayload.entitlement_version : null,
      expires_at: req.session.expires_at,
      server_time: now(),
    };
  });

  app.post('/api/open/v1/license/unbind', async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    const b = req.body || {};
    const machineId = String(b.machine_id || req.session.machine_id || '').trim();
    if (!machineId) return reply.code(400).send({ error: '缺少 machine_id', code: 'PARAM_MISSING' });
    let lic = req.session.license_id ? db.prepare('SELECT * FROM licenses WHERE id = ?').get(req.session.license_id) : null;
    if (!lic && b.license_key) lic = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(String(b.license_key).trim());
    if (!lic) return reply.code(404).send({ error: '未找到授权', code: 'LICENSE_NOT_FOUND' });
    if (lic.user_id !== req.session.user_id) return reply.code(403).send({ error: '无权操作该授权', code: 'FORBIDDEN' });
    db.prepare('DELETE FROM license_devices WHERE license_id = ? AND device_sn = ?').run(lic.id, machineId);
    // 只踢掉被解绑的那台机器的会话，其他设备不受影响
    db.prepare('UPDATE client_sessions SET status = ? WHERE license_id = ? AND machine_id = ?')
      .run('revoked', lic.id, machineId);
    if (machineId === req.session.machine_id) {
      db.prepare('UPDATE client_sessions SET status = ? WHERE id = ?').run('revoked', req.session.id);
    }
    return { ok: true, license: licensePayload(lic) };
  });

  /**
   * 离线票据：让客户端在断网时也能证明「这台机器在某个时刻确实有有效授权」。
   *
   * 用 Ed25519 签名，客户端只拿公钥验签 —— 公钥泄露无所谓，私钥在服务器上。
   * 票据里带 exp（硬到期）与 iat（签发时刻），客户端两样都要校验：
   *   - 本地时间 > exp  → 过期，必须联网
   *   - 本地时间 < iat  → 系统时间被往回拨了，视为过期
   * 这样「改本机时间无限续命」这条路就走不通了。
   */
  app.post('/api/open/v1/license/ticket', async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    touchSession(req.session, clientIp(req));
    const licRaw = req.session.license_id
      ? db.prepare('SELECT * FROM licenses WHERE id = ?').get(req.session.license_id) : null;
    if (!licRaw) return reply.code(404).send({ error: '会话未绑定授权', code: 'LICENSE_NOT_BOUND' });
    // 出票据前先收敛过期订阅：降级后的权益（free 档 features/limits）才签得进票据
    const lic = plans.settleExpiry(licRaw);
    const st = licenseState(lic);
    if (!st.valid) return reply.code(403).send({ valid: false, ...st });

    const appRow = db.prepare('SELECT * FROM open_apps WHERE id = ?').get(req.session.app_id);
    const ent = plans.licenseEntitlement(lic);
    // 套餐授权按档位的 offline_days 走；历史（无档位）授权仍用应用级的离线宽限。
    // 断网时客户端问不了服务端，权益必须跟着 Ed25519 签名一起下发。
    const hasPlan = !!ent.plan_name;
    const offlineDays = hasPlan ? Number(ent.offline_days || 0) : Number((appRow && appRow.offline_days) || 0);
    const iat = Date.now();
    // offline_days = 0 表示必须联网：票据只覆盖本次会话，不额外给离线时长
    const graceMs = offlineDays > 0 ? offlineDays * 86400000 : ACCESS_TTL_MS;
    let exp = iat + graceMs;
    if (lic.end_at) exp = Math.min(exp, new Date(lic.end_at).getTime());
    if (req.session.expires_at) {
      const se = new Date(req.session.expires_at).getTime();
      if (offlineDays <= 0 && se > iat) exp = Math.min(exp, se);
    }

    const payload = {
      v: 1,
      license_id: lic.id,
      license_key: lic.license_key,
      user_id: req.session.user_id,
      machine_id: req.session.machine_id || '',
      product_id: lic.product_id,
      app_id: ent.app_id || null,
      plan: ent.plan_code || lic.type,
      plan_code: ent.plan_code,
      plan_name: ent.plan_name || '',
      tier: ent.tier || 0,
      features: ent.features,
      // 数量配额：断网时客户端同样要按配额限制功能，必须进签名票据
      limits: ent.limits || {},
      seats: ent.seats,
      online_required: ent.online_required,
      max_devices: lic.max_devices,
      offline_days: offlineDays,
      // 到期降级痕迹：离线期间客户端也能提示「订阅到期已降级」
      downgraded_from: lic.downgraded_from || '',
      entitlement_version: plans.entitlementVersion(lic),
      iat: Math.floor(iat / 1000),
      exp: Math.floor(exp / 1000),
    };
    const signed = offlineKey.issue(payload);
    db.prepare('UPDATE client_sessions SET last_seen_at = ? WHERE id = ?').run(now(), req.session.id);
    return {
      ticket: signed.ticket,
      alg: signed.alg,
      kid: signed.kid,
      payload,
      public_key: signed.public_key,
      expires_in: Math.max(0, Math.floor((exp - iat) / 1000)),
      server_time: now(),
    };
  });

  /**
   * 客户端绑定卡密（已登录）。线下买卡 / 渠道发卡的场景：
   * 用户先登录，再把卡上的码贴进来，绑定后这张码才开始计时。
   */
  app.post('/api/open/v1/license/bind', async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    touchSession(req.session, clientIp(req));
    const g = bindSvc.guard(req.session.user_id);
    if (!g.ok) return reply.code(429).send({ error: g.reason, code: g.code });
    const key = String((req.body || {}).license_key || '').trim();
    if (!key) return reply.code(400).send({ error: '缺少 license_key', code: 'PARAM_MISSING' });
    const lic = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(key);
    const res = bindSvc.bind(lic, req.session.user_id, 'self');
    if (!res.ok) {
      bindSvc.noteFail(req.session.user_id);
      return reply.code(400).send({ error: res.reason, code: res.code });
    }
    bindSvc.noteSuccess(req.session.user_id);
    if (req.app && req.app.id) track(req.session.user_id, req.app.app_key, 'license.bind');
    return { ok: true, already: !!res.already, license: licensePayload(res.license) };
  });

  /* ---------------- 遥测上报 ---------------- */

  app.post('/api/open/v1/telemetry', async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    const b = req.body || {};
    track(req.session.user_id, req.app.app_key, 'telemetry');
    db.prepare('UPDATE client_sessions SET last_seen_at = ?, app_version = ? WHERE id = ?')
      .run(now(), String(b.version || req.session.app_version || ''), req.session.id);
    return { ok: true, server_time: now() };
  });
};

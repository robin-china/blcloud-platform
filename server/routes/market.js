/* 模板市场路由（2026-11-13）
 * 开放接口：/api/open/v1/market/*、/api/open/v1/user/credits|signin
 * 后台接口：/api/market/*
 *
 * 鉴权沿用 C 批框架：公开读只要 x-app-key（也可带 Bearer），
 * 写与扣积分必须 Bearer + x-nonce（requireClientWrite，只在新增接口上强制），
 * 下载端点不依赖应用身份 —— 它只认一次性 HMAC 短链。
 */
const fs = require('fs');
const db = require('../db');
const { now } = require('../lib/util');
const { publicUrl } = require('../lib/config');
const { requireAdmin } = require('../lib/auth');
const { logAdmin } = require('../lib/adminlog');
const {
  resolveApp, requireClient, requireClientWrite, readClientToken, getSessionState,
  touchSession, rateHit, consumeNonce,
} = require('../lib/openauth');
const market = require('../lib/market');
const pointsLib = require('../lib/points');

const OPEN = '/api/open/v1';
const ADMIN = '/api/market';
// 上架 API 与后台 /api/market、客户端 /api/open/v1 分开：独立密钥、独立鉴权、
// 独立限流与日志，任何一侧改契约都不会误伤另外两侧。
const API = '/api/market/v1';

function clientIp(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
}

function fail(reply, status, code, error, extra = {}) {
  return reply.code(status).send({ error, code, ...extra });
}

/** 上架 API 的失败：额外把 code 挂到 req 上，供 onResponse 写调用日志。 */
function apiFail(req, reply, status, code, error, extra = {}) {
  req.apiCode = code;
  return fail(reply, status, code, error, extra);
}

module.exports = async function marketRoutes(app) {
  /* 与 open.js 同口径的鉴权模式流水；Fastify 插件作用域独立，两边不会重复记同一请求。 */
  app.addHook('onResponse', async (req, reply) => {
    const url = String(req.url || '');
    // 两条流水互不干扰：这里曾写成「非开放接口直接 return」，把下面
    // /api/market/v1 的调用日志整段跳过了（2026-11-13 测试抓到）。
    if (req.authMode && url.includes('/api/open/v1/')) {
      try {
        db.prepare(`INSERT INTO open_auth_log (path, method, auth_mode, app_key, ip, status, created_at)
          VALUES (?,?,?,?,?,?,?)`).run(
          url.split('?')[0].slice(0, 120), String(req.method || '').slice(0, 8),
          String(req.authMode), String((req.app && req.app.app_key) || req.headers['x-app-key'] || '').slice(0, 64),
          String(req.ip || '').slice(0, 64), Number(reply.statusCode) || 0, now()
        );
      } catch { /* 日志失败不影响响应 */ }
    }
    // 上架 API 每次调用（含失败）都留痕：密钥、幂等键、模板 ID、结果码、IP。
    if (req.apiAction) {
      market.logApiCall({
        keyId: (req.marketKey && req.marketKey.id) || 0,
        action: req.apiAction,
        externalId: req.apiExternalId || '',
        templateId: req.apiTemplateId || '',
        statusCode: Number(reply.statusCode) || 0,
        code: req.apiCode || '',
        ip: clientIp(req),
      });
    }
  });

  /**
   * 上架 API 统一鉴权：X-Market-Key（高熵随机，库里只有 sha256）。
   * 写操作额外要 X-Nonce 一次性值，防网络重试/中间人重放；限流按密钥独立计。
   */
  async function withKey(req, reply, action, { write = false } = {}) {
    req.apiAction = action;
    const raw = String(req.headers['x-market-key'] || '').trim();
    if (!raw) { apiFail(req, reply, 401, 'MARKET_KEY_REQUIRED', '缺少 X-Market-Key'); return null; }
    const key = market.findApiKey(raw);
    if (!key) { apiFail(req, reply, 401, 'MARKET_KEY_INVALID', 'API 密钥无效'); return null; }
    if (key.status !== 'active') { apiFail(req, reply, 403, 'MARKET_KEY_DISABLED', 'API 密钥已停用'); return null; }
    req.marketKey = key;
    if (!rateHit(`market:api:${key.id}`, 120, 60000)) {
      apiFail(req, reply, 429, 'RATE_LIMITED', '调用过于频繁，请稍后再试'); return null;
    }
    if (write) {
      const n = String(req.headers['x-nonce'] || '').trim();
      if (!n || n.length > 128) {
        apiFail(req, reply, 401, 'NONCE_REQUIRED', '写操作必须带 X-Nonce'); return null;
      }
      if (!consumeNonce('mkt:' + key.key_prefix, n)) {
        apiFail(req, reply, 401, 'NONCE_REUSED', 'nonce 已使用，请求重复'); return null;
      }
    }
    market.touchApiKey(key.id);
    return key;
  }

  async function withApp(req, reply) {
    const r = resolveApp(req);
    if (!r.ok) {
      fail(reply, r.code === 'RATE_LIMITED' ? 429 : 401, r.code || 'APP_SIGN_INVALID', r.error);
      return null;
    }
    req.app = r.app;
    req.authMode = r.mode;
    if (r.session) req.session = r.session;
    return r.app;
  }

  /* ---------------- 公开读（免 Bearer） ---------------- */

  /** 枚举字典：后台改完立刻生效，客户端不写死行业/纸型/尺寸预设。 */
  app.get(`${OPEN}/market/meta`, async (req, reply) => {
    if (!(await withApp(req, reply))) return;
    return market.meta();
  });

  /** 列表：4 维筛选 + 4 种排序 + (sortKey,id) 游标分页，恒不含 fileUrl。 */
  app.get(`${OPEN}/market/list`, async (req, reply) => {
    if (!(await withApp(req, reply))) return;
    const q = req.query || {};
    let userId = 0;
    const mine = String(q.mine || '') === 'true' || String(q.mine || '') === '1';
    if (mine) {
      // mine 是「我的已购」，没有登录态就没法判定归属，不能悄悄退化成全量列表
      const st = getSessionState(readClientToken(req));
      if (st.code || !st.session) return fail(reply, 401, 'UNAUTHORIZED', '查看已购需要登录');
      userId = st.session.user_id;
    }
    const r = market.list({
      industry: q.industry, paperType: q.paperType,
      widthMm: q.widthMm, heightMm: q.heightMm,
      q: q.q, sort: q.sort, mine, userId,
      cursor: q.cursor, limit: q.limit,
    });
    if (r.error) return fail(reply, r.status || 400, r.code, r.error);
    return r;
  });

  app.get(`${OPEN}/market/detail/:id`, async (req, reply) => {
    if (!(await withApp(req, reply))) return;
    const r = market.detail(req.params.id);
    if (r.error) return fail(reply, r.status || 404, r.code, r.error);
    return r.item;
  });

  /* ---------------- 登录态读 ---------------- */

  /** 积分余额：客户端本地 credits.json 只是离线缓存，一律以后台为准。 */
  app.get(`${OPEN}/user/credits`, async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    return {
      balance: pointsLib.balance(req.session.user_id),
      signedInToday: pointsLib.signedInToday(req.session.user_id),
      signinGain: Math.trunc(Number(db.prepare("SELECT value FROM settings WHERE key='user_points_signin'").get()?.value || 10)),
      serverTime: now(),
      timezone: 'Asia/Shanghai',
    };
  });

  /** 已购归账号：换机/重装后仍能看到并免费重下（2026-11-13 用户拍板）。 */
  app.get(`${OPEN}/market/owned`, async (req, reply) => {
    if (!(await requireClient(req, reply))) return;
    const ids = market.ownedIds(req.session.user_id);
    return { templateIds: ids, count: ids.length };
  });

  /* ---------------- 写接口（Bearer + x-nonce） ---------------- */

  /** 每日签到：北京时间 00:00 日切，一天一次；重复调用返回 already:true 而非报错。 */
  app.post(`${OPEN}/user/signin`, async (req, reply) => {
    if (!(await requireClientWrite(req, reply))) return;
    touchSession(req.session, clientIp(req));
    const r = pointsLib.signin(req.session.user_id);
    return {
      ok: true, already: r.already, gain: r.gain, balance: r.balance,
      date: r.date, signedInToday: true, serverTime: now(),
    };
  });

  /**
   * 兑换：单事务原子扣分，已购直接重签短链不扣分。
   * machine_code 与 /license/ticket 同口径；与会话机器码不一致直接 403。
   * 离线期间不允许放行兑换 —— 服务端能被调用就说明在线，本地缓存不得用于本地解锁。
   */
  app.post(`${OPEN}/market/redeem`, async (req, reply) => {
    if (!(await requireClientWrite(req, reply))) return;
    touchSession(req.session, clientIp(req));
    const b = req.body || {};
    const machineCode = String(b.machine_code || b.machine_id || '').trim();
    if (!machineCode) return fail(reply, 400, 'MACHINE_REQUIRED', '缺少 machine_code');
    if (req.session.machine_id && machineCode !== req.session.machine_id) {
      return fail(reply, 403, 'MACHINE_MISMATCH', '机器码与会话不一致，请重新激活');
    }
    if (!String(b.template_id || '').trim()) return fail(reply, 400, 'TEMPLATE_REQUIRED', '缺少 template_id');
    // 同机器短时间高频兑换 → 熔断 + 留一条审计告警（不是只靠客户端自觉）
    if (!rateHit(`market:redeem:${machineCode.slice(0, 64)}`, 20, 60000)) {
      try {
        db.prepare('INSERT INTO admin_logs (admin_id, admin_name, action, detail, created_at) VALUES (?,?,?,?,?)')
          .run(0, 'system', '模板兑换限流', `machine=${machineCode.slice(0, 64)} user=${req.session.user_id}`, now());
      } catch { /* ignore */ }
      return fail(reply, 429, 'RATE_LIMITED', '兑换过于频繁，请稍后再试');
    }

    const r = market.redeem({ userId: req.session.user_id, machineCode, templateId: b.template_id });
    if (!r.ok) return fail(reply, r.status || 400, r.code, r.error, r.balance !== undefined ? { balance: r.balance } : {});
    const downloadUrl = publicUrl(req, `/api/open/v1/market/download?token=${encodeURIComponent(r.token)}`);
    return {
      ok: true, orderId: r.orderId, already: r.already, balance: r.balance,
      downloadUrl, fileSha256: r.fileSha256, fileSize: r.fileSize,
      name: r.name, version: r.version, price: r.price,
      expiresIn: r.expiresIn, expiresAt: r.expiresAt,
      serverTime: now(),
    };
  });

  /**
   * 已购丢弃（解除绑定）：客户端「我的已购 → 丢弃」按钮走这里。
   * 只删 market_purchases 的一行，不返还积分、不动本地文件；幂等。
   * machine_code 与 /license/ticket、/market/redeem 同口径。
   */
  app.post(`${OPEN}/market/owned/:templateId/discard`, async (req, reply) => {
    if (!(await requireClientWrite(req, reply))) return;
    touchSession(req.session, clientIp(req));
    const b = req.body || {};
    const machineCode = String(b.machine_code || b.machine_id || '').trim();
    if (!machineCode) return fail(reply, 400, 'MACHINE_REQUIRED', '缺少 machine_code');
    if (req.session.machine_id && machineCode !== req.session.machine_id) {
      return fail(reply, 403, 'MACHINE_MISMATCH', '机器码与会话不一致，请重新激活');
    }
    if (!rateHit(`market:discard:${req.session.user_id}`, 30, 60000)) {
      return fail(reply, 429, 'RATE_LIMITED', '操作过于频繁，请稍后再试');
    }
    const r = market.discardOwned({ userId: req.session.user_id, templateId: req.params.templateId });
    return { ok: true, discarded: r.discarded, serverTime: now() };
  });

  /* ---------------- 一次性下载 ---------------- */

  /**
   * 短链不依赖 Bearer / x-app-key：URL 自身有 HMAC 签名、5 分钟 TTL、绑定
   * template + user + machine，且 jti 只能消费一次。签到/兑换是「发货」，
   * 这一步是「提货」，必须能被下载器直接 GET。
   */
  app.get(`${OPEN}/market/download`, async (req, reply) => {
    const v = market.verifyLink(String((req.query || {}).token || ''));
    if (!v.ok) {
      const msg = {
        LINK_INVALID: '短链无效', LINK_EXPIRED: '短链已过期，请重新兑换',
        LINK_USED: '短链已被使用，请重新兑换', LINK_NOT_FOUND: '短链不存在',
      }[v.code] || '短链无效';
      return fail(reply, v.status, v.code, msg);
    }
    const tpl = db.prepare('SELECT * FROM market_templates WHERE id = ?').get(v.row.template_id);
    if (!tpl || tpl.status !== 'on') return fail(reply, 404, 'TEMPLATE_NOT_FOUND', '模板不存在或已下架');
    const abs = market.fileAbs(tpl);
    if (!abs || !fs.existsSync(abs)) return fail(reply, 409, 'TEMPLATE_FILE_MISSING', '模板文件暂不可用，请联系客服');
    // 先确认文件可读再抢占，别让一次失败把短链白白作废
    if (!market.consumeLink(v.row.jti)) return fail(reply, 410, 'LINK_USED', '短链已被使用，请重新兑换');
    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${tpl.id}.blls"`)
      .header('X-File-Sha256', tpl.file_sha256 || '')
      .header('X-File-Size', String(tpl.file_size || 0))
      .header('X-Template-Version', String(tpl.version || 1))
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff');
    return reply.send(fs.createReadStream(abs));
  });

  /* ---------------- API 上架（独立前缀 /api/market/v1） ---------------- */

  /**
   * 创建或幂等更新一个模板。带 fileBase64 时一步到位（建议 ≤ 10MB），
   * 大文件走下面的 /templates/:id/file 两步式上传。
   * auto_publish=0 的密钥建出来是 off（待审），运营在后台点上架才对外可见。
   */
  app.post(`${API}/templates`, async (req, reply) => {
    const key = await withKey(req, reply, 'publish', { write: true });
    if (!key) return;
    const b = req.body || {};
    req.apiExternalId = String(b.externalId || b.external_id || '').slice(0, 120);
    const r = market.publishTemplate({ key, body: b });
    if (!r.ok) return apiFail(req, reply, r.status || 400, r.code, r.error);
    req.apiTemplateId = r.item.id;
    return { ...r, serverTime: now() };
  });

  /** 按幂等键查上架状态；查不到返回 found:false（不是 404，脚本好写重试逻辑）。 */
  app.get(`${API}/templates`, async (req, reply) => {
    const key = await withKey(req, reply, 'query');
    if (!key) return;
    const externalId = String((req.query || {}).externalId || (req.query || {}).external_id || '').trim();
    req.apiExternalId = externalId.slice(0, 120);
    if (!externalId) return apiFail(req, reply, 400, 'EXTERNAL_ID_REQUIRED', '缺少 externalId');
    const item = market.apiTemplateByExternal(key, externalId);
    req.apiTemplateId = item ? item.id : '';
    return { found: !!item, item, serverTime: now() };
  });

  /**
   * 两步式上传大文件：multipart，字段名 file。
   * 可用 X-File-Sha256 声明哈希，服务端比对，不一致直接拒收且不覆盖旧文件。
   */
  app.post(`${API}/templates/:id/file`, async (req, reply) => {
    const key = await withKey(req, reply, 'upload', { write: true });
    if (!key) return;
    req.apiTemplateId = String(req.params.id || '');
    const data = await req.file();
    if (!data) return apiFail(req, reply, 400, 'FILE_REQUIRED', '未收到文件');
    let buf;
    try { buf = await data.toBuffer(); } catch (e) {
      return apiFail(req, reply, 400, 'FILE_READ_FAILED', '读取文件失败：' + e.message);
    }
    const r = market.apiReplaceFile({
      key, id: req.params.id, filename: data.filename, buffer: buf,
      declaredSha: req.headers['x-file-sha256'],
    });
    if (!r.ok) return apiFail(req, reply, r.status || 400, r.code, r.error);
    return { ok: true, item: r.item, serverTime: now() };
  });

  /**
   * 两步式上传缩略图：multipart，字段名 file。
   * 只收真实图片（魔数 + 扩展名一致）、≤2MB，落公开 uploads 目录，
   * 文件名由内容 sha256 生成，用户给的文件名绝不参与落盘路径。
   */
  app.post(`${API}/templates/:id/thumbnail`, async (req, reply) => {
    const key = await withKey(req, reply, 'upload_thumb', { write: true });
    if (!key) return;
    req.apiTemplateId = String(req.params.id || '');
    let data;
    try { data = await req.file(); }
    catch { return apiFail(req, reply, 400, 'FILE_REQUIRED', '缩略图必须用 multipart/form-data 上传，字段名 file'); }
    if (!data) return apiFail(req, reply, 400, 'FILE_REQUIRED', '未收到缩略图文件');
    let buf;
    try { buf = await data.toBuffer(); } catch (e) {
      if (/too large|filesize|limit/i.test(String(e.message || ''))) {
        return apiFail(req, reply, 400, 'THUMB_TOO_LARGE', '缩略图超过 2MB');
      }
      return apiFail(req, reply, 400, 'FILE_READ_FAILED', '读取缩略图失败：' + e.message);
    }
    const r = market.apiReplaceThumbnail({
      key, id: req.params.id, filename: data.filename, buffer: buf,
      declaredSha: req.headers['x-file-sha256'],
    });
    if (!r.ok) return apiFail(req, reply, r.status || 400, r.code, r.error);
    return { ok: true, ...r, serverTime: now() };
  });

  /* ---------------- 后台管理 ---------------- */

  /* 上架密钥：明文只在创建响应里出现一次，列表永远只回前缀。 */
  app.get(`${ADMIN}/api-keys`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { items: market.listApiKeys(), logs: market.recentApiLogs(50) };
  });

  app.post(`${ADMIN}/api-keys`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    const r = market.createApiKey({ name: b.name, autoPublish: b.autoPublish, createdBy: req.admin?.username });
    logAdmin(req, '模板市场·创建上架密钥', `${r.id} ${r.name} auto_publish=${r.autoPublish}`);
    return { ok: true, ...r, hint: '明文密钥仅本次返回，请立即保存；丢失只能重建' };
  });

  app.patch(`${ADMIN}/api-keys/:id`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const r = market.setApiKey(req.params.id, req.body || {});
    if (!r) return fail(reply, 404, 'NOT_FOUND', '密钥不存在');
    logAdmin(req, '模板市场·修改上架密钥', `${r.id} status=${r.status} auto_publish=${r.auto_publish}`);
    return { ok: true, item: market.listApiKeys().find((x) => x.id === r.id) };
  });

  app.delete(`${ADMIN}/api-keys/:id`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    if (!market.deleteApiKey(req.params.id)) return fail(reply, 404, 'NOT_FOUND', '密钥不存在');
    logAdmin(req, '模板市场·删除上架密钥', String(req.params.id));
    return { ok: true };
  });

  app.get(`${ADMIN}/templates`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { items: market.adminList(String((req.query || {}).q || '')), stats: market.stats() };
  });

  app.get(`${ADMIN}/purchases`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { items: market.recentPurchases((req.query || {}).limit) };
  });

  app.get(`${ADMIN}/options`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const o = market.options();
    return { industries: o.industries, paperTypes: o.paper_types, sizePresets: o.size_presets, dpis: o.dpis };
  });

  app.post(`${ADMIN}/options`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const r = market.saveOptions(req.body || {});
    logAdmin(req, '模板市场·保存枚举字典', JSON.stringify(r));
    return { ok: true, ...r };
  });

  app.post(`${ADMIN}/templates`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const r = market.createTemplate(req.body || {});
    if (r.error) return fail(reply, 400, r.code, r.error);
    logAdmin(req, '模板市场·新增模板', `${r.row.id} ${r.row.name}`);
    return { ok: true, item: market.adminTemplate(r.row) };
  });

  app.patch(`${ADMIN}/templates/:id`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const r = market.updateTemplate(req.params.id, req.body || {});
    if (r.error) return fail(reply, 400, r.code, r.error);
    logAdmin(req, '模板市场·编辑模板', `${r.row.id} ${r.row.name}`);
    return { ok: true, item: market.adminTemplate(r.row) };
  });

  app.delete(`${ADMIN}/templates/:id`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const r = market.deleteTemplate(req.params.id);
    if (r.error) return fail(reply, r.code === 'TEMPLATE_HAS_PURCHASES' ? 409 : 404, r.code, r.error);
    logAdmin(req, '模板市场·删除模板', String(req.params.id));
    return { ok: true };
  });

  /** .blls 上传：落私有目录，只存不解析（AES-256-GCM 文件由客户端自行导入）。 */
  app.post(`${ADMIN}/templates/:id/file`, async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const data = await req.file();
    if (!data) return fail(reply, 400, 'FILE_REQUIRED', '未收到文件');
    let buf;
    try { buf = await data.toBuffer(); } catch (e) { return fail(reply, 400, 'FILE_READ_FAILED', '读取文件失败：' + e.message); }
    const r = market.replaceFile(req.params.id, data.filename, buf);
    if (r.error) return fail(reply, 400, r.code, r.error);
    logAdmin(req, '模板市场·上传模板文件', `${req.params.id} sha256=${r.fileSha256} size=${r.fileSize}`);
    return { ok: true, ...r };
  });
};

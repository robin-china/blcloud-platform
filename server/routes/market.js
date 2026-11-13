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
  touchSession, rateHit,
} = require('../lib/openauth');
const market = require('../lib/market');
const pointsLib = require('../lib/points');

const OPEN = '/api/open/v1';
const ADMIN = '/api/market';

function clientIp(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
}

function fail(reply, status, code, error, extra = {}) {
  return reply.code(status).send({ error, code, ...extra });
}

module.exports = async function marketRoutes(app) {
  /* 与 open.js 同口径的鉴权模式流水；Fastify 插件作用域独立，两边不会重复记同一请求。 */
  app.addHook('onResponse', async (req, reply) => {
    if (!req.authMode || !String(req.url || '').includes('/api/open/v1/')) return;
    try {
      db.prepare(`INSERT INTO open_auth_log (path, method, auth_mode, app_key, ip, status, created_at)
        VALUES (?,?,?,?,?,?,?)`).run(
        String(req.url || '').split('?')[0].slice(0, 120), String(req.method || '').slice(0, 8),
        String(req.authMode), String((req.app && req.app.app_key) || req.headers['x-app-key'] || '').slice(0, 64),
        String(req.ip || '').slice(0, 64), Number(reply.statusCode) || 0, now()
      );
    } catch { /* 日志失败不影响响应 */ }
  });

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

  /* ---------------- 后台管理 ---------------- */

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
    return { industries: o.industries, paperTypes: o.paper_types, sizePresets: o.size_presets };
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

const crypto = require('crypto');
const db = require('../db');
const { now, genLicenseKey } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');
const { logAdmin } = require('../lib/adminlog');
const bindSvc = require('../lib/licensebind');
const plans = require('../lib/plans');

function addDays(days) {
  const d = new Date(Date.now() + Number(days) * 86400000);
  return d.toISOString();
}

/**
 * 按档位发码：档位一旦选定，类型/天数/设备数/app_id 全部取档位配置，
 * 手填项被忽略 —— 保证后台手工发的码和支付发货的码权益一致。
 * 返回 null 表示没选档位（传统授权走手填字段）。
 */
function resolvePlan(b, productId, reply) {
  if (b.plan_id === undefined || b.plan_id === null || b.plan_id === '') return null;
  const plan = plans.get(Number(b.plan_id) || 0);
  if (!plan || plan.status !== 'on') { reply.code(400).send({ error: '所选档位不存在或已停用' }); return false; }
  if (!plan.app_id) { reply.code(400).send({ error: '该档位是通用模板，未绑定软件产品，不能直接发码' }); return false; }
  const app = db.prepare('SELECT id, product_id, name FROM open_apps WHERE id = ?').get(plan.app_id);
  if (!app) { reply.code(400).send({ error: '档位对应的软件产品不存在' }); return false; }
  if (app.product_id && Number(app.product_id) !== Number(productId)) {
    reply.code(400).send({ error: `档位「${plan.name}」属于其他产品，请先切换产品` });
    return false;
  }
  return {
    plan,
    app_id: plan.app_id,
    type: plan.billing === 'period' ? 'subscription' : 'permanent',
    days: plan.billing === 'period' ? Number(plan.period_days) || 365 : 0,
    max_devices: Number(plan.max_devices) || 1,
  };
}

function genBatchNo() {
  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  return `B${day}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

/**
 * 卡密池里的码必须能「先印后卖」：
 *   user_id = 0、status = 'unassigned'、end_at = NULL
 * 有效期从绑定那一刻起算（duration_days 记住时长）。
 */
function isPool(lic) {
  return lic.status === 'unassigned' || !lic.user_id;
}

function listWhere(query) {
  const q = String(query.q || '').trim();
  const status = String(query.status || '').trim();
  const batchNo = String(query.batch_no || '').trim();
  const productId = Number(query.product_id) || 0;
  const where = [];
  const args = [];
  if (q) {
    where.push('(l.license_key LIKE ? OR u.nickname LIKE ? OR u.phone LIKE ? OR p.name LIKE ? OR l.channel LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (status === 'unassigned') where.push("l.status = 'unassigned'");
  else if (status === 'bound') where.push("l.status <> 'unassigned' AND l.user_id > 0");
  else if (status) { where.push('l.status = ?'); args.push(status); }
  if (batchNo) { where.push('l.batch_no = ?'); args.push(batchNo); }
  if (productId) { where.push('l.product_id = ?'); args.push(productId); }
  return { wsql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

const SELECT_LIST = `SELECT l.*, u.nickname, u.phone, p.name AS product_name, p.type AS product_type,
  pl.name AS plan_name,
  (SELECT COUNT(*) FROM license_devices d WHERE d.license_id = l.id) AS bound_devices
  FROM licenses l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN products p ON p.id = l.product_id
  LEFT JOIN plans pl ON pl.id = l.plan_id`;

function csvCell(v) {
  const s = v == null ? '' : String(v);
  // 授权码/备注可能带逗号、引号，甚至以 = + - @ 开头（Excel 会当公式执行）
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

module.exports = async function licenseRoutes(app) {
  app.get('/api/licenses', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
    const { wsql, args } = listWhere(req.query);
    const total = db.prepare(`SELECT COUNT(*) AS c FROM licenses l LEFT JOIN users u ON u.id=l.user_id LEFT JOIN products p ON p.id=l.product_id ${wsql}`).get(...args).c;
    const list = db.prepare(`${SELECT_LIST} ${wsql} ORDER BY l.id DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (page - 1) * pageSize);
    const stats = db.prepare(`SELECT
      SUM(CASE WHEN status <> 'unassigned' AND user_id > 0 THEN 1 ELSE 0 END) AS bound,
      SUM(CASE WHEN status = 'unassigned' THEN 1 ELSE 0 END) AS unassigned,
      SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) AS revoked
      FROM licenses`).get();
    return { total, page, pageSize, list, stats };
  });

  /* ---------------- 发码（单发 / 批量 / 卡密池） ---------------- */

  app.post('/api/licenses', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    const userId = Number(b.user_id);
    const productId = Number(b.product_id);
    if (!productId) return reply.code(400).send({ error: '产品必填' });
    const product = db.prepare('SELECT id, name, type FROM products WHERE id = ?').get(productId);
    if (!product) return reply.code(404).send({ error: '产品不存在' });
    // 服务类（API 额度包）发的是调用次数，不是授权码；发错了用户端会多出一条永远用不上的授权
    if (product.type === 'service') {
      return reply.code(400).send({ error: `「${product.name}」是服务类商品，应发放 API 额度而不是授权码` });
    }
    const type = b.type || 'permanent';
    const days = Number(b.days) || 365;
    const planRes = resolvePlan(b, productId, reply);
    if (planRes === false) return;
    const effType = planRes ? planRes.type : type;
    const effDays = planRes ? planRes.days : days;
    const effDevices = planRes ? planRes.max_devices : (Number(b.max_devices) || 1);
    const key = b.license_key || genLicenseKey();
    if (db.prepare('SELECT 1 FROM licenses WHERE license_key = ?').get(key)) {
      return reply.code(400).send({ error: '该授权码已存在，请换一个' });
    }
    const pool = !userId;
    const ts = now();
    const info = db.prepare(`INSERT INTO licenses
      (license_key, user_id, product_id, type, max_devices, start_at, end_at, status, order_id, remark,
       batch_no, channel, bound_at, bound_by, duration_days, created_at, plan_id, plan_code, app_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(key, pool ? 0 : userId, productId, effType, effDevices, ts,
        pool ? null : (effType === 'permanent' ? null : addDays(effDays)),
        pool ? 'unassigned' : 'active', Number(b.order_id) || null, b.remark || '',
        '', b.channel || '', pool ? '' : ts, pool ? '' : 'admin', effType === 'permanent' ? 0 : effDays, ts,
        planRes ? planRes.plan.id : null, planRes ? planRes.plan.code : null, planRes ? planRes.app_id : null);
    logAdmin(req, pool ? '生成卡密' : '发放授权',
      `${product.name}${planRes ? ` / 档位 ${planRes.plan.name}` : ''} → ${pool ? '卡密池（未分配）' : `用户#${userId}`}，码 ${key}`);
    return { id: info.lastInsertRowid, license_key: key, status: pool ? 'unassigned' : 'active' };
  });

  /**
   * 批量发码：渠道 / 线下客户 / OEM 一次要几十上百个码，一条条点不现实。
   * 不传 user_id 就是卡密池 —— 印出去、卖掉之后由用户自己绑。
   */
  app.post('/api/licenses/batch', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    const userId = Number(b.user_id) || 0;
    const productId = Number(b.product_id);
    if (!productId) return reply.code(400).send({ error: '产品必填' });
    const product = db.prepare('SELECT id, name, type FROM products WHERE id = ?').get(productId);
    if (!product) return reply.code(404).send({ error: '产品不存在' });
    if (product.type === 'service') {
      return reply.code(400).send({ error: `「${product.name}」是服务类商品，应发放 API 额度而不是授权码` });
    }
    if (userId) {
      const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
      if (!user) return reply.code(404).send({ error: '用户不存在' });
    }
    const count = Math.min(Math.max(Number(b.count) || 1, 1), 200);
    const type = b.type || 'permanent';
    const days = Number(b.days) || 365;
    const maxDevices = Math.max(Number(b.max_devices) || 1, 1);
    const planRes = resolvePlan(b, productId, reply);
    if (planRes === false) return;
    const effType = planRes ? planRes.type : type;
    const effDays = planRes ? planRes.days : days;
    const effDevices = planRes ? planRes.max_devices : maxDevices;
    const remark = String(b.remark || (userId ? '批量发放' : '卡密池'));
    const channel = String(b.channel || '');
    const batchNo = genBatchNo();
    const pool = !userId;
    const ts = now();
    const endAt = pool ? null : (effType === 'permanent' ? null : addDays(effDays));

    const insert = db.prepare(`INSERT INTO licenses
      (license_key, user_id, product_id, type, max_devices, start_at, end_at, status, order_id, remark,
       batch_no, channel, bound_at, bound_by, duration_days, created_at, plan_id, plan_code, app_id)
      VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?)`);
    const exists = db.prepare('SELECT 1 FROM licenses WHERE license_key = ?');
    const keys = [];
    const run = db.transaction(() => {
      for (let i = 0; i < count; i += 1) {
        let key = genLicenseKey();
        for (let t = 0; t < 5 && exists.get(key); t += 1) key = genLicenseKey();
        insert.run(key, userId, productId, effType, effDevices, ts, endAt, pool ? 'unassigned' : 'active',
          remark, batchNo, channel, pool ? '' : ts, pool ? '' : 'admin',
          effType === 'permanent' ? 0 : effDays, ts,
          planRes ? planRes.plan.id : null, planRes ? planRes.plan.code : null, planRes ? planRes.app_id : null);
        keys.push(key);
      }
    });
    run();
    logAdmin(req, '批量发放授权',
      `${product.name}${planRes ? ` / 档位 ${planRes.plan.name}` : ''} → ${pool ? '卡密池' : `用户#${userId}`}，批次 ${batchNo}，共 ${keys.length} 个（${keys[0]} … ${keys[keys.length - 1]}）`);
    return {
      ok: true, count: keys.length, license_keys: keys, product: product.name,
      batch_no: batchNo, channel, mode: pool ? 'pool' : 'assigned',
    };
  });

  /** 批次列表：印了几批卡、每批卖了/绑了几个、还剩多少 */
  app.get('/api/licenses/batches', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const list = db.prepare(`SELECT l.batch_no, l.channel, l.product_id, p.name AS product_name,
      COUNT(*) AS total,
      SUM(CASE WHEN l.status = 'unassigned' THEN 1 ELSE 0 END) AS unassigned,
      SUM(CASE WHEN l.status <> 'unassigned' THEN 1 ELSE 0 END) AS bound,
      SUM(CASE WHEN l.status = 'revoked' THEN 1 ELSE 0 END) AS revoked,
      MIN(l.created_at) AS created_at
      FROM licenses l LEFT JOIN products p ON p.id = l.product_id
      WHERE l.batch_no <> '' GROUP BY l.batch_no ORDER BY MIN(l.id) DESC LIMIT 200`).all();
    return { list };
  });

  /** 某批次里的码清单（用于把没领走的码再复制/再导出一次，不必翻列表） */
  app.get('/api/licenses/batches/:batchNo/keys', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const batchNo = String(req.params.batchNo || '');
    const onlyUnbound = String(req.query.unbound || '') === '1';
    const list = db.prepare(`SELECT license_key, status, user_id FROM licenses
      WHERE batch_no = ? ${onlyUnbound ? "AND status = 'unassigned'" : ''} ORDER BY id ASC`).all(batchNo);
    const batchInfo = db.prepare(`SELECT l.batch_no, l.channel, l.created_at, p.name AS product_name
      FROM licenses l LEFT JOIN products p ON p.id = l.product_id WHERE l.batch_no = ? LIMIT 1`).get(batchNo);
    return { list, batch: batchInfo || null };
  });

  /** 作废整批里没被领走的卡（渠道退货 / 印错了） */
  app.post('/api/licenses/batches/:batchNo/revoke', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const batchNo = String(req.params.batchNo || '');
    const info = db.prepare("UPDATE licenses SET status = 'revoked' WHERE batch_no = ? AND status = 'unassigned'").run(batchNo);
    logAdmin(req, '作废卡密批次', `${batchNo}，作废未领取 ${info.changes} 个`);
    return { ok: true, revoked: info.changes };
  });

  /** 管理员把某张卡绑到某个用户（客户线下打电话报码的场景） */
  app.post('/api/licenses/:id/bind', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const userId = Number((req.body || {}).user_id);
    if (!userId) return reply.code(400).send({ error: '请选择用户' });
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return reply.code(404).send({ error: '用户不存在' });
    const lic = db.prepare('SELECT * FROM licenses WHERE id = ?').get(Number(req.params.id));
    const res = bindSvc.bind(lic, userId, 'admin');
    if (!res.ok) return reply.code(400).send({ error: res.reason, code: res.code });
    logAdmin(req, '绑定卡密', `${lic.license_key} → 用户#${userId}`);
    return { ok: true, license_key: lic.license_key, already: !!res.already };
  });

  /**
   * 导出对账：渠道结算靠这个。默认导出当前筛选条件下的全部记录，
   * 带 BOM，Excel 直接双击打开不乱码。
   */
  app.get('/api/licenses/export.csv', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const { wsql, args } = listWhere(req.query);
    const rows = db.prepare(`${SELECT_LIST} ${wsql} ORDER BY l.id DESC LIMIT 50000`).all(...args);
    const head = ['授权码', '批次', '渠道', '产品', '档位', '类型', '账号', '手机号', '设备上限', '已绑设备',
      '开始时间', '到期时间', '状态', '绑定时间', '绑定方式', '备注'];
    const statusText = (l) => (l.status === 'unassigned' ? '未绑定' : l.status === 'revoked' ? '已作废'
      : l.status === 'active' ? '有效' : l.status);
    const typeText = (t) => ({ permanent: '永久', subscription: '订阅', trial: '试用' }[t] || t);
    const lines = [head.map(csvCell).join(',')];
    for (const l of rows) {
      lines.push([
        l.license_key, l.batch_no, l.channel, l.product_name, l.plan_name || '', typeText(l.type),
        l.nickname || '', l.phone || '', l.max_devices, l.bound_devices,
        l.start_at ? String(l.start_at).slice(0, 19).replace('T', ' ') : '',
        l.end_at ? String(l.end_at).slice(0, 19).replace('T', ' ') : '永久',
        statusText(l),
        l.bound_at ? String(l.bound_at).slice(0, 19).replace('T', ' ') : '',
        l.bound_by === 'self' ? '用户自助' : l.bound_by === 'admin' ? '后台绑定' : '',
        l.remark || '',
      ].map(csvCell).join(','));
    }
    const csv = `\uFEFF${lines.join('\r\n')}\r\n`;
    const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
    logAdmin(req, '导出授权清单', `${rows.length} 条`);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="licenses-${stamp}.csv"`)
      .send(csv);
  });

  /* ---------------- 单张操作 ---------------- */

  app.post('/api/licenses/:id/revoke', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    db.prepare('UPDATE licenses SET status = ? WHERE id = ?').run('revoked', Number(req.params.id));
    // 吊销即刻生效：把这张授权下的客户端会话一起作废，别等对方下次心跳
    db.prepare('UPDATE client_sessions SET status = ? WHERE license_id = ?').run('revoked', Number(req.params.id));
    logAdmin(req, '吊销授权', `#${req.params.id}`);
    return { ok: true };
  });

  app.post('/api/licenses/:id/resume', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const lic = db.prepare('SELECT * FROM licenses WHERE id = ?').get(Number(req.params.id));
    if (!lic) return reply.code(404).send({ error: '授权不存在' });
    // 回到正确的状态：没绑人的码恢复成「未绑定」，别让它变成一张谁都用不了的死卡
    const status = isPool(lic) ? 'unassigned' : 'active';
    db.prepare('UPDATE licenses SET status = ? WHERE id = ?').run(status, lic.id);
    logAdmin(req, '恢复授权', `#${lic.id}`);
    return { ok: true, status };
  });

  app.post('/api/licenses/:id/extend', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const days = Number((req.body || {}).days || 30);
    const lic = db.prepare('SELECT * FROM licenses WHERE id = ?').get(Number(req.params.id));
    if (!lic) return reply.code(404).send({ error: '授权不存在' });
    if (isPool(lic)) {
      // 未分配的卡没有「到期时间」可续，直接加时长即可
      db.prepare('UPDATE licenses SET duration_days = IFNULL(duration_days, 0) + ? WHERE id = ?').run(days, lic.id);
      logAdmin(req, '卡密延长时长', `${lic.license_key} +${days} 天（绑定后生效）`);
      return { ok: true, duration_days: Number(lic.duration_days || 0) + days };
    }
    const base = lic.end_at && new Date(lic.end_at).getTime() > Date.now() ? new Date(lic.end_at) : new Date();
    db.prepare('UPDATE licenses SET end_at = ?, status = ? WHERE id = ?')
      .run(new Date(base.getTime() + days * 86400000).toISOString(), 'active', lic.id);
    logAdmin(req, '授权续期', `${lic.license_key} +${days} 天`);
    return { ok: true };
  });

  app.delete('/api/licenses/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const lic = db.prepare('SELECT license_key FROM licenses WHERE id = ?').get(Number(req.params.id));
    db.prepare('DELETE FROM licenses WHERE id = ?').run(Number(req.params.id));
    db.prepare('DELETE FROM license_devices WHERE license_id = ?').run(Number(req.params.id));
    // 删除授权也必须作废客户端会话（同吊销/解绑/退款的约定），
    // 否则机器上拿着老 token 还能继续白嫖到自然过期
    db.prepare('UPDATE client_sessions SET status = ? WHERE license_id = ?')
      .run('revoked', Number(req.params.id));
    logAdmin(req, '删除授权', lic ? lic.license_key : `#${req.params.id}`);
    return { ok: true };
  });

  app.get('/api/licenses/:id/devices', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { list: db.prepare('SELECT * FROM license_devices WHERE license_id = ? ORDER BY id DESC').all(Number(req.params.id)) };
  });

  app.delete('/api/license-devices/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const d = db.prepare('SELECT * FROM license_devices WHERE id = ?').get(Number(req.params.id));
    if (!d) return reply.code(404).send({ error: '绑定记录不存在' });
    db.prepare('DELETE FROM license_devices WHERE id = ?').run(d.id);
    // 解绑必须连带踢会话：否则这台机器拿着老 token 还能继续调接口
    db.prepare('UPDATE client_sessions SET status = ? WHERE license_id = ? AND machine_id = ?')
      .run('revoked', d.license_id, d.device_sn);
    logAdmin(req, '解绑授权设备', `授权#${d.license_id} 机器 ${d.device_sn}`);
    return { ok: true };
  });
};

module.exports.addDays = addDays;
module.exports.isPool = isPool;

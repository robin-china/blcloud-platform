const db = require('../db');
const { now, safeJson } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');
const { logAdmin } = require('../lib/adminlog');

const FIELDS = `type, name, subtitle, description, category, price, original_price, icon, images,
  features, version, download_url, file_size, stock, is_official, status, sort`;
// quota = 额度包商品发放的调用次数；compare_url = 版本差异内容地址（详情内嵌 + 空间卡片共用）
// sku = 权益维度（在线版 / 离线版），与升级通道（app_release.product）分开
// （均由 db/index.js 的 ensureColumn 保证旧库也有这些列）
const FIELDS_WITH_EXTRA = `${FIELDS}, quota, compare_url, sku`;

function shape(row) {
  if (!row) return row;
  return { ...row, images: safeJson(row.images, []), features: safeJson(row.features, []) };
}

/**
 * 版本差异内容地址消毒：只放行站内相对路径与 http(s) 绝对地址。
 * javascript: / data: 这类伪协议一律清空 —— 这个值最终会进 iframe 的 src。
 */
function sanitizeCompareUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s) return '';
  if (/^(javascript|data|vbscript|file):/i.test(s)) return '';
  return s;
}

module.exports = async function productRoutes(app) {
  app.get('/api/products', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const q = String(req.query.q || '').trim();
    const type = String(req.query.type || '').trim();
    const status = String(req.query.status || '').trim();
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
    const where = [];
    const args = [];
    if (q) { where.push('(name LIKE ? OR subtitle LIKE ? OR category LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (type) { where.push('type = ?'); args.push(type); }
    if (status) { where.push('status = ?'); args.push(status); }
    const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM products ${wsql}`).get(...args).c;
    const list = db.prepare(`SELECT * FROM products ${wsql} ORDER BY sort DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (page - 1) * pageSize);
    return { total, page, pageSize, list: list.map(shape) };
  });

  app.get('/api/products/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
    if (!p) return reply.code(404).send({ error: '产品不存在' });
    return { product: shape(p) };
  });

  app.post('/api/products', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    const ts = now();
    const info = db.prepare(`INSERT INTO products (${FIELDS_WITH_EXTRA}, total_downloads, total_installs, active_users, total_sales, created_at, updated_at)
      VALUES (@type,@name,@subtitle,@description,@category,@price,@original_price,@icon,@images,@features,@version,@download_url,@file_size,@stock,@is_official,@status,@sort,@quota,@compare_url,@sku,0,0,0,0,@ts,@ts)`)
      .run({
        type: b.type || 'software', name: b.name || '未命名产品', subtitle: b.subtitle || '',
        description: b.description || '', category: b.category || '', price: Number(b.price) || 0,
        original_price: Number(b.original_price) || 0, icon: b.icon || '', quota: Number(b.quota) || 0,
        images: JSON.stringify(b.images || []), features: JSON.stringify(b.features || []),
        version: b.version || '1.0.0', download_url: b.download_url || '', file_size: b.file_size || '',
        stock: Number(b.stock) || 0, is_official: b.is_official == null ? 1 : Number(b.is_official),
        status: b.status || 'off', sort: Number(b.sort) || 0,
        // 版本差异内容地址：站内相对路径（assets/compare/xxx.html）或 https 外链；非法伪协议直接丢弃
        compare_url: sanitizeCompareUrl(b.compare_url),
        sku: String(b.sku || '').trim().slice(0, 40), ts,
      });
    return { id: info.lastInsertRowid };
  });

  app.post('/api/products/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = Number(req.params.id);
    const b = req.body || {};
    const cur = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!cur) return reply.code(404).send({ error: '产品不存在' });
    const next = { ...cur, ...b };
    db.prepare(`UPDATE products SET type=@type, name=@name, subtitle=@subtitle, description=@description,
      category=@category, price=@price, original_price=@original_price, icon=@icon, images=@images,
      features=@features, version=@version, download_url=@download_url, file_size=@file_size,
      stock=@stock, is_official=@is_official, status=@status, sort=@sort, quota=@quota,
      compare_url=@compare_url, sku=@sku, updated_at=@ts WHERE id=@id`)
      .run({
        id, type: next.type, name: next.name, subtitle: next.subtitle || '', description: next.description || '',
        category: next.category || '', price: Number(next.price) || 0, original_price: Number(next.original_price) || 0,
        icon: next.icon || '', quota: Number(next.quota) || 0, images: JSON.stringify(b.images || safeJson(next.images, [])),
        features: JSON.stringify(b.features || safeJson(next.features, [])), version: next.version || '1.0.0',
        download_url: next.download_url || '', file_size: next.file_size || '', stock: Number(next.stock) || 0,
        is_official: Number(next.is_official), status: next.status || 'off', sort: Number(next.sort) || 0,
        compare_url: sanitizeCompareUrl(next.compare_url), ts: now(),
        sku: String(next.sku || '').trim().slice(0, 40),
      });
    return { ok: true };
  });

  /**
   * 删除商品。
   *
   * 以前是无条件 DELETE，但只要有已售授权 / 软件应用绑定，直接删就会留下指向不存在商品的
   * 授权与开放应用（用户端「我的授权」里商品名空白、软件端激活对不上）。管理员那边看到的是
   * 「点了删除没反应」，其实是前端把 409 静默吞了。
   *
   * 现在分两段：默认只做检查并说明原因；带 `?force=1` 才真正强删，且会同时作废该商品下的
   * 未作废授权、解绑开放应用与档位引用。前端在收到 409 后弹二次确认再带 force 重试。
   */
  app.delete('/api/products/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = Number(req.params.id);
    const product = db.prepare('SELECT id, name FROM products WHERE id = ?').get(id);
    if (!product) return { ok: true, already: true }; // 幂等：重复点删除不报错
    const force = String(req.query.force || '') === '1';

    const licCount = db.prepare("SELECT COUNT(*) AS c FROM licenses WHERE product_id = ? AND status <> 'revoked'").get(id).c;
    const openApp = db.prepare('SELECT id, name FROM open_apps WHERE product_id = ? LIMIT 1').get(id);
    // 档位不直接挂商品：plans.app_id → open_apps.product_id → products.id
    const planCount = db.prepare(`SELECT COUNT(*) AS c FROM plans pl
      JOIN open_apps a ON a.id = pl.app_id WHERE a.product_id = ?`).get(id).c;

    if (!force && (licCount || openApp)) {
      const reasons = [];
      if (licCount) reasons.push(`${licCount} 张未作废授权`);
      if (openApp) reasons.push(`软件应用「${openApp.name}」正在绑定`);
      return reply.code(409).send({
        error: `「${product.name}」还有 ${reasons.join('、')}，不能直接删除。`,
        code: 'PRODUCT_IN_USE',
        blockers: {
          licenses: licCount,
          open_app: openApp ? { id: openApp.id, name: openApp.name } : null,
          plans: planCount,
        },
        hint: '可以「下架」停售（不影响已售授权与历史订单）；确认要删就强制删除，会一并作废这些授权并解除绑定。',
      });
    }

    const run = db.transaction(() => {
      const revoked = licCount
        ? db.prepare("UPDATE licenses SET status = 'revoked', remark = ? WHERE product_id = ? AND status <> 'revoked'")
          .run(`商品「${product.name}」已删除，授权随之作废`, id).changes
        : 0;
      // 吊销授权必须同时作废客户端会话，否则名额释放了、旧令牌还能继续用（单张
      // revoke / 解绑 / 退款都同步踢会话，这里以前漏了）
      if (revoked) {
        db.prepare(`UPDATE client_sessions SET status = 'revoked'
          WHERE status = 'active' AND license_id IN
          (SELECT id FROM licenses WHERE product_id = ?)`).run(id);
      }
      // 档位与开放应用是配置：解除引用即可，不跟着删（档位还可能被历史授权引用）
      const detachedApps = db.prepare('UPDATE open_apps SET product_id = NULL WHERE product_id = ?').run(id).changes;
      db.prepare('DELETE FROM product_versions WHERE product_id = ?').run(id);
      db.prepare('DELETE FROM products WHERE id = ?').run(id);
      return { revoked, detachedPlans: 0, detachedApps, plans: planCount };
    });
    const res = run();
    logAdmin(req, '删除商品', `${product.name}（#${id}）${force ? '强制' : ''}删除` +
      `${res.revoked ? `，作废授权 ${res.revoked} 张` : ''}${res.detachedApps ? `，解绑应用 ${res.detachedApps} 个` : ''}`);
    return { ok: true, ...res };
  });

  app.get('/api/products/:id/versions', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return { list: db.prepare('SELECT * FROM product_versions WHERE product_id = ? ORDER BY id DESC').all(Number(req.params.id)) };
  });

  app.post('/api/products/:id/versions', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    const info = db.prepare(`INSERT INTO product_versions (product_id, version, changelog, download_url, file_size, downloads, released_at)
      VALUES (?,?,?,?,?,0,?)`).run(Number(req.params.id), b.version || '1.0.0', b.changelog || '', b.download_url || '', b.file_size || '', now());
    if (b.version) db.prepare('UPDATE products SET version = ?, updated_at = ? WHERE id = ?').run(b.version, now(), Number(req.params.id));
    return { id: info.lastInsertRowid };
  });

  app.delete('/api/product-versions/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    db.prepare('DELETE FROM product_versions WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });
};

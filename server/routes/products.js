const db = require('../db');
const { now, safeJson } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');

const FIELDS = `type, name, subtitle, description, category, price, original_price, icon, images,
  features, version, download_url, file_size, stock, is_official, status, sort`;

function shape(row) {
  if (!row) return row;
  return { ...row, images: safeJson(row.images, []), features: safeJson(row.features, []) };
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
    const info = db.prepare(`INSERT INTO products (${FIELDS}, total_downloads, total_installs, active_users, total_sales, created_at, updated_at)
      VALUES (@type,@name,@subtitle,@description,@category,@price,@original_price,@icon,@images,@features,@version,@download_url,@file_size,@stock,@is_official,@status,@sort,0,0,0,0,@ts,@ts)`)
      .run({
        type: b.type || 'software', name: b.name || '未命名产品', subtitle: b.subtitle || '',
        description: b.description || '', category: b.category || '', price: Number(b.price) || 0,
        original_price: Number(b.original_price) || 0, icon: b.icon || '',
        images: JSON.stringify(b.images || []), features: JSON.stringify(b.features || []),
        version: b.version || '1.0.0', download_url: b.download_url || '', file_size: b.file_size || '',
        stock: Number(b.stock) || 0, is_official: b.is_official == null ? 1 : Number(b.is_official),
        status: b.status || 'off', sort: Number(b.sort) || 0, ts,
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
      stock=@stock, is_official=@is_official, status=@status, sort=@sort, updated_at=@ts WHERE id=@id`)
      .run({
        id, type: next.type, name: next.name, subtitle: next.subtitle || '', description: next.description || '',
        category: next.category || '', price: Number(next.price) || 0, original_price: Number(next.original_price) || 0,
        icon: next.icon || '', images: JSON.stringify(b.images || safeJson(next.images, [])),
        features: JSON.stringify(b.features || safeJson(next.features, [])), version: next.version || '1.0.0',
        download_url: next.download_url || '', file_size: next.file_size || '', stock: Number(next.stock) || 0,
        is_official: Number(next.is_official), status: next.status || 'off', sort: Number(next.sort) || 0, ts: now(),
      });
    return { ok: true };
  });

  app.delete('/api/products/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    db.prepare('DELETE FROM products WHERE id = ?').run(Number(req.params.id));
    db.prepare('DELETE FROM product_versions WHERE product_id = ?').run(Number(req.params.id));
    return { ok: true };
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

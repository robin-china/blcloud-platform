const fs = require('fs');
const path = require('path');
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const multipart = require('@fastify/multipart');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
const { basePath } = require('./lib/config');

function build() {
  // 子路径部署：BASE_PATH=platform → /platform/admin/、/platform/api/...
  const BASE = basePath();
  // TRUST_PROXY=1 时才信任 X-Forwarded-For（Nginx/CDN 反代场景），默认关闭避免伪造来源 IP
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: 20 * 1024 * 1024,
    trustProxy: process.env.TRUST_PROXY === '1',
  });

  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  app.register(fastifyStatic, { root: UPLOAD_DIR, prefix: `${BASE}/uploads/`, decorateReply: false });
  app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: `${BASE}/`,
    decorateReply: false,
    setHeaders(res, filePath) {
      // 前端资源禁用强缓存，避免更新后浏览器仍使用旧版本脚本
      if (filePath.endsWith('.html') || /[\\/]$/.test(filePath)) res.header('Cache-Control', 'no-store');
      else res.header('Cache-Control', 'no-cache, max-age=0');
    },
  });

  app.get(`${BASE}/api/health`, async () => ({ ok: true, time: new Date().toISOString() }));

  // 所有业务路由统一挂到 BASE 前缀下
  const opts = BASE ? { prefix: BASE } : {};
  for (const name of ['admin', 'products', 'users', 'licenses', 'orders', 'stats',
    'pay', 'wechat', 'portal', 'open', 'openapps', 'blcloud', 'blcloud-admin']) {
    app.register(require(`./routes/${name}`), opts);
  }

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.includes('/api/')) return reply.code(404).send({ error: '接口不存在' });
    // 404 页可能在任意路径下被请求，相对路径不可靠，这里按实际部署前缀注入
    let html = fs.readFileSync(path.join(PUBLIC_DIR, '404.html'), 'utf8');
    html = html
      .replace(/href="\/assets\//g, `href="${BASE}/assets/`)
      .replace(/href="\/admin\/"/g, `href="${BASE}/admin/"`)
      .replace(/href="\/user\/"/g, `href="${BASE}/user/"`);
    return reply.code(404).type('text/html').send(html);
  });

  return app;
}

async function start() {
  const app = build();
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  try {
    await app.listen({ port, host });
    console.log(`\n  管理后台: http://localhost:${port}/admin/`);
    console.log(`  用户空间: http://localhost:${port}/user/`);
    if (process.env.NODE_ENV === 'production') {
      console.log(`  运行环境: production（演示接口已停用）\n`);
    } else {
      console.log(`  运行环境: ${process.env.NODE_ENV || 'development'}（演示接口跟随环境开放，生产请设 NODE_ENV=production）\n`);
    }
  } catch (e) {
    app.log.error(e);
    process.exit(1);
  }
}

if (require.main === module) start();

module.exports = { build, start };

const fs = require('fs');
const path = require('path');
const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const multipart = require('@fastify/multipart');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
// 客户端更新包：大文件、按版本分目录。生产建议 nginx 直接 alias 出去（见 deploy/nginx-subpath.conf），
// 这条静态挂载是本地开发/没配 nginx 时的兜底，Range 断点续传由 @fastify/static 内置支持。
const UPDATES_DIR = process.env.UPDATES_DIR
  ? path.resolve(process.env.UPDATES_DIR)
  : path.join(__dirname, '..', 'data', 'updates');
fs.mkdirSync(UPDATES_DIR, { recursive: true });
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

  // 备份包要能上传整包（含上传文件时可能几十 MB），图片上传共用这条限制。
  // 恢复接口只接受管理员令牌，不存在匿名打满内存的入口。
  app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024 } });

  // DELETE 这类没有 body 的请求，只要带了 `Content-Type: application/json`，
  // Fastify 默认会判成 FST_ERR_CTP_EMPTY_JSON_BODY 直接 400 —— 表现是「删除按钮全报 BadRequest」。
  // 前端已改成无 body 不带该头，这里再兜一层：空 body 当 {}，避免旧缓存页面/第三方客户端继续踩。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (!raw) return done(null, {});
    try {
      return done(null, JSON.parse(raw));
    } catch (e) {
      e.statusCode = 400;
      e.message = '请求体不是合法 JSON';
      return done(e, undefined);
    }
  });

  // 防混合内容：页面上若混入 http:// 的子资源，浏览器会显示「此页面不安全（HTTPS 连接断开）」，
  // 且用户点过一次「加载不安全内容」后 Chrome 会长期记住、一直挂红。
  // upgrade-insecure-requests 让浏览器把所有 http:// 子资源自动升级为 https，从源头杜绝。
  // HSTS 促使浏览器此后一律走 https 访问本站（含之前点过「继续前往不安全」留下的坏印象）。
  app.addHook('onSend', async (req, reply) => {
    reply.header('Content-Security-Policy', 'upgrade-insecure-requests');
    if (req.protocol === 'https') reply.header('Strict-Transport-Security', 'max-age=15552000');
  });

  // 目录型页面（admin/user，public 下有 index.html 的目录）必须以斜杠结尾访问：
  // 新版 @fastify/static 对无斜杠 URL 直接 200 返回 HTML 不再重定向，而页面里的
  // css/js 全是相对路径，浏览器会按无斜杠 URL 解析 → 全部 404 → 样式丢失、脚本不执行
  // （2026-11-04 线上「后台所有开关显示异常且点不动」就是这个）。统一 301 补斜杠，保留查询参数。
  const dirSlashRe = new RegExp(`^${BASE}/([a-z][a-z0-9_-]*)$`);
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return;
    const urlNoQ = req.url.split('?')[0];
    const m = dirSlashRe.exec(urlNoQ);
    if (!m) return;
    const dir = path.join(PUBLIC_DIR, m[1]);
    if (!fs.existsSync(path.join(dir, 'index.html'))) return;
    const q = req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
    return reply.redirect(`${urlNoQ}/${q}`, 301);
  });

  app.register(fastifyStatic, { root: UPLOAD_DIR, prefix: `${BASE}/uploads/`, decorateReply: false });

  // 客户端更新包：禁止列目录（index/list 全关）、包按文件名里的版本号长缓存、清单不缓存。
  // Content-Type 一律 octet-stream —— 上传目录里若混进 html/svg，被浏览器当页面渲染就是存储型 XSS。
  app.register(fastifyStatic, {
    root: UPDATES_DIR,
    prefix: `${BASE}/updates/`,
    decorateReply: false,
    index: false,
    list: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.json')) {
        res.header('Cache-Control', 'no-cache');
        res.header('Content-Type', 'application/json; charset=utf-8');
        return;
      }
      res.header('Cache-Control', 'public, max-age=31536000, immutable');
      res.header('Content-Type', 'application/octet-stream');
      // 断点续传：客户端用 Range 续传，必须显式声明支持
      res.header('Accept-Ranges', 'bytes');
    },
  });
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
  for (const name of ['admin', 'products', 'plans', 'users', 'licenses', 'orders', 'stats',
    'pay', 'wechat', 'portal', 'open', 'openapps', 'agents', 'blcloud', 'blcloud-admin', 'backup', 'releases']) {
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
  // 到期提醒扫描放在 start() 而不是 build()：测试会反复 build()，
  // 在 build 里起定时器会泄漏句柄，导致测试进程挂住不退出。
  const reminders = require('./lib/reminders');
  try { reminders.scan(); } catch (e) { app.log.warn(`到期提醒扫描失败: ${e.message}`); }
  // 每天自动留一份账套备份：被攻击/误删时，最坏情况也能退回昨天。
  // 放在 start() 里而不是 build()，测试反复 build() 不该产生备份文件。
  const backup = require('./lib/backup');
  // 更新包的兜底清单如果丢了（比如换服务器只迁了库），按库里现有版本补一份。
  // 站点地址没配就不写：写出来会是相对路径，客户端在 Electron 里用不了。
  try {
    const release = require('./lib/release');
    if (!fs.existsSync(path.join(release.ROOT, 'latest.json')) && release.siteBase()) {
      const body = release.writeLatest();
      if (body.latest) app.log.info(`已重建更新清单 latest.json（${body.latest}）`);
    }
  } catch (e) { app.log.warn(`重建更新清单失败: ${e.message}`); }
  const snapshot = () => {
    try {
      const pkg = backup.autoSnapshot();
      if (pkg) app.log.info(`每日账套备份完成: ${pkg.name}`);
    } catch (e) { app.log.warn(`自动备份失败: ${e.message}`); }
  };
  snapshot();
  const backupTimer = setInterval(snapshot, 6 * 60 * 60 * 1000);
  backupTimer.unref();
  const timer = setInterval(() => {
    try { reminders.scan(); } catch (e) { app.log.warn(`到期提醒扫描失败: ${e.message}`); }
  }, 6 * 60 * 60 * 1000);
  timer.unref();
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

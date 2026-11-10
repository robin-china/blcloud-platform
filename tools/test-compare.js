/* 版本差异（compare_url）契约测试：
 * 1) products.compare_url 字段可存可取（ensureColumn 迁移 + 白名单接口）
 * 2) 伪协议地址被服务端消毒清空
 * 3) 用户端 shop / product 详情 / space 三条路径都能拿到 compare_url
 * 4) 默认内容页 /assets/compare/default.html 可被静态访问
 * 5) 订单补发幂等：已发过的单默认 409，force=1 才重发（顺手回归）
 */
process.env.NODE_ENV = 'test';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', 'test-compare.db');
process.env.ADMIN_INIT_PASSWORD = 'admin123';
try { require('fs').unlinkSync(process.env.DB_PATH); } catch { /* 不存在更好 */ }

const { build } = require('../server/index');
const db = require('../server/db');

let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`  ✗   ${name}${detail ? ' → ' + detail : ''}`); }
}

(async () => {
  const app = build();
  await app.ready();

  const login = (await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' } })).json();
  const AH = { authorization: `Bearer ${login.token}` };

  // ── 1. 字段存取 + 消毒 ──
  const created = (await app.inject({
    method: 'POST', url: '/api/products', headers: AH,
    payload: { name: '对比测试产品', type: 'software', status: 'on', price: 99, compare_url: 'assets/compare/labelgo.html' },
  })).json();
  const detail = (await app.inject({ method: 'GET', url: `/api/products/${created.id}`, headers: AH })).json();
  t('产品详情返回 compare_url', detail.product.compare_url === 'assets/compare/labelgo.html', JSON.stringify(detail.product.compare_url));

  await app.inject({ method: 'POST', url: `/api/products/${created.id}`, headers: AH, payload: { compare_url: 'javascript:alert(1)' } });
  const detail2 = (await app.inject({ method: 'GET', url: `/api/products/${created.id}`, headers: AH })).json();
  t('伪协议地址被消毒为空', detail2.product.compare_url === '', JSON.stringify(detail2.product.compare_url));

  await app.inject({ method: 'POST', url: `/api/products/${created.id}`, headers: AH, payload: { compare_url: 'https://example.com/compare.html' } });
  const detail3 = (await app.inject({ method: 'GET', url: `/api/products/${created.id}`, headers: AH })).json();
  t('https 外链地址保留', detail3.product.compare_url === 'https://example.com/compare.html', JSON.stringify(detail3.product.compare_url));

  // ── 2. 用户端接口 ──
  const shop = (await app.inject({ method: 'GET', url: '/api/portal/shop?type=software' })).json();
  const hit = (shop.list || []).find((p) => p.id === created.id);
  t('商城列表带 compare_url', !!(hit && hit.compare_url === 'https://example.com/compare.html'), JSON.stringify(hit && hit.compare_url));
  const pd = (await app.inject({ method: 'GET', url: `/api/portal/product/${created.id}` })).json();
  t('商品详情带 compare_url', pd.product.compare_url === 'https://example.com/compare.html');

  // ── 3. 静态默认内容页 ──
  const html = await app.inject({ method: 'GET', url: '/assets/compare/default.html' });
  t('默认版本差异页可访问（200）', html.statusCode === 200, String(html.statusCode));
  t('默认页是 HTML 且含对比表', /版本差异/.test(html.body) && /<table/.test(html.body));

  // ── 4. space 路径（open_app 绑产品后可见） ──
  const appRes = (await app.inject({
    method: 'POST', url: '/api/open-apps', headers: AH,
    payload: { name: '对比测试应用', product_id: created.id, status: 'active' },
  })).json();
  // 模拟支付默认关闭，测试库先打开（test 环境不受生产禁改限制）
  await app.inject({ method: 'POST', url: '/api/settings', headers: AH, payload: { pay_simulate: '1' } });
  const qr = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode', payload: {} })).json();
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${qr.scene}`, payload: { openid: 'cmp-user-1', nickname: '对比用户' } });
  const loginRes = (await app.inject({ method: 'GET', url: `/api/wechat/qrcode/${qr.scene}` })).json();
  const UH = { authorization: `Bearer ${loginRes.token}` };
  const space = (await app.inject({ method: 'GET', url: '/api/portal/space', headers: UH })).json();
  const sa = (space.apps || []).find((x) => x.app_id === appRes.id);
  t('我的空间卡片带 product.compare_url', !!(sa && sa.product.compare_url === 'https://example.com/compare.html'),
    JSON.stringify(sa && sa.product));

  // ── 5. 补发幂等（回归） ──
  const order = (await app.inject({
    method: 'POST', url: '/api/portal/orders', headers: UH,
    payload: { items: [{ product_id: created.id, qty: 1 }] },
  })).json();
  const sim = await app.inject({ method: 'POST', url: `/api/pay/simulate/${order.order_no}`, headers: UH, payload: {} });
  t('模拟支付成功（自动发货）', sim.statusCode === 200, String(sim.statusCode) + ' ' + String(sim.body).slice(0, 80));
  const orderRow = db.prepare('SELECT id, deliver_result FROM orders WHERE order_no = ?').get(order.order_no);
  t('支付后已有发货结果', (() => { try { return JSON.parse(orderRow.deliver_result || '[]').length >= 1; } catch { return false; } })(),
    String(orderRow && orderRow.deliver_result).slice(0, 80));
  const first = await app.inject({ method: 'POST', url: `/api/orders/${orderRow.id}/deliver`, headers: AH, payload: {} });
  t('已发货订单重复补发默认 409', first.statusCode === 409 && first.json().code === 'ALREADY_DELIVERED', String(first.statusCode));
  const forced = await app.inject({ method: 'POST', url: `/api/orders/${orderRow.id}/deliver`, headers: AH, payload: { force: true } });
  t('带 force=1 可重发', forced.statusCode === 200, String(forced.statusCode) + ' ' + String(forced.body).slice(0, 80));

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });

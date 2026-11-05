/* 产品卡片排版 / 图片 / 头像选择器的静态回归：node tools/test-ui-layout.js
 *
 * 背景（2026-11-03）：产品图用 object-fit:cover 被裁、描述不限行数导致卡片高低不齐、
 * 卡片内 .kv 沿用 110px 固定列把长授权码挤出去、详情页固定 220px 左列在窄屏挤成一条。
 * 这里把修复后的关键规则钉死，以后改样式时若把某条删掉会立刻变红。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const css = read('public/assets/ui.css');
const pages = read('public/user/js/pages.js');
const adminProducts = read('public/admin/js/pages-products.js');
const userIndex = read('public/user/index.html');
const apiJs = read('public/assets/api.js');
const avatarJs = read('public/assets/avatars.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + String(extra).slice(0, 200) : '')); }
}

console.log('\n产品图：完整显示，不裁切');
check('卡片缩略图 object-fit: contain', /\.prod-card \.thumb img \{[^}]*object-fit:\s*contain/s.test(css));
check('详情页封面 object-fit: contain', /\.product-detail \.cover img \{[^}]*object-fit:\s*contain/s.test(css));
check('后台小缩略图 object-fit: contain', /\.thumb-sm img \{[^}]*object-fit:\s*contain/s.test(css));
check('产品图区域不再出现 object-fit: cover', !/\.prod-card \.thumb img[^}]*object-fit:\s*cover/.test(css));
check('后台商品表格不再内联 cover 裁切', !/object-fit:cover/.test(adminProducts));
check('详情页不再用固定 220px 左列', !/grid-template-columns:220px 1fr/.test(pages));
check('详情页使用响应式 product-detail 类', /card-body product-detail/.test(pages) && /\.product-detail \{/.test(css));

console.log('\n文字与卡片：定高截断、等高、按钮推底');
check('标题单行省略', /\.prod-card h4 \{[^}]*text-overflow:\s*ellipsis/s.test(css));
check('描述两行截断且定高', /\.prod-card \.desc \{[^}]*line-clamp:\s*2/s.test(css) && /min-height:\s*38px/.test(css));
check('卡片 min-width:0 防止被长文本撑破', /\.prod-card \{[^}]*min-width:\s*0/s.test(css));
check('按钮区 margin-top:auto 保证底部对齐', /\.prod-card \.foot, \.prod-card \.actions \{[^}]*margin-top:\s*auto/s.test(css));
check('空态占满整行', /\.prod-grid > \.empty \{[^}]*grid-column:\s*1 \/ -1/s.test(css));
check('卡片内 kv 改成紧凑自动列', /\.prod-card \.kv \{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\)/s.test(css));
check('卡片内 kv 值超长省略', /\.prod-card \.kv > div \{[^}]*text-overflow:\s*ellipsis/s.test(css));
check('我的空间卡片 kv 不再写死 110px 字号内联', !/<div class="kv" style="font-size:12\.5px">/.test(pages));
check('授权码带 title 可看全文', /class="mono" :title="a\.license \? a\.license\.license_key/.test(pages));
check('商品名/副标题带 title', /<h4 :title="p\.name">/.test(pages) && /<h4 :title="a\.product\.name">/.test(pages));
check('我的空间按钮区推到底部', /class="btn-group actions"/.test(pages));

console.log('\n窄屏响应式');
check('有 900px 断点', /@media \(max-width: 900px\)/.test(css));
check('窄屏详情页改上下堆叠', /\.product-detail \{ grid-template-columns: 1fr; \}/.test(css));
check('窄屏顶栏导航换行', /\.site-nav \{ flex-wrap: wrap; \}/.test(css));
check('hero 内文字容器 min-width:0', /\.hero\.hero-user \.hero-text \{[^}]*min-width:\s*0/s.test(css));

console.log('\n缩略图渲染安全与统一');
check('productIcon 对 src 做 HTML 转义', /function escHtml\(/.test(pages) && /escHtml\(p\.icon\)/.test(pages));
check('无图标时统一用 .ph 占位', /class="ph"/.test(pages) && /\.prod-card \.thumb \.ph \{/.test(css));
check('后台上架卡片也用 .ph 占位', /v-else class="ph"/.test(adminProducts));
check('后台商品表格/预览用 thumb-sm 类', (adminProducts.match(/class="thumb-sm"/g) || []).length >= 2);

console.log('\n头像：内置卡通可选，不再让用户填地址');
check('账户中心不再有「头像地址」输入框', !/头像地址/.test(pages));
check('账户中心有头像选择器网格', /class="avatar-picker"/.test(pages));
check('自定义链接收进折叠的高级选项', /<summary>高级：改用图片链接<\/summary>/.test(pages));
check('CSS 有头像选择器与选中态样式', /\.avatar-picker button\.active/.test(css));
check('模板不直接引用全局 U', !/v-if="U\./.test(pages) && !/:src="U\./.test(pages) && !/v-if="U\./.test(userIndex));
check('api.js 暴露 U.avatar / U.avatarPresets', /avatar,\s*avatarPresets/.test(apiJs) || /avatarPresets,/.test(apiJs));
check('user/index.html 引入 avatars.js', /<script src="\.\.\/assets\/avatars\.js"><\/script>/.test(userIndex));
const iAv = userIndex.indexOf('avatars.js');
const iApi = userIndex.indexOf('assets/api.js');
check('avatars.js 早于 api.js 加载', iAv > -1 && iApi > -1 && iAv < iApi, { iAv, iApi });
check('头像库是 UMD（前后端共用一份）',
  /module\.exports/.test(avatarJs) && /root\.AvatarPresets/.test(avatarJs));
check('头像库提供 8 个预设', (avatarJs.match(/id: '\d\d', name:/g) || []).length === 8);
check('头像库导出 defaultValue 供服务端分配', /defaultValue/.test(avatarJs));

console.log('\n开关组件：.field 里的 label.switch 必须保住 inline-flex');
// .field label { display:block } 与 label.switch 同为 (0,1,1)，靠后者胜 → label.switch 必须存在
check('ui.css 有 label.switch 显式声明（压过 .field label 的 display:block）',
  /label\.switch\s*\{[^}]*inline-flex/.test(css));
check('.switch .track 有 display:inline-block 兜底（inline 上宽高失效）',
  /\.switch \.track\s*\{[^}]*display:\s*inline-block/.test(css));

console.log('\n手机端适配：微信内打开（375px 上下）不能把内容挤成一团');
check('有 720px 手机断点', /@media \(max-width:\s*720px\)/.test(css));
const mobile = css.slice(css.indexOf('@media (max-width: 720px)'));
check('前台导航在手机上横向滚动而不是换行堆叠',
  /\.site-nav\s*\{[^}]*overflow-x:\s*auto/.test(mobile));
check('表格容器在窄屏横向滚动（.card-body.tight）',
  /\.card-body\.tight\s*\{[^}]*overflow-x:\s*auto/.test(mobile));
check('微信底部工具条安全区（env(safe-area-inset-bottom)）', /safe-area-inset-bottom/.test(mobile));
check('后台侧栏在 768px 以下变成顶部横条',
  /@media \(max-width:\s*768px\)[\s\S]*\.layout\s*\{[^}]*flex-direction:\s*column/.test(css));

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) process.exitCode = 1;

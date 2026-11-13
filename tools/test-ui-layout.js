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
const accountJs = read('public/user/js/page-account.js');
const adminProducts = read('public/admin/js/pages-products.js');
const userIndex = read('public/user/index.html');
const apiJs = read('public/assets/api.js');
const avatarJs = read('public/assets/avatars.js');
const compareJs = read('public/assets/compare.js');

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
// 「我的空间」卡片里的授权码自 2026-11-10 起默认脱敏（LIC-****-****-尾4位），
// 但 title 仍挂完整码、旁边有「显示」按钮 —— 断言按新契约写，别再要求明文直出
check('授权码默认脱敏但 title 保留全文',
  /class="mono"[\s\S]{0,120}:title="a\.license \? a\.license\.license_key/.test(pages) && /maskKey\(a\)/.test(pages));
check('授权码可点「显示」看全文', /toggleKey\(a\)/.test(pages));
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

const adminIndex = read('public/admin/index.html');
const releasePage = read('public/admin/js/pages-release.js');
const retentionPage = read('public/admin/js/pages-retention.js');
const openapiPage = read('public/admin/js/pages-openapi.js');

console.log('\n客户端更新页：按产品分组，不再全产品混排');
check('左侧产品侧栏存在', /class="rel-rail"/.test(releasePage) && /rel-item/.test(releasePage));
check('点击产品只切换当前产品', /function selectProduct\(name\)/.test(releasePage));
check('版本列表/升级记录标题带产品名', /版本列表 · \{\{ active/.test(releasePage) && /升级记录 · \{\{ active/.test(releasePage));
check('不再有「全部 + 每产品」chips 混排', !/setFilter\(''\)/.test(releasePage));
check('升级记录按产品请求', /product: active\.value/.test(releasePage));
check('选中产品记忆到 localStorage', /admin_release_product/.test(releasePage));
check('发布表单产品锁定为当前产品', /fd\.append\('product', active\.value\)/.test(releasePage));
check('可登记未发布的产品线', /add_product/.test(releasePage) && /rel-add/.test(releasePage));
check('升级记录有清理入口且需确认词', /openPurge/.test(releasePage) && /purgeConfirm !== '清除'/.test(releasePage));
check('产品侧栏有响应式断点', /@media \(max-width: 900px\)[\s\S]*\.rel-wrap \{ flex-direction: column/.test(css));

console.log('\n数据留存页：流水表可滚动清理');
check('留存页已注册到后台导航', /key: 'retention', name: '数据留存'/.test(read('public/admin/js/app.js')));
check('留存页已挂到 index.html', /<page-retention v-if="state.route === 'retention'"><\/page-retention>/.test(adminIndex)
  && /pages-retention\.js/.test(adminIndex));
check('每张表显示行数与最早一行', /p\.rows/.test(retentionPage) && /p\.oldest/.test(retentionPage));
check('保留天数可编辑且 0=不自动清', /v-model\.number="days\[p\.key\]"/.test(retentionPage));
check('清空需输入确认词', /clearConfirm !== '清除'/.test(retentionPage));
check('在线会话永不删除（服务端特例）', /status <> 'active' OR expires_at </.test(read('server/lib/retention.js')));

console.log('\n开放接口会话：可清理失效记录');
check('会话抽屉有清理失效会话按钮', /cleanupSessions/.test(openapiPage));
check('会话抽屉显示生效条数', /生效 \{\{ sessions\.online \}\}/.test(openapiPage));
check('服务端只删失效/过期会话', /status <> 'active' OR expires_at </.test(read('server/routes/openapps.js')));

console.log('\n账户中心：中性默认头像 + 上传 + 紧凑单列');
check('账户中心不再有「头像地址」输入框', !/头像地址/.test(accountJs));
check('不再铺一整排卡通头像选择器', !/avatar-picker/.test(accountJs) && /上传头像/.test(accountJs));
check('手机绑定收进 teleport 模态框', /<teleport to="body">/.test(accountJs)
  && /绑定手机号|更换手机号/.test(accountJs) && /acct-code/.test(accountJs));
check('主页面只留手机号状态与按钮', /maskedPhone/.test(accountJs) && /openPhone/.test(accountJs));
check('主页面不再显示 openid，改显示个人 ID', !/user\?\.openid|me\?\.openid/.test(accountJs)
  && /publicId/.test(accountJs));
check('CSS 有账户中心紧凑布局与移动端断点', /\.acct \{/.test(css) && /@media \(max-width: 560px\)/.test(css));
check('弹层 teleport 到 body 且有滚动锁/Esc', /<teleport to="body">/.test(accountJs)
  && /body\.style\.overflow/.test(accountJs) && /e\.key === 'Escape'/.test(accountJs));
check('user/index.html 引入新账户中心并注册 pay-dialog',
  /js\/page-account\.js/.test(userIndex) && /component\('pay-dialog'/.test(userIndex));
check('模板不直接引用全局 U', !/v-if="U\./.test(pages) && !/:src="U\./.test(pages) && !/v-if="U\./.test(userIndex));
check('api.js 暴露 U.avatar / U.avatarPresets', /avatar,\s*avatarPresets/.test(apiJs) || /avatarPresets,/.test(apiJs));
check('user/index.html 引入 avatars.js', /<script src="\.\.\/assets\/avatars\.js"><\/script>/.test(userIndex));
const iAv = userIndex.indexOf('avatars.js');
const iApi = userIndex.indexOf('assets/api.js');
check('avatars.js 早于 api.js 加载', iAv > -1 && iApi > -1 && iAv < iApi, { iAv, iApi });
check('头像库是 UMD（前后端共用一份）',
  /module\.exports/.test(avatarJs) && /root\.AvatarPresets/.test(avatarJs));
check('头像库提供 9 个预设（含中性默认 00）',
  (avatarJs.match(/id: '\d\d', name:/g) || []).length === 9 && /id: '00', name: '默认头像'/.test(avatarJs));
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

console.log('\n版本差异（version-compare）：详情页内嵌必须撑满整宽');
// 2026-11-10：.product-detail 是两列 grid（封面 180~240px | 内容），版本差异块作为第三个
// 子元素会掉进封面列，宽度只剩两百来像素，用户看到的就是「很小的框框」。必须跨列。
check('inline 模式根元素跨过 product-detail 的两列 grid', /\.vc-root\.is-inline\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s.test(css));
check('inline 模式根元素是 block + 100% 宽（不是 inline-flex 收缩）', /\.vc-root\.is-inline\s*\{[^}]*display:\s*block/s.test(css) && /\.vc-root\.is-inline\s*\{[^}]*width:\s*100%/s.test(css));
check('按钮形态（我的空间卡片）仍是 inline-flex', /\.vc-root\s*\{[^}]*display:\s*inline-flex/s.test(css));
check('inline 模式不再套 .card（避免卡片套卡片显得又小又挤）', !/mode === 'inline'[\s\S]{0,200}class="card"/.test(compareJs));
check('组件根元素带 is-inline 开关', /class="vc-root"/.test(compareJs) && /'is-inline':\s*mode === 'inline'/.test(compareJs));
check('iframe 高度给足（≥520px）', /\.compare-frame\s*\{[^}]*height:\s*(5[2-9]\d|[6-9]\d\d)px/s.test(css));
check('弹层内边距清零、iframe 占满高度', /\.vc-modal-body\s*\{[^}]*padding:\s*0/s.test(css) && /\.vc-modal-body \.compare-frame\s*\{[^}]*min\(/s.test(css));
check('iframe 沙箱不带 allow-scripts（挡 XSS）', /sandbox="[^"]*allow-same-origin[^"]*"/.test(compareJs) && !/sandbox="[^"]*allow-scripts/.test(compareJs));

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) process.exitCode = 1;

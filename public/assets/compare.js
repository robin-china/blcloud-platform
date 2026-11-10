(function () {
  /**
   * 版本差异（版本/档位对比）通用组件。
   *
   * 一份 HTML 内容，两处引用：
   *   - 「我的空间」产品卡片：默认 modal 模式（按钮 → 弹层）
   *   - 产品详情页：mode="inline"（直接嵌入卡片）
   * 内容地址来自 products.compare_url（后台产品表单可配），缺省用
   * /assets/compare/default.html —— 管理员直接编辑该文件即可全站生效。
   *
   * 安全约定：
   *   - 用 iframe + sandbox（不带 allow-scripts）加载：即使有人在内容里塞了脚本，
   *     在沙箱里也执行不了，天然挡掉存储型 XSS；
   *   - URL 规范化时拒绝 javascript: / data: 这类伪协议；
   *   - 相对路径自动补部署前缀（U.basePath），子路径部署 /platform/ 下同样可用。
   *
   * 注意：本组件 template 是 JS 字符串（非 in-DOM 模板），自闭合写法安全；
   * 模板里不引用全局变量，全部通过 computed 暴露。
   */
  const { ref, computed } = Vue;
  const DEFAULT_URL = '/assets/compare/default.html';

  function normalizeUrl(u) {
    const s = String(u == null ? '' : u).trim();
    if (!s) return '';
    if (/^(javascript|data|vbscript|file):/i.test(s)) return '';
    return s;
  }

  window.VersionCompare = {
    name: 'VersionCompare',
    props: {
      url: { type: String, default: '' },
      title: { type: String, default: '版本差异' },
      // modal = 按钮 + 遮罩弹层（「我的空间」卡片用）；inline = 直接嵌入（产品详情页用）
      mode: { type: String, default: 'modal' },
      btnClass: { type: String, default: 'btn sm' },
    },
    template: `
      <div v-if="finalUrl" class="vc-root" :class="{ 'is-inline': mode === 'inline' }">
        <button v-if="mode !== 'inline'" :class="btnClass" @click="open">{{ title }}</button>

        <!-- inline：直接嵌进产品详情。不要再套一层 .card —— 详情页本身就在 .card
             里，卡片套卡片会显得又小又挤；宽度由 .vc-root.is-inline 撑满并跨列 -->
        <div v-if="mode === 'inline'" class="vc-inline">
          <div class="vc-inline-head">
            <h3>{{ title }}</h3>
            <a :href="finalUrl" target="_blank" rel="noopener" class="btn sm">在新窗口打开</a>
          </div>
          <iframe :src="finalUrl" class="compare-frame" sandbox="allow-same-origin allow-popups" loading="lazy" title="版本差异"></iframe>
        </div>

        <div v-if="mode !== 'inline' && show" class="mask" @click.self="close">
          <div class="modal wide">
            <div class="modal-head">
              <h3>{{ title }}</h3>
              <button class="close-x" @click="close">&times;</button>
            </div>
            <div class="modal-body vc-modal-body">
              <iframe :src="finalUrl" class="compare-frame" sandbox="allow-same-origin allow-popups" title="版本差异"></iframe>
            </div>
          </div>
        </div>
      </div>
    `,
    setup(props) {
      const show = ref(false);
      const finalUrl = computed(() => {
        const u = normalizeUrl(props.url) || DEFAULT_URL;
        if (/^https?:\/\//i.test(u)) return u;
        const base = (window.U && window.U.basePath) || '';
        return base + (u.startsWith('/') ? u : '/' + u);
      });
      function open() { show.value = true; }
      function close() { show.value = false; }
      return { show, finalUrl, open, close };
    },
  };
})();

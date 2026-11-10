(function () {
const USER_MENU = [
  { key: 'shop', name: '官方产品' },
  { key: 'space', name: '我的空间' },
  { key: 'licenses', name: '我的授权' },
  { key: 'devices', name: '我的硬件' },
  { key: 'orders', name: '我的订单' },
  { key: 'earnings', name: '我的收益' },
  { key: 'blcloud', name: 'blcloud' },
  { key: 'account', name: '账户中心' },
];

const { createApp, ref, reactive, onMounted, computed } = Vue;

U.api.scope = 'user';

const userApp = createApp({
  setup() {
    const state = reactive({
      token: localStorage.getItem('user_token') || '',
      user: null,
      route: 'shop',
      param: '',
      settings: {},
      // 登录态校验中：true 之前顶栏不渲染「登录」按钮（已登录用户先看到它就是误导）
      authReady: false,
      // 服务端是否具备微信网页授权能力（前端据此决定微信内要不要自动登录）
      site: { wechat_oauth: false, wechat_oauth_scope: '' },
      menu: USER_MENU,
      cart: [],
    });

    function go(key, param) {
      state.route = key;
      state.param = param || '';
      const next = param ? `#/${key}/${param}` : `#/${key}`;
      if (location.hash !== next) location.hash = next;
    }

    function syncHash() {
      const raw = (location.hash || '#/shop').replace('#/', '');
      // 允许 #/space?app=xxx 这类带查询的路由：路由名只取 ? 之前的部分，
      // 查询参数由各页面自己解析（如「我的空间」用 app 定位产品卡片）
      const [pathPart] = raw.split('?');
      const [r, p] = pathPart.split('/');
      state.route = r || 'shop';
      state.param = p || '';
    }

    async function loadSite() {
      try {
        const res = await U.api.get('/api/portal/site');
        state.settings = res.settings || {};
        state.site = {
          wechat_oauth: !!res.wechat_oauth,
          wechat_oauth_scope: res.wechat_oauth_scope || '',
        };
        U.applySiteSettings(state.settings);
      } catch (e) { /* ignore */ }
    }

    // 「我的收益」只对代理商开放：菜单与顶栏共用同一份过滤结果
    function refreshMenu() {
      state.menu = USER_MENU.filter((m) => m.key !== 'earnings'
        || !!(state.user && state.user.agent_status === 'active'));
    }
    refreshMenu();

    async function loadMe() {
      if (!state.token) { state.user = null; refreshMenu(); return; }
      try {
        const res = await U.api.get('/api/portal/me');
        state.user = res.user;
      } catch (e) {
        // 只有服务端明确 401（登录态真失效）才清；网络抖动 / 5xx / 404 一律保留，
        // 否则已登录用户会被误判成未登录：顶栏变「登录」、页面守卫弹「请先登录」，
        // 刷新一下又好了 —— 线上典型「已登录还提示要登录」就是这里。
        if (e && e.status === 401) {
          U.api.setToken('user', '');
          state.token = '';
          state.user = null;
        } else {
          console.warn('[me] 获取用户资料失败，保留登录态：', e && e.message);
        }
      }
      refreshMenu();
    }

    function logout() {
      U.api.setToken('user', '');
      state.token = '';
      state.user = null;
      U.setAuthReady(false);
      refreshMenu();
      go('shop');
    }

    // 顶栏头像：模板不直接引用全局 U，在 setup 里把 preset:XX 展开成可渲染 src
    const userAvatar = computed(() => U.avatar(state.user && state.user.avatar));

    /**
     * 软件端点「用户中心」跳过来时，地址上带 `?t=<一次性票据>`。
     *
     * 票据只能换一次，所以要做的第一件事是**把它从地址栏抹掉**（replaceState）：
     * 否则用户刷新一次就第二次兑换失败，把链接发给别人也永远打不开。
     * 兑换失败不挡浏览 —— 顶多是没自动登录，用户还可以扫码进。
     */
    async function claimHandoff() {
      const q = new URLSearchParams(location.search);
      const t = q.get('t');
      if (!t) return;
      q.delete('t');
      const rest = q.toString();
      history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
      try {
        const res = await U.api.post('/api/portal/handoff', { t });
        if (res && res.token) {
          U.api.setToken('user', res.token);
          state.token = res.token;
          state.user = res.user || null;
        }
      } catch (e) {
        console.warn('[handoff] 免登链接无效：', e && e.message);
      }
    }

    /**
     * 代理商推广链接 `?agent=CODE`：把渠道码记到 localStorage，
     * 之后本浏览器内任何一次扫码登录都会带上它，新账号自动归到该代理商名下。
     * 参数要立刻从地址栏抹掉（同 handoff 票据），否则用户一刷新归属码就丢了、分享链接也会泄露。
     */
    function captureAgentRef() {
      const q = new URLSearchParams(location.search);
      const code = (q.get('agent') || '').trim().toUpperCase();
      if (code && /^AG[A-Z0-9]{4,16}$/.test(code)) {
        localStorage.setItem('agent_ref', code);
        q.delete('agent');
        const rest = q.toString();
        history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
      }
    }

    /**
     * 微信内置浏览器里不需要扫码：用户已经登录着微信，再让他扫一次很别扭。
     * 这里直接跳公众号网页授权（snsapi_base 静默），回调服务端发一张一次性票据，
     * 页面用 claimHandoff 换登录态。
     *
     * 用 sessionStorage 记「本次会话试过」：用户取消授权、state 过期、公众号没配
     * 网页授权域名时，不能让页面陷入无限跳转。
     */
    function isWechatBrowser() {
      return /MicroMessenger/i.test(navigator.userAgent || '');
    }

    function tryWechatOAuth() {
      if (state.token) return false;
      if (!isWechatBrowser()) return false;
      if (!state.site || !state.site.wechat_oauth) return false;
      if (sessionStorage.getItem('wx_oauth_tried') === '1') return false;
      sessionStorage.setItem('wx_oauth_tried', '1');
      // 落到用户当前想看的页面，默认「我的空间」
      const pages = ['space', 'licenses', 'devices', 'orders', 'account', 'shop', 'earnings', 'blcloud'];
      const to = pages.includes(state.route) ? state.route : 'space';
      const agent = localStorage.getItem('agent_ref') || '';
      const qs = `?to=${encodeURIComponent(to)}&agent=${encodeURIComponent(agent)}`;
      location.replace(`${U.basePath}/api/wechat/oauth/start${qs}`);
      return true;
    }

    async function onLogged() {
      state.token = localStorage.getItem('user_token') || '';
      await loadMe();
      U.setAuthReady(!!state.token);
      go('space');
    }

    /**
     * api.js 在「真登录态过期 401」时会清 localStorage 并派发本事件（带 code 的业务
     * 401 与登录接口自身 401 都不会触发）。这里同步 Vue state，否则顶栏仍显示已登录、
     * 后续每个请求都不带令牌 → 数据一片空白，必须手动刷新才恢复。
     */
    const PRIVATE_ROUTES = ['space', 'licenses', 'devices', 'orders', 'account', 'earnings', 'blcloud'];
    function onUnauthorized(e) {
      const d = (e && e.detail) || {};
      if (d.scope !== 'user') return;
      U.api.setToken('user', '');
      state.token = '';
      state.user = null;
      state.authReady = true;
      U.setAuthReady(false);
      refreshMenu();
      // 正在浏览公开内容（商城/产品页）时不硬跳，只提醒，避免打断逛街
      if (PRIVATE_ROUTES.includes(state.route)) go('login');
      else U.toast(d.message || '登录已过期，请重新登录', 'error');
    }
    window.addEventListener('app:unauthorized', onUnauthorized);

    Vue.provide('state', state);
    Vue.provide('settings', computed(() => state.settings));
    Vue.provide('site', computed(() => state.site));
    Vue.provide('user', computed(() => state.user));

    onMounted(async () => {
      syncHash();
      window.addEventListener('hashchange', syncHash);
      captureAgentRef();
      // 先换票再拉资料：否则第一屏会是「未登录」，换完才跳回来闪一下
      try {
        await claimHandoff();
        await loadSite();
        await loadMe();
      } finally {
        // 登录态尘埃落定：撤首屏遮罩（index.html 监听 app:ready）、
        // 唤醒各页面守卫（U.authReady）并固定结果，之后的守卫立即返回
        state.authReady = true;
        U.setAuthReady(!!state.token);
        try { window.dispatchEvent(new CustomEvent('app:ready')); } catch { /* 忽略 */ }
      }
      // 票据/本地登录态都没有、又在微信里打开 → 直接走免扫码登录
      tryWechatOAuth();
    });

    return { state, go, logout, onLogged, loadMe, userAvatar, isWechatBrowser };
  },
});

// Vue 模板只能看见 setup/data/props/globalProperties 里的东西，
// 看不到挂在 window 上的全局变量。把 U 注册进来，
// 模板里写 U.xxx 才不会渲染成 Cannot read properties of undefined。
userApp.config.globalProperties.U = window.U;

window.UserApp = { app: userApp };
})();

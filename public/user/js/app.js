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
      const [r, p] = raw.split('/');
      state.route = r || 'shop';
      state.param = p || '';
    }

    async function loadSite() {
      try {
        const res = await U.api.get('/api/portal/site');
        state.settings = res.settings || {};
        U.applySiteSettings(state.settings);
      } catch (e) { /* ignore */ }
    }

    async function loadMe() {
      if (!state.token) { state.user = null; return; }
      try {
        const res = await U.api.get('/api/portal/me');
        state.user = res.user;
      } catch (e) {
        state.token = '';
        state.user = null;
      }
    }

    function logout() {
      U.api.setToken('user', '');
      state.token = '';
      state.user = null;
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

    async function onLogged() {
      state.token = localStorage.getItem('user_token') || '';
      await loadMe();
      go('space');
    }

    Vue.provide('state', state);
    Vue.provide('settings', computed(() => state.settings));
    Vue.provide('user', computed(() => state.user));

    onMounted(async () => {
      syncHash();
      window.addEventListener('hashchange', syncHash);
      // 先换票再拉资料：否则第一屏会是「未登录」，换完才跳回来闪一下
      await claimHandoff();
      await loadSite();
      await loadMe();
    });

    return { state, go, logout, onLogged, loadMe, userAvatar };
  },
});

// Vue 模板只能看见 setup/data/props/globalProperties 里的东西，
// 看不到挂在 window 上的全局变量。把 U 注册进来，
// 模板里写 U.xxx 才不会渲染成 Cannot read properties of undefined。
userApp.config.globalProperties.U = window.U;

window.UserApp = { app: userApp };
})();

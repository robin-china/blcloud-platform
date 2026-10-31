(function () {
const USER_MENU = [
  { key: 'shop', name: '官方产品' },
  { key: 'space', name: '我的空间' },
  { key: 'licenses', name: '我的授权' },
  { key: 'devices', name: '我的硬件' },
  { key: 'orders', name: '我的订单' },
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
      await loadSite();
      await loadMe();
    });

    return { state, go, logout, onLogged, loadMe };
  },
});

window.UserApp = { app: userApp };
})();

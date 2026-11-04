(function () {
  const { createApp, ref, reactive, computed, onMounted, watch } = Vue;
  const ICONS = U.icons;

  const MENU = [
    { group: '概览', items: [{ key: 'dashboard', name: '仪表盘', icon: 'dashboard' }] },
    {
      group: '产品运营',
      items: [
        { key: 'products', name: '产品管理', icon: 'box' },
        { key: 'plans', name: '套餐档位', icon: 'shield' },
        { key: 'storefront', name: '官方上架', icon: 'store' },
        { key: 'release', name: '客户端更新', icon: 'download' },
        { key: 'licenses', name: '授权管理', icon: 'shield' },
      ],
    },
    {
      group: '交易与数据',
      items: [
        { key: 'orders', name: '订单管理', icon: 'order' },
        { key: 'revenue', name: '收入统计', icon: 'chart' },
        { key: 'apiUsage', name: 'API 消费', icon: 'api' },
      ],
    },
    {
      group: '用户',
      items: [
        { key: 'users', name: '用户管理', icon: 'users' },
        { key: 'agents', name: '代理商与佣金', icon: 'users' },
        { key: 'blcloud', name: 'blcloud 调用', icon: 'cloud' },
      ],
    },
    {
      group: '系统',
      items: [
        { key: 'settings', name: '站点设置', icon: 'settings' },
        { key: 'integration', name: '接入配置', icon: 'plug' },
        { key: 'openapi', name: '开放接口', icon: 'key' },
        { key: 'backup', name: '备份与恢复', icon: 'download' },
        { key: 'admins', name: '管理员', icon: 'admin' },
      ],
    },
  ];

  const app = createApp({
    setup() {
      const state = reactive({
        booted: false,
        token: localStorage.getItem('admin_token') || '',
        admin: null,
        route: 'dashboard',
        settings: {},
        menu: MENU,
      });

      const current = computed(() => {
        for (const g of MENU) {
          const hit = g.items.find((i) => i.key === state.route);
          if (hit) return hit;
        }
        return { name: '', icon: 'dashboard' };
      });

      function icon(name) {
        return U.svgIcon(name);
      }

      async function loadSettings() {
        try {
          const res = await U.api.get('/api/settings');
          state.settings = res.settings || {};
          U.applySiteSettings(state.settings);
        } catch (e) { /* ignore */ }
      }

      async function loadMe() {
        try {
          const res = await U.api.get('/api/admin/me');
          state.admin = res.admin;
        } catch (e) {
          state.token = '';
        }
      }

      function syncHash() {
        const h = (location.hash || '#/dashboard').replace('#/', '');
        state.route = h || 'dashboard';
      }

      function go(key) {
        state.route = key;
        const next = `#/${key}`;
        if (location.hash !== next) location.hash = next;
      }

      function logout() {
        U.api.setToken('admin', '');
        state.token = '';
        state.admin = null;
        location.hash = '#/dashboard';
      }

      async function onLogged(token) {
        state.token = token;
        await loadMe();
        await loadSettings();
      }

      onMounted(async () => {
        syncHash();
        window.addEventListener('hashchange', syncHash);
        if (state.token) {
          await loadMe();
          await loadSettings();
        }
        state.booted = true;
      });

      return { state, current, icon, go, logout, onLogged, loadSettings, loadMe };
    },
  });

// 同 user/app.js：让模板里也能访问全局 U（否则模板作用域看不到它）
app.config.globalProperties.U = window.U;

  window.AdminApp = { app, ref, reactive, computed, onMounted, watch, ICONS };
})();

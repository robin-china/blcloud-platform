(function () {
const { ref, reactive, onMounted, computed } = Vue;

window.PageDashboard = {
  template: `
  <div>
    <div class="grid g4" style="margin-bottom:16px">
      <div class="stat">
        <div class="label">累计下载 / 安装</div>
        <div class="value">{{ fmt.int(ov.products?.downloads) }} / {{ fmt.int(ov.products?.installs) }}</div>
        <div class="delta">今日 +{{ fmt.int(ov.today?.downloads) }} 下载</div>
        <div class="icon" v-html="icon('box')"></div>
      </div>
      <div class="stat">
        <div class="label">活跃用户</div>
        <div class="value">{{ fmt.int(ov.products?.active_users) }}</div>
        <div class="delta">今日活跃 {{ fmt.int(ov.today?.active_users) }}</div>
        <div class="icon" v-html="icon('users')"></div>
      </div>
      <div class="stat">
        <div class="label">累计收入</div>
        <div class="value">{{ fmt.money(ov.revenue?.total) }}</div>
        <div class="delta">近 30 天 {{ fmt.money(ov.revenue?.month) }}</div>
        <div class="icon" v-html="icon('chart')"></div>
      </div>
      <div class="stat">
        <div class="label">注册用户 / 设备</div>
        <div class="value">{{ fmt.int(ov.users) }} / {{ fmt.int(ov.devices?.total) }}</div>
        <div class="delta">在线设备 {{ fmt.int(ov.devices?.online) }}</div>
        <div class="icon" v-html="icon('plug')"></div>
      </div>
    </div>

    <div class="grid g2" style="margin-bottom:16px">
      <div class="card">
        <div class="card-head"><h3>下载 / 安装趋势</h3><span class="tag brand">近 14 天</span></div>
        <div class="card-body" v-html="trendChart"></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>收入趋势</h3><span class="tag success">累计 {{ fmt.money(ov.revenue?.total) }}</span></div>
        <div class="card-body" v-html="revenueChart"></div>
      </div>
    </div>

    <div class="grid g3">
      <div class="card">
        <div class="card-head"><h3>支付渠道占比</h3></div>
        <div class="card-body" v-html="channelChart"></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>热销产品</h3></div>
        <div class="card-body tight">
          <div class="row-list" style="padding:6px 18px">
            <div class="row-item" v-for="p in revenue.topProducts || []" :key="p.name">
              <div>
                <div style="font-weight:500">{{ p.name }}</div>
                <div style="color:var(--text-3);font-size:12px">{{ p.type === 'hardware' ? '硬件' : p.type === 'software' ? '软件' : '服务' }} · 活跃 {{ fmt.int(p.active_users) }}</div>
              </div>
              <span class="tag brand">销量 {{ fmt.int(p.total_sales) }}</span>
            </div>
            <div class="empty" v-if="!(revenue.topProducts||[]).length">暂无数据</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>待办事项</h3></div>
        <div class="card-body tight">
          <div class="row-list" style="padding:6px 18px">
            <div class="row-item">
              <span>待支付订单</span>
              <span class="tag warning">{{ fmt.int(ov.pendingOrders) }} 笔</span>
            </div>
            <div class="row-item">
              <span>待发放授权</span>
              <span class="tag info">{{ fmt.int(ov.pendingLicenses) }} 个</span>
            </div>
            <div class="row-item">
              <span>今日新增用户</span>
              <span class="tag success">{{ fmt.int(ov.today?.new_users) }} 人</span>
            </div>
            <div class="row-item">
              <span>今日 API 调用</span>
              <span class="tag">{{ fmt.int(ov.today?.api_calls) }} 次</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const ov = reactive({ products: {}, today: {}, revenue: {}, devices: {} });
    const trend = ref([]);
    const revenue = reactive({ trend: [], byChannel: [], topProducts: [] });

    const fmt = U.fmt;
    const icon = (n) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">${U.icons[n]}</svg>`;

    const trendChart = computed(() => U.lineChart(trend.value, {
      keys: [
        { key: 'downloads', color: '#2563eb', name: '下载' },
        { key: 'installs', color: '#16a34a', name: '安装' },
      ],
    }));

    const revenueChart = computed(() => U.barChart(
      (revenue.trend || []).map((r) => ({ label: r.date.slice(5), value: r.revenue })),
      { color: '#7c3aed' }
    ));

    const channelChart = computed(() => {
      const colors = { wxpay: '#16a34a', alipay: '#2563eb', simulate: '#d97706', balance: '#7c3aed' };
      const names = { wxpay: '微信支付', alipay: '支付宝', simulate: '模拟支付', balance: '余额' };
      const items = (revenue.byChannel || []).map((c) => ({
        name: names[c.name] || c.name || '未支付',
        value: c.amount,
        color: colors[c.name] || '#8a93a6',
      }));
      return items.length ? U.donut(items) : '<div class="empty">暂无支付数据</div>';
    });

    onMounted(async () => {
      try {
        const o = await U.api.get('/api/stats/overview');
        Object.assign(ov, o);
        const t = await U.api.get('/api/stats/trend?days=14');
        trend.value = t.list || [];
        const r = await U.api.get('/api/stats/revenue?days=14');
        Object.assign(revenue, r);
      } catch (e) {
        U.toast(e.message, 'error');
      }
    });

    return { ov, trend, revenue, fmt, icon, trendChart, revenueChart, channelChart };
  },
};
})();

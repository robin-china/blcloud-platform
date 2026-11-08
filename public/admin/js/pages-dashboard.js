(function () {
const { ref, reactive, onMounted, computed } = Vue;

window.PageDashboard = {
  template: `
  <div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:12px">
      <button class="btn sm" :disabled="resetting" @click="resetStats">{{ resetting ? '处理中…' : '清零演示统计' }}</button>
    </div>
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

    <div style="display:flex;align-items:center;justify-content:space-between;margin:4px 0 10px">
      <h3 style="margin:0;font-size:15px">应用接入</h3>
      <span class="tag brand">软件端 open API</span>
    </div>
    <div class="grid g4" style="margin-bottom:16px">
      <div class="stat">
        <div class="label">接入应用</div>
        <div class="value">{{ fmt.int(acc.apps?.active) }} / {{ fmt.int(acc.apps?.total) }}</div>
        <div class="delta">启用 / 总数</div>
        <div class="icon" v-html="icon('plug')"></div>
      </div>
      <div class="stat">
        <div class="label">在线客户端</div>
        <div class="value">{{ fmt.int(acc.sessions?.online) }}</div>
        <div class="delta">今日活跃 {{ fmt.int(acc.sessions?.today_sessions) }} 台 · {{ fmt.int(acc.sessions?.online_users) }} 人</div>
        <div class="icon" v-html="icon('device')"></div>
      </div>
      <div class="stat">
        <div class="label">今日 API 调用</div>
        <div class="value">{{ fmt.int(acc.calls?.total_today) }}</div>
        <div class="delta">应用 {{ fmt.int(acc.calls?.open_today) }} · 设备 {{ fmt.int(acc.calls?.device_today) }}</div>
        <div class="icon" v-html="icon('api')"></div>
      </div>
      <div class="stat">
        <div class="label">累计 API 调用</div>
        <div class="value">{{ fmt.int(acc.calls?.total) }}</div>
        <div class="delta" :style="acc.calls?.device_fail_today ? 'color:var(--danger)' : ''">今日设备失败 {{ fmt.int(acc.calls?.device_fail_today) }} 次</div>
        <div class="icon" v-html="icon('cloud')"></div>
      </div>
    </div>

    <div class="grid g2" style="margin-bottom:16px">
      <div class="card">
        <div class="card-head"><h3>API 调用趋势</h3><span class="tag brand">近 14 天</span></div>
        <div class="card-body" v-html="apiChart"></div>
      </div>
      <div class="card">
        <div class="card-head">
          <h3>各应用接入情况</h3>
          <span class="tag" v-if="acc.updates">今日升级 检查 {{ fmt.int(acc.updates.check) }} · 成功 {{ fmt.int(acc.updates.success) }} · 失败 {{ fmt.int(acc.updates.fail) }}</span>
        </div>
        <div class="card-body tight">
          <div class="row-list" style="padding:6px 18px">
            <div class="row-item" v-for="a in acc.byApp || []" :key="a.id">
              <div style="min-width:0">
                <div style="font-weight:500;display:flex;align-items:center;gap:6px">
                  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ a.name }}</span>
                  <span class="tag" v-if="a.status !== 'active'">已停用</span>
                  <span class="tag" v-else-if="a.version">v{{ a.version }}</span>
                </div>
                <div style="color:var(--text-3);font-size:12px">
                  在线 {{ fmt.int(a.online) }} · 用户 {{ fmt.int(a.users) }} · 授权 {{ fmt.int(a.licenses) }}
                </div>
              </div>
              <span class="tag brand">今日 {{ fmt.int(a.calls_today) }} / 共 {{ fmt.int(a.calls) }}</span>
            </div>
            <div class="empty" v-if="!(acc.byApp || []).length">还没有接入应用，去「接入应用」创建一个</div>
          </div>
        </div>
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
    const acc = reactive({ apps: {}, sessions: {}, calls: {}, updates: null, byApp: [], trend: [] });
    const resetting = ref(false);

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

    const apiChart = computed(() => U.lineChart(acc.trend || [], {
      keys: [
        { key: 'open', color: '#2563eb', name: '应用 API' },
        { key: 'device', color: '#16a34a', name: '设备 API' },
      ],
    }));

    async function loadAll() {
      const o = await U.api.get('/api/stats/overview');
      Object.assign(ov, o);
      const t = await U.api.get('/api/stats/trend?days=14');
      trend.value = t.list || [];
      const r = await U.api.get('/api/stats/revenue?days=14');
      Object.assign(revenue, r);
      const a = await U.api.get('/api/stats/apps?days=14');
      Object.assign(acc, a);
    }

    /**
     * 早期演示数据里塞了假的下载/安装/活跃与趋势曲线。这里给一个显式入口：
     * 下载/安装/活跃归 0、趋势清空、销量按已支付订单重算（真卖出去的不抹）。
     */
    async function resetStats() {
      const ok = await U.confirm(
        '将把商品的累计下载、安装、活跃数字清零，并清空趋势曲线。\n销量会按已支付订单重新计算，不会抹掉真实成交。确定继续？',
        { danger: true, okText: '清零' }
      );
      if (!ok) return;
      resetting.value = true;
      try {
        const r = await U.api.post('/api/stats/reset', { real_sales: true });
        U.toast(`已清零：下载 ${r.before.d} → ${r.after.d}，趋势清空 ${r.trend_rows_removed} 行`, 'success');
        await loadAll();
      } catch (e) {
        U.toast(U.failMsg(e, '清零失败'), 'error');
      } finally {
        resetting.value = false;
      }
    }

    onMounted(async () => {
      try {
        await loadAll();
      } catch (e) {
        U.toast(e.message, 'error');
      }
    });

    return { ov, trend, revenue, acc, resetting, fmt, icon, trendChart, revenueChart, channelChart, apiChart, resetStats };
  },
};
})();

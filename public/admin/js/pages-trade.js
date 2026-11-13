(function () {
const { ref, reactive, onMounted, computed } = Vue;

const STATUS_MAP = {
  pending: { text: '待支付', cls: 'warning' },
  paid: { text: '已支付', cls: 'success' },
  refunded: { text: '已退款', cls: 'danger' },
  closed: { text: '已关闭', cls: '' },
};
const CHANNEL_MAP = { wxpay: '微信支付', alipay: '支付宝', simulate: '模拟支付', balance: '余额' };

window.PageOrders = {
  template: `
  <div>
    <div class="toolbar">
      <input class="input" v-model="q" placeholder="订单号 / 用户 / 交易号" @keyup.enter="load" />
      <select class="select" v-model="status">
        <option value="">全部状态</option>
        <option value="pending">待支付</option>
        <option value="paid">已支付</option>
        <option value="refunded">已退款</option>
        <option value="deleted">已删除</option>
      </select>
      <select class="select" v-model="channel">
        <option value="">全部渠道</option>
        <option value="wxpay">微信支付</option>
        <option value="alipay">支付宝</option>
        <option value="simulate">模拟支付</option>
      </select>
      <button class="btn" @click="load">查询</button>
      <button class="btn danger" @click="purge">清理 7 天前未付款</button>
    </div>

    <div class="card">
      <div class="card-body tight">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>订单号</th><th>用户</th><th>商品</th><th>金额</th><th>渠道</th><th>状态</th><th>下单时间</th><th style="width:190px">操作</th></tr></thead>
            <tbody>
              <tr v-for="o in list" :key="o.id">
                <td style="font-family:ui-monospace,monospace;font-size:12.5px">{{ o.order_no }}</td>
                <td>{{ o.nickname || '-' }}<div style="color:var(--text-3);font-size:12px">{{ o.phone || '' }}</div></td>
                <td>
                  <div v-for="it in o.items" :key="it.product_id" style="font-size:12.5px">
                    {{ it.product_name }} × {{ it.qty }}
                  </div>
                  <div v-if="deliverText(o)" style="color:var(--text-3);font-size:12px;margin-top:4px">已发：{{ deliverText(o) }}</div>
                  <div v-else-if="o.status==='paid'" style="color:var(--danger);font-size:12px;margin-top:4px">未发放任何内容</div>
                </td>
                <td>{{ fmt.money(o.pay_amount) }}<div v-if="o.discount" style="color:var(--text-3);font-size:12px">已抵 {{ fmt.money(o.discount) }}</div></td>
                <td>{{ channelName(o.channel) }}</td>
                <td><span class="tag" :class="statusCls(o)">{{ statusText(o) }}</span></td>
                <td>{{ fmt.time(o.created_at) }}</td>
                <td>
                  <div class="table-actions">
                    <button class="btn sm" @click="open(o)">详情</button>
                    <button class="btn sm" v-if="o.status==='pending' && !o.deleted_at" @click="simulatePay(o)">标记已付</button>
                    <button class="btn sm" v-if="o.status==='pending' && !o.deleted_at" @click="syncPay(o)">向微信查单</button>
                    <button class="btn sm" v-if="o.status==='paid'" @click="deliver(o)">补发授权</button>
                    <button class="btn sm danger" v-if="o.status==='paid'" @click="refund(o)">退款</button>
                    <button class="btn sm danger" v-if="o.status==='pending' && !o.deleted_at" @click="remove(o)">删除</button>
                    <button class="btn sm" v-if="o.deleted_at" @click="restore(o)">恢复</button>
                  </div>
                </td>
              </tr>
              <tr v-if="!list.length"><td colspan="8"><div class="empty">暂无订单</div></td></tr>
            </tbody>
          </table>
        </div>
        <div class="pager">
          <span>共 {{ total }} 条</span>
          <button class="btn sm" :disabled="page<=1" @click="page--;load()">上一页</button>
          <span>{{ page }} / {{ pages }}</span>
          <button class="btn sm" :disabled="page>=pages" @click="page++;load()">下一页</button>
        </div>
      </div>
    </div>

    <div class="drawer-mask" v-if="detail" @click.self="detail=null">
      <div class="drawer">
        <div class="modal-head"><h3>订单详情</h3><button class="close-x" @click="detail=null">&times;</button></div>
        <div class="modal-body">
          <div class="kv">
            <div class="k">订单号</div><div>{{ detail.order.order_no }}</div>
            <div class="k">状态</div><div><span class="tag" :class="statusCls(detail.order)">{{ statusText(detail.order) }}</span></div>
            <div class="k">用户</div><div>{{ detail.user?.nickname || '-' }} {{ detail.user?.phone || '' }}</div>
            <div class="k">应付金额</div><div>{{ fmt.money(detail.order.pay_amount) }}</div>
            <div class="k">优惠</div><div>{{ fmt.money(detail.order.discount) }}</div>
            <div class="k">支付渠道</div><div>{{ channelName(detail.order.channel) }}</div>
            <div class="k">交易号</div><div>{{ detail.order.trade_no || '-' }}</div>
            <div class="k">下单时间</div><div>{{ fmt.time(detail.order.created_at) }}</div>
            <div class="k">支付时间</div><div>{{ fmt.time(detail.order.paid_at) }}</div>
            <div class="k">发货结果</div>
            <div>
              <span v-if="deliverText(detail.order)" style="font-size:13px">{{ deliverText(detail.order) }}</span>
              <span v-else-if="detail.order.status==='paid'" style="color:var(--danger);font-size:13px">未发放任何内容</span>
              <span v-else style="color:var(--text-3);font-size:13px">待支付</span>
            </div>
          </div>
          <h4 style="margin:18px 0 8px;font-size:14px">商品明细</h4>
          <table class="table">
            <thead><tr><th>商品</th><th>单价</th><th>数量</th></tr></thead>
            <tbody>
              <tr v-for="it in detail.order.items" :key="it.product_id">
                <td>{{ it.product_name }}</td><td>{{ fmt.money(it.price) }}</td><td>{{ it.qty }}</td>
              </tr>
            </tbody>
          </table>
          <h4 style="margin:18px 0 8px;font-size:14px">支付流水</h4>
          <div class="empty" v-if="!detail.payments.length">暂无流水</div>
          <table class="table" v-else>
            <thead><tr><th>渠道</th><th>交易号</th><th>金额</th><th>时间</th></tr></thead>
            <tbody>
              <tr v-for="p in detail.payments" :key="p.id">
                <td>{{ channelName(p.channel) }}</td><td>{{ p.trade_no }}</td><td>{{ fmt.money(p.amount) }}</td><td>{{ fmt.time(p.created_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const list = ref([]);
    const total = ref(0);
    const page = ref(1);
    const q = ref('');
    const status = ref('');
    const channel = ref('');
    const detail = ref(null);
    const fmt = U.fmt;
    const pages = computed(() => Math.max(1, Math.ceil(total.value / 20)));

    async function load() {
      const res = await U.api.get(`/api/orders?page=${page.value}&pageSize=20&q=${encodeURIComponent(q.value)}&status=${status.value}&channel=${channel.value}`);
      list.value = res.list;
      total.value = res.total;
    }

    async function open(o) {
      detail.value = await U.api.get(`/api/orders/${o.id}`);
    }

    async function simulatePay(o) {
      try {
        await U.api.post(`/api/pay/simulate/${o.order_no}`);
        U.toast('已完成支付并发放授权', 'success');
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    // 回调丢了/失败过时用这条：直接问微信这笔到底付了没有，付了就补齐发货
    async function syncPay(o) {
      try {
        const r = await U.api.post(`/api/orders/${o.id}/sync-pay`, {});
        U.toast(r.notice || '已同步', r.status === 'paid' ? 'success' : 'info');
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    // 补发授权：服务端有幂等保护（已发过的单默认 409），这里确认后带 force 重发。
    // 以前既没 catch 也没 load()：接口一报错就是「点了完全没反应」，
    // 成功了列表也不刷新，管理员看不到任何变化 —— 全是零反馈。
    async function deliver(o, force) {
      try {
        const r = await U.api.post(`/api/orders/${o.id}/deliver`, { force: !!force });
        if (!r.delivered || !r.delivered.length) {
          U.toast('订单已标记补发，但未发放任何内容（商品可能已被删除），请核对商品与授权', 'error');
        } else {
          U.toast(`已发放：${deliverText({ deliver_result: JSON.stringify(r.delivered) })}`, 'success');
        }
        load();
      } catch (e) {
        if (e.data && e.data.code === 'ALREADY_DELIVERED') {
          const ok = await U.confirm(
            `订单 ${o.order_no} 已发放过：${deliverText(o) || '（内容为空）'}\n\n`
            + '再发一次会重复发码 / 重复加额度 / 叠加续期，确定继续？',
            { title: '重复发货确认', okText: '仍然重发' },
          );
          if (ok) return deliver(o, true);
          return;
        }
        U.toast(U.failMsg(e, '补发失败'), 'error');
      }
    }

    async function refund(o) {
      if (!(await U.confirm(`确定退款订单 ${o.order_no}？`))) return;
      try {
        await U.api.post(`/api/orders/${o.id}/refund`, {});
        U.toast('已退款', 'success');
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    // 已删除的未付款订单状态仍是 pending，列表里必须显示「已删除」，
    // 否则管理员看不出这单是被谁清掉的
    const statusText = (o) => (o && o.deleted_at ? '已删除' : (STATUS_MAP[o && o.status]?.text || (o && o.status) || ''));
    const statusCls = (o) => (o && o.deleted_at ? 'danger' : (STATUS_MAP[o && o.status]?.cls || ''));
    const channelName = (c) => CHANNEL_MAP[c] || c || '-';
    // 订单「已支付」不等于「已发货」：额度包发的是 API 调用次数而不是授权码，
    // 管理员必须能在列表里一眼看到发了什么，否则客服无法应答
    function deliverText(o) {
      let arr = [];
      try { arr = JSON.parse(o.deliver_result || '[]'); } catch { arr = []; }
      if (!Array.isArray(arr) || !arr.length) return '';
      return arr.map((c) => {
        if (c.type === 'api_quota') return `API 额度 ${c.quota} 次（余额 ${c.after}）`;
        if (c.type === 'license') return `授权码 ${c.license_key}`;
        // 续费/升级单不发新码（沿用原授权），漏掉这两个分支时订单在后台
        // 永远显示「未发放任何内容」，管理员会反复点补发 → 每次叠加一年
        if (c.type === 'license_renew') return `授权 ${c.license_key} 续期 ${c.days} 天`;
        if (c.type === 'license_upgrade') return `授权 ${c.license_key} 升级为 ${c.product}`;
        if (c.type === 'device') return `设备 ${c.sn}`;
        if (c.type === 'points') return `积分 +${c.points}（余额 ${c.balance}）`;
        return '';
      }).filter(Boolean).join('，');
    }

    onMounted(load);
    // 只清未付款订单，而且是软删除：二维码可能已经发出去了，
    // 用户事后扫码付钱时回调必须还能找到这笔订单（付了会自动恢复）
    async function remove(o) {
      if (!(await U.confirm(`删除未付款订单 ${o.order_no}？\n会从用户端和后台列表消失，记录仍保留：用户若事后扫码付了款，回调会自动恢复这笔订单。`))) return;
      try {
        const r = await U.api.del(`/api/orders/${o.id}`);
        U.toast(r.points_back > 0 ? `已删除，退回用户 ${r.points_back} 积分` : '已删除', 'success');
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function restore(o) {
      try {
        await U.api.post(`/api/orders/${o.id}/restore`, {});
        U.toast('已恢复到待支付', 'success');
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function purge() {
      if (!(await U.confirm('清理 7 天前仍未支付的订单？\n只会从列表移除，记录保留，之后付了款会自动恢复。'))) return;
      try {
        const r = await U.api.post('/api/orders/purge-pending', { days: 7 });
        U.toast(`已清理 ${r.count} 条`, r.count ? 'success' : 'info');
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    return { list, total, page, pages, q, status, channel, detail, fmt, load, open, simulatePay, syncPay, deliver, refund, remove, restore, purge, statusText, statusCls, channelName, deliverText };
  },
};

window.PageRevenue = {
  template: `
  <div>
    <div class="grid g3" style="margin-bottom:16px">
      <div class="stat"><div class="label">累计收入</div><div class="value">{{ fmt.money(ov.revenue?.total) }}</div><div class="delta">{{ fmt.int(ov.revenue?.count) }} 笔已支付</div></div>
      <div class="stat"><div class="label">近 30 天收入</div><div class="value">{{ fmt.money(ov.revenue?.month) }}</div><div class="delta">今日 {{ fmt.money(ov.today?.revenue) }}</div></div>
      <div class="stat"><div class="label">客单价</div><div class="value">{{ fmt.money(avg) }}</div><div class="delta">按已支付订单计算</div></div>
    </div>
    <div class="grid g2">
      <div class="card">
        <div class="card-head"><h3>收入趋势</h3><span class="tag brand">近 30 天</span></div>
        <div class="card-body" v-html="revenueChart"></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>渠道分布</h3></div>
        <div class="card-body" v-html="channelChart"></div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>产品销量排行</h3></div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>产品</th><th>类型</th><th>累计销量</th><th>活跃用户</th></tr></thead>
            <tbody>
              <tr v-for="p in data.topProducts || []" :key="p.name">
                <td>{{ p.name }}</td>
                <td><span class="tag">{{ p.type === 'hardware' ? '硬件' : p.type === 'software' ? '软件' : '服务' }}</span></td>
                <td>{{ fmt.int(p.total_sales) }}</td>
                <td>{{ fmt.int(p.active_users) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const data = reactive({ trend: [], byChannel: [], topProducts: [] });
    const ov = reactive({ revenue: {}, today: {} });
    const fmt = U.fmt;
    const avg = computed(() => (ov.revenue?.count ? ov.revenue.total / ov.revenue.count : 0));
    const revenueChart = computed(() => U.barChart((data.trend || []).map((r) => ({ label: r.date.slice(5), value: r.revenue })), { color: '#2563eb' }));
    const channelChart = computed(() => {
      const colors = { wxpay: '#16a34a', alipay: '#2563eb', simulate: '#d97706' };
      const names = { wxpay: '微信支付', alipay: '支付宝', simulate: '模拟支付' };
      const items = (data.byChannel || []).map((c) => ({ name: names[c.name] || c.name, value: c.amount, color: colors[c.name] || '#8a93a6' }));
      return items.length ? U.donut(items) : '<div class="empty">暂无支付数据</div>';
    });
    onMounted(async () => {
      Object.assign(data, await U.api.get('/api/stats/revenue?days=30'));
      Object.assign(ov, await U.api.get('/api/stats/overview'));
    });
    return { data, ov, fmt, avg, revenueChart, channelChart };
  },
};

window.PageApiUsage = {
  template: `
  <div>
    <div class="grid g3" style="margin-bottom:16px">
      <div class="stat"><div class="label">累计 API 调用</div><div class="value">{{ fmt.int(ov.apiCalls) }}</div><div class="delta">今日 {{ fmt.int(ov.today?.api_calls) }} 次</div></div>
      <div class="stat"><div class="label">活跃密钥</div><div class="value">{{ fmt.int((usage.keys||[]).filter(k=>k.status==='active').length) }}</div><div class="delta">共 {{ fmt.int((usage.keys||[]).length) }} 个</div></div>
      <div class="stat"><div class="label">额度消耗</div><div class="value">{{ usedPercent }}%</div><div class="delta">{{ fmt.int(totalUsed) }} / {{ fmt.int(totalQuota) }} 次</div></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>调用趋势</h3></div>
      <div class="card-body" v-html="usageChart"></div>
    </div>
    <div class="grid g2">
      <div class="card">
        <div class="card-head"><h3>调用 Top 用户</h3></div>
        <div class="card-body tight">
          <table class="table">
            <thead><tr><th>用户</th><th>手机号</th><th>调用次数</th></tr></thead>
            <tbody>
              <tr v-for="u in usage.byUser || []" :key="u.id"><td>{{ u.nickname || '-' }}</td><td>{{ u.phone || '-' }}</td><td>{{ fmt.int(u.calls) }}</td></tr>
              <tr v-if="!(usage.byUser||[]).length"><td colspan="3"><div class="empty">暂无数据</div></td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>接口分布</h3></div>
        <div class="card-body tight">
          <table class="table">
            <thead><tr><th>接口</th><th>调用次数</th></tr></thead>
            <tbody>
              <tr v-for="e in usage.byEndpoint || []" :key="e.endpoint"><td>{{ e.endpoint || '-' }}</td><td>{{ fmt.int(e.calls) }}</td></tr>
              <tr v-if="!(usage.byEndpoint||[]).length"><td colspan="2"><div class="empty">暂无数据</div></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>API 密钥</h3></div>
      <div class="card-body tight">
        <table class="table">
          <thead><tr><th>用户</th><th>密钥</th><th>额度</th><th>已用</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="k in usage.keys || []" :key="k.id">
              <td>{{ k.nickname || '-' }}</td>
              <td style="font-family:ui-monospace,monospace;font-size:12.5px">{{ k.api_key }}</td>
              <td>{{ fmt.int(k.quota) }}</td>
              <td>{{ fmt.int(k.used) }}</td>
              <td><span class="tag" :class="k.status==='active'?'success':''">{{ k.status==='active'?'启用':'停用' }}</span></td>
            </tr>
            <tr v-if="!(usage.keys||[]).length"><td colspan="5"><div class="empty">暂无密钥，用户购买服务类产品后自动生成</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
  `,
  setup() {
    const usage = reactive({ byDay: [], byUser: [], byEndpoint: [], keys: [] });
    const ov = reactive({ apiCalls: 0, today: {} });
    const fmt = U.fmt;
    const totalQuota = computed(() => (usage.keys || []).reduce((s, k) => s + (k.quota || 0), 0));
    const totalUsed = computed(() => (usage.keys || []).reduce((s, k) => s + (k.used || 0), 0));
    const usedPercent = computed(() => (totalQuota.value ? Math.round((totalUsed.value / totalQuota.value) * 100) : 0));
    const usageChart = computed(() => U.lineChart((usage.byDay || []).map((r) => ({ label: r.date.slice(5), value: r.calls })), {
      keys: [{ key: 'value', color: '#0891b2', name: '调用次数' }],
    }));
    onMounted(async () => {
      Object.assign(usage, await U.api.get('/api/stats/api-usage?days=14'));
      Object.assign(ov, await U.api.get('/api/stats/overview'));
    });
    return { usage, ov, fmt, totalQuota, totalUsed, usedPercent, usageChart };
  },
};
})();

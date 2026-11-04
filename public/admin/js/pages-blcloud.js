(function () {
const { ref, computed, onMounted } = Vue;
const fmt = U.fmt;

window.PageAdminBlcloud = {
  template: `
  <div>
    <div class="grid g4" style="margin-bottom:16px">
      <div class="card"><div class="card-body">
        <div class="stat"><div class="label">密钥总数</div><div class="value">{{ stats.keys?.total || 0 }}</div>
          <div class="delta">启用 {{ stats.keys?.active || 0 }} 个</div></div>
      </div></div>
      <div class="card"><div class="card-body">
        <div class="stat"><div class="label">累计调用</div><div class="value">{{ fmt.int(stats.calls?.calls) }}</div>
          <div class="delta">{{ fmt.int(stats.calls?.reqs) }} 次请求</div></div>
      </div></div>
      <div class="card"><div class="card-body">
        <div class="stat"><div class="label">今日调用</div><div class="value">{{ fmt.int(stats.todayCalls) }}</div>
          <div class="delta">失败 {{ fmt.int(stats.calls?.fails) }} 次</div></div>
      </div></div>
      <div class="card"><div class="card-body">
        <div class="stat"><div class="label">已分配额度</div><div class="value">{{ fmt.int(stats.keys?.quota) }}</div>
          <div class="delta">已消耗 {{ fmt.int(stats.keys?.used) }}</div></div>
      </div></div>
    </div>

    <div class="grid g2" style="margin-bottom:16px">
      <div class="card">
        <div class="card-head"><h3>调用趋势（近 14 天）</h3></div>
        <div class="card-body" v-html="chart"></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>额度策略</h3><button class="btn primary sm" @click="saveCfg">保存</button></div>
        <div class="card-body">
          <div class="field"><label>开关</label>
            <select class="input" v-model="cfgForm.enabled">
              <option :value="true">启用 blcloud 接口</option>
              <option :value="false">停用（所有调用拒绝）</option>
            </select>
          </div>
          <div class="field"><label>新用户免费额度（次）</label><input class="input" type="number" v-model="cfgForm.freeQuota" /></div>
          <div class="field"><label>1 积分可兑换调用次数</label><input class="input" type="number" v-model="cfgForm.perPoint" /></div>
          <div class="field"><label>单用户每日上限（0 为不限）</label><input class="input" type="number" v-model="cfgForm.dailyLimit" /></div>
          <div class="hint">免费额度在用户首次使用 blcloud 时一次性发放。</div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>用户额度</h3>
        <div style="display:flex;gap:8px;align-items:center">
          <input class="input" style="width:120px" v-model="adj.userId" placeholder="用户 ID" />
          <input class="input" style="width:120px" v-model="adj.delta" placeholder="增减次数" />
          <input class="input" style="width:180px" v-model="adj.reason" placeholder="备注（可选）" />
          <button class="btn primary sm" @click="adjust">调整</button>
        </div>
      </div>
      <div class="card-body tight">
        <table class="table">
          <thead><tr><th>用户</th><th>OpenID</th><th>总额度</th><th>已用</th><th>剩余</th><th style="width:180px">快捷调整</th></tr></thead>
          <tbody>
            <tr v-for="u in stats.quotaRank" :key="u.id">
              <td>{{ u.nickname || '-' }}</td>
              <td style="font-family:ui-monospace,monospace;font-size:12.5px">{{ u.openid }}</td>
              <td>{{ fmt.int(u.quota) }}</td>
              <td>{{ fmt.int(u.used) }}</td>
              <td>{{ fmt.int(Math.max(0, (u.quota||0) - (u.used||0))) }}</td>
              <td>
                <button class="btn sm" @click="quick(u, 10000)">+1万</button>
                <button class="btn sm" @click="quick(u, 100000)">+10万</button>
              </td>
            </tr>
            <tr v-if="!stats.quotaRank?.length"><td colspan="6"><div class="empty">暂无发放记录</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>API 密钥</h3>
        <input class="input" style="width:240px" v-model="keyQ" placeholder="搜索名称 / 用户 / OpenID" @keyup.enter="loadKeys" />
      </div>
      <div class="card-body tight">
        <table class="table">
          <thead><tr><th>用户</th><th>名称</th><th>密钥</th><th>权限</th><th>额度</th><th>已用</th><th>状态</th><th>最近使用</th><th style="width:140px">操作</th></tr></thead>
          <tbody>
            <tr v-for="k in keys" :key="k.id">
              <td>{{ k.nickname || ('#' + k.user_id) }}</td>
              <td>{{ k.name }}</td>
              <td style="font-family:ui-monospace,monospace;font-size:12.5px">{{ k.prefix }}</td>
              <td><span class="tag">{{ k.scopes && k.scopes.includes('write') ? '读写' : '只读' }}</span></td>
              <td>{{ k.quota > 0 ? fmt.int(k.quota) : '不限' }}</td>
              <td>{{ fmt.int(k.used) }}</td>
              <td><span class="tag" :class="k.status==='active'?'success':'danger'">{{ k.status==='active'?'启用':'停用' }}</span></td>
              <td>{{ fmt.time(k.last_used_at) }}</td>
              <td>
                <button class="btn sm" @click="toggleKey(k)">{{ k.status==='active'?'停用':'启用' }}</button>
                <button class="btn sm" @click="delKey(k)">删除</button>
              </td>
            </tr>
            <tr v-if="!keys.length"><td colspan="9"><div class="empty">暂无密钥</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="grid g2">
      <div class="card">
        <div class="card-head"><h3>调用排行（用户）</h3></div>
        <div class="card-body tight">
          <table class="table">
            <thead><tr><th>用户</th><th>OpenID</th><th>调用次数</th></tr></thead>
            <tbody>
              <tr v-for="u in stats.topUsers" :key="u.id">
                <td>{{ u.nickname || '-' }}</td>
                <td style="font-family:ui-monospace,monospace;font-size:12.5px">{{ u.openid }}</td>
                <td>{{ fmt.int(u.calls) }}</td>
              </tr>
              <tr v-if="!stats.topUsers?.length"><td colspan="3"><div class="empty">暂无数据</div></td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>接口分布</h3></div>
        <div class="card-body tight">
          <table class="table">
            <thead><tr><th>接口</th><th>调用</th><th>失败</th></tr></thead>
            <tbody>
              <tr v-for="e in stats.topEndpoints" :key="e.endpoint">
                <td style="font-family:ui-monospace,monospace;font-size:12.5px">{{ e.endpoint }}</td>
                <td>{{ fmt.int(e.calls) }}</td>
                <td :style="{color:e.fails>0?'var(--danger)':''}">{{ fmt.int(e.fails) }}</td>
              </tr>
              <tr v-if="!stats.topEndpoints?.length"><td colspan="3"><div class="empty">暂无数据</div></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const stats = ref({ keys: {}, calls: {}, daily: [], topUsers: [], topEndpoints: [], quotaRank: [], cfg: {} });
    const keys = ref([]);
    const keyQ = ref('');
    const cfgForm = ref({ enabled: true, freeQuota: 10000, perPoint: 100, dailyLimit: 0 });
    const adj = ref({ userId: '', delta: '', reason: '' });

    const chart = computed(() => U.barChart(
      (stats.value.daily || []).map((d) => ({ label: String(d.date || '').slice(5), value: Number(d.calls) || 0 })),
      { height: 200 }
    ));

    async function loadStats() {
      try {
        const res = await U.api.get('/api/admin/blcloud/stats?days=14');
        stats.value = res;
        cfgForm.value = { ...res.cfg };
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function loadKeys() {
      try {
        const res = await U.api.get(`/api/admin/blcloud/keys?pageSize=20&q=${encodeURIComponent(keyQ.value)}`);
        keys.value = res.list || [];
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function saveCfg() {
      try {
        await U.api.post('/api/admin/blcloud/settings', cfgForm.value);
        U.toast('已保存', 'success');
        loadStats();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function adjust() {
      const uid = Number(adj.value.userId) || 0;
      const d = Number(adj.value.delta) || 0;
      if (!uid || !d) { U.toast('请填写用户 ID 与增减次数', 'error'); return; }
      try {
        const res = await U.api.post('/api/admin/blcloud/quota', { user_id: uid, delta: d, reason: adj.value.reason });
        U.toast(`已调整，当前剩余 ${res.quota.remaining} 次`, 'success');
        adj.value = { userId: '', delta: '', reason: '' };
        loadStats();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function quick(u, delta) {
      adj.value = { userId: String(u.id), delta: String(delta), reason: '平台赠送' };
      adjust();
    }

    async function toggleKey(k) {
      try {
        await U.api.post(`/api/admin/blcloud/keys/${k.id}/status`, { status: k.status === 'active' ? 'revoked' : 'active' });
        loadKeys();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function delKey(k) {
      if (!(await U.confirm('确认删除该密钥？使用该密钥的服务将立即失效。'))) return;
      try {
        await U.api.del(`/api/admin/blcloud/keys/${k.id}`);
        U.toast('已删除', 'success');
        loadKeys();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    onMounted(async () => {
      await loadStats();
      await loadKeys();
    });

    return {
      fmt, stats, keys, keyQ, cfgForm, adj, chart,
      loadStats, loadKeys, saveCfg, adjust, quick, toggleKey, delKey,
    };
  },
};
})();

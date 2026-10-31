(function () {
const { ref, computed, onMounted, watch } = Vue;

function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
      U.toast('已复制', 'success');
      return;
    }
  } catch { /* fallback */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); U.toast('已复制', 'success'); } catch { U.toast('复制失败，请手动选择', 'error'); }
  ta.remove();
}

window.PageUserBlcloud = {
  template: `
  <div>
    <div class="grid g3" style="margin-bottom:16px">
      <div class="card">
        <div class="card-body">
          <div class="stat">
            <div class="label">调用额度剩余</div>
            <div class="value">{{ fmt.int(quota.remaining) }}</div>
            <div class="delta">总额度 {{ fmt.int(quota.total) }} · 已用 {{ fmt.int(quota.used) }}</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-body">
          <div class="stat">
            <div class="label">今日调用</div>
            <div class="value">{{ fmt.int(todayCalls) }}</div>
            <div class="delta">近 14 天 {{ fmt.int(totalCalls) }} 次</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-body">
          <div class="stat">
            <div class="label">API 密钥</div>
            <div class="value">{{ keys.length }}</div>
            <div class="delta">可用密钥 {{ activeKeys }} 个</div>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head">
        <h3>blcloud 物联服务</h3>
        <span class="tag" :class="account.status==='active'?'success':'warning'">{{ account.status==='active'?'已开通':'待开通' }}</span>
      </div>
      <div class="card-body">
        <div class="kv">
          <div class="k">服务状态</div><div>{{ account.status==='active' ? '已开通，您的硬件设备已自动接入' : '开通中 / 待同步' }}</div>
          <div class="k">访问方式</div><div>使用下方生成的 API 密钥，无需任何账号密码</div>
        </div>
        <div class="hint">物联服务由平台自动打通与管理。API 密钥即您访问设备接口的唯一凭证，所有调用计入您的额度。</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head">
        <h3>我的 API 密钥</h3>
        <button class="btn primary sm" @click="showCreate = !showCreate">{{ showCreate ? '收起' : '新建密钥' }}</button>
      </div>
      <div class="card-body" v-if="showCreate">
        <div class="grid g2">
          <div class="field"><label>密钥名称</label><input class="input" v-model="form.name" placeholder="例如：家庭自动化脚本" /></div>
          <div class="field"><label>分配额度（次）</label><input class="input" type="number" v-model="form.quota" placeholder="从账户额度划拨，留空为不限" /></div>
          <div class="field"><label>权限</label>
            <select class="input" v-model="form.scopes">
              <option value="device.read">只读（查询设备与数据）</option>
              <option value="device.read,device.write">读写（含下发指令、上报数据）</option>
            </select>
          </div>
          <div class="field"><label>有效期（天）</label><input class="input" type="number" v-model="form.days" placeholder="留空为长期有效" /></div>
        </div>
        <div class="hint" style="margin-bottom:8px">账户剩余可用额度 {{ fmt.int(quota.remaining) }} 次</div>
        <button class="btn primary" @click="create">生成密钥</button>
      </div>
      <div class="card-body" v-if="newSecret" style="border-top:1px solid var(--border)">
        <div class="hint" style="color:var(--danger);margin-bottom:6px">密钥明文仅显示这一次，请立即保存：</div>
        <div style="display:flex;gap:8px;align-items:center">
          <code style="flex:1;font-family:ui-monospace,monospace;background:var(--surface-2);padding:8px 10px;border-radius:6px;word-break:break-all">{{ newSecret }}</code>
          <button class="btn sm" @click="copy(newSecret)">复制</button>
          <button class="btn sm" @click="newSecret = ''">关闭</button>
        </div>
      </div>
      <div class="card-body tight">
        <table class="table">
          <thead><tr><th>名称</th><th>密钥</th><th>权限</th><th>额度</th><th>已用</th><th>状态</th><th>最近使用</th><th style="width:210px">操作</th></tr></thead>
          <tbody>
            <tr v-for="k in keys" :key="k.id">
              <td>{{ k.name }}</td>
              <td style="font-family:ui-monospace,monospace;font-size:12.5px">{{ k.prefix }}</td>
              <td><span class="tag">{{ k.scopes && k.scopes.includes('write') ? '读写' : '只读' }}</span></td>
              <td>{{ k.quota > 0 ? fmt.int(k.quota) : '不限' }}</td>
              <td>{{ fmt.int(k.used) }}</td>
              <td><span class="tag" :class="k.status==='active'?'success':'danger'">{{ k.status==='active'?'启用':'停用' }}</span></td>
              <td>{{ fmt.time(k.last_used_at) }}</td>
              <td>
                <button class="btn sm" @click="toggle(k)">{{ k.status==='active'?'停用':'启用' }}</button>
                <button class="btn sm" @click="reset(k)">重置</button>
                <button class="btn sm" @click="remove(k)">删除</button>
              </td>
            </tr>
            <tr v-if="!keys.length"><td colspan="8"><div class="empty">还没有密钥，点击右上角「新建密钥」生成</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="grid g2" style="margin-bottom:16px">
      <div class="card">
        <div class="card-head"><h3>近 14 天调用量</h3></div>
        <div class="card-body" v-html="chart"></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>额度明细</h3></div>
        <div class="card-body">
          <div class="kv">
            <div class="k">免费额度</div><div>{{ fmt.int(cfg.freeQuota) }} 次</div>
            <div class="k">积分兑换比例</div><div>1 积分 = {{ cfg.perPoint }} 次</div>
            <div class="k">每日上限</div><div>{{ cfg.dailyLimit ? fmt.int(cfg.dailyLimit) + ' 次' : '不限' }}</div>
          </div>
          <div class="field" style="margin-top:10px"><label>用积分兑换额度（当前 {{ user?.points || 0 }} 积分）</label>
            <div style="display:flex;gap:8px">
              <input class="input" type="number" v-model="exPoints" placeholder="输入积分数量" />
              <button class="btn primary" @click="exchange">兑换</button>
            </div>
          </div>
          <div class="hint">兑换后额度立即到账，可用于所有密钥。</div>
        </div>
      </div>
    </div>

    <div class="grid g2">
      <div class="card">
        <div class="card-head"><h3>接口调用分布</h3></div>
        <div class="card-body tight">
          <table class="table">
            <thead><tr><th>接口</th><th>调用次数</th><th>最近调用</th></tr></thead>
            <tbody>
              <tr v-for="e in byEndpoint" :key="e.endpoint">
                <td style="font-family:ui-monospace,monospace;font-size:12.5px">{{ e.endpoint }}</td>
                <td>{{ fmt.int(e.calls) }}</td>
                <td>{{ fmt.time(e.last) }}</td>
              </tr>
              <tr v-if="!byEndpoint.length"><td colspan="3"><div class="empty">暂无调用记录</div></td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>接入示例</h3></div>
        <div class="card-body">
          <pre style="margin:0;font-size:12px;line-height:1.7;white-space:pre-wrap;background:var(--surface-2);padding:12px;border-radius:8px">curl -X GET "{{ origin }}/api/blcloud/v1/devices" \\
  -H "X-BLC-Key: blc_xxxxxxxxxxxx"

# 读取遥测
curl "{{ origin }}/api/blcloud/v1/devices/{设备ID}/telemetry?keys=temperature,humidity" \\
  -H "X-BLC-Key: blc_xxxxxxxxxxxx"</pre>
          <div class="hint">每次调用按接口计费（普通查询 1 次、下发指令 5 次、签发直连令牌 10 次），失败不计费。</div>
        </div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const user = Vue.inject('user');
    const fmt = U.fmt;
    const data = ref({ quota: { total: 0, used: 0, remaining: 0 }, cfg: {}, keys: [], account: {}, daily: [], byEndpoint: [], todayCalls: 0, recent: [] });
    const showCreate = ref(false);
    const newSecret = ref('');
    const exPoints = ref('');
    const form = ref({ name: '', quota: '', scopes: 'device.read', days: '' });
    const origin = typeof location !== 'undefined' ? location.origin : '';

    const quota = computed(() => data.value.quota || { total: 0, used: 0, remaining: 0 });
    const keys = computed(() => data.value.keys || []);
    const cfg = computed(() => data.value.cfg || {});
    const account = computed(() => data.value.account || {});
    const byEndpoint = computed(() => data.value.byEndpoint || []);
    const todayCalls = computed(() => data.value.todayCalls || 0);
    const totalCalls = computed(() => (data.value.daily || []).reduce((s, d) => s + (Number(d.calls) || 0), 0));
    const activeKeys = computed(() => keys.value.filter((k) => k.status === 'active').length);
    const chart = computed(() => U.barChart(
      (data.value.daily || []).map((d) => ({ label: String(d.date || '').slice(5), value: Number(d.calls) || 0 })),
      { height: 200 }
    ));

    async function load() {
      try {
        data.value = await U.api.get('/api/portal/blcloud/overview');
      } catch (e) { U.toast(e.message || '加载失败', 'error'); }
    }

    async function create() {
      try {
        const res = await U.api.post('/api/portal/blcloud/keys', {
          name: form.value.name || '默认密钥',
          quota: Number(form.value.quota) || 0,
          scopes: form.value.scopes,
          days: form.value.days ? Number(form.value.days) : 0,
        });
        newSecret.value = res.secret;
        showCreate.value = false;
        form.value = { name: '', quota: '', scopes: 'device.read', days: '' };
        U.toast('密钥已生成', 'success');
        load();
      } catch (e) { U.toast(e.message || '创建失败', 'error'); }
    }

    async function toggle(k) {
      try {
        await U.api.post(`/api/portal/blcloud/keys/${k.id}`, { status: k.status === 'active' ? 'revoked' : 'active' });
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function reset(k) {
      if (!confirm('重置后旧密钥立即失效，且该密钥用量清零。确认继续？')) return;
      try {
        const res = await U.api.post(`/api/portal/blcloud/keys/${k.id}/reset`, {});
        newSecret.value = res.secret;
        showCreate.value = false;
        U.toast('已重置', 'success');
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function remove(k) {
      if (!confirm('删除后使用该密钥的服务将立即失效，确认删除？')) return;
      try {
        await U.api.del(`/api/portal/blcloud/keys/${k.id}`);
        U.toast('已删除', 'success');
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function exchange() {
      const p = Number(exPoints.value) || 0;
      if (p <= 0) { U.toast('请输入积分数量', 'error'); return; }
      try {
        const res = await U.api.post('/api/portal/blcloud/exchange', { points: p });
        U.toast(`兑换成功，获得 ${res.gain} 次额度`, 'success');
        exPoints.value = '';
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    onMounted(async () => {
      if (!localStorage.getItem('user_token')) { location.hash = '#/login'; return; }
      load();
    });

    return {
      user, fmt, data, quota, keys, cfg, account, byEndpoint, todayCalls, totalCalls, activeKeys, chart,
      showCreate, newSecret, form, exPoints, origin, create, toggle, reset, remove, exchange, copy: copyText,
    };
  },
};
})();

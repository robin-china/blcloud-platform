(function () {
const { ref, reactive, onMounted, computed } = Vue;

window.PageUsers = {
  template: `
  <div>
    <div class="toolbar">
      <input class="input" v-model="q" placeholder="昵称 / 手机号 / OpenID / blcloud 账户" @keyup.enter="load" />
      <select class="select" v-model="status">
        <option value="">全部状态</option><option value="active">正常</option><option value="disabled">已禁用</option>
      </select>
      <button class="btn" @click="load">查询</button>
    </div>

    <div class="card">
      <div class="card-body tight">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>用户</th><th>OpenID</th><th>手机</th><th>积分</th><th>blcloud 账户</th><th>授权</th><th>设备</th><th>消费</th><th>状态</th><th style="width:120px">操作</th></tr></thead>
            <tbody>
              <tr v-for="u in list" :key="u.id">
                <td>
                  <div style="display:flex;align-items:center;gap:9px">
                    <div class="avatar">{{ (u.nickname||'U').slice(0,1) }}</div>
                    <div><div style="font-weight:500">{{ u.nickname || '未设置' }}</div>
                    <div style="color:var(--text-3);font-size:12px">{{ fmt.ago(u.last_login_at) }}活跃</div></div>
                  </div>
                </td>
                <td style="font-family:ui-monospace,monospace;font-size:12px">{{ (u.openid||'-').slice(0,14) }}</td>
                <td>{{ u.phone || '-' }}</td>
                <td>{{ fmt.int(u.points) }}</td>
                <td>
                  <div v-if="u.tb_username" style="font-size:12.5px">{{ u.tb_username }}</div>
                  <span class="tag" :class="u.tb_status==='active'?'success':u.tb_status==='error'?'danger':'warning'">
                    {{ tbText(u.tb_status) }}
                  </span>
                </td>
                <td>{{ u.license_count }}</td>
                <td>{{ u.device_count }}</td>
                <td>{{ fmt.money(u.total_paid) }}</td>
                <td><span class="tag" :class="u.status==='active'?'success':'danger'">{{ u.status==='active'?'正常':'禁用' }}</span></td>
                <td>
                  <div class="table-actions">
                    <button class="btn sm" @click="open(u)">详情</button>
                  </div>
                </td>
              </tr>
              <tr v-if="!list.length"><td colspan="10"><div class="empty">暂无用户</div></td></tr>
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
        <div class="modal-head">
          <h3>{{ detail.user.nickname || '用户详情' }}</h3>
          <button class="close-x" @click="detail=null">&times;</button>
        </div>
        <div class="modal-body">
          <div class="tabs">
            <button :class="tab==='base'?'active':''" @click="tab='base'">资料</button>
            <button :class="tab==='license'?'active':''" @click="tab='license'">授权</button>
            <button :class="tab==='device'?'active':''" @click="tab='device'">硬件</button>
            <button :class="tab==='order'?'active':''" @click="tab='order'">订单</button>
            <button :class="tab==='point'?'active':''" @click="tab='point'">积分</button>
          </div>

          <div v-if="tab==='base'">
            <div class="kv">
              <div class="k">用户 ID</div><div>{{ detail.user.id }}</div>
              <div class="k">OpenID</div><div style="font-family:ui-monospace,monospace;font-size:12.5px">{{ detail.user.openid || '-' }}</div>
              <div class="k">手机号</div><div>{{ detail.user.phone || '未绑定' }}</div>
              <div class="k">积分</div><div>{{ fmt.int(detail.user.points) }}</div>
              <div class="k">API 额度</div>
              <div>总额 {{ fmt.int(detail.user.blcloud_quota) }} 次 · 已用 {{ fmt.int(detail.user.blcloud_used) }} 次 · 剩余 {{ fmt.int(Math.max((detail.user.blcloud_quota||0)-(detail.user.blcloud_used||0),0)) }} 次</div>
              <div class="k">注册时间</div><div>{{ fmt.time(detail.user.created_at) }}</div>
              <div class="k">blcloud 账户</div><div>{{ detail.user.tb_username || '未开通' }}</div>
              <div class="k">blcloud 密码</div><div style="font-family:ui-monospace,monospace">{{ detail.user.tb_password || '-' }}</div>
              <div class="k">blcloud 状态</div><div><span class="tag" :class="detail.user.tb_status==='active'?'success':'warning'">{{ tbText(detail.user.tb_status) }}</span></div>
            </div>
            <div class="btn-group" style="margin-top:16px">
              <button class="btn primary" @click="provisionTb">开通 / 同步 blcloud 账户</button>
              <button class="btn" @click="adjustPoints">调整积分</button>
              <button class="btn" :class="detail.user.status==='active'?'':'primary'" @click="toggleStatus">
                {{ detail.user.status==='active' ? '禁用账号' : '启用账号' }}
              </button>
            </div>
            <div class="field" style="margin-top:16px">
              <label>绑定硬件（SN）</label>
              <div style="display:flex;gap:8px">
                <input class="input" v-model="newSn" placeholder="输入设备 SN" />
                <button class="btn primary" @click="bindDevice">绑定</button>
              </div>
              <div class="hint">绑定后该硬件归入此用户名下，并同步创建 blcloud 设备</div>
            </div>
          </div>

          <div v-else-if="tab==='license'">
            <div class="empty" v-if="!detail.licenses.length">暂无授权</div>
            <table class="table" v-else>
              <thead><tr><th>产品</th><th>授权码</th><th>类型</th><th>有效期</th><th>状态</th></tr></thead>
              <tbody>
                <tr v-for="l in detail.licenses" :key="l.id">
                  <td>{{ l.product_name }}</td>
                  <td style="font-family:ui-monospace,monospace;font-size:12px">{{ l.license_key }}</td>
                  <td>{{ l.type==='permanent'?'永久':'订阅' }}</td>
                  <td>{{ l.end_at ? fmt.date(l.end_at) : '永久' }}</td>
                  <td><span class="tag" :class="l.status==='active'?'success':'danger'">{{ l.status==='active'?'有效':'失效' }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-else-if="tab==='device'">
            <div class="empty" v-if="!detail.devices.length">暂无硬件</div>
            <table class="table" v-else>
              <thead><tr><th>名称</th><th>SN</th><th>型号</th><th>状态</th><th>绑定时间</th><th></th></tr></thead>
              <tbody>
                <tr v-for="d in detail.devices" :key="d.id">
                  <td>{{ d.name }}</td>
                  <td style="font-family:ui-monospace,monospace;font-size:12px">{{ d.sn }}</td>
                  <td>{{ d.model || '-' }}</td>
                  <td><span class="tag" :class="d.status==='online'?'success':''">{{ d.status==='online'?'在线':'离线' }}</span></td>
                  <td>{{ fmt.date(d.bound_at) }}</td>
                  <td><button class="btn sm danger" @click="removeDevice(d)">移除</button></td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-else-if="tab==='order'">
            <div class="empty" v-if="!detail.orders.length">暂无订单</div>
            <table class="table" v-else>
              <thead><tr><th>订单号</th><th>金额</th><th>状态</th><th>时间</th></tr></thead>
              <tbody>
                <tr v-for="o in detail.orders" :key="o.id">
                  <td style="font-family:ui-monospace,monospace;font-size:12px">{{ o.order_no }}</td>
                  <td>{{ fmt.money(o.pay_amount) }}</td>
                  <td>{{ o.status }}</td>
                  <td>{{ fmt.time(o.created_at) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-else>
            <div class="empty" v-if="!detail.points.length">暂无积分记录</div>
            <table class="table" v-else>
              <thead><tr><th>变动</th><th>余额</th><th>原因</th><th>时间</th></tr></thead>
              <tbody>
                <tr v-for="p in detail.points" :key="p.id">
                  <td :style="{color: p.change>0?'var(--success)':'var(--danger)'}">{{ p.change>0?'+':'' }}{{ p.change }}</td>
                  <td>{{ p.balance }}</td>
                  <td>{{ p.reason }}</td>
                  <td>{{ fmt.time(p.created_at) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
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
    const detail = ref(null);
    const tab = ref('base');
    const newSn = ref('');
    const fmt = U.fmt;
    const pages = computed(() => Math.max(1, Math.ceil(total.value / 20)));

    async function load() {
      const res = await U.api.get(`/api/users?page=${page.value}&pageSize=20&q=${encodeURIComponent(q.value)}&status=${status.value}`);
      list.value = res.list;
      total.value = res.total;
    }

    async function open(u) {
      tab.value = 'base';
      detail.value = await U.api.get(`/api/users/${u.id}`);
    }

    async function reloadDetail() {
      detail.value = await U.api.get(`/api/users/${detail.value.user.id}`);
    }

    async function provisionTb() {
      try {
        const res = await U.api.post(`/api/users/${detail.value.user.id}/tb-provision`, {});
        U.toast(`blcloud 账户：${res.tb.username}（${res.tb.message}）`, 'success');
        await reloadDetail();
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function adjustPoints() {
      const v = prompt('积分变动（正数为增加，负数为扣减）', '10');
      if (v == null) return;
      const reason = prompt('变动原因', '管理员调整') || '管理员调整';
      await U.api.post(`/api/users/${detail.value.user.id}/points`, { change: Number(v), reason });
      U.toast('已调整', 'success');
      await reloadDetail();
      load();
    }

    async function toggleStatus() {
      await U.api.post(`/api/users/${detail.value.user.id}/status`, { status: detail.value.user.status === 'active' ? 'disabled' : 'active' });
      await reloadDetail();
      load();
    }

    async function bindDevice() {
      if (!newSn.value.trim()) return;
      try {
        await U.api.post(`/api/users/${detail.value.user.id}/devices`, { sn: newSn.value.trim() });
        U.toast('已绑定', 'success');
        newSn.value = '';
        await reloadDetail();
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function removeDevice(d) {
      if (!confirm(`移除硬件 ${d.sn}？`)) return;
      await U.api.del(`/api/devices/${d.id}`);
      await reloadDetail();
      load();
    }

    function tbText(s) {
      return { active: '已开通', pending: '待激活', error: '异常', none: '未开通' }[s] || '未开通';
    }

    onMounted(load);
    return { list, total, page, pages, q, status, detail, tab, newSn, fmt, load, open, provisionTb, adjustPoints, toggleStatus, bindDevice, removeDevice, tbText };
  },
};

window.PageLicenses = {
  template: `
  <div>
    <div class="toolbar">
      <input class="input" v-model="q" placeholder="授权码 / 用户 / 产品" @keyup.enter="load" />
      <select class="select" v-model="status">
        <option value="">全部状态</option><option value="active">有效</option><option value="revoked">已吊销</option>
      </select>
      <button class="btn" @click="load">查询</button>
      <div class="spacer"></div>
      <button class="btn primary" @click="openCreate">+ 发放授权</button>
    </div>

    <div class="card">
      <div class="card-body tight">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>授权码</th><th>用户</th><th>产品</th><th>类型</th><th>设备数</th><th>有效期</th><th>状态</th><th style="width:200px">操作</th></tr></thead>
            <tbody>
              <tr v-for="l in list" :key="l.id">
                <td style="font-family:ui-monospace,monospace;font-size:12.5px">{{ l.license_key }}</td>
                <td>{{ l.nickname || '-' }}<div style="color:var(--text-3);font-size:12px">{{ l.phone || '' }}</div></td>
                <td>{{ l.product_name }}</td>
                <td>{{ l.type==='permanent'?'永久':'订阅' }}</td>
                <td>{{ l.bound_devices }} / {{ l.max_devices }}</td>
                <td>{{ l.end_at ? fmt.date(l.end_at) : '永久' }}</td>
                <td><span class="tag" :class="l.status==='active'?'success':'danger'">{{ l.status==='active'?'有效':'已吊销' }}</span></td>
                <td>
                  <div class="table-actions">
                    <button class="btn sm" @click="extend(l)">续期</button>
                    <button class="btn sm" v-if="l.status==='active'" @click="revoke(l)">吊销</button>
                    <button class="btn sm" v-else @click="resume(l)">恢复</button>
                    <button class="btn sm danger" @click="remove(l)">删除</button>
                  </div>
                </td>
              </tr>
              <tr v-if="!list.length"><td colspan="8"><div class="empty">暂无授权记录</div></td></tr>
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

    <div class="mask" v-if="editing" @click.self="editing=false">
      <div class="modal">
        <div class="modal-head"><h3>发放授权</h3><button class="close-x" @click="editing=false">&times;</button></div>
        <div class="modal-body">
          <div class="field"><label>选择用户</label>
            <select class="select" v-model="form.user_id">
              <option v-for="u in users" :key="u.id" :value="u.id">{{ u.nickname || '未命名' }} · {{ u.phone || u.openid }}</option>
            </select>
          </div>
          <div class="field"><label>选择产品</label>
            <select class="select" v-model="form.product_id">
              <option v-for="p in products" :key="p.id" :value="p.id">{{ p.name }}（{{ p.type==='hardware'?'硬件':p.type==='software'?'软件':'服务' }}）</option>
            </select>
          </div>
          <div class="field-row">
            <div class="field"><label>授权类型</label>
              <select class="select" v-model="form.type"><option value="permanent">永久</option><option value="subscription">订阅</option><option value="trial">试用</option></select>
            </div>
            <div class="field"><label>设备数上限</label><input class="input" type="number" v-model.number="form.max_devices" /></div>
          </div>
          <div class="field" v-if="form.type!=='permanent'"><label>有效天数</label><input class="input" type="number" v-model.number="form.days" /></div>
          <div class="field"><label>备注</label><input class="input" v-model="form.remark" /></div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editing=false">取消</button>
          <button class="btn primary" @click="save">发放</button>
        </div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const list = ref([]);
    const users = ref([]);
    const products = ref([]);
    const total = ref(0);
    const page = ref(1);
    const q = ref('');
    const status = ref('');
    const editing = ref(false);
    const form = reactive({ user_id: '', product_id: '', type: 'permanent', max_devices: 1, days: 365, remark: '' });
    const fmt = U.fmt;
    const pages = computed(() => Math.max(1, Math.ceil(total.value / 20)));

    async function load() {
      const res = await U.api.get(`/api/licenses?page=${page.value}&pageSize=20&q=${encodeURIComponent(q.value)}&status=${status.value}`);
      list.value = res.list;
      total.value = res.total;
    }

    async function openCreate() {
      const u = await U.api.get('/api/users?pageSize=100');
      users.value = u.list;
      const p = await U.api.get('/api/products?pageSize=100');
      products.value = p.list;
      Object.assign(form, { user_id: u.list[0]?.id || '', product_id: p.list[0]?.id || '', type: 'permanent', max_devices: 1, days: 365, remark: '' });
      editing.value = true;
    }

    async function save() {
      try {
        const res = await U.api.post('/api/licenses', form);
        U.toast(`授权已发放：${res.license_key}`, 'success');
        editing.value = false;
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function extend(l) {
      const d = prompt('续期天数', '30');
      if (d == null) return;
      await U.api.post(`/api/licenses/${l.id}/extend`, { days: Number(d) });
      U.toast('已续期', 'success');
      load();
    }

    async function revoke(l) {
      if (!confirm('确定吊销该授权？')) return;
      await U.api.post(`/api/licenses/${l.id}/revoke`, {});
      load();
    }

    async function resume(l) {
      await U.api.post(`/api/licenses/${l.id}/resume`, {});
      load();
    }

    async function remove(l) {
      if (!confirm('确定删除该授权？')) return;
      await U.api.del(`/api/licenses/${l.id}`);
      load();
    }

    onMounted(load);
    return { list, users, products, total, page, pages, q, status, editing, form, fmt, load, openCreate, save, extend, revoke, resume, remove };
  },
};
})();

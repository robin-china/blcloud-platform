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
              <div class="k">blcloud 状态</div><div><span class="tag" :class="detail.user.tb_status==='active'?'success':detail.user.tb_status==='error'?'danger':'warning'">{{ tbText(detail.user.tb_status) }}</span></div>
              <div v-if="detail.user.tb_message" class="k">开通结果</div>
              <div v-if="detail.user.tb_message" style="color:var(--danger, #d93025);font-size:12.5px">{{ detail.user.tb_message }}</div>
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
                  <td>{{ l.product_name }}<div v-if="l.plan_name" style="font-size:12px;color:var(--text-3)">{{ l.plan_name }}</div></td>
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
        const t = res.tb || {};
        // 开通失败时必须把卡住的那一步说出来，只回一句"失败"等于没说
        const failed = (t.steps || []).filter((s) => !s.ok);
        const detailText = failed.length ? `失败步骤：${failed.map((s) => s.name).join(' → ')}｜${failed[failed.length - 1].detail}` : (t.message || '');
        if (t.status === 'active') U.toast(`已开通：${t.username}`, 'success');
        else U.toast(`未开通成功：${detailText}`, 'error');
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
      <input class="input" v-model="q" placeholder="授权码 / 用户 / 产品 / 渠道" @keyup.enter="load" />
      <select class="select" v-model="status" @change="page=1;load()">
        <option value="">全部状态</option>
        <option value="bound">已绑定</option>
        <option value="unassigned">未绑定（卡密池）</option>
        <option value="revoked">已作废</option>
      </select>
      <button class="btn" @click="page=1;load()">查询</button>
      <div class="spacer"></div>
      <button class="btn" @click="openBatches">批次</button>
      <button class="btn" @click="exportCsv">导出 CSV</button>
      <button class="btn primary" @click="openCreate">+ 发放 / 印卡</button>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-body" style="display:flex;gap:26px;flex-wrap:wrap;font-size:13px">
        <div><span style="color:var(--text-3)">已绑定</span> <b>{{ stats.bound || 0 }}</b></div>
        <div><span style="color:var(--text-3)">未绑定（卡密池）</span> <b style="color:var(--warning,#b45309)">{{ stats.unassigned || 0 }}</b></div>
        <div><span style="color:var(--text-3)">已作废</span> <b>{{ stats.revoked || 0 }}</b></div>
        <div style="color:var(--text-3)">卡密池的码「绑定那一刻」才开始计时，印卡后放多久都不损耗有效期</div>
      </div>
    </div>

    <div class="card">
      <div class="card-body tight">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>授权码</th><th>批次 / 渠道</th><th>用户</th><th>产品</th><th>类型</th><th>设备数</th><th>有效期</th><th>状态</th><th style="width:230px">操作</th></tr></thead>
            <tbody>
              <tr v-for="l in list" :key="l.id">
                <td style="font-family:ui-monospace,monospace;font-size:12.5px">{{ l.license_key }}</td>
                <td style="font-size:12px;color:var(--text-3)">
                  {{ l.batch_no || '-' }}<div v-if="l.channel">{{ l.channel }}</div>
                </td>
                <td>
                  <template v-if="l.user_id">{{ l.nickname || '-' }}<div style="color:var(--text-3);font-size:12px">{{ l.phone || '' }}</div></template>
                  <span v-else class="tag warning">未绑定</span>
                </td>
                <td>{{ l.product_name }}<div v-if="l.plan_name" style="font-size:12px;color:var(--text-3)">{{ l.plan_name }}</div></td>
                <td>{{ typeText(l.type) }}<div v-if="l.status==='unassigned' && l.duration_days" style="font-size:12px;color:var(--text-3)">{{ l.duration_days }} 天</div></td>
                <td><button class="btn sm" @click="openDevices(l)" :disabled="!l.user_id">{{ l.bound_devices }} / {{ l.max_devices }}</button></td>
                <td>{{ l.end_at ? fmt.date(l.end_at) : (l.status==='unassigned' ? '绑定后起算' : '永久') }}</td>
                <td>
                  <span class="tag" :class="l.status==='active'?'success':l.status==='unassigned'?'warning':'danger'">{{ statusText(l.status) }}</span>
                </td>
                <td>
                  <div class="table-actions">
                    <button class="btn sm primary" v-if="l.status==='unassigned'" @click="openBind(l)">绑定用户</button>
                    <button class="btn sm" @click="extend(l)">{{ l.status==='unassigned' ? '加时长' : '续期' }}</button>
                    <button class="btn sm" v-if="l.status==='active'" @click="revoke(l)">吊销</button>
                    <button class="btn sm" v-else @click="resume(l)">恢复</button>
                    <button class="btn sm danger" @click="remove(l)">删除</button>
                  </div>
                </td>
              </tr>
              <tr v-if="!list.length"><td colspan="9"><div class="empty">暂无授权记录</div></td></tr>
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
        <div class="modal-head"><h3>发放授权 / 印卡</h3><button class="close-x" @click="editing=false">&times;</button></div>
        <div class="modal-body">
          <div class="field">
            <label>发放方式</label>
            <select class="select" v-model="form.mode">
              <option value="assigned">指定用户（立刻绑定）</option>
              <option value="pool">卡密池（先发码，用户自己绑）</option>
            </select>
          </div>
          <div class="hint" v-if="form.mode==='pool'">
            卡密池的码不带用户、不带到期时间，用户登录后在「我的授权」里绑定，从绑定那一刻开始计时。
          </div>
          <div class="field" v-if="form.mode==='assigned'"><label>选择用户</label>
            <select class="select" v-model="form.user_id">
              <option v-for="u in users" :key="u.id" :value="u.id">{{ u.nickname || '未命名' }} · {{ u.phone || u.openid }}</option>
            </select>
          </div>
          <div class="field"><label>选择产品</label>
            <select class="select" v-model="form.product_id" @change="form.plan_id=''; loadPlans()">
              <option v-for="p in products" :key="p.id" :value="p.id">{{ p.name }}（{{ p.type==='hardware'?'硬件':p.type==='software'?'软件':'服务' }}）</option>
            </select>
          </div>
          <div class="field" v-if="planOptions.length">
            <label>套餐档位（可选，选定后权益自动取档位配置）</label>
            <select class="select" v-model="form.plan_id">
              <option value="">不指定（传统授权：手填类型 / 天数 / 设备数）</option>
              <option v-for="p in planOptions" :key="p.id" :value="p.id">
                {{ p.name }}（{{ p.billing==='period' ? p.period_days + ' 天/期' : p.billing==='once' ? '永久' : '免费' }} · {{ p.max_devices }} 设备）
              </option>
            </select>
          </div>
          <div class="hint" v-if="selectedPlan">
            已选档位 <b>{{ selectedPlan.name }}</b>：类型 <b>{{ selectedPlan.billing==='period' ? '订阅 ' + selectedPlan.period_days + ' 天' : '永久' }}</b>、
            设备上限 <b>{{ selectedPlan.max_devices }}</b>、功能码 {{ (selectedPlan.features || []).length }} 项
            —— 下方手填的类型 / 设备数 / 天数将被忽略，与支付发货的权益完全一致。
          </div>
          <div class="field-row" v-if="!selectedPlan">
            <div class="field"><label>授权类型</label>
              <select class="select" v-model="form.type"><option value="permanent">永久</option><option value="subscription">订阅</option><option value="trial">试用</option></select>
            </div>
            <div class="field"><label>设备数上限</label><input class="input" type="number" v-model.number="form.max_devices" /></div>
          </div>
          <div class="field" v-if="!selectedPlan && form.type!=='permanent'">
            <label>{{ form.mode==='pool' ? '有效天数（绑定后起算）' : '有效天数' }}</label>
            <input class="input" type="number" v-model.number="form.days" />
          </div>
          <div class="field"><label>渠道（可选，如 京东 / 华东代理）</label><input class="input" v-model="form.channel" /></div>
          <div class="field"><label>备注</label><input class="input" v-model="form.remark" /></div>
          <div class="field">
            <label>数量（大于 1 则批量生成，最多 200）</label>
            <input class="input" type="number" min="1" max="200" v-model.number="form.count" />
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editing=false">取消</button>
          <button class="btn primary" @click="save">生成</button>
        </div>
      </div>
    </div>

    <div class="mask" v-if="bindLic" @click.self="bindLic=null">
      <div class="modal" style="max-width:460px">
        <div class="modal-head"><h3>绑定卡密</h3><button class="close-x" @click="bindLic=null">&times;</button></div>
        <div class="modal-body">
          <div class="hint">授权码 <b style="font-family:ui-monospace,monospace">{{ bindLic.license_key }}</b> 绑给哪个用户？绑定后从此刻开始计时。</div>
          <div class="field"><label>用户</label>
            <select class="select" v-model="bindUserId">
              <option v-for="u in users" :key="u.id" :value="u.id">{{ u.nickname || '未命名' }} · {{ u.phone || u.openid }}</option>
            </select>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="bindLic=null">取消</button>
          <button class="btn primary" @click="doBind">绑定</button>
        </div>
      </div>
    </div>

    <div class="mask" v-if="batches" @click.self="batches=null">
      <div class="modal" style="max-width:820px">
        <div class="modal-head"><h3>批次</h3><button class="close-x" @click="batches=null">&times;</button></div>
        <div class="modal-body">
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>批次号</th><th>产品</th><th>渠道</th><th>总数</th><th>已领</th><th>未领</th><th>作废</th><th>创建</th><th style="width:190px">操作</th></tr></thead>
              <tbody>
                <tr v-for="b in batches" :key="b.batch_no">
                  <td style="font-family:ui-monospace,monospace;font-size:12px">{{ b.batch_no }}</td>
                  <td>{{ b.product_name }}</td>
                  <td>{{ b.channel || '-' }}</td>
                  <td>{{ b.total }}</td>
                  <td>{{ b.bound }}</td>
                  <td><b :style="b.unassigned?'color:var(--warning,#b45309)':''">{{ b.unassigned }}</b></td>
                  <td>{{ b.revoked }}</td>
                  <td style="font-size:12px">{{ fmt.date(b.created_at) }}</td>
                  <td>
                    <div class="table-actions">
                      <button class="btn sm" @click="copyBatchKeys(b)">复制未领码</button>
                      <button class="btn sm danger" v-if="b.unassigned" @click="revokeBatch(b)">作废未领</button>
                    </div>
                  </td>
                </tr>
                <tr v-if="!batches.length"><td colspan="9"><div class="empty">还没有批次（单张发放不计批次）</div></td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot"><button class="btn" @click="batches=null">关闭</button></div>
      </div>
    </div>

    <div class="mask" v-if="devLic" @click.self="devLic=null">
      <div class="modal">
        <div class="modal-head"><h3>已绑定机器 · {{ devLic.license_key }}</h3><button class="close-x" @click="devLic=null">&times;</button></div>
        <div class="modal-body">
          <div style="color:var(--text-3);font-size:12.5px;margin-bottom:12px">
            {{ devices.length }} / {{ devLic.max_devices }} 台。解绑后该机器立刻失去会话，需要重新激活。
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>机器码</th><th>名称</th><th>版本</th><th>IP</th><th>最后活跃</th><th style="width:80px"></th></tr></thead>
              <tbody>
                <tr v-for="d in devices" :key="d.id">
                  <td style="font-family:ui-monospace,monospace;font-size:12px">{{ d.device_sn }}</td>
                  <td>{{ d.device_name || '-' }}</td>
                  <td>{{ d.last_version || '-' }}</td>
                  <td style="font-size:12px">{{ d.last_ip || '-' }}</td>
                  <td>{{ d.last_seen_at ? fmt.time(d.last_seen_at) : '-' }}</td>
                  <td><button class="btn sm danger" @click="unbindDevice(d)">解绑</button></td>
                </tr>
                <tr v-if="!devices.length"><td colspan="6"><div class="empty">还没有设备激活这张授权</div></td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot"><button class="btn" @click="devLic=null">关闭</button></div>
      </div>
    </div>

    <div class="mask" v-if="batchResult" @click.self="batchResult=null">
      <div class="modal">
        <div class="modal-head"><h3>已生成 {{ batchResult.count }} 个授权码</h3><button class="close-x" @click="batchResult=null">&times;</button></div>
        <div class="modal-body">
          <div style="color:var(--text-3);font-size:12.5px;margin-bottom:10px">
            {{ batchResult.product }} · 批次 {{ batchResult.batch_no }}
            {{ batchResult.mode==='pool' ? '· 未绑定用户，用户领取后自行绑定' : '' }}
          </div>
          <textarea class="input" style="height:220px;font-family:ui-monospace,monospace;font-size:12px" readonly :value="batchText"></textarea>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="batchResult=null">关闭</button>
          <button class="btn primary" @click="copyBatch">全部复制</button>
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
    const stats = ref({});
    const page = ref(1);
    const q = ref('');
    const status = ref('');
    const editing = ref(false);
    const devLic = ref(null);
    const devices = ref([]);
    const batchResult = ref(null);
    const batches = ref(null);
    const bindLic = ref(null);
    const bindUserId = ref('');
    // 换行必须在 setup 里拼：写进模板会被模板字面量先求值成真实换行，Vue 编译报错
    const batchText = computed(() => (batchResult.value ? batchResult.value.license_keys.join('\n') : ''));
    const form = reactive({
      mode: 'assigned', user_id: '', product_id: '', type: 'permanent',
      max_devices: 1, days: 365, remark: '', count: 1, channel: '', plan_id: '',
    });
    const planOptions = ref([]);
    const selectedPlan = computed(() => planOptions.value.find((p) => String(p.id) === String(form.plan_id)) || null);
    const fmt = U.fmt;
    const pages = computed(() => Math.max(1, Math.ceil(total.value / 20)));
    const typeText = (t) => ({ permanent: '永久', subscription: '订阅', trial: '试用' }[t] || t);
    const statusText = (s) => ({ active: '有效', unassigned: '未绑定', revoked: '已作废' }[s] || s);

    /** 产品联动档位：该产品绑定的接入应用自己的档位（免费档不在此发放） */
    async function loadPlans() {
      planOptions.value = [];
      if (!form.product_id) return;
      try {
        const res = await U.api.get(`/api/plans?product_id=${Number(form.product_id)}`);
        planOptions.value = (res.list || []).filter((p) => p.billing !== 'free' && p.app_id);
      } catch (e) { /* 没配档位就只走传统授权，不打断发码 */ }
    }

    async function load() {
      const res = await U.api.get(`/api/licenses?page=${page.value}&pageSize=20&q=${encodeURIComponent(q.value)}&status=${status.value}`);
      list.value = res.list;
      total.value = res.total;
      stats.value = res.stats || {};
    }

    async function loadRefs() {
      if (users.value.length && products.value.length) return;
      const u = await U.api.get('/api/users?pageSize=100');
      users.value = u.list;
      const p = await U.api.get('/api/products?pageSize=100');
      products.value = p.list;
    }

    async function openCreate() {
      await loadRefs();
      Object.assign(form, {
        mode: 'assigned', user_id: users.value[0] ? users.value[0].id : '',
        product_id: products.value[0] ? products.value[0].id : '',
        type: 'permanent', max_devices: 1, days: 365, remark: '', count: 1, channel: '', plan_id: '',
      });
      await loadPlans();
      editing.value = true;
    }

    async function save() {
      if (!form.product_id) return U.toast('请选择产品', 'error');
      if (form.mode === 'assigned' && !form.user_id) return U.toast('请选择用户，或改为卡密池', 'error');
      const payload = { ...form, plan_id: form.plan_id || undefined };
      if (form.mode === 'pool') payload.user_id = 0;
      try {
        if (Number(form.count) > 1) {
          const res = await U.api.post('/api/licenses/batch', payload);
          batchResult.value = res;
          U.toast(`已生成 ${res.count} 个授权码`, 'success');
        } else {
          const res = await U.api.post('/api/licenses', payload);
          U.toast(res.status === 'unassigned' ? `已生成卡密：${res.license_key}` : `授权已发放：${res.license_key}`, 'success');
        }
        editing.value = false;
        page.value = 1;
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function openBind(l) {
      await loadRefs();
      bindLic.value = l;
      bindUserId.value = users.value[0] ? users.value[0].id : '';
    }

    async function doBind() {
      if (!bindUserId.value) return U.toast('请选择用户', 'error');
      try {
        await U.api.post(`/api/licenses/${bindLic.value.id}/bind`, { user_id: bindUserId.value });
        U.toast('已绑定，有效期从此刻开始计算', 'success');
        bindLic.value = null;
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function openBatches() {
      const res = await U.api.get('/api/licenses/batches');
      batches.value = res.list;
    }

    async function copyBatchKeys(b) {
      const res = await U.api.get(`/api/licenses/batches/${encodeURIComponent(b.batch_no)}/keys?unbound=1`);
      const text = res.list.map((x) => x.license_key).join('\n');
      if (!text) return U.toast('这批没有未领取的码', 'error');
      copyToClipboard(text, `已复制 ${res.list.length} 个未领取的码`);
    }

    function copyToClipboard(text, okMsg) {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text)
          .then(() => U.toast(okMsg, 'success'), () => window.prompt('手动复制', text));
      } else {
        window.prompt('手动复制', text);
      }
    }

    async function revokeBatch(b) {
      if (!confirm(`作废批次 ${b.batch_no} 里 ${b.unassigned} 个还没被领取的码？作废后无法再绑定。`)) return;
      const res = await U.api.post(`/api/licenses/batches/${encodeURIComponent(b.batch_no)}/revoke`, {});
      U.toast(`已作废 ${res.revoked} 个`, 'success');
      openBatches();
      load();
    }

    /* 导出走原生 fetch：U.api 只解析 JSON，拿不到 CSV 流 */
    async function exportCsv() {
      const token = U.api.getToken('admin');
      const qs = new URLSearchParams({ q: q.value, status: status.value });
      const url = `${U.basePath}/api/licenses/export.csv?${qs.toString()}`;
      try {
        const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!res.ok) throw new Error(`导出失败 ${res.status}`);
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `licenses-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        U.toast('已导出当前筛选结果', 'success');
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function openDevices(l) {
      devLic.value = l;
      devices.value = [];
      const res = await U.api.get(`/api/licenses/${l.id}/devices`);
      devices.value = res.list;
    }

    async function unbindDevice(d) {
      if (!confirm(`解绑机器 ${d.device_sn}？该机器的客户端会话会立即失效。`)) return;
      try {
        await U.api.del(`/api/license-devices/${d.id}`);
        U.toast('已解绑', 'success');
        const keep = devLic.value;
        await openDevices(keep);
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    function copyBatch() {
      copyToClipboard(batchResult.value.license_keys.join('\n'), '已复制全部授权码');
    }

    async function extend(l) {
      const d = prompt(l.status === 'unassigned' ? '增加多少天（绑定后生效）' : '续期天数', '30');
      if (d == null) return;
      await U.api.post(`/api/licenses/${l.id}/extend`, { days: Number(d) });
      U.toast('已处理', 'success');
      load();
    }

    async function revoke(l) {
      if (!confirm('确定吊销该授权？该授权下所有机器会立即掉线。')) return;
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
    return { list, users, products, total, stats, page, pages, q, status, editing, form, fmt, load, openCreate, save,
      planOptions, selectedPlan, loadPlans,
      extend, revoke, resume, remove, devLic, devices, batchResult, batchText, openDevices, unbindDevice, copyBatch,
      batches, openBatches, copyBatchKeys, revokeBatch, exportCsv, bindLic, bindUserId, openBind, doBind,
      typeText, statusText };
  },
};
})();

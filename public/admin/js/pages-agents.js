(function () {
const { ref, reactive, onMounted, computed } = Vue;

window.PageAgents = {
  template: `
  <div>
    <div class="toolbar">
      <button class="btn" :class="tab==='agents'?'primary':''" @click="tab='agents';load()">代理商</button>
      <button class="btn" :class="tab==='commissions'?'primary':''" @click="tab='commissions';load()">佣金明细</button>
      <button class="btn" :class="tab==='withdrawals'?'primary':''" @click="tab='withdrawals';load()">提现单</button>
      <button class="btn" :class="tab==='reminders'?'primary':''" @click="tab='reminders';load()">到期提醒</button>
      <button class="btn" :class="tab==='settings'?'primary':''" @click="tab='settings';load()">参数设置</button>
      <div class="spacer"></div>
      <button class="btn" v-if="tab==='withdrawals'" @click="exportCsv">导出 CSV</button>
      <button class="btn" v-if="tab==='reminders'" @click="scanReminders">立即扫描</button>
      <button class="btn primary" v-if="tab==='agents'" @click="openGrant">+ 授权代理商</button>
    </div>

    <div class="card" v-if="tab==='agents'">
      <div class="card-body tight">
        <table class="table">
          <thead><tr><th>ID</th><th>代理商</th><th>邀请码</th><th>佣金比例</th><th>名下用户</th>
            <th>名下成交额</th><th>待结算</th><th>可提现</th><th>已提现</th><th style="width:170px">操作</th></tr></thead>
          <tbody>
            <tr v-for="a in agents" :key="a.id">
              <td>{{ a.id }}</td>
              <td><b>{{ a.nickname || '-' }}</b><div style="font-size:12px;color:var(--text-3)">{{ a.phone || '' }}</div></td>
              <td style="font-family:ui-monospace,monospace;font-size:12px">{{ a.agent_code }}</td>
              <td>{{ (a.agent_rate*100).toFixed(0) }}%</td>
              <td>{{ a.downline_count }}</td>
              <td>{{ fmt.money(a.downline_paid) }}</td>
              <td>{{ fmt.money(a.summary.pending) }}</td>
              <td><b>{{ fmt.money(a.summary.available) }}</b></td>
              <td>{{ fmt.money(a.summary.withdrawn) }}</td>
              <td>
                <div class="table-actions">
                  <button class="btn sm" @click="openDownline(a)">名下用户</button>
                  <button class="btn sm" @click="editRate(a)">改比例</button>
                  <button class="btn sm danger" @click="revoke(a)">暂停</button>
                </div>
              </td>
            </tr>
            <tr v-if="!agents.length"><td colspan="10"><div class="empty">还没有代理商，点右上角「授权代理商」</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" v-if="tab==='commissions'">
      <div class="card-head"><h3>佣金账本</h3><span class="tag">实收 × 比例，退款自动冲正</span></div>
      <div class="card-body tight">
        <table class="table">
          <thead><tr><th>订单号</th><th>代理商</th><th>买家</th><th>实收</th><th>比例</th><th>佣金</th>
            <th>类型</th><th>状态</th><th>可提现时间</th><th>时间</th></tr></thead>
          <tbody>
            <tr v-for="c in commissions" :key="c.id">
              <td style="font-family:ui-monospace,monospace;font-size:12px">{{ c.order_no }}</td>
              <td>{{ c.agent_name || c.agent_user_id }}</td>
              <td>{{ c.buyer_name || c.buyer_user_id }}</td>
              <td>{{ fmt.money(c.base_amount) }}</td>
              <td>{{ (c.rate*100).toFixed(0) }}%</td>
              <td><b>{{ fmt.money(c.amount) }}</b></td>
              <td>{{ c.kind === 'adjustment' ? '退款追回' : '佣金' }}</td>
              <td><span class="tag" :class="statusClass(c.status)">{{ statusText(c.status) }}</span></td>
              <td>{{ c.available_at ? fmt.time(c.available_at) : '-' }}</td>
              <td>{{ fmt.time(c.created_at) }}</td>
            </tr>
            <tr v-if="!commissions.length"><td colspan="10"><div class="empty">暂无佣金记录</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" v-if="tab==='withdrawals'">
      <div class="card-head"><h3>提现单</h3><span class="tag">一期人工审核 / 线下打款</span></div>
      <div class="card-body tight">
        <table class="table">
          <thead><tr><th>单号</th><th>代理商</th><th>金额</th><th>渠道</th><th>状态</th><th>收款账号备注</th>
            <th>申请时间</th><th>审核人</th><th style="width:170px">操作</th></tr></thead>
          <tbody>
            <tr v-for="w in withdrawals" :key="w.id">
              <td style="font-family:ui-monospace,monospace;font-size:12px">{{ w.withdrawal_no }}</td>
              <td>{{ w.nickname || w.agent_user_id }}<div style="font-size:12px;color:var(--text-3)">{{ w.phone || '' }}</div></td>
              <td><b>{{ fmt.money(w.amount) }}</b></td>
              <td>{{ w.channel === 'manual' ? '人工打款' : w.channel }}</td>
              <td><span class="tag" :class="statusClass(w.status)">{{ statusText(w.status) }}</span></td>
              <td>{{ w.pay_account || '-' }}</td>
              <td>{{ fmt.time(w.created_at) }}</td>
              <td>{{ w.reviewed_by || '-' }}</td>
              <td>
                <div class="table-actions" v-if="w.status==='pending'">
                  <button class="btn sm primary" @click="review(w, true)">已打款</button>
                  <button class="btn sm danger" @click="review(w, false)">驳回</button>
                </div>
                <span v-else style="color:var(--text-3);font-size:12px">已处理</span>
              </td>
            </tr>
            <tr v-if="!withdrawals.length"><td colspan="9"><div class="empty">暂无提现申请</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" v-if="tab==='reminders'">
      <div class="card-head"><h3>到期提醒</h3><span class="tag">当前提醒档位：{{ remindDays.join(' / ') }} 天</span></div>
      <div class="card-body tight">
        <table class="table">
          <thead><tr><th>用户</th><th>授权码</th><th>档位</th><th>剩余天数</th><th>到期时间</th><th>生成时间</th></tr></thead>
          <tbody>
            <tr v-for="r in remindList" :key="r.id">
              <td>{{ r.nickname || r.user_id }}</td>
              <td style="font-family:ui-monospace,monospace;font-size:12px">{{ r.license_key }}</td>
              <td>{{ r.plan_code || '-' }}</td>
              <td>{{ r.days_left }}</td>
              <td>{{ fmt.time(r.end_at) }}</td>
              <td>{{ fmt.time(r.created_at) }}</td>
            </tr>
            <tr v-if="!remindList.length"><td colspan="6"><div class="empty">暂无提醒，可点「立即扫描」</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" v-if="tab==='settings'">
      <div class="card-head"><h3>套餐与佣金参数</h3><span class="tag">保存到站点设置，立即生效</span></div>
      <div class="card-body">
        <div class="field-row">
          <div class="field"><label>到期提醒天数（逗号分隔）</label>
            <input class="input" v-model="s.renew_remind_days" placeholder="7,3,1" />
            <div class="hint">服务每 6 小时扫一次授权到期时间，按这些天数生成站内提醒。</div>
          </div>
          <div class="field"><label>佣金账期（天）</label>
            <input class="input" type="number" v-model.number="s.agent_settle_days" />
            <div class="hint">付款后过完账期才可提现，防止「付款→提现→退款」。</div>
          </div>
        </div>
        <div class="field-row">
          <div class="field"><label>最低提现金额（元）</label>
            <input class="input" type="number" v-model.number="s.agent_withdraw_min" /></div>
          <div class="field"><label>升级差价按剩余天数折算</label>
            <select class="select" v-model="s.upgrade_proration">
              <option value="1">是（按剩余时长折算）</option>
              <option value="0">否（收全额差价）</option>
            </select>
          </div>
        </div>
        <button class="btn primary" @click="saveSettings">保存参数</button>
      </div>
    </div>

    <div class="mask" v-if="granting" @click.self="granting=false">
      <div class="modal">
        <div class="modal-head"><h3>{{ grant.id ? '修改佣金比例' : '授权代理商' }}</h3><button class="close-x" @click="granting=false">&times;</button></div>
        <div class="modal-body">
          <div class="field" v-if="!grant.id"><label>用户 ID</label>
            <input class="input" type="number" v-model.number="grant.user_id" placeholder="在「用户管理」里查到的用户 ID" />
            <div class="hint">代理商身份由管理员手动授予，不需要用户自己申请。</div>
          </div>
          <div class="field"><label>佣金比例（0~1，例如 0.1 表示 10%）</label>
            <input class="input" type="number" step="0.01" v-model.number="grant.rate" /></div>
          <div class="field"><label>邀请码（留空自动生成）</label><input class="input" v-model="grant.code" placeholder="AGXXXXXXXX" /></div>
          <div class="hint" v-if="grantError" style="color:var(--danger)">{{ grantError }}</div>
        </div>
        <div class="modal-foot"><button class="btn" @click="granting=false">取消</button><button class="btn primary" @click="submitGrant">保存</button></div>
      </div>
    </div>

    <div class="mask" v-if="downline" @click.self="downline=null">
      <div class="modal wide">
        <div class="modal-head"><h3>名下用户 · {{ downline.nickname || downline.id }}</h3><button class="close-x" @click="downline=null">&times;</button></div>
        <div class="modal-body">
          <div class="field-row">
            <div class="field"><label>添加名下用户（用户 ID）</label><input class="input" type="number" v-model.number="addUserId" /></div>
            <div class="field"><label>&nbsp;</label><button class="btn primary" @click="addDownline">添加归属</button></div>
          </div>
          <table class="table">
            <thead><tr><th>ID</th><th>用户</th><th>手机</th><th>已付订单</th><th>成交额</th><th></th></tr></thead>
            <tbody>
              <tr v-for="u in downlineList" :key="u.id">
                <td>{{ u.id }}</td><td>{{ u.nickname || '-' }}</td><td>{{ u.phone || '-' }}</td>
                <td>{{ u.paid_orders }}</td><td>{{ fmt.money(u.paid_amount) }}</td>
                <td><button class="btn sm danger" @click="removeDownline(u)">移除</button></td>
              </tr>
              <tr v-if="!downlineList.length"><td colspan="6"><div class="empty">暂无名下用户</div></td></tr>
            </tbody>
          </table>
        </div>
        <div class="modal-foot"><button class="btn" @click="downline=null">关闭</button></div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const tab = ref('agents');
    const agents = ref([]);
    const commissions = ref([]);
    const withdrawals = ref([]);
    const remindList = ref([]);
    const remindDays = ref([]);
    const granting = ref(false);
    const grantError = ref('');
    const grant = reactive({ id: 0, user_id: 0, rate: 0.1, code: '' });
    const downline = ref(null);
    const downlineList = ref([]);
    const addUserId = ref(0);
    const fmt = U.fmt;
    const s = reactive({ renew_remind_days: '7,3,1', agent_settle_days: 7,
      agent_withdraw_min: 10, upgrade_proration: '1' });

    const statusText = (s) => ({ pending: '待结算', settled: '可提现', withdrawn: '已提现',
      reversed: '已冲正', paid: '已打款', rejected: '已驳回' }[s] || s);
    const statusClass = (s) => (['settled', 'paid'].includes(s) ? 'success'
      : ['reversed', 'rejected'].includes(s) ? 'danger' : '');

    async function load() {
      if (tab.value === 'agents') agents.value = (await U.api.get('/api/agents')).list;
      else if (tab.value === 'commissions') commissions.value = (await U.api.get('/api/agents/commissions')).list;
      else if (tab.value === 'withdrawals') withdrawals.value = (await U.api.get('/api/agents/withdrawals')).list;
      else if (tab.value === 'settings') await loadSettings();
      else {
        const r = await U.api.get('/api/agents/reminders');
        remindList.value = r.list;
        remindDays.value = r.days || [];
      }
    }

    async function loadSettings() {
      const res = await U.api.get('/api/settings');
      const all = res.settings || {};
      for (const k of Object.keys(s)) if (all[k] !== undefined) s[k] = all[k];
    }

    async function saveSettings() {
      try {
        await U.api.post('/api/settings', {
          renew_remind_days: String(s.renew_remind_days),
          agent_settle_days: String(s.agent_settle_days),
          agent_withdraw_min: String(s.agent_withdraw_min),
          upgrade_proration: String(s.upgrade_proration),
        });
        U.toast('已保存，参数立即生效', 'success');
      } catch (e) { U.toast(e.message, 'error'); }
    }

    function openGrant() {
      Object.assign(grant, { id: 0, user_id: 0, rate: 0.1, code: '' });
      grantError.value = '';
      granting.value = true;
    }
    function editRate(a) {
      Object.assign(grant, { id: a.id, user_id: a.id, rate: a.agent_rate, code: a.agent_code || '' });
      grantError.value = '';
      granting.value = true;
    }
    async function submitGrant() {
      grantError.value = '';
      try {
        await U.api.post(`/api/agents/${grant.id || grant.user_id}/authorize`,
          { rate: grant.rate, code: grant.code });
        U.toast('已保存', 'success');
        granting.value = false;
        load();
      } catch (e) { grantError.value = e.message; }
    }
    async function revoke(a) {
      if (!confirm(`暂停「${a.nickname || a.id}」的代理商身份？已有佣金记录不受影响。`)) return;
      await U.api.post(`/api/agents/${a.id}/revoke`, {});
      load();
    }

    async function openDownline(a) {
      downline.value = a;
      addUserId.value = 0;
      downlineList.value = (await U.api.get(`/api/agents/${a.id}/downline`)).list;
    }
    async function addDownline() {
      if (!addUserId.value) { U.toast('请输入用户 ID', 'error'); return; }
      try {
        await U.api.post(`/api/agents/${downline.value.id}/downline`, { user_id: addUserId.value });
        U.toast('已添加归属', 'success');
        addUserId.value = 0;
        await openDownline(downline.value);
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }
    async function removeDownline(u) {
      if (!confirm(`移除用户 ${u.id} 的代理商归属？`)) return;
      await U.api.del(`/api/agents/downline/${u.id}`);
      await openDownline(downline.value);
      load();
    }

    async function review(w, approve) {
      const note = approve ? '' : (prompt('驳回原因（可留空）') || '管理员驳回');
      try {
        await U.api.post(`/api/agents/withdrawals/${w.id}/review`, { approve, remark: note });
        U.toast(approve ? '已标记打款' : '已驳回，佣金已退回可提现', 'success');
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function exportCsv() {
      try {
        const res = await fetch(U.basePath + '/api/agents/withdrawals/export.csv', {
          headers: { Authorization: 'Bearer ' + U.api.getToken('admin') },
        });
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'withdrawals.csv';
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (e) { U.toast('导出失败：' + e.message, 'error'); }
    }

    async function scanReminders() {
      const r = await U.api.post('/api/agents/reminders/scan', {});
      U.toast(`扫描 ${r.scanned} 张授权，新增 ${r.created} 条提醒`, 'success');
      load();
    }

    onMounted(load);
    return {
      tab, agents, commissions, withdrawals, remindList, remindDays, granting, grant, grantError,
      downline, downlineList, addUserId, fmt, s, statusText, statusClass,
      load, loadSettings, saveSettings, openGrant, editRate, submitGrant, revoke,
      openDownline, addDownline, removeDownline, review, exportCsv, scanReminders,
    };
  },
};
})();

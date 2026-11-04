(function () {
const { ref, onMounted, computed } = Vue;

window.PageEarnings = {
  template: `
  <div>
    <div class="grid g4" style="margin-bottom:16px" v-if="data.is_agent">
      <div class="stat"><div class="label">待结算</div><div class="value">{{ fmt.money(data.summary.pending) }}</div>
        <div class="delta">账期 {{ data.settle_days }} 天</div></div>
      <div class="stat"><div class="label">可提现</div><div class="value">{{ fmt.money(data.summary.available) }}</div>
        <div class="delta" v-if="data.summary.debt">待抵扣 ¥{{ data.summary.debt.toFixed(2) }}</div></div>
      <div class="stat"><div class="label">已提现</div><div class="value">{{ fmt.money(data.summary.withdrawn) }}</div></div>
      <div class="stat"><div class="label">累计佣金</div><div class="value">{{ fmt.money(data.summary.total) }}</div></div>
    </div>

    <div class="card" style="margin-bottom:16px" v-if="!data.is_agent">
      <div class="card-head"><h3>代理商归属</h3><span class="tag">收益功能仅对代理商开放</span></div>
      <div class="card-body">
        <div class="hint" style="margin-top:0" v-if="agentInfo.upline">
          当前上级代理商：<b>{{ agentInfo.upline.nickname }}</b>（邀请码 {{ agentInfo.upline.code }}）
        </div>
        <div class="field-row" v-else>
          <div class="field"><label>输入邀请码绑定归属（绑定后不可自助变更）</label>
            <input class="input" v-model="inviteCode" placeholder="AGXXXXXXXX" /></div>
          <div class="field"><label>&nbsp;</label><button class="btn primary" @click="bindAgent">绑定</button></div>
        </div>
        <div class="hint">当前账号还不是代理商。代理商身份由管理员在后台手动授予，授权后这里会显示佣金统计、推广二维码与提现入口。</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px" v-if="data.is_agent">
      <div class="card-head"><h3>申请提现</h3><span class="tag">一期人工审核打款</span></div>
      <div class="card-body">
        <div class="field-row">
          <div class="field"><label>收款账号备注（微信号 / 银行卡后四位，供财务核对）</label>
            <input class="input" v-model="payAccount" placeholder="例如：微信 xxxx / 尾号 1234" /></div>
          <div class="field"><label>&nbsp;</label>
            <button class="btn primary" :disabled="busy" @click="apply">
              {{ busy ? '提交中…' : '申请提现 ' + fmt.money(data.summary.available) }}
            </button>
          </div>
        </div>
        <div class="hint">
          提现按当前<b>全部可提现余额</b>整笔提交，最低 ¥{{ data.withdraw_min }}。
          管理员审核打款后状态变为「已打款」；驳回会自动退回可提现余额。
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px" v-if="!data.is_agent">
      <div class="card-head"><h3>代理商归属</h3></div>
      <div class="card-body">
        <div class="hint" style="margin-top:0" v-if="agentInfo.upline">
          当前上级代理商：<b>{{ agentInfo.upline.nickname }}</b>（邀请码 {{ agentInfo.upline.code }}）
        </div>
        <div class="field-row" v-else>
          <div class="field"><label>输入邀请码绑定归属（绑定后不可自助变更）</label>
            <input class="input" v-model="inviteCode" placeholder="AGXXXXXXXX" /></div>
          <div class="field"><label>&nbsp;</label><button class="btn primary" @click="bindAgent">绑定</button></div>
        </div>
        <div class="hint">成为代理商由管理员在后台手动授权，授权后这里会显示你的邀请码与佣金明细。</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px" v-if="data.is_agent">
      <div class="card-head"><h3>推广物料</h3><span class="tag">新用户经此码登录自动归到你名下</span></div>
      <div class="card-body">
        <div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">
          <div style="flex:0 0 auto">
            <img v-if="agentInfo.promote_url" :src="qrSrc(agentInfo.promote_url)"
              style="width:140px;height:140px;border:1px solid var(--border,#e5e7eb);border-radius:8px;display:block" alt="推广二维码" />
            <div v-else class="qr-placeholder" style="width:140px;height:140px;display:grid;place-items:center;font-size:12px;color:var(--text-3)">邀请码未生成</div>
          </div>
          <div style="flex:1 1 260px;min-width:0">
            <div class="field"><label>推广链接（含渠道标识 {{ agentInfo.agent_code }}）</label>
              <input class="input" readonly :value="agentInfo.promote_url" @focus="$event.target.select()" /></div>
            <div class="btn-group" style="margin-top:8px">
              <button class="btn primary" @click="copyPromote">复制链接</button>
              <a class="btn" v-if="agentInfo.promote_url" :href="qrDownloadUrl" download="推广二维码.png">下载二维码到本地</a>
            </div>
            <div class="hint" style="margin-top:8px">
              用户扫码或点链接打开用户中心后，在该浏览器里<b>首次扫码登录的新账号</b>自动归属到你名下；
              已注册的老用户不受影响。归属关系也可在后台由管理员手工划拨。
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px" v-if="data.is_agent">
      <div class="card-head"><h3>提现记录</h3></div>
      <div class="card-body tight">
        <table class="table">
          <thead><tr><th>单号</th><th>金额</th><th>状态</th><th>收款账号</th><th>申请时间</th><th>备注</th></tr></thead>
          <tbody>
            <tr v-for="w in data.withdrawals" :key="w.id">
              <td style="font-family:ui-monospace,monospace;font-size:12px">{{ w.withdrawal_no }}</td>
              <td>{{ fmt.money(w.amount) }}</td>
              <td><span class="tag" :class="w.status==='paid'?'success':w.status==='rejected'?'danger':''">{{ statusText(w.status) }}</span></td>
              <td>{{ w.pay_account || '-' }}</td>
              <td>{{ fmt.time(w.created_at) }}</td>
              <td>{{ w.remark || '-' }}</td>
            </tr>
            <tr v-if="!data.withdrawals || !data.withdrawals.length"><td colspan="6"><div class="empty">暂无提现记录</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" v-if="data.is_agent">
      <div class="card-head"><h3>佣金明细</h3><span class="tag">按订单实收结算</span></div>
      <div class="card-body tight">
        <table class="table">
          <thead><tr><th>订单号</th><th>买家</th><th>实收</th><th>比例</th><th>佣金</th><th>状态</th><th>时间</th></tr></thead>
          <tbody>
            <tr v-for="c in data.list" :key="c.id">
              <td style="font-family:ui-monospace,monospace;font-size:12px">{{ c.order_no }}</td>
              <td>{{ c.buyer_name || c.buyer_user_id }}</td>
              <td>{{ fmt.money(c.base_amount) }}</td>
              <td>{{ (c.rate*100).toFixed(0) }}%</td>
              <td><b>{{ fmt.money(c.amount) }}</b></td>
              <td><span class="tag" :class="c.status==='settled'?'success':c.status==='reversed'?'danger':''">{{ statusText(c.status) }}</span></td>
              <td>{{ fmt.time(c.created_at) }}</td>
            </tr>
            <tr v-if="!data.list || !data.list.length"><td colspan="7"><div class="empty">暂无佣金记录</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
  `,
  setup() {
    const data = ref({ summary: {}, list: [], withdrawals: [], is_agent: false, settle_days: 7, withdraw_min: 10 });
    const agentInfo = ref({});
    const payAccount = ref('');
    const inviteCode = ref('');
    const busy = ref(false);
    const fmt = U.fmt;

    const statusText = (s) => ({ pending: '待结算', settled: '可提现', withdrawn: '已提现',
      reversed: '已冲正', paid: '已打款', rejected: '已驳回' }[s] || s);

    async function load() {
      if (!localStorage.getItem('user_token')) { location.hash = '#/login'; return; }
      data.value = await U.api.get('/api/portal/earnings');
      try { agentInfo.value = await U.api.get('/api/portal/agent'); } catch (e) { agentInfo.value = {}; }
    }

    async function apply() {
      busy.value = true;
      try {
        await U.api.post('/api/portal/withdrawals', { pay_account: payAccount.value, remark: '' });
        U.toast('提现申请已提交，等待管理员审核', 'success');
        payAccount.value = '';
        await load();
      } catch (e) { U.toast(e.message, 'error'); }
      finally { busy.value = false; }
    }

    async function bindAgent() {
      try {
        const r = await U.api.post('/api/portal/agent/bind', { code: inviteCode.value.trim() });
        U.toast('已绑定 ' + (r.agent?.nickname || '代理商'), 'success');
        inviteCode.value = '';
        await load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    // 换行/路径必须在 setup 里拼：模板不能直接引用全局 U
    const basePath = U.basePath || '';
    function qrSrc(text) { return basePath + '/api/portal/qrcode?text=' + encodeURIComponent(text); }
    const qrDownloadUrl = computed(() => (agentInfo.value.promote_url
      ? basePath + '/api/portal/qrcode?text=' + encodeURIComponent(agentInfo.value.promote_url) : ''));
    async function copyPromote() {
      const text = agentInfo.value.promote_url || '';
      if (!text) return U.toast('邀请码未生成，请联系管理员', 'error');
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => U.toast('推广链接已复制', 'success'), () => window.prompt('手动复制', text));
      } else {
        window.prompt('手动复制', text);
      }
    }

    onMounted(load);
    return { data, agentInfo, payAccount, inviteCode, busy, fmt, statusText, apply, bindAgent,
      qrSrc, qrDownloadUrl, copyPromote };
  },
};
})();

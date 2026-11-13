/* 账户中心（2026-11-13 重构）
 *
 * 口径变化：
 *  - openid 不再对外，展示 9 位数字个人 ID；
 *  - 默认一张中性头像，微信给头像则覆盖，用户也可自行上传；不再铺一整排卡通头像；
 *  - 手机绑定收进模态框，主页面只留「状态 + 按钮」；
 *  - 积分可充值，¥1 = 100 积分，走现有订单/支付/发货链路；
 *  - 所有弹层 teleport 到 body（祖先 hover transform 会劫持 position:fixed）。
 */
(function () {
const { ref, computed, onMounted, onUnmounted } = Vue;

/**
 * 通用支付弹层：给定 orderNo 就能下单支付、展示二维码、查到账状态。
 * 账户中心充值与「我的订单 → 继续支付」共用，避免两套二维码逻辑各自漂移。
 */
window.PayDialog = {
  props: {
    open: Boolean,
    orderNo: String,
    channels: { type: Array, default: () => [] },
    title: String,
  },
  emits: ['close', 'paid'],
  template: `
  <teleport to="body">
    <div v-if="open" class="mask" @click.self="close">
      <div class="modal" style="max-width:430px">
        <div class="modal-head">
          <h3>{{ title || '支付' }}</h3>
          <button class="btn sm" type="button" @click="close">✕</button>
        </div>
        <div class="modal-body">
          <div v-if="!payResult && !errMsg">
            <div class="field" v-if="channels.length > 1">
              <label>支付方式</label>
              <select class="input" v-model="channel">
                <option v-for="c in channels" :key="c" :value="c">{{ channelName(c) }}</option>
              </select>
            </div>
            <div class="hint">订单 {{ orderNo }}</div>
            <button class="btn primary" :disabled="busy" @click="startPay">{{ busy ? '生成中…' : '生成支付二维码' }}</button>
          </div>
          <div v-else-if="payResult">
            <div v-if="payResult.mode === 'qrcode'" class="qr-box">
              <img v-if="payResult.code_url" :src="qrSrc(payResult.code_url)" alt="支付二维码" />
              <div v-else class="qr-placeholder">未获取到支付二维码</div>
            </div>
            <div v-else-if="payResult.mode === 'redirect'">
              <a class="btn primary" :href="payResult.pay_url" target="_blank" rel="noopener">前往付款</a>
            </div>
            <div v-else class="hint">演示模式：点「模拟支付完成」即可到账。</div>
            <div class="hint" style="margin-top:10px">付款完成后点「我已完成支付」查询到账状态。</div>
          </div>
          <div v-if="errMsg" style="color:var(--danger);margin-top:10px">{{ errMsg }}</div>
        </div>
        <div class="modal-foot">
          <button v-if="payResult && payResult.mode === 'simulate'" class="btn" @click="simulatePay">模拟支付完成</button>
          <button class="btn" @click="close">关闭</button>
          <button class="btn primary" :disabled="busy || !payResult" @click="checkPaid">我已完成支付</button>
        </div>
      </div>
    </div>
  </teleport>`,
  setup(props, { emit }) {
    const payResult = ref(null);
    const busy = ref(false);
    const errMsg = ref('');
    const channel = ref((props.channels && props.channels[0]) || 'wxpay');
    const basePath = U.basePath;
    let prevOverflow = '';
    function lock(on) {
      if (on) { prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
      else document.body.style.overflow = prevOverflow || '';
    }
    function qrSrc(text) { return basePath + '/api/portal/qrcode?text=' + encodeURIComponent(text); }
    function channelName(c) { return ({ wxpay: '微信支付', alipay: '支付宝', simulate: '模拟支付' })[c] || c; }
    function close() { emit('close'); }
    function onKey(e) { if (e.key === 'Escape' && props.open) close(); }
    Vue.watch(() => props.open, (v) => {
      if (v) {
        payResult.value = null;
        errMsg.value = '';
        channel.value = (props.channels && props.channels[0]) || 'wxpay';
        window.addEventListener('keydown', onKey);
        lock(true);
        startPay();
      } else {
        window.removeEventListener('keydown', onKey);
        lock(false);
      }
    });
    onUnmounted(() => { window.removeEventListener('keydown', onKey); lock(false); });
    async function startPay() {
      busy.value = true;
      errMsg.value = '';
      try {
        payResult.value = await U.api.post('/api/portal/orders/' + props.orderNo + '/pay', { channel: channel.value });
      } catch (e) { errMsg.value = e.message || '下单失败'; }
      finally { busy.value = false; }
    }
    async function checkPaid() {
      busy.value = true;
      errMsg.value = '';
      try {
        const r = await U.api.get('/api/portal/orders');
        const o = (r.list || []).find((x) => x.order_no === props.orderNo);
        if (o && o.status === 'paid') { emit('paid'); close(); }
        else errMsg.value = '还没查到支付结果，请稍后再试';
      } catch (e) { errMsg.value = e.message || '查询失败'; }
      finally { busy.value = false; }
    }
    async function simulatePay() {
      busy.value = true;
      errMsg.value = '';
      try {
        await U.api.post('/api/pay/simulate/' + props.orderNo, {});
        emit('paid'); close();
      } catch (e) { errMsg.value = e.message || '模拟支付失败'; }
      finally { busy.value = false; }
    }
    return { payResult, busy, errMsg, channel, channelName, qrSrc, close, startPay, checkPaid, simulatePay };
  },
};

window.PageAccount = {
  template: `
  <div class="acct">
    <div class="card acct-card">
      <div class="card-head">
        <h3>账户资料</h3>
        <span class="tag" :class="me?.profile_custom ? 'success' : ''">{{ me?.profile_custom ? '已自定义' : '来自微信' }}</span>
      </div>
      <div class="card-body">
        <div class="acct-top">
          <div class="acct-avatar">
            <img v-if="avatarUrl" :src="avatarUrl" alt="头像" />
            <div v-else class="avatar">{{ (nickname || 'U').slice(0, 1) }}</div>
          </div>
          <div class="acct-who">
            <b class="acct-name">{{ nickname || '-' }}</b>
            <div class="hint">个人 ID <b>{{ me?.publicId || '生成中…' }}</b></div>
            <div class="acct-avatar-btns">
              <button class="btn sm" type="button" :disabled="uploading" @click="pickFile">{{ uploading ? '上传中…' : '上传头像' }}</button>
              <button class="btn sm" type="button" @click="resetAvatar">恢复默认</button>
              <input ref="fileEl" type="file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none" @change="onFile" />
            </div>
          </div>
        </div>

        <div class="kv acct-kv">
          <div class="k">手机号</div>
          <div class="acct-val">
            <span>{{ maskedPhone }}</span>
            <button class="btn sm" type="button" @click="openPhone">{{ me?.phone ? '更换' : '绑定' }}</button>
          </div>
          <div class="k">积分</div>
          <div class="acct-val">
            <b>{{ fmt.int(me?.points || 0) }}</b>
            <button class="btn primary sm" type="button" @click="openRecharge">充值</button>
            <button class="btn sm" type="button" @click="signin">签到</button>
          </div>
          <div class="k">注册时间</div><div>{{ fmt.time(me?.created_at) }}</div>
        </div>

        <div class="acct-edit">
          <input class="input" v-model="nickname" maxlength="24" placeholder="修改昵称" />
          <button class="btn primary" :disabled="saving" @click="saveProfile">{{ saving ? '保存中…' : '保存资料' }}</button>
        </div>
        <div class="hint">微信登录后若拿到头像会覆盖默认头像；你自己上传或改过昵称后，微信不再覆盖。</div>
      </div>
    </div>

    <div class="card acct-card">
      <div class="card-head"><h3>积分明细</h3><span class="tag">¥1 = 100 积分</span></div>
      <div class="card-body tight">
        <table class="table">
          <thead><tr><th>变动</th><th>余额</th><th>原因</th><th>时间</th></tr></thead>
          <tbody>
            <tr v-for="p in points" :key="p.id">
              <td :style="{color:p.change>0?'var(--success)':'var(--danger)'}">{{ p.change>0?'+':'' }}{{ p.change }}</td>
              <td>{{ p.balance }}</td><td>{{ p.reason }}</td><td>{{ fmt.time(p.created_at) }}</td>
            </tr>
            <tr v-if="!points.length"><td colspan="4"><div class="empty">暂无记录</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 手机绑定：只由状态按钮唤起，不再占一整张卡片 -->
    <teleport to="body">
      <div v-if="phoneOpen" class="mask" @click.self="closePhone">
        <div class="modal" style="max-width:420px">
          <div class="modal-head"><h3>{{ me?.phone ? '更换手机号' : '绑定手机号' }}</h3>
            <button class="btn sm" type="button" @click="closePhone">✕</button></div>
          <div class="modal-body">
            <div class="field"><label>手机号</label><input class="input" v-model="phone" placeholder="请输入手机号" inputmode="numeric" /></div>
            <div class="field"><label>验证码</label>
              <div class="acct-code">
                <input class="input" v-model="code" placeholder="6 位验证码" inputmode="numeric" />
                <button class="btn" type="button" @click="sendCode">发送验证码</button>
              </div>
              <div class="hint" v-if="devCode">开发模式验证码：{{ devCode }}</div>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn" @click="closePhone">取消</button>
            <button class="btn primary" @click="bind">确认绑定</button>
          </div>
        </div>
      </div>
    </teleport>

    <!-- 积分充值 -->
    <teleport to="body">
      <div v-if="rechargeOpen" class="mask" @click.self="closeRecharge">
        <div class="modal" style="max-width:460px">
          <div class="modal-head"><h3>积分充值</h3>
            <button class="btn sm" type="button" @click="closeRecharge">✕</button></div>
          <div class="modal-body">
            <div class="hint" style="margin-top:0">¥1 = 100 积分；充值到账后可用于下单抵扣、模板兑换。</div>
            <div class="acct-tiers">
              <button type="button" v-for="y in tiers" :key="y" class="btn acct-tier"
                :class="yuan === y && !customYuan ? 'primary' : ''" @click="chooseTier(y)">¥{{ y }}</button>
            </div>
            <div class="field"><label>自定义金额（元，1~1000 的整数）</label>
              <input class="input" v-model="customYuan" placeholder="留空则使用上方档位" inputmode="numeric" /></div>
            <div class="acct-sum">应付 <b>¥{{ yuan }}</b> → 到账 <b>{{ fmt.int(pts) }}</b> 积分</div>
            <div v-if="!validYuan" class="hint" style="color:var(--danger)">请输入 1~1000 的整数元</div>
            <div v-if="!payChannels.length" class="hint" style="color:var(--danger)">当前未开通支付方式，请联系管理员。</div>
          </div>
          <div class="modal-foot">
            <button class="btn" @click="closeRecharge">取消</button>
            <button class="btn primary" :disabled="busy || !payChannels.length || !validYuan" @click="submitRecharge">
              {{ busy ? '下单中…' : '立即充值' }}</button>
          </div>
        </div>
      </div>
    </teleport>

    <pay-dialog :open="payOpen" :order-no="payOrderNo" :channels="payChannels"
      title="积分充值支付" @close="payOpen = false" @paid="onPaid"></pay-dialog>
  </div>
  `,
  setup() {
    const state = Vue.inject('state');
    const me = ref(null);
    const points = ref([]);
    const nickname = ref('');
    const avatarValue = ref('');
    const fileEl = ref(null);
    const saving = ref(false);
    const uploading = ref(false);
    const busy = ref(false);
    const fmt = U.fmt;
    const phone = ref('');
    const code = ref('');
    const devCode = ref('');
    const phoneOpen = ref(false);
    const rechargeOpen = ref(false);
    const payOpen = ref(false);
    const payOrderNo = ref('');
    const payChannels = ref([]);
    const tiers = [10, 30, 50, 100, 200, 500];
    const customYuan = ref('');
    // 不做 trunc：输入 1.5 必须显式判为非法，不能悄悄显示成 ¥1 少收钱
    const yuan = computed(() => {
      const n = Number(customYuan.value);
      return Number.isFinite(n) && n > 0 ? n : selected.value;
    });
    const selected = ref(10);
    const validYuan = computed(() => Number.isInteger(Number(yuan.value)) && Number(yuan.value) >= 1 && Number(yuan.value) <= 1000);
    const pts = computed(() => (validYuan.value ? Number(yuan.value) * 100 : 0));
    const avatarUrl = computed(() => U.avatar(avatarValue.value));
    const maskedPhone = computed(() => {
      const p = String((me.value && me.value.phone) || '');
      return p ? p.slice(0, 3) + '****' + p.slice(-4) : '未绑定';
    });
    let prevOverflow = '';
    function lock(on) {
      if (on) { prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
      else document.body.style.overflow = prevOverflow || '';
    }
    function onKey(e) {
      if (e.key !== 'Escape') return;
      if (phoneOpen.value) closePhone();
      else if (rechargeOpen.value) closeRecharge();
    }
    Vue.watch([phoneOpen, rechargeOpen], ([a, b]) => lock(a || b));
    onMounted(() => window.addEventListener('keydown', onKey));
    onUnmounted(() => { window.removeEventListener('keydown', onKey); lock(false); });

    function syncUser(u) {
      me.value = u;
      if (state) state.user = u;
    }
    async function refresh() {
      try {
        const r = await U.api.get('/api/portal/me');
        syncUser(r.user);
        nickname.value = r.user.nickname || '';
        avatarValue.value = r.user.avatar || '';
      } catch { /* 忽略：登录态由根组件统一处理 */ }
      try { points.value = (await U.api.get('/api/portal/points')).list; } catch { /* ignore */ }
    }

    function pickFile() { if (fileEl.value) fileEl.value.click(); }
    async function onFile(e) {
      const f = (e.target.files || [])[0];
      if (!f) return;
      uploading.value = true;
      try {
        const fd = new FormData();
        fd.append('file', f);
        const res = await fetch(U.basePath + '/api/portal/avatar', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + U.api.getToken('user') },
          body: fd,
        });
        let data = {};
        try { data = await res.json(); } catch { /* ignore */ }
        if (!res.ok) throw new Error(data.error || '上传失败');
        syncUser(data.user);
        avatarValue.value = data.user.avatar || '';
        U.toast('头像已更新', 'success');
      } catch (err) { U.toast(err.message, 'error'); }
      finally { uploading.value = false; e.target.value = ''; }
    }
    async function resetAvatar() {
      saving.value = true;
      try {
        const r = await U.api.post('/api/portal/profile', { nickname: nickname.value, avatar: 'preset:00' });
        syncUser(r.user);
        avatarValue.value = r.user.avatar || 'preset:00';
        U.toast('已恢复默认头像', 'success');
      } catch (e) { U.toast(e.message, 'error'); }
      finally { saving.value = false; }
    }
    async function saveProfile() {
      saving.value = true;
      try {
        const r = await U.api.post('/api/portal/profile', { nickname: nickname.value, avatar: avatarValue.value });
        syncUser(r.user);
        avatarValue.value = r.user.avatar || '';
        U.toast('资料已保存', 'success');
      } catch (e) { U.toast(e.message, 'error'); }
      finally { saving.value = false; }
    }

    function openPhone() { phone.value = ''; code.value = ''; devCode.value = ''; phoneOpen.value = true; }
    function closePhone() { phoneOpen.value = false; }
    async function sendCode() {
      if (!/^1\d{10}$/.test(phone.value)) { U.toast('手机号格式不正确', 'error'); return; }
      try {
        const r = await U.api.post('/api/portal/phone/code', { phone: phone.value });
        devCode.value = r.devCode || '';
        U.toast('验证码已发送', 'success');
      } catch (e) { U.toast(e.message, 'error'); }
    }
    async function bind() {
      try {
        await U.api.post('/api/portal/phone/bind', { phone: phone.value, code: code.value });
        U.toast('绑定成功', 'success');
        closePhone();
        await refresh();
      } catch (e) { U.toast(e.message, 'error'); }
    }
    async function signin() {
      try {
        const r = await U.api.post('/api/portal/signin', {});
        U.toast(`签到成功 +${r.gain} 积分`, 'success');
        await refresh();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    function openRecharge() { customYuan.value = ''; selected.value = 10; rechargeOpen.value = true; }
    function closeRecharge() { rechargeOpen.value = false; }
    function chooseTier(y) { selected.value = y; customYuan.value = ''; }
    async function submitRecharge() {
      if (!validYuan.value) { U.toast('请输入 1~1000 的整数元', 'error'); return; }
      busy.value = true;
      try {
        const r = await U.api.post('/api/portal/orders', {
          kind: 'points_recharge', points_amount: Number(yuan.value),
          channel: payChannels.value[0] || '',
        });
        payOrderNo.value = r.order_no;
        rechargeOpen.value = false;
        payOpen.value = true;
      } catch (e) { U.toast(e.message, 'error'); }
      finally { busy.value = false; }
    }
    async function onPaid() {
      U.toast('充值到账', 'success');
      await refresh();
    }

    onMounted(async () => {
      if (!(await U.authReady())) { location.hash = '#/login'; return; }
      await refresh();
      try {
        const s = await U.api.get('/api/portal/site');
        payChannels.value = s.pay_channels || [];
      } catch { /* ignore */ }
    });
    return {
      me, points, nickname, avatarUrl, avatarValue, fileEl, saving, uploading, busy, fmt,
      maskedPhone, phone, code, devCode, phoneOpen, rechargeOpen, payOpen, payOrderNo,
      payChannels, tiers, customYuan, yuan, pts, validYuan,
      pickFile, onFile, resetAvatar, saveProfile, openPhone, closePhone, sendCode, bind, signin,
      openRecharge, closeRecharge, chooseTier, submitRecharge, onPaid,
    };
  },
};
})();

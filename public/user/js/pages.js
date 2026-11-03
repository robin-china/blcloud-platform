(function () {
const { ref, reactive, onMounted, computed } = Vue;

function productIcon(p) {
  if (p.icon) return `<img src="${p.icon}" />`;
  return `<span style="font-size:32px;color:var(--brand)">${p.type === 'hardware' ? '◎' : p.type === 'service' ? '⚙' : '▤'}</span>`;
}

window.PageShop = {
  template: `
  <div>
    <div class="hero">
      <h2>{{ settings.site_name || '官方产品' }}</h2>
      <p>{{ settings.site_description || '软硬件一体化产品与授权服务' }}</p>
    </div>
    <div class="tabs">
      <button :class="type===''?'active':''" @click="type='';load()">全部</button>
      <button :class="type==='software'?'active':''" @click="type='software';load()">软件</button>
      <button :class="type==='hardware'?'active':''" @click="type='hardware';load()">硬件</button>
      <button :class="type==='service'?'active':''" @click="type='service';load()">服务</button>
    </div>
    <div class="prod-grid">
      <div class="prod-card" v-for="p in list" :key="p.id" @click="$root.go('product', p.id)" style="cursor:pointer">
        <div class="thumb" v-html="thumb(p)"></div>
        <div class="body">
          <h4>{{ p.name }}</h4>
          <div class="desc">{{ p.subtitle }}</div>
          <div class="price">¥{{ p.price }}<small v-if="p.original_price">¥{{ p.original_price }}</small></div>
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
            <span class="tag">{{ p.type==='hardware'?'硬件':p.type==='software'?'软件':'服务' }}</span>
            <span class="tag info" v-if="p.type==='software'">{{ fmt.int(p.total_downloads) }} 次下载</span>
            <span class="tag success" v-if="p.type==='hardware'">{{ fmt.int(p.active_users) }} 台在用</span>
          </div>
        </div>
      </div>
      <div class="empty" v-if="!list.length">暂无上架产品</div>
    </div>
  </div>
  `,
  setup() {
    const list = ref([]);
    const type = ref('');
    const fmt = U.fmt;
    const settings = Vue.inject('settings');
    async function load() {
      list.value = (await U.api.get(`/api/portal/shop${type.value ? `?type=${type.value}` : ''}`)).list;
    }
    onMounted(load);
    return { list, type, fmt, settings, load, thumb: productIcon };
  },
};

window.PageProduct = {
  template: `
  <div>
    <div class="card" v-if="product">
      <div class="card-body" style="display:grid;grid-template-columns:220px 1fr;gap:24px">
        <div>
          <div style="width:220px;height:180px;border-radius:12px;background:var(--surface-2);display:grid;place-items:center;overflow:hidden">
            <img v-if="product.icon" :src="product.icon" style="width:100%;height:100%;object-fit:cover" />
            <span v-else style="font-size:48px;color:var(--brand)">{{ product.type==='hardware'?'◎':'▤' }}</span>
          </div>
        </div>
        <div>
          <h2 style="font-size:20px">{{ product.name }}</h2>
          <div style="color:var(--text-2);margin-top:4px">{{ product.subtitle }}</div>
          <div style="margin:14px 0">
            <span style="color:var(--danger);font-size:28px;font-weight:600">¥{{ product.price }}</span>
            <span v-if="product.original_price" style="color:var(--text-3);text-decoration:line-through;margin-left:8px">¥{{ product.original_price }}</span>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
            <span class="tag">{{ product.type==='hardware'?'硬件':product.type==='software'?'软件':'服务' }}</span>
            <span class="tag info">版本 {{ product.version }}</span>
            <span class="tag" v-if="product.category">{{ product.category }}</span>
          </div>
          <p style="color:var(--text-2);line-height:1.8">{{ product.description }}</p>
          <div v-if="(product.features||[]).length" style="margin-top:12px">
            <div v-for="f in product.features" :key="f" style="padding:4px 0;color:var(--text-2)">· {{ f }}</div>
          </div>
          <div class="btn-group" style="margin-top:20px">
            <button class="btn primary" @click="buy">立即购买</button>
            <button class="btn" v-if="product.type==='software' && product.download_url" @click="download">下载安装包</button>
          </div>
        </div>
      </div>
    </div>

    <div class="mask" v-if="paying" @click.self="paying=false">
      <div class="modal">
        <div class="modal-head"><h3>订单支付</h3><button class="close-x" @click="paying=false">&times;</button></div>
        <div class="modal-body">
          <div class="kv" style="margin-bottom:14px">
            <div class="k">订单号</div><div style="font-size:12.5px">{{ pay.order_no }}</div>
            <div class="k">应付金额</div><div style="color:var(--danger);font-weight:600">¥{{ pay.pay_amount }}</div>
          </div>
          <div class="btn-group" style="margin-bottom:14px">
            <button class="btn" v-for="c in payChannels" :key="c.key"
              :class="channel===c.key?'primary':''" @click="start(c.key)">{{ c.name }}</button>
          </div>
          <div v-if="!payChannels.length" class="hint">当前未开通任何支付方式，请联系管理员</div>
          <div v-if="payResult">
            <div class="qr-box" v-if="payResult.mode==='qrcode'">
              <img v-if="payResult.code_url" :src="basePath + '/api/portal/qrcode?text=' + encodeURIComponent(payResult.code_url)" />
              <div v-else class="qr-placeholder">未获取到支付二维码</div>
              <div class="hint">请使用微信扫码支付</div>
            </div>
            <div v-else-if="payResult.mode==='redirect'">
              <a class="btn primary" :href="payResult.pay_url" target="_blank">前往支付宝付款</a>
            </div>
            <div v-else class="qr-placeholder" style="width:100%;height:auto;padding:18px">
              当前为模拟支付模式（未配置商户参数），点击下方按钮完成支付
            </div>
            <div class="btn-group" style="margin-top:14px;justify-content:center">
              <button class="btn" v-if="payResult.mode==='simulate'" @click="simulatePay">模拟支付完成</button>
              <button class="btn" @click="checkPaid">我已支付</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const product = ref(null);
    const paying = ref(false);
    const channel = ref('wxpay');
    const pay = reactive({});
    const payResult = ref(null);
    const id = computed(() => location.hash.split('/')[2] || '');
    const payChannels = ref([]);
    // 模板里只能访问 setup 暴露出来的东西，不能直接引用全局 window.U
    const basePath = window.U ? window.U.basePath || '' : '';
    let timer = null;

    const CHANNEL_NAMES = { wxpay: '微信支付', alipay: '支付宝', simulate: '模拟支付' };

    // 只展示后台已开通的支付渠道，未开通的渠道不显示按钮
    async function loadPayChannels() {
      try {
        const res = await U.api.get('/api/portal/site');
        payChannels.value = (res.pay_channels || [])
          .map((k) => ({ key: k, name: CHANNEL_NAMES[k] || k }));
        if (payChannels.value.length) channel.value = payChannels.value[0].key;
      } catch (e) { payChannels.value = []; }
    }

    async function load() {
      product.value = (await U.api.get(`/api/portal/product/${id.value}`)).product;
    }

    async function buy() {
      if (!localStorage.getItem('user_token')) {
        U.toast('请先登录', 'error');
        location.hash = '#/login';
        return;
      }
      const res = await U.api.post('/api/portal/orders', { items: [{ product_id: product.value.id, qty: 1 }] });
      Object.assign(pay, res);
      paying.value = true;
      payResult.value = null;
      // 只有一个渠道时直接拉起支付，省一次点击
      if (payChannels.value.length === 1) start(payChannels.value[0].key);
    }

    async function start(ch) {
      channel.value = ch;
      try {
        payResult.value = await U.api.post(`/api/portal/orders/${pay.order_no}/pay`, { channel: ch });
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function simulatePay() {
      await U.api.post(`/api/pay/simulate/${pay.order_no}`, {});
      U.toast('支付成功，授权已发放', 'success');
      paying.value = false;
      location.hash = '#/orders';
    }

    async function checkPaid() {
      const res = await U.api.get('/api/portal/orders');
      const hit = (res.list || []).find((o) => o.order_no === pay.order_no);
      if (hit && hit.status === 'paid') {
        U.toast('支付成功', 'success');
        paying.value = false;
        location.hash = '#/orders';
      } else {
        U.toast('尚未检测到支付结果，请稍后再试', 'error');
      }
    }

    async function download() {
      const res = await U.api.post(`/api/portal/download/${product.value.id}`, {});
      if (res.url) window.open(res.url, '_blank');
      else U.toast('该暂未提供下载地址', 'error');
    }

    onMounted(async () => {
      await Promise.all([load(), loadPayChannels()]);
    });
    return { product, paying, channel, pay, payResult, payChannels, basePath, buy, start, simulatePay, checkPaid, download };
  },
};

window.PageSpace = {
  template: `
  <div>
    <div class="hero" style="background:linear-gradient(120deg,#0f766e 0%,#2563eb 100%)">
      <h2>你好，{{ user?.nickname || '用户' }}</h2>
      <p>{{ user?.phone ? '已绑定手机 ' + user.phone : '未绑定手机号，建议前往账户中心绑定' }}</p>
    </div>
    <div class="grid g4" style="margin-bottom:16px">
      <div class="stat"><div class="label">我的授权</div><div class="value">{{ licenses.length }}</div></div>
      <div class="stat"><div class="label">我的硬件</div><div class="value">{{ devices.length }}</div><div class="delta">在线 {{ onlineCount }}</div></div>
      <div class="stat"><div class="label">积分</div><div class="value">{{ user?.points || 0 }}</div><div class="delta">可抵 ¥{{ ((user?.points||0)/100).toFixed(2) }}</div></div>
      <div class="stat"><div class="label">订单</div><div class="value">{{ orders.length }}</div><div class="delta">已支付 {{ paidCount }}</div></div>
    </div>
    <div class="grid g2">
      <div class="card">
        <div class="card-head"><h3>blcloud 物联服务</h3><span class="tag" :class="tbStatus==='active'?'success':'warning'">{{ tbText }}</span></div>
        <div class="card-body">
          <div class="kv">
            <div class="k">服务状态</div><div>{{ tbStatus==='active' ? '已开通，设备数据自动同步' : '开通中 / 待同步' }}</div>
            <div class="k">设备接入</div><div>绑定硬件后自动完成，无需任何账号</div>
          </div>
          <div class="hint">物联服务由系统自动打通。程序化访问设备数据请在「blcloud」板块生成 API 密钥。</div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>快捷入口</h3></div>
        <div class="card-body">
          <div class="btn-group">
            <button class="btn" @click="$root.go('shop')">浏览官方产品</button>
            <button class="btn" @click="$root.go('licenses')">查看授权</button>
            <button class="btn" @click="$root.go('devices')">绑定硬件</button>
            <button class="btn" @click="$root.go('orders')">我的订单</button>
            <button class="btn primary" @click="signin">每日签到</button>
          </div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>我的产品</h3><button class="btn sm" @click="$root.go('shop')">去购买</button></div>
      <div class="card-body tight">
        <div class="prod-grid" style="padding:16px">
          <div class="prod-card" v-for="l in licenses" :key="l.id">
            <div class="thumb" v-html="thumb(l)"></div>
            <div class="body">
              <h4>{{ l.product_name }}</h4>
              <div class="desc" style="font-family:ui-monospace,monospace;font-size:12px">{{ l.license_key }}</div>
              <div style="margin-top:8px"><span class="tag success">有效</span></div>
            </div>
          </div>
          <div class="empty" v-if="!licenses.length">还没有已购产品</div>
        </div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const user = Vue.inject('user');
    const licenses = ref([]);
    const devices = ref([]);
    const orders = ref([]);
    const onlineCount = computed(() => devices.value.filter((d) => d.status === 'online').length);
    const paidCount = computed(() => orders.value.filter((o) => o.status === 'paid').length);
    const tbStatus = computed(() => user.value?.tb_status || 'none');
    const tbText = computed(() => ({ active: '已开通', pending: '待激活', error: '异常' }[tbStatus.value] || '未开通'));

    async function load() {
      licenses.value = (await U.api.get('/api/portal/licenses')).list;
      devices.value = (await U.api.get('/api/portal/devices')).list;
      orders.value = (await U.api.get('/api/portal/orders')).list;
    }
    async function signin() {
      try {
        const res = await U.api.post('/api/portal/signin', {});
        U.toast(`签到成功，获得 ${res.gain} 积分`, 'success');
        await U.api.get('/api/portal/me');
        location.reload();
      } catch (e) { U.toast(e.message, 'error'); }
    }
    onMounted(async () => {
      if (!localStorage.getItem('user_token')) { location.hash = '#/login'; return; }
      load();
    });
    return { user, licenses, devices, orders, onlineCount, paidCount, tbStatus, tbText, signin, thumb: productIcon };
  },
};

window.PageMyLicenses = {
  template: `
  <div>
    <div class="card" style="margin-bottom:14px" v-if="notices.length">
      <div class="card-head"><h3>到期提醒</h3><span class="tag warning">记得续费</span></div>
      <div class="card-body">
        <div v-for="n in notices" :key="n.id" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:6px 0">
          <span>授权 <b style="font-family:ui-monospace,monospace">{{ n.license_key }}</b>
            （{{ n.plan_name || n.plan_code || '套餐' }}）还有 <b>{{ n.days_left }}</b> 天到期，
            到期日 {{ fmt.date(n.end_at) }}</span>
          <button class="btn sm primary" @click="openRenew(n.license_id)">一键续费</button>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-head"><h3>绑定授权码</h3></div>
      <div class="card-body">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <input class="input" style="max-width:340px;font-family:ui-monospace,monospace"
                 v-model="keyInput" placeholder="LIC-XXXX-XXXX-XXXX-XXXX"
                 @keyup.enter="bindKey" />
          <button class="btn primary" :disabled="binding" @click="bindKey">{{ binding ? '绑定中…' : '绑定' }}</button>
          <span style="color:var(--text-3);font-size:12.5px">买到实体卡 / 渠道发的码，在这里绑定，从绑定这一刻开始计算有效期</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>我的授权</h3>
        <span style="color:var(--text-3);font-size:12.5px">换电脑或重装系统后，先解绑旧机器再激活，不占名额</span>
      </div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>产品</th><th>档位</th><th>授权码</th><th>类型</th><th>有效期</th><th>绑定设备</th><th>状态</th><th style="width:230px">操作</th></tr></thead>
            <tbody>
              <tr v-for="l in list" :key="l.id">
                <td>{{ l.product_name }}</td>
                <td><span class="tag">{{ l.plan_name || l.plan_code || '-' }}</span></td>
                <td style="font-family:ui-monospace,monospace;font-size:12.5px">{{ l.license_key }}</td>
                <td>{{ typeText(l.type) }}</td>
                <td>
                  {{ l.end_at ? fmt.date(l.end_at) : '永久' }}
                  <div v-if="l.days_left !== null && l.days_left !== undefined" style="font-size:12px"
                       :style="{ color: l.days_left <= 7 ? 'var(--danger)' : 'var(--text-3)' }">
                    剩 {{ leftDays(l.days_left) }} 天
                  </div>
                </td>
                <td>{{ l.bound_devices || 0 }} / {{ l.max_devices }}</td>
                <td><span class="tag" :class="l.status==='active'?'success':'danger'">{{ l.status==='active'?'有效':'失效' }}</span></td>
                <td>
                  <div class="table-actions">
                    <button class="btn sm" @click="copy(l.license_key)">复制</button>
                    <button class="btn sm" @click="openDevices(l)">设备</button>
                    <button class="btn sm primary" v-if="l.plan_code && l.end_at" @click="openRenew(l.id)">续费</button>
                    <button class="btn sm" v-if="l.plan_code" @click="openUpgrade(l.id)">升级</button>
                  </div>
                </td>
              </tr>
              <tr v-if="!list.length"><td colspan="8"><div class="empty">暂无授权</div></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="mask" v-if="planDialog" @click.self="closePlan">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ planMode === 'renew' ? '一键续费' : '升级档位' }}</h3>
          <button class="close-x" @click="closePlan">&times;</button>
        </div>
        <div class="modal-body">
          <div v-if="!payResult">
            <div class="hint" style="margin-top:0" v-if="planMode === 'renew'">
              续费只延长原授权的有效期，<b>不会换授权码、不需要重新激活</b>，已绑定的机器全部保留。
            </div>
            <div class="hint" style="margin-top:0" v-else>
              升级只改档位与设备数，同样<b>保留原授权码和已绑定机器</b>；差价按当前剩余天数折算。
            </div>

            <div class="card" style="margin-bottom:12px" v-if="planMode === 'renew' && options.renew">
              <div class="card-body">
                <div><b>{{ options.renew.name }}</b> · {{ options.renew.period_days }} 天</div>
                <div style="font-size:20px;margin-top:6px">{{ fmt.money(options.renew.price) }}</div>
                <button class="btn primary" style="margin-top:10px" :disabled="submitting" @click="submit('renew', options.renew.plan_id)">
                  {{ submitting ? '提交中…' : '立即续费' }}
                </button>
              </div>
            </div>

            <div v-if="planMode === 'upgrade'">
              <div class="card" style="margin-bottom:10px" v-for="p in options.upgrades" :key="p.id">
                <div class="card-body" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
                  <div>
                    <b>{{ p.name }}</b>
                    <div style="font-size:12px;color:var(--text-3);margin-top:4px">
                      {{ p.max_devices }} 台设备 · {{ p.seats }} 席位 · {{ p.offline_days ? '离线 ' + p.offline_days + ' 天' : '需联网' }}
                    </div>
                  </div>
                  <div style="display:flex;align-items:center;gap:10px">
                    <b>补差价 {{ fmt.money(p.price) }}</b>
                    <button class="btn primary sm" :disabled="submitting" @click="submit('upgrade', p.id)">升级</button>
                  </div>
                </div>
              </div>
              <div class="empty" v-if="!options.upgrades || !options.upgrades.length">当前已是最高档位</div>
            </div>
          </div>

          <div v-else>
            <div class="qr-box" v-if="payResult.mode==='qrcode'">
              <img v-if="payResult.code_url" :src="basePath + '/api/portal/qrcode?text=' + encodeURIComponent(payResult.code_url)" />
              <div class="hint">请使用微信扫码支付</div>
            </div>
            <div v-else-if="payResult.mode==='redirect'">
              <a class="btn primary" :href="payResult.pay_url" target="_blank">前往支付宝付款</a>
            </div>
            <div v-else class="qr-placeholder" style="width:100%;height:auto;padding:18px">
              当前为模拟支付模式，点击下方按钮完成支付
            </div>
            <div class="btn-group" style="margin-top:14px;justify-content:center">
              <button class="btn" v-if="payResult.mode==='simulate'" @click="simulatePay">模拟支付完成</button>
              <button class="btn" @click="checkPaid">我已支付</button>
            </div>
          </div>
          <div class="hint" v-if="planError" style="color:var(--danger)">{{ planError }}</div>
        </div>
        <div class="modal-foot"><button class="btn" @click="closePlan">关闭</button></div>
      </div>
    </div>

    <div class="mask" v-if="cur" @click.self="cur=null">
      <div class="modal">
        <div class="modal-head"><h3>绑定设备 · {{ cur.product_name }}</h3><button class="close-x" @click="cur=null">&times;</button></div>
        <div class="modal-body">
          <div style="color:var(--text-3);font-size:12.5px;margin-bottom:12px">
            授权码 <b style="font-family:ui-monospace,monospace;color:var(--text)">{{ cur.license_key }}</b>，
            已绑定 {{ devices.length }} / {{ cur.max_devices }} 台。换机器时先解绑旧机器，名额即刻释放。
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>机器码</th><th>名称</th><th>版本</th><th>最后活跃</th><th style="width:80px"></th></tr></thead>
              <tbody>
                <tr v-for="d in devices" :key="d.id">
                  <td style="font-family:ui-monospace,monospace;font-size:12px">{{ d.device_sn }}</td>
                  <td>{{ d.device_name || '-' }}</td>
                  <td>{{ d.last_version || '-' }}</td>
                  <td>{{ d.last_seen_at ? fmt.time(d.last_seen_at) : '-' }}</td>
                  <td><button class="btn sm danger" @click="unbind(d)">解绑</button></td>
                </tr>
                <tr v-if="!devices.length"><td colspan="5"><div class="empty">还没有设备激活这张授权</div></td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-foot"><button class="btn" @click="cur=null">关闭</button></div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const list = ref([]);
    const cur = ref(null);
    const devices = ref([]);
    const keyInput = ref('');
    const binding = ref(false);
    const fmt = U.fmt;
    // 模板只能看见 setup 暴露的标识符，脚本里取一次全局值再传出去
    const basePath = window.U ? (window.U.basePath || '') : '';

    const notices = ref([]);
    const planDialog = ref(false);
    const planMode = ref('renew');
    const planError = ref('');
    const submitting = ref(false);
    const refLicenseId = ref(0);
    const options = ref({ renew: null, upgrades: [] });
    const payResult = ref(null);
    const orderNo = ref('');

    async function bindKey() {
      const key = String(keyInput.value || '').trim();
      if (!key) { U.toast('请输入授权码', 'error'); return; }
      binding.value = true;
      try {
        const res = await U.api.post('/api/portal/licenses/bind', { license_key: key });
        U.toast(res.already ? '这张码已经在你的账号下了' : '绑定成功，有效期从现在开始计算', 'success');
        keyInput.value = '';
        await load();
      } catch (e) { U.toast(e.message, 'error'); }
      finally { binding.value = false; }
    }

    async function load() {
      list.value = (await U.api.get('/api/portal/licenses')).list;
      try { notices.value = (await U.api.get('/api/portal/notices')).list.slice(0, 5); }
      catch (e) { notices.value = []; }
    }

    async function openDevices(l) {
      cur.value = l;
      devices.value = [];
      const res = await U.api.get(`/api/portal/licenses/${l.id}/devices`);
      devices.value = res.list;
    }

    async function unbind(d) {
      if (!confirm(`解绑机器 ${d.device_sn}？解绑后该机器需要重新激活才能使用。`)) return;
      try {
        await U.api.del(`/api/portal/licenses/${cur.value.id}/devices/${d.id}`);
        U.toast('已解绑，名额已释放', 'success');
        const keep = cur.value;
        await openDevices(keep);
        await load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    function copy(text) {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text)
          .then(() => U.toast('已复制授权码', 'success'), () => window.prompt('手动复制授权码', text));
      } else {
        window.prompt('手动复制授权码', text);
      }
    }

    const typeText = (t) => ({ permanent: '永久', subscription: '订阅', trial: '试用' }[t] || t);
    const leftDays = (n) => Math.max(0, Number(n) || 0);

    async function openOptions(mode, licenseId) {
      planMode.value = mode;
      planError.value = '';
      payResult.value = null;
      orderNo.value = '';
      refLicenseId.value = Number(licenseId) || 0;
      try {
        options.value = await U.api.get(`/api/portal/licenses/${refLicenseId.value}/options`);
        planDialog.value = true;
      } catch (e) { U.toast(e.message, 'error'); }
    }
    function openRenew(id) { openOptions('renew', id); }
    function openUpgrade(id) { openOptions('upgrade', id); }
    function closePlan() { planDialog.value = false; payResult.value = null; }

    async function submit(kind, planId) {
      submitting.value = true;
      planError.value = '';
      try {
        const res = await U.api.post('/api/portal/orders', {
          kind, plan_id: planId, ref_license_id: refLicenseId.value,
        });
        orderNo.value = res.order_no;
        const site = await U.api.get('/api/portal/site');
        const channels = site.pay_channels || [];
        const channel = channels[0] || 'wxpay';
        payResult.value = await U.api.post(`/api/portal/orders/${res.order_no}/pay`, { channel });
      } catch (e) { planError.value = e.message; }
      finally { submitting.value = false; }
    }

    async function simulatePay() {
      try {
        await U.api.post(`/api/pay/simulate/${orderNo.value}`, {});
        U.toast('支付成功，授权已续期/升级', 'success');
        closePlan();
        await load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function checkPaid() {
      try {
        const res = await U.api.get('/api/portal/orders');
        const hit = (res.list || []).find((o) => o.order_no === orderNo.value);
        if (hit && hit.status === 'paid') {
          U.toast('支付成功', 'success');
          closePlan();
          await load();
        } else {
          U.toast('尚未检测到支付结果，请稍后再试', 'error');
        }
      } catch (e) { U.toast(e.message, 'error'); }
    }

    onMounted(async () => {
      if (!localStorage.getItem('user_token')) { location.hash = '#/login'; return; }
      await load();
    });

    return {
      list, cur, devices, fmt, basePath, openDevices, unbind, copy, typeText, leftDays,
      keyInput, binding, bindKey, notices, planDialog, planMode, planError, submitting,
      options, payResult, openRenew, openUpgrade, closePlan, submit, simulatePay, checkPaid,
    };
  },
};

window.PageMyDevices = {
  template: `
  <div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>绑定硬件</h3></div>
      <div class="card-body">
        <div style="display:flex;gap:8px">
          <input class="input" v-model="sn" placeholder="输入设备 SN（可在设备铭牌或包装上找到）" />
          <button class="btn primary" @click="bind">绑定</button>
        </div>
        <div class="hint">绑定后该硬件会出现在您的个人空间，并自动同步到您的 blcloud 物联账户。</div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>我的硬件</h3></div>
      <div class="card-body tight">
        <table class="table">
          <thead><tr><th>名称</th><th>产品</th><th>SN</th><th>状态</th><th>绑定时间</th></tr></thead>
          <tbody>
            <tr v-for="d in list" :key="d.id">
              <td>{{ d.name }}</td>
              <td>{{ d.product_name || '-' }}</td>
              <td style="font-family:ui-monospace,monospace;font-size:12.5px">{{ d.sn }}</td>
              <td><span class="tag" :class="d.status==='online'?'success':''">{{ d.status==='online'?'在线':'离线' }}</span></td>
              <td>{{ fmt.date(d.bound_at) }}</td>
            </tr>
            <tr v-if="!list.length"><td colspan="5"><div class="empty">还没有绑定硬件</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
  `,
  setup() {
    const list = ref([]);
    const sn = ref('');
    const fmt = U.fmt;
    async function load() { list.value = (await U.api.get('/api/portal/devices')).list; }
    async function bind() {
      if (!sn.value.trim()) return;
      try {
        await U.api.post('/api/portal/devices/bind', { sn: sn.value.trim() });
        U.toast('绑定成功', 'success');
        sn.value = '';
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }
    onMounted(async () => {
      if (!localStorage.getItem('user_token')) { location.hash = '#/login'; return; }
      load();
    });
    return { list, sn, fmt, bind };
  },
};

window.PageMyOrders = {
  template: `
  <div class="card">
    <div class="card-head"><h3>我的订单</h3></div>
    <div class="card-body tight">
      <table class="table">
        <thead><tr><th>订单号</th><th>商品</th><th>金额</th><th>渠道</th><th>状态</th><th>时间</th><th></th></tr></thead>
        <tbody>
          <tr v-for="o in list" :key="o.id">
            <td style="font-family:ui-monospace,monospace;font-size:12.5px">{{ o.order_no }}</td>
            <td>
              <div v-for="it in o.items" :key="it.product_id">{{ it.product_name }} × {{ it.qty }}</div>
              <div v-if="deliverText(o)" style="margin-top:6px;font-size:12px;color:var(--text-3)">已发放：{{ deliverText(o) }}</div>
              <div v-else-if="o.status==='paid'" style="margin-top:6px;font-size:12px;color:var(--danger)">未发放任何内容，请联系客服</div>
            </td>
            <td>¥{{ o.pay_amount }}</td>
            <td>{{ channelName(o.channel) }}</td>
            <td><span class="tag" :class="o.status==='paid'?'success':o.status==='pending'?'warning':''">{{ statusText(o.status) }}</span></td>
            <td>{{ fmt.time(o.created_at) }}</td>
            <td>
              <button class="btn sm" v-if="o.status==='pending'" @click="pay(o)">继续支付</button>
              <button class="btn sm" v-if="o.status==='pending' && canSimulate" @click="simulatePay(o)">模拟支付</button>
            </td>
          </tr>
          <tr v-if="!list.length"><td colspan="7"><div class="empty">暂无订单</div></td></tr>
        </tbody>
      </table>
    </div>
  </div>
  `,
  setup() {
    const list = ref([]);
    const fmt = U.fmt;
    // 模拟支付按钮只在后台显式开启时出现，避免生产环境暴露 0 元发货入口
    const canSimulate = ref(false);
    async function load() { list.value = (await U.api.get('/api/portal/orders')).list; }
    async function simulatePay(o) {
      try {
        await U.api.post(`/api/pay/simulate/${o.order_no}`, {});
        U.toast('支付成功', 'success');
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }
    function pay(o) { location.hash = `#/product/${o.items[0].product_id}`; }
    const statusText = (s) => ({ pending: '待支付', paid: '已支付', refunded: '已退款' }[s] || s);
    const channelName = (c) => ({ wxpay: '微信支付', alipay: '支付宝', simulate: '模拟支付' }[c] || c || '-');
    // 付了钱到底发了什么，必须让用户自己看得见：额度包不会发授权码，
    // 不写出来的话用户只会以为「付了钱没发货」
    function deliverText(o) {
      let arr = [];
      try { arr = JSON.parse(o.deliver_result || '[]'); } catch { arr = []; }
      if (!Array.isArray(arr) || !arr.length) return '';
      return arr.map((c) => {
        if (c.type === 'api_quota') return `API 额度 ${c.quota} 次`;
        if (c.type === 'license') return `授权码 ${c.license_key}`;
        if (c.type === 'license_renew') return `授权 ${c.license_key} 续期 ${c.days} 天`;
        if (c.type === 'license_upgrade') return `授权 ${c.license_key} 升级为 ${c.product}`;
        if (c.type === 'device') return `设备 ${c.sn}`;
        return '';
      }).filter(Boolean).join('，');
    }
    onMounted(async () => {
      if (!localStorage.getItem('user_token')) { location.hash = '#/login'; return; }
      load();
      try {
        const s = await U.api.get('/api/portal/site');
        canSimulate.value = (s.pay_channels || []).includes('simulate');
      } catch (e) { /* ignore */ }
    });
    return { list, fmt, canSimulate, simulatePay, pay, statusText, channelName, deliverText };
  },
};

window.PageAccount = {
  template: `
  <div class="grid g2">
    <div class="card">
      <div class="card-head"><h3>账户资料</h3></div>
      <div class="card-body">
        <div class="kv">
          <div class="k">昵称</div><div>{{ user?.nickname || '-' }}</div>
          <div class="k">OpenID</div><div style="font-family:ui-monospace,monospace;font-size:12.5px">{{ user?.openid || '-' }}</div>
          <div class="k">手机号</div><div>{{ user?.phone || '未绑定' }}</div>
          <div class="k">积分</div><div>{{ user?.points || 0 }}</div>
          <div class="k">注册时间</div><div>{{ fmt.time(user?.created_at) }}</div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>绑定手机号</h3></div>
      <div class="card-body">
        <div class="field"><label>手机号</label><input class="input" v-model="phone" placeholder="请输入手机号" /></div>
        <div class="field"><label>验证码</label>
          <div style="display:flex;gap:8px">
            <input class="input" v-model="code" placeholder="6 位验证码" />
            <button class="btn" @click="sendCode">发送验证码</button>
          </div>
          <div class="hint" v-if="devCode">开发模式验证码：{{ devCode }}</div>
        </div>
        <button class="btn primary" @click="bind">确认绑定</button>
      </div>
    </div>
    <div class="card" style="grid-column:1/-1">
      <div class="card-head"><h3>积分明细</h3><button class="btn primary sm" @click="signin">每日签到</button></div>
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
  </div>
  `,
  setup() {
    const user = Vue.inject('user');
    const phone = ref('');
    const code = ref('');
    const devCode = ref('');
    const points = ref([]);
    const fmt = U.fmt;
    async function sendCode() {
      if (!/^1\d{10}$/.test(phone.value)) { U.toast('手机号格式不正确', 'error'); return; }
      const res = await U.api.post('/api/portal/phone/code', { phone: phone.value });
      devCode.value = res.devCode || '';
      U.toast('验证码已发送', 'success');
    }
    async function bind() {
      try {
        await U.api.post('/api/portal/phone/bind', { phone: phone.value, code: code.value });
        U.toast('绑定成功', 'success');
        location.reload();
      } catch (e) { U.toast(e.message, 'error'); }
    }
    async function signin() {
      try {
        const res = await U.api.post('/api/portal/signin', {});
        U.toast(`签到成功 +${res.gain} 积分`, 'success');
        location.reload();
      } catch (e) { U.toast(e.message, 'error'); }
    }
    onMounted(async () => {
      if (!localStorage.getItem('user_token')) { location.hash = '#/login'; return; }
      points.value = (await U.api.get('/api/portal/points')).list;
    });
    return { user, phone, code, devCode, points, fmt, sendCode, bind, signin };
  },
};

window.PageUserLogin = {
  template: `
  <div class="login-page">
    <div class="login-card">
      <div class="logo">
        <div v-if="settings.site_logo" style="width:40px;height:40px;border-radius:10px;overflow:hidden">
          <img :src="settings.site_logo" style="width:100%;height:100%;object-fit:contain" />
        </div>
        <div v-else style="width:40px;height:40px;border-radius:10px;background:var(--brand);color:#fff;display:grid;place-items:center;font-weight:700">
          {{ (settings.site_short_name || 'U').slice(0,1) }}
        </div>
        <div style="text-align:left">
          <div style="font-weight:600;font-size:15px">{{ settings.site_name || '用户中心' }}</div>
          <div style="color:var(--text-3);font-size:12px">个人空间与产品服务</div>
        </div>
      </div>
      <h2>微信扫码登录</h2>
      <div class="tip">使用微信扫描下方二维码，完成登录</div>
      <div class="qr-box">
        <img v-if="qrcode_url" :src="qrcode_url" />
        <div v-else-if="errmsg" class="qr-placeholder" style="cursor:default">
          <div style="color:var(--danger);font-weight:600">二维码生成失败</div>
        </div>
        <div v-else-if="simulatable" class="qr-placeholder" @click="simulate" style="cursor:pointer">
          未配置服务号参数<br />点击此处使用演示扫码登录
        </div>
        <div v-else class="qr-placeholder" style="cursor:default">未获取到二维码</div>
      </div>
      <div v-if="errmsg" style="text-align:center;font-size:12px;color:var(--danger);margin:8px 12px;word-break:break-all;line-height:1.6">{{ errmsg }}</div>
      <div class="hint" style="text-align:center">{{ statusText }}</div>
      <div class="btn-group" style="justify-content:center;margin-top:12px">
        <button class="btn" @click="refresh">刷新二维码</button>
        <button class="btn" v-if="simulatable && !qrcode_url" @click="simulate">演示登录</button>
      </div>
    </div>
  </div>
  `,
  setup() {
    const settings = Vue.inject('settings');
    const qrcode_url = ref('');
    const scene = ref('');
    const statusText = ref('正在获取二维码...');
    const errmsg = ref('');
    const simulatable = ref(false);
    let timer = null;

    async function refresh() {
      clearInterval(timer);
      qrcode_url.value = '';
      errmsg.value = '';
      statusText.value = '正在获取二维码...';
      let res;
      try {
        res = await U.api.post('/api/wechat/qrcode', {});
      } catch (e) {
        // 以前这里没有 catch，接口一报错就变成未处理的 Promise rejection，
        // 页面永远停在「等待扫码」——表现就是扫码登录页毫无反应
        clearInterval(timer);
        errmsg.value = e.message || '无法连接服务器';
        statusText.value = '请点击「刷新二维码」重试';
        simulatable.value = false;
        return;
      }
      scene.value = res.scene || '';
      qrcode_url.value = res.qrcode_url || '';
      if (res.mode === 'wechat') {
        simulatable.value = false;
        statusText.value = '请使用微信扫码';
      } else if (res.mode === 'error') {
        simulatable.value = false;
        errmsg.value = res.error || '服务号接口调用失败';
        statusText.value = '配置已填写，但调用微信失败（详见上方提示）';
      } else {
        simulatable.value = true;
        statusText.value = '当前为演示模式（未配置服务号）';
      }
      timer = setInterval(poll, 1500);
    }

    async function poll() {
      if (!scene.value) return;
      try {
        const res = await U.api.get(`/api/wechat/qrcode/${scene.value}`);
        if (res.status === 'expired') { statusText.value = '二维码已过期，请刷新'; clearInterval(timer); return; }
        if (res.status === 'confirmed' && res.token) {
          clearInterval(timer);
          U.api.setToken('user', res.token);
          U.toast('登录成功', 'success');
          location.hash = '#/space';
          location.reload();
        }
      } catch (e) { /* ignore */ }
    }

    async function simulate() {
      if (!scene.value) await refresh();
      if (!scene.value) return;
      try {
        await U.api.post(`/api/wechat/simulate/${scene.value}`, { nickname: '演示用户' });
        statusText.value = '已扫码，正在登录...';
      } catch (e) {
        errmsg.value = e.message || '演示登录失败';
      }
    }

    onMounted(refresh);
    return { settings, qrcode_url, statusText, errmsg, simulatable, refresh, simulate };
  },
};
})();

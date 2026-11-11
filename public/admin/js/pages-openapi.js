(function () {
const { ref, reactive, onMounted, computed } = Vue;

window.PageOpenapi = {
  template: `
  <div>
    <div class="grid g4" style="margin-bottom:16px">
      <div class="stat"><div class="label">接入应用</div><div class="value">{{ fmt.int(summary.apps) }}</div><div class="delta">已创建凭证</div></div>
      <div class="stat"><div class="label">在线客户端</div><div class="value">{{ fmt.int(summary.online_sessions) }}</div><div class="delta">令牌有效期内</div></div>
      <div class="stat"><div class="label">今日 API 调用</div><div class="value">{{ fmt.int(summary.today_api_calls) }}</div><div class="delta">软件端请求数</div></div>
      <div class="stat"><div class="label">已激活机器</div><div class="value">{{ fmt.int(summary.bound_machines) }}</div><div class="delta">授权绑定终端</div></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>接入信息</h3><span class="tag brand">给软件端开发用</span></div>
      <div class="card-body">
        <div class="kv">
          <div class="k">接口基址</div><div class="v">{{ baseUrl }}/api/open/v1</div>
          <div class="k">应用签名</div><div class="v">HMAC-SHA256，请求头 X-App-Key / X-Timestamp / X-Nonce / X-Signature（旧客户端，双模期保留）</div>
          <div class="k">公开模式</div><div class="v">仅 X-App-Key（写请求必须带 X-Nonce），每 IP / 每应用频控；新客户端不内置共享密钥</div>
          <div class="k">签名内容</div><div class="v">appKey \\n METHOD \\n path \\n timestamp \\n nonce \\n bodyRaw（\\n 分隔，body 为空时传空串）</div>
          <div class="k">用户令牌</div><div class="v">Authorization: Bearer &lt;access_token&gt;，有效期 2 小时，可用 refresh_token 续期</div>
        </div>
        <div class="hint" style="margin-top:10px">完整接口文档见项目 docs/软件端接入API.md</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>鉴权模式（近 14 天）</h3>
        <button class="btn sm" @click="loadAuthModes">刷新</button>
      </div>
      <div class="card-body">
        <div class="grid g4" style="margin-bottom:10px">
          <div class="stat"><div class="label">用户令牌</div><div class="value">{{ fmt.int(authTotals.token || 0) }}</div><div class="delta">Bearer access_token</div></div>
          <div class="stat"><div class="label">当前密钥签名</div><div class="value">{{ fmt.int(authTotals.hmac || 0) }}</div><div class="delta">新 AppSecret</div></div>
          <div class="stat"><div class="label">旧密钥签名</div><div class="value" :style="{ color: authTotals.hmac_legacy ? 'var(--danger)' : 'var(--success)' }">{{ fmt.int(authTotals.hmac_legacy || 0) }}</div><div class="delta">归零后才能关旧通道</div></div>
          <div class="stat"><div class="label">公开模式</div><div class="value">{{ fmt.int(authTotals.public || 0) }}</div><div class="delta">仅 x-app-key + 频控</div></div>
        </div>
        <div class="hint">旧密钥请求连续 7 天为 0，说明在用的客户端都已换成新凭证；此时再「关闭旧密钥」不会误伤。</div>
      </div>
    </div>

    <div class="toolbar">
      <button class="btn primary" @click="openCreate">新建应用</button>
      <button class="btn" @click="loadAll">刷新</button>
      <span class="hint">密钥只在创建或重置时明文返回一次，请立即保存</span>
    </div>

    <div class="card">
      <div class="card-body tight">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>应用</th><th>绑定上架商品</th><th>套餐档位</th><th>AppKey</th><th>AppSecret</th><th>鉴权通道</th><th>状态</th><th>会话 / 在线</th><th>API 调用</th><th style="width:290px">操作</th></tr></thead>
            <tbody>
              <tr v-for="a in list" :key="a.id">
                <td>
                  <b>{{ a.name }}</b>
                  <div style="color:var(--text-3);font-size:12px">{{ a.version || '未设版本' }}<span v-if="a.remark"> · {{ a.remark }}</span></div>
                </td>
                <td>
                  {{ a.product_name || '未绑定' }}
                  <div style="color:var(--text-3);font-size:12px">
                    {{ a.product_name ? '商品 ID ' + a.product_id : '未绑定商品，用户端不展示' }}
                  </div>
                </td>
                <td>
                  <span class="tag" :class="a.plan_count ? 'success' : ''">{{ a.plan_count || 0 }} 档</span>
                  <div style="color:var(--text-3);font-size:12px" v-if="!a.plan_count">去「套餐档位」复制模板</div>
                </td>
                <td style="font-family:ui-monospace,monospace;font-size:12px">{{ a.app_key }}</td>
                <td style="font-family:ui-monospace,monospace;font-size:12px">{{ a.app_secret_masked }}</td>
                <td>
                  <span class="tag" :class="a.public_auth ? 'success' : ''">公开{{ a.public_auth ? '开' : '关' }}</span>
                  <span class="tag" :class="a.legacy_hmac ? 'warning' : 'success'" style="margin-left:4px">旧密钥{{ a.legacy_hmac ? '可用' : '已停' }}</span>
                  <div style="color:var(--text-3);font-size:12px">{{ a.release_product || '未设升级通道' }}</div>
                </td>
                <td><span class="tag" :class="a.status === 'active' ? 'success' : 'danger'">{{ a.status === 'active' ? '启用' : '停用' }}</span></td>
                <td>{{ a.session_count }} / <b style="color:var(--brand)">{{ a.online_count }}</b></td>
                <td>{{ fmt.int(a.api_calls) }}</td>
                <td>
                  <div class="table-actions">
                    <button class="btn sm" @click="edit(a)">编辑</button>
                    <button class="btn sm" @click="viewSessions(a)">会话</button>
                    <button class="btn sm" @click="toggle(a)">{{ a.status === 'active' ? '停用' : '启用' }}</button>
                    <button class="btn sm" @click="rotate(a)">轮换密钥</button>
                    <button class="btn sm" @click="toggleLegacy(a)">{{ a.legacy_hmac ? '关旧密钥' : '开旧密钥' }}</button>
                    <button class="btn sm" @click="resetSecret(a)">重置密钥</button>
                    <button class="btn sm danger" @click="remove(a)">删除</button>
                  </div>
                </td>
              </tr>
              <tr v-if="!list.length"><td colspan="9"><div class="empty">还没有接入应用，点击「新建应用」创建第一对凭证</div></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="mask" v-if="editing" @click.self="editing=false">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ form.id ? '编辑应用' : '新建应用' }}</h3>
          <button class="close-x" @click="editing=false">&times;</button>
        </div>
        <div class="modal-body">
          <div class="field"><label>应用名称</label><input class="input" v-model="form.name" placeholder="例如：花盆卫士 PC 客户端" /></div>
          <div class="field-row">
            <div class="field"><label>绑定后台上架商品</label>
              <select class="select" v-model="form.product_id">
                <option :value="null">未绑定（用户端不展示该产品）</option>
                <option v-for="p in products" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
              <div class="hint" style="margin-bottom:0">软件端应用 ↔ 上架商品一一对应。建好后到「套餐档位」选中本应用复制模板；未绑定商品或未启用时，用户「我的空间」看不到它。</div>
            </div>
            <div class="field"><label>状态</label>
              <select class="select" v-model="form.status"><option value="active">启用</option><option value="disabled">停用</option></select>
            </div>
          </div>
          <div class="field-row">
            <div class="field"><label>最新版本号</label><input class="input" v-model="form.version" placeholder="V1.0.0" /></div>
            <div class="field"><label>离线宽限（天）</label><input class="input" type="number" v-model.number="form.offline_days" /></div>
          </div>
          <div class="field">
            <label>升级通道产品名</label>
            <input class="input" v-model="form.release_product" placeholder="LabelGo（离线版填 LabelGo-Offline）" />
            <div class="hint" style="margin-bottom:0">对应「版本发布」里的产品名，决定这台客户端查哪份 latest.json。与商品 sku（权益维度）是两件事。</div>
          </div>
          <div class="field"><label>安装包下载地址</label><input class="input" v-model="form.download_url" placeholder="https://..." /></div>
          <div class="field">
            <label>功能码表 feature_schema（每行 token = 名称；登记后套餐档位表单变为勾选，未知 token 无法保存）</label>
            <textarea class="input" rows="6" style="font-family:ui-monospace,monospace;font-size:12px" v-model="schemaText"
              placeholder="labelgo.basic = 基础打印&#10;labelgo.library = 标签库&#10;labelgo.concat = 拼接排版"></textarea>
            <div class="hint" style="margin-bottom:0">
              词表要与客户端约定一致（客户端用 features.includes(token) 判功能）。只影响之后保存的档位，已售授权里的旧 token 不受影响。
              <button class="btn sm" type="button" style="margin-left:8px" @click="fillLabelgoPreset">填入标签打印示例词表</button>
            </div>
          </div>
          <div class="field"><label>更新说明</label><textarea class="input" v-model="form.release_note"></textarea></div>
          <div class="field"><label>备注</label><input class="input" v-model="form.remark" /></div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editing=false">取消</button>
          <button class="btn primary" @click="save">保存</button>
        </div>
      </div>
    </div>

    <div class="mask" v-if="secretBox.show" @click.self="secretBox.show=false">
      <div class="modal">
        <div class="modal-head"><h3>请立即保存密钥</h3><button class="close-x" @click="secretBox.show=false">&times;</button></div>
        <div class="modal-body">
          <div class="hint" style="margin-bottom:8px">关闭后无法再次查看明文，重置密钥会使该应用下所有客户端令牌立即失效。</div>
          <div class="field"><label>AppKey</label><input class="input" :value="secretBox.app_key" readonly /></div>
          <div class="field"><label>AppSecret</label><input class="input" :value="secretBox.app_secret" readonly /></div>
        </div>
        <div class="modal-foot"><button class="btn primary" @click="secretBox.show=false">我已保存</button></div>
      </div>
    </div>

    <div class="drawer-mask" v-if="sessions.show" @click.self="sessions.show=false">
      <div class="drawer">
        <div class="modal-head"><h3>{{ sessions.appName }} · 客户端会话</h3><button class="close-x" @click="sessions.show=false">&times;</button></div>
        <div class="modal-body">
          <div class="row-list">
            <div class="row-item" v-for="s in sessions.list" :key="s.id">
              <div>
                <b>{{ s.nickname || '未知用户' }}</b>
                <div style="color:var(--text-3);font-size:12px">
                  机器 {{ s.machine_id || '-' }} · {{ s.app_version || '未知版本' }} · {{ s.ip || '-' }}
                </div>
                <div style="color:var(--text-3);font-size:12px">
                  授权 {{ s.license_key || '未绑定' }} · 活跃 {{ fmt.ago(s.last_seen_at) }} · 过期 {{ fmt.time(s.expires_at) }}
                </div>
              </div>
              <button class="btn sm danger" v-if="s.status === 'active'" @click="revoke(s)">踢下线</button>
              <span class="tag" v-else>已失效</span>
            </div>
            <div class="empty" v-if="!sessions.list.length">暂无客户端登录记录</div>
          </div>
        </div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const list = ref([]);
    const products = ref([]);
    const summary = ref({ apps: 0, online_sessions: 0, today_api_calls: 0, bound_machines: 0 });
    const editing = ref(false);
    const fmt = U.fmt;
    const baseUrl = computed(() => location.origin);
    const form = reactive({
      id: 0, name: '', product_id: null, status: 'active', offline_days: 0,
      version: '', download_url: '', release_note: '', remark: '', release_product: '',
    });
    // 双模切换看板：近 14 天各鉴权模式的调用量
    const authTotals = ref({});
    const authRows = ref([]);
    // 功能码表用「每行 token = 名称」的文本编辑；提交时服务端统一校验格式与去重
    const schemaText = ref('');
    // 标签打印软件（labelgo）示例词表：与客户端核对后可增删，别让两套语义对不上
    const LABELGO_PRESET = [
      'labelgo.basic = 基础打印',
      'labelgo.library = 标签库',
      'labelgo.concat = 拼接排版',
      'labelgo.batch = 批量打印',
      'labelgo.excel = Excel 导入',
      'labelgo.ribbon = 碳带/纸张配比',
      'labelgo.cloud = 云同步',
      'labelgo.offline = 离线模式',
      'labelgo.api = 本地接口',
      'labelgo.distributed = 分布式席位',
      'labelgo.erp_conn = ERP 对接',
    ].join('\n');
    const secretBox = reactive({ show: false, app_key: '', app_secret: '' });
    const sessions = reactive({ show: false, appId: 0, appName: '', list: [] });

    async function load() {
      const res = await U.api.get('/api/open-apps');
      list.value = res.list || [];
    }
    async function loadSummary() {
      try {
        summary.value = await U.api.get('/api/open-stats/summary');
      } catch (e) { /* ignore */ }
    }
    async function loadProducts() {
      try {
        const res = await U.api.get('/api/products?pageSize=100');
        products.value = res.list || [];
      } catch (e) { /* ignore */ }
    }
    /** 档位数从 /api/plans/apps 拿，方便一眼看出哪个新应用还没配套餐 */
    async function loadPlanCounts() {
      try {
        const res = await U.api.get('/api/plans/apps');
        const counts = {};
        (res.list || []).forEach((a) => { counts[a.id] = a.plan_count || 0; });
        list.value = list.value.map((a) => ({ ...a, plan_count: counts[a.id] || 0 }));
      } catch (e) { /* ignore */ }
    }
    async function loadAll() {
      await Promise.all([load(), loadSummary(), loadProducts(), loadAuthModes()]);
      await loadPlanCounts();
    }

    async function loadAuthModes() {
      try {
        const res = await U.api.get('/api/open-apps/auth-modes?days=14');
        authTotals.value = res.totals || {};
        authRows.value = res.rows || [];
      } catch (e) { /* 报表失败不影响主表 */ }
    }

    function openCreate() {
      Object.assign(form, { id: 0, name: '', product_id: null, status: 'active', offline_days: 0, version: '', download_url: '', release_note: '', remark: '', release_product: '' });
      schemaText.value = '';
      editing.value = true;
    }
    function edit(a) {
      Object.assign(form, {
        id: a.id, name: a.name, product_id: a.product_id || null, status: a.status,
        offline_days: a.offline_days || 0, version: a.version || '', download_url: a.download_url || '',
        release_note: a.release_note || '', remark: a.remark || '', release_product: a.release_product || '',
      });
      schemaText.value = (a.feature_schema || []).map((x) => x.label ? `${x.token} = ${x.label}` : x.token).join('\n');
      editing.value = true;
    }
    function fillLabelgoPreset() {
      schemaText.value = schemaText.value
        ? schemaText.value + '\n' + LABELGO_PRESET
        : LABELGO_PRESET;
      U.toast('已填入示例词表，请与客户端核对后保存', 'success');
    }
    async function save() {
      if (!form.name.trim()) return U.toast('请填写应用名称', 'error');
      try {
        const body = { ...form, feature_schema: schemaText.value };
        if (form.id) {
          await U.api.post('/api/open-apps/' + form.id, body);
          U.toast('已保存', 'success');
        } else {
          const res = await U.api.post('/api/open-apps', body);
          secretBox.app_key = res.app_key;
          secretBox.app_secret = res.app_secret;
          secretBox.show = true;
        }
        editing.value = false;
        await loadAll();
      } catch (e) {
        U.toast(e.message, 'error');
      }
    }
    async function toggle(a) {
      try {
        await U.api.post('/api/open-apps/' + a.id, { status: a.status === 'active' ? 'disabled' : 'active' });
        U.toast('已更新', 'success');
        await loadAll();
      } catch (e) { U.toast(e.message, 'error'); }
    }
    async function resetSecret(a) {
      if (!(await U.confirm('重置后旧密钥立即作废（含双模期的旧值），该应用下所有已登录客户端会被强制下线，继续？'))) return;
      try {
        const res = await U.api.post('/api/open-apps/' + a.id + '/reset-secret', {});
        secretBox.app_key = a.app_key;
        secretBox.app_secret = res.app_secret;
        secretBox.show = true;
        await loadAll();
      } catch (e) { U.toast(e.message, 'error'); }
    }
    /** 双模轮换：新值生效、旧值继续放行，不踢会话；等报表归零后再关旧通道 */
    async function rotate(a) {
      if (!(await U.confirm('轮换后新密钥立即生效，旧密钥在「关闭旧密钥」前仍可用（双模期），在线客户端不会被踢下线。继续？'))) return;
      try {
        const res = await U.api.post('/api/open-apps/' + a.id + '/rotate-secret', {});
        secretBox.app_key = a.app_key;
        secretBox.app_secret = res.app_secret;
        secretBox.show = true;
        U.toast(res.hint || '已轮换', 'success');
        await loadAll();
      } catch (e) { U.toast(e.message, 'error'); }
    }
    async function toggleLegacy(a) {
      const next = !a.legacy_hmac;
      if (!next && !(await U.confirm('关闭后仍用旧密钥的客户端会直接 401（APP_SECRET_RETIRED）。确认近 14 天「旧密钥签名」已归零？'))) return;
      try {
        await U.api.post('/api/open-apps/' + a.id + '/legacy', { enabled: next });
        U.toast(next ? '旧密钥通道已开启' : '旧密钥通道已关闭', 'success');
        await loadAll();
      } catch (e) { U.toast(e.message, 'error'); }
    }
    async function remove(a) {
      if (!(await U.confirm('删除应用后，其客户端令牌将全部失效，继续？'))) return;
      try {
        await U.api.del('/api/open-apps/' + a.id);
        U.toast('已删除', 'success');
        await loadAll();
      } catch (e) { U.toast(e.message, 'error'); }
    }
    async function viewSessions(a) {
      sessions.appId = a.id;
      sessions.appName = a.name;
      sessions.show = true;
      try {
        const res = await U.api.get('/api/open-apps/' + a.id + '/sessions');
        sessions.list = res.list || [];
      } catch (e) { U.toast(e.message, 'error'); }
    }
    async function revoke(s) {
      try {
        await U.api.post('/api/open-apps/sessions/' + s.id + '/revoke', {});
        U.toast('已踢下线', 'success');
        await viewSessions({ id: sessions.appId, name: sessions.appName });
      } catch (e) { U.toast(e.message, 'error'); }
    }

    onMounted(loadAll);

    return {
      list, products, summary, editing, form, secretBox, sessions, fmt, baseUrl,
      schemaText, fillLabelgoPreset, authTotals, authRows,
      openCreate, edit, save, toggle, rotate, toggleLegacy, resetSecret, remove, viewSessions, revoke, loadAll, loadAuthModes,
    };
  },
};
})();

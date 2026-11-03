(function () {
const { ref, reactive, onMounted, computed } = Vue;

window.PagePlans = {
  template: `
  <div>
    <div class="toolbar">
      <select class="select" style="max-width:280px" v-model="filterApp">
        <option value="all">全部软件产品</option>
        <option value="template">通用模板（未绑定产品）</option>
        <option v-for="a in apps" :key="a.id" :value="a.id">{{ a.name }} · {{ a.product_name || '未绑定商品' }}</option>
      </select>
      <button class="btn" @click="load">刷新</button>
      <div class="spacer"></div>
      <button class="btn" :disabled="!selectedAppId" @click="copyTemplate">从模板复制到该产品</button>
      <button class="btn" @click="openExport">导出 JSON</button>
      <button class="btn" @click="openImport">导入 JSON</button>
      <button class="btn primary" @click="openCreate">+ 新增档位</button>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-body">
        <div class="hint" style="margin-top:0">
          套餐档位<b>按软件产品分组</b>：每个产品都有自己的一套等级，同一 code（如 free / member）可以在不同产品下重复。
          档位挂在「开放接入应用」上，应用再绑定后台上架商品。<b>运行时以数据库为准</b>，JSON 只用于备份与版本管理。
        </div>
        <div class="hint" style="margin-bottom:0">
          新上架软件：先在「开放接入」建应用并绑定上架商品 → 回到本页选中该产品 → 点「从模板复制」生成五档 → 按实际价格与权益修改。
          <span v-if="selectedApp">当前产品：<b>{{ selectedApp.name }}</b>（绑定商品：{{ selectedApp.product_name || '未绑定' }}，已有 {{ selectedApp.plan_count }} 档）</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-body tight">
        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th>档位</th><th>所属产品</th><th>code</th><th>等级</th><th>计费</th><th>价格</th><th>周期</th>
              <th>联网</th><th>离线天数</th><th>设备/席位</th><th>权益</th><th>状态</th><th style="width:150px">操作</th>
            </tr></thead>
            <tbody>
              <tr v-for="p in list" :key="p.id">
                <td><b>{{ p.name }}</b></td>
                <td style="font-size:12.5px">{{ p.app_name || '通用模板' }}</td>
                <td style="font-family:ui-monospace,monospace;font-size:12px">{{ p.code }}</td>
                <td>{{ p.tier }}</td>
                <td>{{ billingText(p.billing) }}</td>
                <td>{{ fmt.money(p.price) }}</td>
                <td>{{ p.period_days ? p.period_days + ' 天' : '-' }}</td>
                <td>{{ p.online_required ? '必须' : '可离线' }}</td>
                <td>{{ p.offline_days }}</td>
                <td>{{ p.max_devices }} / {{ p.seats }}</td>
                <td style="font-size:12px;color:var(--text-3)">{{ (p.features || []).length }} 项</td>
                <td><span class="tag" :class="p.status==='on'?'success':''">{{ p.status==='on'?'已上架':'已下架' }}</span></td>
                <td>
                  <div class="table-actions">
                    <button class="btn sm" @click="openEdit(p)">编辑</button>
                    <button class="btn sm" @click="toggle(p)">{{ p.status==='on'?'下架':'上架' }}</button>
                    <button class="btn sm danger" @click="remove(p)">删除</button>
                  </div>
                </td>
              </tr>
              <tr v-if="!list.length"><td colspan="13"><div class="empty">该产品还没有档位，点「从模板复制」或「新增档位」</div></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="mask" v-if="editing" @click.self="editing=false">
      <div class="modal wide">
        <div class="modal-head"><h3>{{ form.id ? '编辑档位' : '新增档位' }}</h3><button class="close-x" @click="editing=false">&times;</button></div>
        <div class="modal-body">
          <div class="field-row">
            <div class="field"><label>所属软件产品</label>
              <select class="select" v-model="form.app_id">
                <option :value="null">通用模板（不直接售卖，仅用于复制）</option>
                <option v-for="a in apps" :key="a.id" :value="a.id">{{ a.name }} · {{ a.product_name || '未绑定商品' }}</option>
              </select>
              <div class="hint" style="margin-bottom:0">选具体产品后，该档位只能用于这个软件；通用模板只作底稿。</div>
            </div>
            <div class="field"><label>档位名称</label><input class="input" v-model="form.name" placeholder="例如：在线会员版" /></div>
          </div>
          <div class="field-row">
            <div class="field"><label>code（小写字母/数字/下划线，同一产品内唯一）</label><input class="input" v-model="form.code" placeholder="member" /></div>
            <div class="field"><label>等级 tier（数字越大越高档，用于判断升降级）</label><input class="input" type="number" v-model.number="form.tier" /></div>
          </div>
          <div class="field-row">
            <div class="field"><label>计费方式</label>
              <select class="select" v-model="form.billing">
                <option value="free">免费（无需下单）</option>
                <option value="once">买断（无到期）</option>
                <option value="period">周期订阅（有到期，可续费）</option>
              </select>
            </div>
            <div class="field"><label>状态</label>
              <select class="select" v-model="form.status"><option value="on">已上架</option><option value="off">已下架</option></select>
            </div>
          </div>
          <div class="field-row">
            <div class="field"><label>售价（元）</label><input class="input" type="number" v-model.number="form.price" /></div>
            <div class="field"><label>原价（元）</label><input class="input" type="number" v-model.number="form.original_price" /></div>
          </div>
          <div class="field-row">
            <div class="field"><label>周期天数（仅周期订阅有效）</label><input class="input" type="number" v-model.number="form.period_days" /></div>
            <div class="field"><label>最大设备数</label><input class="input" type="number" v-model.number="form.max_devices" /></div>
          </div>
          <div class="field-row">
            <div class="field"><label>联网要求</label>
              <select class="select" v-model.number="form.online_required">
                <option :value="1">必须联网（离线宽限最多 7 天）</option>
                <option :value="0">允许离线</option>
              </select>
            </div>
            <div class="field"><label>离线宽限天数（写进签名票据）</label><input class="input" type="number" v-model.number="form.offline_days" /></div>
          </div>
          <div class="field-row">
            <div class="field"><label>席位数（分布式版用）</label><input class="input" type="number" v-model.number="form.seats" /></div>
            <div class="field"><label>排序（越大越前）</label><input class="input" type="number" v-model.number="form.sort" /></div>
          </div>
          <div class="field">
            <label>功能权限码（每行一条，会随离线票据签名下发给客户端）</label>
            <textarea class="input" rows="4" v-model="featureText" placeholder="basic.view&#10;device.read&#10;offline.mode"></textarea>
          </div>
          <div class="field"><label>备注</label><input class="input" v-model="form.remark" /></div>
          <div class="hint" v-if="error" style="color:var(--danger)">{{ error }}</div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editing=false">取消</button>
          <button class="btn primary" @click="save">保存</button>
        </div>
      </div>
    </div>

    <div class="mask" v-if="ioMode" @click.self="ioMode=''">
      <div class="modal wide">
        <div class="modal-head"><h3>{{ ioMode==='export' ? '导出档位配置' : '导入档位配置' }}</h3><button class="close-x" @click="ioMode=''">&times;</button></div>
        <div class="modal-body">
          <div class="hint" style="margin-top:0" v-if="ioMode==='export'">
            复制后存进版本库即可。按 (产品, code) 新增/更新，不会删除已有档位。
            <span v-if="selectedAppId">当前导出的是「{{ selectedApp.name }}」的档位。</span>
          </div>
          <div class="hint" style="margin-top:0" v-else>
            粘贴 <b>{ "plans": [...] }</b> 或直接粘贴档位数组。
            <span v-if="selectedAppId">选中了产品时，整份配置会导入到「{{ selectedApp.name }}」，很适合把通用模板复制过去。</span>
            导入前请先核对价格与权益。
          </div>
          <textarea class="input" rows="16" style="font-family:ui-monospace,monospace;font-size:12px" v-model="ioText"></textarea>
          <div class="hint" v-if="ioError" style="color:var(--danger)">{{ ioError }}</div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="ioMode=''">关闭</button>
          <button class="btn" v-if="ioMode==='export'" @click="copyText">复制</button>
          <button class="btn primary" v-if="ioMode==='import'" @click="doImport">校验并导入</button>
        </div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const allList = ref([]);
    const apps = ref([]);
    const filterApp = ref('all');
    const editing = ref(false);
    const error = ref('');
    const ioMode = ref('');
    const ioText = ref('');
    const ioError = ref('');
    const featureText = ref('');
    const form = reactive({});
    const fmt = U.fmt;

    const selectedAppId = computed(() => {
      const v = filterApp.value;
      return (v === 'all' || v === 'template') ? 0 : Number(v) || 0;
    });
    const selectedApp = computed(() => apps.value.find((a) => Number(a.id) === selectedAppId.value) || null);
    const list = computed(() => {
      const v = filterApp.value;
      if (v === 'all') return allList.value;
      if (v === 'template') return allList.value.filter((p) => !p.app_id);
      return allList.value.filter((p) => Number(p.app_id) === Number(v));
    });

    const billingText = (b) => ({ free: '免费', once: '买断', period: '周期订阅' }[b] || b);

    async function load() {
      const res = await U.api.get('/api/plans');
      allList.value = res.list || [];
      apps.value = res.apps || [];
    }

    function reset() {
      Object.keys(form).forEach((k) => delete form[k]);
      Object.assign(form, {
        name: '', code: '', app_id: selectedAppId.value || null,
        tier: 0, billing: 'period', price: 0, original_price: 0,
        period_days: 365, online_required: 1, offline_days: 0, max_devices: 1,
        seats: 1, sort: 0, features: [], status: 'on', remark: '',
      });
      featureText.value = '';
      error.value = '';
    }

    function openCreate() { reset(); editing.value = true; }
    function openEdit(p) {
      reset();
      Object.assign(form, p);
      form.app_id = p.app_id || null;
      featureText.value = (p.features || []).join('\n');
      editing.value = true;
    }

    async function save() {
      error.value = '';
      form.features = featureText.value.split('\n').map((s) => s.trim()).filter(Boolean);
      form.app_id = form.app_id ? Number(form.app_id) || null : null;
      try {
        if (form.id) await U.api.post(`/api/plans/${form.id}`, form);
        else await U.api.post('/api/plans', form);
        U.toast('保存成功', 'success');
        editing.value = false;
        load();
      } catch (e) { error.value = e.message; }
    }

    async function toggle(p) {
      try {
        await U.api.post(`/api/plans/${p.id}`, { ...p, status: p.status === 'on' ? 'off' : 'on' });
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function remove(p) {
      if (!confirm(`确定删除档位「${p.name}」？已有授权引用的档位不能删除。`)) return;
      try {
        await U.api.del(`/api/plans/${p.id}`);
        U.toast('已删除', 'success');
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function copyTemplate() {
      if (!selectedAppId.value) return;
      if (!confirm(`把通用模板档位复制到「${selectedApp.value ? selectedApp.value.name : ''}」？已存在的 code 会跳过，不会覆盖已调好的价格。`)) return;
      try {
        const res = await U.api.post('/api/plans/copy-template', { app_id: selectedAppId.value });
        U.toast(`已复制 ${res.created} 档，跳过 ${res.skipped} 档`, 'success');
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function openExport() {
      ioError.value = '';
      const url = selectedAppId.value ? '/api/plans/export?app_id=' + encodeURIComponent(selectedAppId.value) : '/api/plans/export';
      const cfg = await U.api.get(url);
      ioText.value = JSON.stringify(cfg, null, 2);
      ioMode.value = 'export';
    }

    function openImport() {
      ioError.value = '';
      ioText.value = '';
      ioMode.value = 'import';
    }

    async function doImport() {
      ioError.value = '';
      try {
        let cfg = ioText.value;
        // 选中具体产品时把目标产品写进配置，服务端会整份落到该产品，
        // 这样「导出通用模板 → 选产品导入」等价于复制一套档位。
        if (selectedAppId.value && selectedApp.value) {
          const parsed = JSON.parse(cfg);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            parsed.app = { app_key: selectedApp.value.app_key };
            cfg = JSON.stringify(parsed);
          }
        }
        const res = await U.api.post('/api/plans/import', { config: cfg });
        U.toast(`导入完成：新增 ${res.created} / 更新 ${res.updated}`, 'success');
        ioMode.value = '';
        load();
      } catch (e) { ioError.value = e.message; }
    }

    function copyText() {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(ioText.value)
          .then(() => U.toast('已复制', 'success'), () => U.toast('复制失败，请手动选中', 'error'));
      } else {
        U.toast('请手动选中文本复制', 'error');
      }
    }

    onMounted(load);
    return {
      allList, apps, filterApp, list, selectedAppId, selectedApp,
      editing, form, featureText, error, ioMode, ioText, ioError, fmt,
      billingText, load, openCreate, openEdit, save, toggle, remove, copyTemplate,
      openExport, openImport, doImport, copyText,
    };
  },
};
})();

(function () {
const { ref, reactive, onMounted, computed } = Vue;

window.PagePlans = {
  template: `
  <div>
    <div class="toolbar">
      <button class="btn" @click="load">刷新</button>
      <div class="spacer"></div>
      <button class="btn" @click="openExport">导出 JSON</button>
      <button class="btn" @click="openImport">导入 JSON</button>
      <button class="btn primary" @click="openCreate">+ 新增档位</button>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-body">
        <div class="hint" style="margin-top:0">
          同一软件产品的等级定义（免费 / 会员 / 高级会员 / 离线企业 / 离线分布式）。
          <b>运行时以数据库为准</b>，JSON 只用于备份与版本管理；导入只会新增或更新档位，不会删除表里已有的档位。
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-body tight">
        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th>档位</th><th>code</th><th>等级</th><th>计费</th><th>价格</th><th>周期</th>
              <th>联网</th><th>离线天数</th><th>设备/席位</th><th>权益</th><th>状态</th><th style="width:150px">操作</th>
            </tr></thead>
            <tbody>
              <tr v-for="p in list" :key="p.id">
                <td><b>{{ p.name }}</b></td>
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
              <tr v-if="!list.length"><td colspan="12"><div class="empty">还没有档位，点「新增档位」或导入 JSON</div></td></tr>
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
            <div class="field"><label>档位名称</label><input class="input" v-model="form.name" placeholder="例如：在线会员版" /></div>
            <div class="field"><label>code（小写字母/数字/下划线，唯一）</label><input class="input" v-model="form.code" placeholder="member" /></div>
          </div>
          <div class="field-row">
            <div class="field"><label>等级 tier（数字越大越高档，用于判断升降级）</label><input class="input" type="number" v-model.number="form.tier" /></div>
            <div class="field"><label>计费方式</label>
              <select class="select" v-model="form.billing">
                <option value="free">免费（无需下单）</option>
                <option value="once">买断（无到期）</option>
                <option value="period">周期订阅（有到期，可续费）</option>
              </select>
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
            <textarea class="input" rows="5" v-model="featureText" placeholder="basic.view&#10;device.read&#10;offline.mode"></textarea>
          </div>
          <div class="field-row">
            <div class="field"><label>状态</label>
              <select class="select" v-model="form.status"><option value="on">已上架</option><option value="off">已下架</option></select>
            </div>
            <div class="field"><label>备注</label><input class="input" v-model="form.remark" /></div>
          </div>
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
            复制后存进版本库即可。恢复时用「导入」，按 code 新增/更新，不会删除已有档位。
          </div>
          <div class="hint" style="margin-top:0" v-else>
            粘贴 <b>{ "plans": [...] }</b> 或直接粘贴档位数组。导入前请先在表单里核对价格与权益。
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
    const list = ref([]);
    const editing = ref(false);
    const error = ref('');
    const ioMode = ref('');
    const ioText = ref('');
    const ioError = ref('');
    const featureText = ref('');
    const form = reactive({});
    const fmt = U.fmt;

    const billingText = (b) => ({ free: '免费', once: '买断', period: '周期订阅' }[b] || b);

    async function load() {
      list.value = (await U.api.get('/api/plans')).list;
    }

    function reset() {
      Object.keys(form).forEach((k) => delete form[k]);
      Object.assign(form, {
        name: '', code: '', tier: 0, billing: 'period', price: 0, original_price: 0,
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
      featureText.value = (p.features || []).join('\n');
      editing.value = true;
    }

    async function save() {
      error.value = '';
      form.features = featureText.value.split('\n').map((s) => s.trim()).filter(Boolean);
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

    async function openExport() {
      ioError.value = '';
      const cfg = await U.api.get('/api/plans/export');
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
        const res = await U.api.post('/api/plans/import', { config: ioText.value });
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
      list, editing, form, featureText, error, ioMode, ioText, ioError, fmt,
      billingText, load, openCreate, openEdit, save, toggle, remove,
      openExport, openImport, doImport, copyText,
    };
  },
};
})();

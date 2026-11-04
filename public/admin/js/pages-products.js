(function () {
const { ref, reactive, onMounted, computed } = Vue;

const PRODUCT_TYPES = { software: '软件', hardware: '硬件', service: '服务' };

window.PageProducts = {
  template: `
  <div>
    <div class="toolbar">
      <input class="input" v-model="q" placeholder="搜索产品名称 / 分类" @keyup.enter="load" />
      <select class="select" v-model="type">
        <option value="">全部类型</option>
        <option value="software">软件</option>
        <option value="hardware">硬件</option>
        <option value="service">服务</option>
      </select>
      <select class="select" v-model="status">
        <option value="">全部状态</option>
        <option value="on">已上架</option>
        <option value="off">未上架</option>
      </select>
      <button class="btn" @click="load">查询</button>
      <div class="spacer"></div>
      <button class="btn primary" @click="openCreate">+ 新增产品</button>
    </div>

    <div class="card">
      <div class="card-body tight">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>产品</th><th>类型</th><th>分类</th><th>价格</th><th>下载/安装</th>
                <th>活跃</th><th>销量</th><th>库存</th><th>状态</th><th style="width:180px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in list" :key="p.id">
                <td>
                  <div style="display:flex;align-items:center;gap:10px">
                    <div class="thumb-sm">
                      <img v-if="p.icon" :src="p.icon" alt="" />
                      <span v-else style="color:var(--brand)" v-html="icon('box')"></span>
                    </div>
                    <div>
                      <div style="font-weight:500">{{ p.name }}</div>
                      <div style="color:var(--text-3);font-size:12px">{{ p.subtitle }}</div>
                    </div>
                  </div>
                </td>
                <td><span class="tag">{{ typeName(p.type) }}</span></td>
                <td>{{ p.category || '-' }}</td>
                <td>{{ fmt.money(p.price) }}</td>
                <td>{{ fmt.int(p.total_downloads) }} / {{ fmt.int(p.total_installs) }}</td>
                <td>{{ fmt.int(p.active_users) }}</td>
                <td>{{ fmt.int(p.total_sales) }}</td>
                <td>{{ fmt.int(p.stock) }}</td>
                <td><span class="tag" :class="p.status === 'on' ? 'success' : ''">{{ p.status === 'on' ? '已上架' : '未上架' }}</span></td>
                <td>
                  <div class="table-actions">
                    <button class="btn sm" @click="openEdit(p)">编辑</button>
                    <button class="btn sm" @click="toggle(p)">{{ p.status === 'on' ? '下架' : '上架' }}</button>
                    <button class="btn sm danger" @click="remove(p)">删除</button>
                  </div>
                </td>
              </tr>
              <tr v-if="!list.length"><td colspan="10"><div class="empty">没有找到产品</div></td></tr>
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
      <div class="modal wide">
        <div class="modal-head">
          <h3>{{ form.id ? '编辑产品' : '新增产品' }}</h3>
          <button class="close-x" @click="editing=false">&times;</button>
        </div>
        <div class="modal-body">
          <div class="field-row">
            <div class="field"><label>产品名称</label><input class="input" v-model="form.name" placeholder="例如：花盆卫士 Pro" /></div>
            <div class="field"><label>产品类型</label>
              <select class="select" v-model="form.type">
                <option value="software">软件</option><option value="hardware">硬件</option><option value="service">服务</option>
              </select>
            </div>
          </div>
          <div class="field-row">
            <div class="field"><label>副标题</label><input class="input" v-model="form.subtitle" /></div>
            <div class="field"><label>分类</label><input class="input" v-model="form.category" placeholder="如：智能硬件" /></div>
          </div>
          <div class="field-row">
            <div class="field"><label>售价（元）</label><input class="input" type="number" v-model.number="form.price" /></div>
            <div class="field"><label>原价（元）</label><input class="input" type="number" v-model.number="form.original_price" /></div>
          </div>
          <div class="field-row">
            <div class="field"><label>库存</label><input class="input" type="number" v-model.number="form.stock" /></div>
            <div class="field"><label>版本号</label><input class="input" v-model="form.version" /></div>
          </div>
          <div class="field" v-if="form.type==='service'">
            <label>API 额度（次）</label>
            <input class="input" type="number" v-model.number="form.quota" placeholder="例如 100000" />
            <div class="hint">「服务」类商品支付后直接给用户账户充这个次数的 API 调用额度。
              <b>留空才会按名称/副标题里的「N 万次」猜</b>，猜不出就发 10 万次 —— 建议一定显式填。</div>
          </div>
          <div class="field"><label>产品图标</label>
            <div style="display:flex;gap:10px;align-items:center">
              <div class="thumb-sm" style="width:56px;height:56px;border-radius:10px;border:1px solid var(--border)">
                <img v-if="form.icon" :src="form.icon" alt="" />
                <span v-else style="color:var(--text-3);font-size:12px">无</span>
              </div>
              <input type="file" accept="image/*" @change="uploadIcon" />
            </div>
          </div>
          <div class="field"><label>下载地址</label><input class="input" v-model="form.download_url" placeholder="安装包 URL" /></div>
          <div class="field"><label>产品简介</label><textarea class="input" v-model="form.description"></textarea></div>
          <div class="field"><label>功能亮点（每行一条）</label><textarea class="input" v-model="featureText" placeholder="远程控制&#10;自动灌溉&#10;数据看板"></textarea></div>
          <div class="field-row">
            <div class="field"><label>状态</label>
              <select class="select" v-model="form.status"><option value="on">上架</option><option value="off">下架</option></select>
            </div>
            <div class="field"><label>排序（越大越前）</label><input class="input" type="number" v-model.number="form.sort" /></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editing=false">取消</button>
          <button class="btn primary" @click="save">保存</button>
        </div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const list = ref([]);
    const total = ref(0);
    const page = ref(1);
    const pageSize = 20;
    const q = ref('');
    const type = ref('');
    const status = ref('');
    const editing = ref(false);
    const featureText = ref('');
    const form = reactive({});
    const fmt = U.fmt;
    const icon = (n) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">${U.icons[n]}</svg>`;
    const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

    async function load() {
      const url = `/api/products?page=${page.value}&pageSize=${pageSize}&q=${encodeURIComponent(q.value)}&type=${type.value}&status=${status.value}`;
      const res = await U.api.get(url);
      list.value = res.list;
      total.value = res.total;
    }

    function reset() {
      Object.keys(form).forEach((k) => delete form[k]);
      Object.assign(form, {
        type: 'software', name: '', subtitle: '', category: '', price: 0, original_price: 0,
        stock: 0, version: '1.0.0', icon: '', download_url: '', description: '', status: 'off',
        sort: 0, is_official: 1, quota: 0, features: [],
      });
      featureText.value = '';
    }

    function openCreate() { reset(); editing.value = true; }

    function openEdit(p) {
      reset();
      Object.assign(form, p);
      featureText.value = (p.features || []).join('\n');
      editing.value = true;
    }

    async function save() {
      form.features = featureText.value.split('\n').map((s) => s.trim()).filter(Boolean);
      try {
        if (form.id) await U.api.post(`/api/products/${form.id}`, form);
        else await U.api.post('/api/products', form);
        U.toast('保存成功', 'success');
        editing.value = false;
        load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function toggle(p) {
      await U.api.post(`/api/products/${p.id}`, { status: p.status === 'on' ? 'off' : 'on' });
      load();
    }

    async function remove(p) {
      if (!(await U.confirm(`确定删除「${p.name}」？`))) return;
      try {
        await U.api.del(`/api/products/${p.id}`);
        U.toast('已删除', 'success');
        load();
      } catch (e) {
        // 409 = 还有授权或软件应用绑着，服务端给出了原因。这里必须把原因摊开讲，
        // 再让管理员决定是否强删 —— 以前是直接静默失败，看起来像「删不掉」。
        if (e.data && e.data.code === 'PRODUCT_IN_USE') {
          const b = e.data.blockers || {};
          const detail = [
            b.licenses ? `• ${b.licenses} 张未作废授权会被一并作废` : '',
            b.open_app ? `• 软件应用「${b.open_app.name}」会解除商品绑定` : '',
            b.plans ? `• ${b.plans} 个套餐档位会解除商品关联` : '',
          ].filter(Boolean).join('\n');
          const ok = await U.confirm(
            `${e.data.error}\n\n强制删除会：\n${detail}\n\n已售授权将立即失效、对应客户端会掉线。确定继续？`,
            { title: '该商品仍在使用', okText: '强制删除' },
          );
          if (!ok) return;
          try {
            const res = await U.api.del(`/api/products/${p.id}?force=1`);
            U.toast(`已强制删除${res.revoked ? `，作废 ${res.revoked} 张授权` : ''}`, 'success');
            load();
          } catch (e2) { U.toast(U.failMsg(e2, '删除失败'), 'error'); }
          return;
        }
        U.toast(U.failMsg(e, '删除失败'), 'error');
      }
    }

    async function uploadIcon(e) {
      const file = e.target.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${U.basePath}/api/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${U.api.getToken('admin')}` },
        body: fd,
      }).then((r) => r.json());
      if (res.url) form.icon = res.url;
    }

    function typeName(t) { return PRODUCT_TYPES[t] || t; }

    onMounted(load);
    return {
      list, total, page, pages, q, type, status, editing, form, featureText, fmt, icon,
      load, openCreate, openEdit, save, toggle, remove, uploadIcon, typeName,
    };
  },
};

window.PageStorefront = {
  template: `
  <div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>官方上架栏目</h3><span class="tag brand">用户端首页展示</span></div>
      <div class="card-body">
        <div class="hint" style="margin-top:0">这里展示我方官方软硬件产品。拖动排序按钮可调整展示顺序，关闭「首页推荐」后不出现在用户端首页推荐位。</div>
      </div>
    </div>
    <div class="prod-grid">
      <div class="prod-card" v-for="p in list" :key="p.id">
        <div class="thumb">
          <img v-if="p.icon" :src="p.icon" alt="" loading="lazy" />
          <span v-else class="ph">{{ p.type==='hardware' ? '◎' : p.type==='service' ? '⚙' : '▤' }}</span>
        </div>
        <div class="body">
          <h4 :title="p.name">{{ p.name }}</h4>
          <div class="desc" :title="p.subtitle">{{ p.subtitle }}</div>
          <div class="price">{{ fmt.money(p.price) }}<small v-if="p.original_price">¥{{ p.original_price }}</small></div>
          <div class="tags" style="margin-top:8px">
            <span class="tag">{{ typeName(p.type) }}</span>
            <span class="tag success" v-if="p.status==='on'">已上架</span>
            <span class="tag warning" v-else>已下架</span>
            <span class="tag info" v-if="p.is_official">首页推荐</span>
          </div>
          <div class="foot">
            <button class="btn sm" @click="move(p,-1)">上移</button>
            <button class="btn sm" @click="move(p,1)">下移</button>
            <button class="btn sm" :class="p.is_official ? '' : 'primary'" @click="toggleRecommend(p)">
              {{ p.is_official ? '取消推荐' : '设为推荐' }}
            </button>
            <button class="btn sm" @click="toggleShelf(p)">{{ p.status === 'on' ? '下架' : '上架' }}</button>
          </div>
        </div>
      </div>
      <div class="empty" v-if="!list.length">还没有上架的产品，请先到「产品管理」创建并上架</div>

    </div>
  </div>
  `,
  setup() {
    const list = ref([]);
    const fmt = U.fmt;
    const icon = (n) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">${U.icons[n]}</svg>`;

    async function load() {
      const res = await U.api.get('/api/products?pageSize=100&status=on');
      list.value = (res.list || []).sort((a, b) => b.sort - a.sort);
    }

    async function move(p, dir) {
      await U.api.post(`/api/products/${p.id}`, { sort: (p.sort || 0) + dir });
      load();
    }

    async function toggleRecommend(p) {
      await U.api.post(`/api/products/${p.id}`, { is_official: p.is_official ? 0 : 1 });
      load();
    }

    async function toggleShelf(p) {
      await U.api.post(`/api/products/${p.id}`, { status: p.status === 'on' ? 'off' : 'on' });
      load();
    }

    function typeName(t) { return PRODUCT_TYPES[t] || t; }
    onMounted(load);
    return { list, fmt, icon, move, toggleRecommend, toggleShelf, typeName };
  },
};
})();

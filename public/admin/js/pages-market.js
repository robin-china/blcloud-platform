(function () {
const { ref, reactive, computed, onMounted } = Vue;

/* 模板市场后台两页：
 *  - PageMarket       模板上下架（增删改、定价、状态、.blls 与缩略图上传）
 *  - PageMarketOptions 枚举字典（行业 / 纸型 / 尺寸预设，改完 /market/meta 立即生效）
 *
 * 前端约定：IIFE 包裹、模板不引用全局变量、弹层用 teleport 到 body
 * （卡片 hover transform 会把 position:fixed 的祖先劫持，2026-11-12 踩过）。
 */

const DEFAULT_INDUSTRIES = ['制造业', '物流仓储', '零售电商', '食品餐饮', '医疗器械', '固定资产', '化工', '服饰', '其他'];
const DEFAULT_PAPERS = ['间隙纸', '黑标纸', '连续纸'];

function emptyForm() {
  return {
    id: '', name: '', industry: '', paper_type: '', description: '', tags: '',
    width_mm: 50, height_mm: 30, dpi: 203, columns: 1, price: 0,
    author: '官方', thumbnail_url: '', status: 'on',
  };
}

function lockScroll(on) {
  try { document.body.style.overflow = on ? 'hidden' : ''; } catch { /* ignore */ }
}

window.PageMarket = {
  template: `
  <div>
    <div class="grid g4" style="margin-bottom:16px">
      <div class="stat"><div class="label">模板总数</div><div class="value">{{ fmt.int(stats.templates || 0) }}</div><div class="delta">含已下架</div></div>
      <div class="stat"><div class="label">当前上架</div><div class="value">{{ fmt.int(stats.online || 0) }}</div><div class="delta">客户端可见</div></div>
      <div class="stat"><div class="label">累计下载</div><div class="value">{{ fmt.int(stats.downloads || 0) }}</div><div class="delta">含已购重复下载</div></div>
      <div class="stat"><div class="label">兑换笔数</div><div class="value">{{ fmt.int(stats.purchases || 0) }}</div><div class="delta">消耗 {{ fmt.int(stats.pointsSpent || 0) }} 积分</div></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>模板上下架</h3>
        <div style="display:flex;gap:8px;align-items:center">
          <input class="input" style="width:210px" placeholder="搜名称 / 模板 ID" v-model="q" @keyup.enter="load" />
          <button class="btn sm" @click="load" :disabled="busy">搜索</button>
          <button class="btn sm" @click="load" :disabled="busy">刷新</button>
          <button class="btn sm primary" @click="openNew">+ 新增模板</button>
        </div>
      </div>
      <div class="card-body" style="padding:0">
        <div class="hint" style="padding:12px 16px 0;margin:0">
          .blls 模板文件存在<b>私有目录</b>，列表/详情接口不返回任何下载地址；只有用户兑换成功后才由后端签发
          5 分钟一次性短链。缩略图走公开上传目录，可直接给客户端懒加载。
        </div>
        <table class="table" style="margin-top:10px">
          <thead><tr>
            <th style="width:70px">缩略图</th><th>模板</th><th>行业 / 纸型</th><th>尺寸</th>
            <th style="width:90px">积分</th><th style="width:86px">状态</th>
            <th style="width:86px">下载</th><th style="width:100px">文件</th><th style="width:200px">操作</th>
          </tr></thead>
          <tbody>
            <tr v-for="it in items" :key="it.id">
              <td>
                <img v-if="it.thumbnailUrl" :src="thumb(it.thumbnailUrl)" style="width:48px;height:36px;object-fit:cover;border-radius:4px;background:#f1f3f6" />
                <div v-else style="width:48px;height:36px;border-radius:4px;background:#f1f3f6"></div>
              </td>
              <td>
                <b>{{ it.name }}</b>
                <span v-if="it.author" class="tag" style="margin-left:6px">{{ it.author }}</span>
                <div class="hint" style="margin:2px 0 0">{{ it.id }} · v{{ it.version }}</div>
                <div v-if="it.description" class="hint" style="margin:2px 0 0">{{ it.description }}</div>
              </td>
              <td>{{ it.industry || '-' }}<div class="hint" style="margin:2px 0 0">{{ it.paperType || '-' }} · {{ it.dpi }}dpi · {{ it.columns }}列</div></td>
              <td>{{ it.widthMm }}×{{ it.heightMm }}<div class="hint" style="margin:2px 0 0">mm</div></td>
              <td><b :style="it.price ? '' : 'color:var(--success)'">{{ it.price ? it.price : '免费' }}</b></td>
              <td><span class="tag" :class="it.status === 'on' ? 'success' : ''">{{ it.status === 'on' ? '上架' : '下架' }}</span></td>
              <td>{{ fmt.int(it.downloads) }}</td>
              <td>
                <span v-if="it.hasFile" class="tag success">已上传</span>
                <span v-else class="tag danger">缺文件</span>
                <div v-if="it.hasFile" class="hint" style="margin:2px 0 0">{{ bytes(it.fileSize) }}</div>
              </td>
              <td>
                <div class="table-actions">
                  <button class="btn sm" @click="openEdit(it)">编辑</button>
                  <button class="btn sm" @click="toggle(it)" :disabled="busy">{{ it.status === 'on' ? '下架' : '上架' }}</button>
                  <button class="btn sm danger" @click="remove(it)" :disabled="busy">删除</button>
                </div>
              </td>
            </tr>
            <tr v-if="!items.length"><td colspan="9" style="text-align:center;padding:28px" class="hint">还没有模板，点右上角「新增模板」开始</td></tr>
          </tbody>
        </table>
        <div class="hint" style="padding:10px 16px 14px">
          有用户兑换过的模板不能删除（会让人已购资产凭空消失），只能下架；下架后详情与兑换都会拒绝，已购用户仍可重新下载。
        </div>
      </div>
    </div>

    <teleport to="body">
      <div class="mask" v-if="showEdit" @click.self="closeEdit">
        <div class="modal" style="width:720px;max-width:94vw;max-height:88vh;overflow:auto">
          <div class="card-head"><h3>{{ editing ? '编辑模板' : '新增模板' }}</h3>
            <button class="btn sm" @click="closeEdit">关闭</button></div>
          <div class="card-body">
            <div class="grid g2" style="gap:12px">
              <label class="field"><span>模板名 *</span><input class="input" v-model="form.name" placeholder="如：仓储货架标签 50×30" /></label>
              <label class="field"><span>上架者 / 作者</span><input class="input" v-model="form.author" placeholder="官方（UGC 预留）" /></label>
              <label class="field"><span>行业</span>
                <select class="input" v-model="form.industry">
                  <option value="">未分类</option>
                  <option v-for="o in opts.industries" :key="o" :value="o">{{ o }}</option>
                </select>
              </label>
              <label class="field"><span>纸类型</span>
                <select class="input" v-model="form.paper_type">
                  <option value="">未指定</option>
                  <option v-for="o in opts.paperTypes" :key="o" :value="o">{{ o }}</option>
                </select>
              </label>
              <label class="field"><span>宽 mm</span><input class="input" type="number" min="1" v-model.number="form.width_mm" /></label>
              <label class="field"><span>高 mm</span><input class="input" type="number" min="1" v-model.number="form.height_mm" /></label>
              <label class="field"><span>打印分辨率</span>
                <select class="input" v-model.number="form.dpi"><option :value="203">203 dpi</option><option :value="300">300 dpi</option></select>
              </label>
              <label class="field"><span>一纸列数</span><input class="input" type="number" min="1" v-model.number="form.columns" /></label>
              <label class="field"><span>所需积分（0 = 免费）</span><input class="input" type="number" min="0" v-model.number="form.price" /></label>
              <label class="field"><span>状态</span>
                <select class="input" v-model="form.status"><option value="on">上架</option><option value="off">下架</option></select>
              </label>
            </div>

            <div class="hint" style="margin:12px 0 6px">尺寸预设（点击填入宽高）</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn sm" v-for="p in opts.sizePresets" :key="p.label" @click="usePreset(p)">{{ p.label }}</button>
              <span v-if="!opts.sizePresets.length" class="hint">尚未配置，去「模板字典」页添加</span>
            </div>

            <label class="field" style="margin-top:12px"><span>一句话描述</span><input class="input" v-model="form.description" placeholder="用于列表展示与关键词检索" /></label>
            <label class="field" style="margin-top:10px"><span>标签（逗号分隔，增强检索）</span><input class="input" v-model="form.tags" placeholder="条码, 物流, 示例" /></label>

            <div class="grid g2" style="gap:12px;margin-top:12px">
              <label class="field"><span>缩略图（jpg/png/webp，≤300px 最佳）</span>
                <input class="input" type="file" accept="image/*" @change="onThumb" />
                <span class="hint">也可直接填 URL：<input class="input" v-model="form.thumbnail_url" placeholder="/platform/uploads/xxx.png" style="margin-top:6px" /></span>
              </label>
              <label class="field"><span>模板文件 .blls（加密二进制，后台只存不解析）</span>
                <input class="input" type="file" accept=".blls" @change="onBlls" />
                <span class="hint">{{ bllsName || '未选择新文件；不选则保留原文件' }}</span>
              </label>
            </div>
            <div v-if="editing && currentFile" class="hint" style="margin-top:8px">
              当前文件 sha256：{{ currentFile }} · {{ bytes(currentSize) }}
            </div>

            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
              <button class="btn" @click="closeEdit">取消</button>
              <button class="btn primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button>
            </div>
          </div>
        </div>
      </div>
    </teleport>
  </div>`,
  setup() {
    const fmt = U.fmt;
    const items = ref([]);
    const stats = ref({});
    const opts = ref({ industries: [], paperTypes: [], sizePresets: [] });
    const q = ref('');
    const busy = ref(false);
    const showEdit = ref(false);
    const editing = ref(false);
    const form = reactive(emptyForm());
    const bllsFile = ref(null);
    const thumbFile = ref(null);
    const bllsName = ref('');
    const currentFile = ref('');
    const currentSize = ref(0);

    function bytes(n) {
      const v = Number(n) || 0;
      if (v < 1024) return v + ' B';
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
      return (v / 1024 / 1024).toFixed(1) + ' MB';
    }

    function thumb(url) {
      const s = String(url || '');
      const base = U.basePath || '';
      // /api/upload 在子路径部署下返回的 URL 已经带 /platform 前缀，别再拼一次
      if (!s.startsWith('/') || (base && s.startsWith(base + '/'))) return s;
      return base + s;
    }

    async function load() {
      busy.value = true;
      try {
        const r = await U.api.get('/api/market/templates?q=' + encodeURIComponent(q.value || ''));
        items.value = r.items || [];
        stats.value = r.stats || {};
      } catch (e) { U.toast(U.failMsg(e, '加载模板失败'), 'error'); }
      finally { busy.value = false; }
    }

    async function loadOptions() {
      try { opts.value = await U.api.get('/api/market/options'); } catch { /* 字典加载失败不阻塞列表 */ }
    }

    function openNew() {
      Object.assign(form, emptyForm());
      editing.value = false;
      bllsFile.value = null; thumbFile.value = null; bllsName.value = '';
      currentFile.value = ''; currentSize.value = 0;
      showEdit.value = true; lockScroll(true);
    }

    function openEdit(it) {
      Object.assign(form, {
        id: it.id, name: it.name, industry: it.industry, paper_type: it.paperType,
        description: it.description, tags: (it.tags || []).join(', '),
        width_mm: it.widthMm, height_mm: it.heightMm, dpi: it.dpi, columns: it.columns,
        price: it.price, author: it.author, thumbnail_url: it.thumbnailUrl, status: it.status,
      });
      editing.value = true;
      bllsFile.value = null; thumbFile.value = null; bllsName.value = '';
      currentFile.value = it.fileSha256 || '';
      currentSize.value = it.fileSize || 0;
      showEdit.value = true; lockScroll(true);
    }

    function closeEdit() { showEdit.value = false; lockScroll(false); }
    function onBlls(e) { bllsFile.value = (e.target.files || [])[0] || null; bllsName.value = bllsFile.value ? bllsFile.value.name : ''; }
    function onThumb(e) { thumbFile.value = (e.target.files || [])[0] || null; }
    function usePreset(p) { form.width_mm = p.widthMm; form.height_mm = p.heightMm; }

    async function uploadTo(url, file) {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(U.basePath + url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + U.api.getToken('admin') },
        body: fd,
      });
      let data = {};
      try { data = await res.json(); } catch { /* ignore */ }
      if (!res.ok) throw new Error(data.error || '上传失败');
      return data;
    }

    async function save() {
      if (!String(form.name || '').trim()) { U.toast('模板名不能为空', 'error'); return; }
      busy.value = true;
      try {
        let thumbUrl = form.thumbnail_url;
        if (thumbFile.value) {
          const r = await uploadTo('/api/upload', thumbFile.value);
          thumbUrl = r.url;
        }
        const payload = {
          name: form.name, industry: form.industry, paper_type: form.paper_type,
          description: form.description, tags: form.tags,
          width_mm: form.width_mm, height_mm: form.height_mm, dpi: form.dpi, columns: form.columns,
          price: form.price, author: form.author, thumbnail_url: thumbUrl, status: form.status,
        };
        let id = form.id;
        if (editing.value) await U.api.patch('/api/market/templates/' + id, payload);
        else {
          const r = await U.api.post('/api/market/templates', payload);
          id = r.item.id;
        }
        if (bllsFile.value) await uploadTo('/api/market/templates/' + id + '/file', bllsFile.value);
        U.toast('模板已保存', 'success');
        closeEdit();
        await load();
      } catch (e) { U.toast(U.failMsg(e, '保存失败'), 'error'); }
      finally { busy.value = false; }
    }

    async function toggle(it) {
      busy.value = true;
      try {
        await U.api.patch('/api/market/templates/' + it.id, { status: it.status === 'on' ? 'off' : 'on' });
        U.toast(it.status === 'on' ? '已下架' : '已上架', 'success');
        await load();
      } catch (e) { U.toast(U.failMsg(e, '操作失败'), 'error'); }
      finally { busy.value = false; }
    }

    async function remove(it) {
      if (!(await U.confirm('确定删除「' + it.name + '」？私有 .blls 文件会一并删除，且不可恢复。'))) return;
      busy.value = true;
      try {
        await U.api.del('/api/market/templates/' + it.id);
        U.toast('已删除', 'success');
        await load();
      } catch (e) { U.toast(U.failMsg(e, '删除失败'), 'error'); }
      finally { busy.value = false; }
    }

    onMounted(() => { load(); loadOptions(); });
    return {
      fmt, items, stats, opts, q, busy, showEdit, editing, form,
      bllsName, currentFile, currentSize, thumb, bytes,
      load, openNew, openEdit, closeEdit, onBlls, onThumb, usePreset, save, toggle, remove,
    };
  },
};

/* ---------------------------------------------------------------- 字典 */

window.PageMarketOptions = {
  template: `
  <div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>枚举字典</h3>
        <div style="display:flex;gap:8px">
          <button class="btn sm" @click="resetDefaults" :disabled="busy">恢复默认值</button>
          <button class="btn sm" @click="load" :disabled="busy">重新加载</button>
          <button class="btn sm primary" :disabled="busy || !dirty" @click="save">{{ dirty ? '保存字典' : '未修改' }}</button>
        </div>
      </div>
      <div class="card-body">
        <div class="hint" style="margin-top:0">
          客户端的行业 / 纸型 / 尺寸预设全部来自 <b>GET /api/open/v1/market/meta</b>，不写死在安装包里。
          这里保存后<b>立即生效</b>，不需要发客户端版本。顺序即客户端展示顺序。
        </div>
      </div>
    </div>

    <div class="grid g2" style="gap:16px;margin-bottom:16px">
      <div class="card">
        <div class="card-head"><h3>行业 industry</h3><span class="tag">{{ industries.length }} 项</span></div>
        <div class="card-body">
          <div style="display:flex;gap:8px;margin-bottom:10px">
            <input class="input" v-model="newIndustry" placeholder="新行业名称" @keyup.enter="addIndustry" />
            <button class="btn sm primary" @click="addIndustry">添加</button>
          </div>
          <div v-for="(v,i) in industries" :key="'i'+i" class="dict-row">
            <span class="dict-idx">{{ i+1 }}</span>
            <input class="input" v-model="industries[i]" @input="markDirty" />
            <button class="btn sm" @click="move(industries,i,-1)" :disabled="i===0">↑</button>
            <button class="btn sm" @click="move(industries,i,1)" :disabled="i===industries.length-1">↓</button>
            <button class="btn sm danger" @click="del(industries,i)">删</button>
          </div>
          <div v-if="!industries.length" class="hint">列表为空时 meta 会回退到内置 9 个默认行业</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>纸类型 paperType</h3><span class="tag">{{ papers.length }} 项</span></div>
        <div class="card-body">
          <div style="display:flex;gap:8px;margin-bottom:10px">
            <input class="input" v-model="newPaper" placeholder="新纸型名称" @keyup.enter="addPaper" />
            <button class="btn sm primary" @click="addPaper">添加</button>
          </div>
          <div v-for="(v,i) in papers" :key="'p'+i" class="dict-row">
            <span class="dict-idx">{{ i+1 }}</span>
            <input class="input" v-model="papers[i]" @input="markDirty" />
            <button class="btn sm" @click="move(papers,i,-1)" :disabled="i===0">↑</button>
            <button class="btn sm" @click="move(papers,i,1)" :disabled="i===papers.length-1">↓</button>
            <button class="btn sm danger" @click="del(papers,i)">删</button>
          </div>
          <div v-if="!papers.length" class="hint">列表为空时 meta 会回退到内置 3 种默认纸型</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>尺寸预设 sizePresets</h3><span class="tag">仅填表辅助，客户端按宽高精确筛选</span></div>
      <div class="card-body" style="padding:0">
        <div class="hint" style="padding:12px 16px 0;margin:0">
          尺寸<b>不是枚举</b>：客户端传 widthMm / heightMm 精确值筛选。这里只下发常用尺寸给客户端做快捷按钮。
        </div>
        <table class="table" style="margin-top:10px">
          <thead><tr><th style="width:70px">#</th><th>显示名</th><th style="width:160px">宽 mm</th><th style="width:160px">高 mm</th><th style="width:160px">操作</th></tr></thead>
          <tbody>
            <tr v-for="(p,i) in presets" :key="'s'+i">
              <td class="hint">{{ i+1 }}</td>
              <td><input class="input" v-model="p.label" @input="markDirty" /></td>
              <td><input class="input" type="number" min="1" v-model.number="p.widthMm" @input="markDirty" /></td>
              <td><input class="input" type="number" min="1" v-model.number="p.heightMm" @input="markDirty" /></td>
              <td><div class="table-actions">
                <button class="btn sm" @click="move(presets,i,-1)" :disabled="i===0">上移</button>
                <button class="btn sm danger" @click="del(presets,i)">删除</button>
              </div></td>
            </tr>
            <tr v-if="!presets.length"><td colspan="5" class="hint" style="text-align:center;padding:20px">暂无预设</td></tr>
          </tbody>
        </table>
        <div style="padding:12px 16px 16px;display:flex;gap:8px;align-items:center">
          <input class="input" style="width:180px" v-model="np.label" placeholder="如 70×50mm" />
          <input class="input" style="width:110px" type="number" min="1" v-model.number="np.widthMm" placeholder="宽" />
          <input class="input" style="width:110px" type="number" min="1" v-model.number="np.heightMm" placeholder="高" />
          <button class="btn sm" @click="addPreset">添加预设</button>
        </div>
      </div>
    </div>
  </div>`,
  setup() {
    const industries = ref([]);
    const papers = ref([]);
    const presets = ref([]);
    const newIndustry = ref('');
    const newPaper = ref('');
    const np = reactive({ label: '', widthMm: 50, heightMm: 30 });
    const busy = ref(false);
    const dirty = ref(false);

    function markDirty() { dirty.value = true; }

    async function load() {
      busy.value = true;
      try {
        const r = await U.api.get('/api/market/options');
        industries.value = r.industries || [];
        papers.value = r.paperTypes || [];
        presets.value = (r.sizePresets || []).map((p) => ({ label: p.label, widthMm: p.widthMm, heightMm: p.heightMm }));
        dirty.value = false;
      } catch (e) { U.toast(U.failMsg(e, '加载字典失败'), 'error'); }
      finally { busy.value = false; }
    }

    function del(arr, i) { arr.splice(i, 1); markDirty(); }
    function move(arr, i, d) {
      const j = i + d;
      if (j < 0 || j >= arr.length) return;
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      markDirty();
    }
    function addIndustry() {
      const v = String(newIndustry.value || '').trim();
      if (!v) return;
      if (!industries.value.includes(v)) industries.value.push(v);
      newIndustry.value = ''; markDirty();
    }
    function addPaper() {
      const v = String(newPaper.value || '').trim();
      if (!v) return;
      if (!papers.value.includes(v)) papers.value.push(v);
      newPaper.value = ''; markDirty();
    }
    function addPreset() {
      const label = String(np.label || '').trim();
      if (!label || !(Number(np.widthMm) > 0) || !(Number(np.heightMm) > 0)) { U.toast('请填显示名与有效宽高', 'error'); return; }
      presets.value.push({ label, widthMm: Number(np.widthMm), heightMm: Number(np.heightMm) });
      np.label = ''; markDirty();
    }
    function resetDefaults() {
      industries.value = [...DEFAULT_INDUSTRIES];
      papers.value = [...DEFAULT_PAPERS];
      presets.value = [
        { label: '50×30mm', widthMm: 50, heightMm: 30 },
        { label: '40×30mm', widthMm: 40, heightMm: 30 },
        { label: '60×40mm', widthMm: 60, heightMm: 40 },
        { label: '100×100mm', widthMm: 100, heightMm: 100 },
      ];
      markDirty();
      U.toast('已填入默认值，记得点「保存字典」', 'info');
    }

    async function save() {
      busy.value = true;
      try {
        const r = await U.api.post('/api/market/options', {
          industries: industries.value, paperTypes: papers.value, sizePresets: presets.value,
        });
        U.toast(`字典已保存：${r.industries} 行业 / ${r.paperTypes} 纸型 / ${r.sizePresets} 预设`, 'success');
        await load();
      } catch (e) { U.toast(U.failMsg(e, '保存失败'), 'error'); }
      finally { busy.value = false; }
    }

    onMounted(load);
    return {
      industries, papers, presets, newIndustry, newPaper, np, busy, dirty,
      markDirty, load, del, move, addIndustry, addPaper, addPreset, resetDefaults, save,
    };
  },
};
})();

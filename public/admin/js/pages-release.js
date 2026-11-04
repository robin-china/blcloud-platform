(function () {
const { ref, reactive, computed, onMounted } = Vue;

window.PageRelease = {
  template: `
  <div>
    <div class="grid g4" style="margin-bottom:16px">
      <div class="stat"><div class="label">已发布版本</div><div class="value">{{ rows.length }}</div>
        <div class="delta">{{ products.length ? products.join(' · ') : '还没有发布记录' }}</div></div>
      <div class="stat"><div class="label">最新版本</div><div class="value">{{ latestVersion || '-' }}</div>
        <div class="delta">{{ latestVersion ? '客户端最低可升到此版本' : '先上传一个全量包' }}</div></div>
      <div class="stat"><div class="label">更新包占用</div><div class="value">{{ bytes(totalSize) }}</div>
        <div class="delta">{{ cfg.updates_dir }}</div></div>
      <div class="stat"><div class="label">清单地址</div>
        <div class="value" style="font-size:13px;word-break:break-all">{{ checkUrl }}</div>
        <div class="delta">客户端每次启动轮询，不鉴权</div></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>发布新版本</h3>
        <span class="tag">全量包必填，增量包可选</span></div>
      <div class="card-body">
        <div class="grid g4">
          <div class="field"><label>产品</label><input v-model.trim="form.product" placeholder="LabelGo" /></div>
          <div class="field"><label>版本号</label><input v-model.trim="form.version" placeholder="1.0.21" /></div>
          <div class="field"><label>渠道</label><input v-model.trim="form.channel" placeholder="stable" /></div>
          <div class="field"><label>平台 / 架构</label>
            <div style="display:flex;gap:8px">
              <input v-model.trim="form.platform" placeholder="win32" />
              <input v-model.trim="form.arch" placeholder="x64" />
            </div>
          </div>
        </div>
        <div class="grid g4" style="margin-top:10px">
          <div class="field"><label>最低可用版本（低于此版本强制升级）</label>
            <input v-model.trim="form.min_version" placeholder="1.0.0，留空不强制" /></div>
          <div class="field"><label>灰度比例 %</label>
            <input type="number" min="0" max="100" v-model.number="form.rollout" />
            <div class="hint" style="margin:4px 0 0">100 = 全量；10 = 先给约 10% 机器；0 = 暂停下发</div></div>
          <div class="field"><label>开关</label>
            <div style="display:flex;flex-direction:column;gap:8px;padding-top:4px">
              <label class="switch"><input type="checkbox" v-model="form.mandatory" />
                <span class="track"></span><span>强制升级（弹阻断窗）</span></label>
              <label class="switch"><input type="checkbox" v-model="form.enabled" />
                <span class="track"></span><span>启用（关闭后客户端看不到）</span></label>
            </div>
          </div>
          <div class="field"><label>全量包</label>
            <input type="file" @change="pickFull" />
            <div class="hint" style="margin:4px 0 0">{{ fullFile ? fullFile.name + '（' + bytes(fullFile.size) + '）' : 'zip，≤ ' + (cfg.max_upload_mb || 64) + 'MB' }}</div>
          </div>
        </div>
        <div class="grid g4" style="margin-top:10px">
          <div class="field"><label>增量包（可选）</label>
            <input type="file" @change="pickDelta" />
            <div class="hint" style="margin:4px 0 0">{{ deltaFile ? deltaFile.name + '（' + bytes(deltaFile.size) + '）' : '.pkg，只对来源版本生效' }}</div></div>
          <div class="field"><label>增量来源版本</label>
            <input v-model.trim="form.from" placeholder="1.0.20" :disabled="!deltaFile" /></div>
          <div class="field" style="grid-column:span 2"><label>更新说明</label>
            <textarea v-model="form.changelog" rows="2" placeholder="- 修复共享打印机被误判离线&#10;- 新增 600dpi 支持"></textarea></div>
        </div>
        <div style="display:flex;gap:12px;align-items:center;margin-top:14px;flex-wrap:wrap">
          <button class="btn primary" :disabled="busy || !form.product || !form.version" @click="publish">
            {{ busy ? '处理中…' : '上传并发布' }}</button>
          <span class="hint" style="margin:0">包会落到 {{ cfg.updates_dir }}/版本号/，同时重建 latest.json。</span>
        </div>
        <div class="hint" style="margin-top:10px">
          超过 50MB 的包请用命令行：<code>node tools/publish-release.js --file 包路径 --version 版本号</code>，
          或直接 scp 到目录后点「重建清单」。
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>版本列表</h3>
        <div style="display:flex;gap:8px">
          <button class="btn sm" @click="rebuild">重建 latest.json</button>
          <button class="btn sm" @click="load">刷新</button>
        </div></div>
      <div class="card-body" style="padding:0">
        <table class="table">
          <thead><tr>
            <th>版本</th><th>产品 / 渠道</th><th>平台</th><th>全量包</th><th>增量</th>
            <th>策略</th><th>状态</th><th>发布时间</th><th style="width:210px">操作</th>
          </tr></thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id">
              <td><b>{{ r.version }}</b></td>
              <td>{{ r.product }}<div class="hint" style="margin:0">{{ r.channel }}</div></td>
              <td>{{ r.platform }} / {{ r.arch }}</td>
              <td>{{ bytes(r.full_size) }}
                <div class="hint" style="margin:0" :title="r.full_sha256">{{ short(r.full_sha256) }}</div>
                <div v-if="!r.full_exists" class="hint" style="margin:0;color:var(--danger)">文件缺失</div></td>
              <td>{{ (r.delta || []).length ? (r.delta || []).length + ' 条' : '-' }}
                <div v-for="d in (r.delta || [])" :key="d.from" class="hint" style="margin:0">
                  from {{ d.from }}<span v-if="!d.exists" style="color:var(--danger)">（缺失）</span></div></td>
              <td>
                <span v-if="r.mandatory" class="tag danger">强制</span>
                <span v-else class="tag">可选</span>
                <div class="hint" style="margin:2px 0 0">灰度 {{ r.rollout }}%</div>
                <div v-if="r.min_version" class="hint" style="margin:0">最低 {{ r.min_version }}</div>
              </td>
              <td>
                <button class="btn sm" :class="r.enabled ? '' : 'danger'" @click="toggle(r)">
                  {{ r.enabled ? '已启用' : '已停用' }}</button>
              </td>
              <td>{{ when(r.published_at) }}</td>
              <td>
                <div class="table-actions">
                  <button class="btn sm" @click="copy(r.full_url_public)">复制链接</button>
                  <button class="btn sm" @click="verify(r)">校验</button>
                  <button class="btn sm danger" @click="remove(r)">删除</button>
                </div>
              </td>
            </tr>
            <tr v-if="!rows.length"><td colspan="9"><div class="empty">还没有发布过版本</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>客户端会看到什么</h3>
        <span class="tag">按版本号 + 机器码模拟一次检查</span></div>
      <div class="card-body">
        <div class="grid g4">
          <div class="field"><label>当前版本</label><input v-model.trim="probe.version" placeholder="1.0.20" /></div>
          <div class="field"><label>机器码（灰度分桶用）</label><input v-model.trim="probe.machine" placeholder="BLBT-XXXX-XXXX" /></div>
          <div class="field"><label>产品</label><input v-model.trim="probe.product" /></div>
          <div class="field" style="display:flex;align-items:flex-end">
            <button class="btn" :disabled="probing" @click="runProbe">{{ probing ? '查询中…' : '查询' }}</button>
          </div>
        </div>
        <pre v-if="probeOut" style="margin-top:12px;background:var(--bg-2);border:1px solid var(--border);border-radius:10px;padding:12px;font-size:12px;line-height:1.6;overflow:auto;max-height:320px">{{ probeOut }}</pre>
        <div v-else class="hint" style="margin-top:10px">填版本号点查询，可验证「灰度是否命中」「强制升级是否生效」。</div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>对外地址</h3>
        <span class="tag">latest.json 里的绝对地址用它拼</span></div>
      <div class="card-body">
        <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="flex:1;min-width:320px;margin:0">
            <label>站点根地址（含子路径）</label>
            <input v-model.trim="cfg.site_url" :placeholder="cfg.detected_base" />
          </div>
          <button class="btn" @click="saveSite">保存并重建</button>
        </div>
        <div class="hint" style="margin-top:10px">
          留空则按当前访问地址自动拼（<code>{{ cfg.detected_base }}</code>）。换了域名或部署路径后，
          改这里 + 点保存，清单里的下载地址会一次性刷新。
        </div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const cfg = reactive({ updates_dir: '', site_url: '', detected_base: '', max_upload_mb: 64, default_product: 'LabelGo' });
    const rows = ref([]);
    const products = ref([]);
    const totalSize = ref(0);
    const busy = ref(false);
    const probing = ref(false);
    const probeOut = ref('');
    const fullFile = ref(null);
    const deltaFile = ref(null);

    const form = reactive({
      product: 'LabelGo', version: '', channel: 'stable', platform: 'win32', arch: 'x64',
      min_version: '', rollout: 100, mandatory: false, enabled: true, changelog: '', from: '',
    });
    const probe = reactive({ product: 'LabelGo', version: '1.0.20', machine: '' });

    const checkUrl = computed(() => {
      const base = (cfg.detected_base || '').replace(/\/+$/, '');
      return base + '/api/open/v1/app/version?product=' + encodeURIComponent(form.product || 'LabelGo')
        + '&version=<当前版本>&platform=win32&arch=x64&channel=stable';
    });

    const latestVersion = computed(() => {
      const list = rows.value.filter((r) => r.enabled);
      const cmp = (a, b) => {
        const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
        const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
          const x = pa[i] || 0;
          const y = pb[i] || 0;
          if (x !== y) return x > y ? 1 : -1;
        }
        return 0;
      };
      let top = '';
      for (const r of list) if (!top || cmp(r.version, top) > 0) top = r.version;
      return top;
    });

    function bytes(n) {
      const v = Number(n || 0);
      if (v < 1024) return v + ' B';
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
      if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(2) + ' MB';
      return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }
    function when(s) {
      if (!s) return '-';
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return s;
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    function short(h) {
      const s = String(h || '');
      return s ? s.slice(0, 12) + '…' : '-';
    }

    async function load() {
      try {
        const [c, r] = await Promise.all([
          U.api.get('/api/releases/config'),
          U.api.get('/api/releases'),
        ]);
        Object.assign(cfg, c);
        rows.value = r.list || [];
        products.value = r.products || [];
        totalSize.value = r.total_size || 0;
      } catch (e) { U.toast(U.failMsg(e, '加载失败'), 'error'); }
    }

    function pickFull(ev) {
      fullFile.value = (ev.target.files || [])[0] || null;
      const f = fullFile.value;
      // 版本号留空时从文件名 LabelGo-1.0.21-full.zip 里猜一个，少手打一次少一次错
      if (f && !form.version) {
        const m = /(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)/.exec(f.name);
        if (m) form.version = m[1];
      }
    }
    function pickDelta(ev) {
      deltaFile.value = (ev.target.files || [])[0] || null;
      if (deltaFile.value && !form.from) {
        const m = /from-(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)/.exec(deltaFile.value.name);
        if (m) form.from = m[1];
      }
    }

    async function publish() {
      if (!form.version) { U.toast('请填写版本号', 'error'); return; }
      busy.value = true;
      try {
        const fd = new FormData();
        for (const k of ['product', 'version', 'channel', 'platform', 'arch', 'min_version', 'changelog']) {
          fd.append(k, form[k] == null ? '' : String(form[k]));
        }
        fd.append('rollout', String(form.rollout));
        fd.append('mandatory', form.mandatory ? '1' : '0');
        fd.append('enabled', form.enabled ? '1' : '0');
        if (deltaFile.value) {
          fd.append('delta', deltaFile.value);
          fd.append('from', form.from || '');
        }
        if (fullFile.value) fd.append('file', fullFile.value);
        const res = await fetch(U.basePath + '/api/releases/publish', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + U.api.getToken('admin') },
          body: fd,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ('发布失败 ' + res.status));
        U.toast('已发布 ' + data.release.product + ' ' + data.release.version, 'success');
        form.version = '';
        form.changelog = '';
        form.from = '';
        fullFile.value = null;
        deltaFile.value = null;
        await load();
      } catch (e) {
        U.toast(U.failMsg(e, '发布失败'), 'error');
      } finally { busy.value = false; }
    }

    async function toggle(r) {
      try {
        await U.api.patch('/api/releases/' + r.id, { enabled: !r.enabled });
        U.toast(r.enabled ? '已停用' : '已启用', 'success');
        await load();
      } catch (e) { U.toast(U.failMsg(e, '操作失败'), 'error'); }
    }

    async function verify(r) {
      try {
        const v = await U.api.post('/api/releases/' + r.id + '/verify');
        U.toast(v.ok ? '校验通过：文件与清单一致' : '校验不通过：文件被改动或缺失', v.ok ? 'success' : 'error');
      } catch (e) { U.toast(U.failMsg(e, '校验失败'), 'error'); }
    }

    async function remove(r) {
      if (!(await U.confirm('删除 ' + r.product + ' ' + r.version + ' 的发布记录？\n'
        + '安装包文件会一起删除，已升级的客户端不受影响，但没升级的将拿不到这个版本。', { title: '删除版本' }))) return;
      try {
        await U.api.del('/api/releases/' + r.id + '?files=1');
        U.toast('已删除', 'success');
        await load();
      } catch (e) { U.toast(U.failMsg(e, '删除失败'), 'error'); }
    }

    async function rebuild() {
      try {
        const r = await U.api.post('/api/releases/latest.json');
        U.toast('latest.json 已重建：' + (r.latest.latest || '无版本'), 'success');
      } catch (e) { U.toast(U.failMsg(e, '重建失败'), 'error'); }
    }

    async function saveSite() {
      try {
        await U.api.post('/api/releases/config', { site_url: cfg.site_url || '' });
        U.toast('已保存并重建清单', 'success');
        await load();
      } catch (e) { U.toast(U.failMsg(e, '保存失败'), 'error'); }
    }

    async function runProbe() {
      probing.value = true;
      probeOut.value = '';
      try {
        const q = new URLSearchParams({
          product: probe.product || 'LabelGo',
          version: probe.version || '',
          machine: probe.machine || '',
        });
        const r = await U.api.get('/api/releases/preview?' + q.toString());
        probeOut.value = JSON.stringify(r, null, 2);
      } catch (e) {
        probeOut.value = String(e.message || e);
      } finally { probing.value = false; }
    }

    function copy(text) {
      const s = String(text || '');
      if (!s) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(s).then(
          () => U.toast('已复制下载地址', 'success'),
          () => U.toast(s, 'info')
        );
      } else {
        U.toast(s, 'info');
      }
    }

    onMounted(async () => {
      await load();
      if (!probe.product) probe.product = cfg.default_product || 'LabelGo';
    });

    return {
      cfg, rows, products, totalSize, busy, form, probe, probeOut, probing,
      fullFile, deltaFile, checkUrl, latestVersion,
      bytes, when, short, load, pickFull, pickDelta, publish, toggle, verify, remove,
      rebuild, saveSite, runProbe, copy,
    };
  },
};
})();

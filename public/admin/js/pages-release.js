(function () {
const { ref, reactive, computed, onMounted, watch } = Vue;

/* 客户端更新（按产品分组）
 *
 * 之前这一页把所有产品混在一张表里：版本列表混排、升级记录默认全产品、
 * 统计卡算的是全站数字，切产品只能靠一排 chips —— 产品一多就分不清
 * 「我正在看哪个软件」。现在改成「左边选产品、右边全是这个产品的事」：
 * 概览、发布、版本列表、升级记录、模拟查询都跟着选中产品走，
 * 只有「对外地址」是站点级配置，留在最下面。
 */
window.PageRelease = {
  template: `
  <div>
    <div class="rel-wrap">
      <aside class="rel-rail">
        <div class="rel-rail-head">
          <span>软件产品</span>
          <button class="btn sm" @click="adding = !adding" :title="adding ? '收起' : '添加产品线'">{{ adding ? '×' : '+' }}</button>
        </div>
        <div v-if="adding" class="rel-add">
          <input class="input" v-model.trim="newProduct" placeholder="新产品名，如 LabelGo-Offline"
            @keyup.enter="addProduct" />
          <button class="btn sm primary" :disabled="busy || !newProduct" @click="addProduct">添加</button>
        </div>
        <button v-for="p in products" :key="p.product" class="rel-item" :class="active === p.product ? 'active' : ''"
          @click="selectProduct(p.product)">
          <div class="rel-item-top">
            <b>{{ p.product }}</b>
            <span v-if="!p.published" class="tag">未发布</span>
          </div>
          <div class="rel-item-sub">
            最新 {{ p.latest || '—' }} · {{ p.versions }} 个版本
          </div>
          <div class="rel-item-sub">{{ bytes(p.bytes) }}</div>
        </button>
        <div v-if="!products.length && !adding" class="rel-empty">
          还没有任何产品线。<br />点右上角「+」登记一个，或直接在右侧发布。
        </div>
        <div class="rel-rail-foot">
          <a href="javascript:;" @click="goRetention">数据留存设置 ›</a>
        </div>
      </aside>

      <div class="rel-main">
        <div class="card" style="margin-bottom:16px">
          <div class="card-body" style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">
            <div style="flex:1;min-width:260px">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <h2 style="margin:0;font-size:18px">{{ active || '未选择产品' }}</h2>
                <span class="tag" v-if="curMeta.latest">最新 {{ curMeta.latest }}</span>
                <span class="tag" v-else>还没有可用版本</span>
                <span class="tag" v-for="c in curMeta.channels" :key="c">{{ c }}</span>
              </div>
              <div class="hint" style="margin-top:8px">
                {{ curMeta.published ? ('共 ' + curMeta.versions + ' 个版本，占用 ' + bytes(curMeta.bytes) + '；平台 ' + (curMeta.platforms.join(' / ') || '-')) : '这个产品还没有发布过安装包，客户端查询会拿到 no_release' }}
              </div>
            </div>
            <div style="min-width:320px;flex:1">
              <div class="hint" style="margin:0 0 4px">客户端清单地址（不鉴权，每次启动轮询）</div>
              <div style="display:flex;gap:8px">
                <input class="input" readonly :value="checkUrl" style="font-size:12px" />
                <button class="btn sm" @click="copy(checkUrl)">复制</button>
              </div>
            </div>
          </div>
        </div>

        <div class="grid g4" style="margin-bottom:16px">
          <div class="stat"><div class="label">版本数</div><div class="value">{{ curMeta.versions || 0 }}</div>
            <div class="delta">{{ active || '-' }}</div></div>
          <div class="stat"><div class="label">最新版本</div><div class="value">{{ curMeta.latest || '-' }}</div>
            <div class="delta">{{ curMeta.latest ? '客户端最多升到这里' : '先发布一个全量包' }}</div></div>
          <div class="stat"><div class="label">更新包占用</div><div class="value">{{ bytes(curMeta.bytes) }}</div>
            <div class="delta">全站 {{ bytes(totalAllSize) }}</div></div>
          <div class="stat"><div class="label">升级记录</div><div class="value">{{ upSummary.check + upSummary.success + upSummary.fail + upSummary.rollback }}</div>
            <div class="delta">涉及机器 {{ upSummary.machines }} 台</div></div>
        </div>

        <div class="card" style="margin-bottom:16px">
          <div class="card-head"><h3>发布新版本</h3>
            <span class="tag">发布到：{{ active || '（先选产品）' }}</span></div>
          <div class="card-body">
            <div class="grid g4">
              <div class="field"><label>版本号</label><input v-model.trim="form.version" placeholder="V1.0.52" />
                <div class="hint" style="margin:4px 0 0">V1.0.0 起步，第三位递增</div></div>
              <div class="field"><label>渠道</label><input v-model.trim="form.channel" placeholder="stable" /></div>
              <div class="field"><label>平台 / 架构</label>
                <div style="display:flex;gap:8px">
                  <input v-model.trim="form.platform" placeholder="win32" />
                  <input v-model.trim="form.arch" placeholder="x64" />
                </div>
              </div>
              <div class="field"><label>全量包</label>
                <input type="file" @change="pickFull" />
                <div class="hint" style="margin:4px 0 0">{{ fullFile ? fullFile.name + '（' + bytes(fullFile.size) + '）' : 'zip，≤ ' + (cfg.max_upload_mb || 64) + 'MB' }}</div>
              </div>
            </div>
            <div class="grid g4" style="margin-top:10px">
              <div class="field"><label>最低可用版本（低于此版本强制升级）</label>
                <input v-model.trim="form.min_version" placeholder="V1.0.0，留空不强制" /></div>
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
              <div class="field"><label>增量包（可选）</label>
                <input type="file" @change="pickDelta" />
                <div class="hint" style="margin:4px 0 0">{{ deltaFile ? deltaFile.name + '（' + bytes(deltaFile.size) + '）' : '.pkg，只对来源版本生效' }}</div></div>
            </div>
            <div class="grid g4" style="margin-top:10px">
              <div class="field"><label>增量来源版本</label>
                <input v-model.trim="form.from" placeholder="V1.0.51" :disabled="!deltaFile" /></div>
              <div class="field" style="grid-column:span 3"><label>更新说明</label>
                <textarea v-model="form.changelog" rows="2" placeholder="- 修复共享打印机被误判离线&#10;- 新增 600dpi 支持"></textarea></div>
            </div>
            <div style="display:flex;gap:12px;align-items:center;margin-top:14px;flex-wrap:wrap">
              <button class="btn primary" :disabled="busy || !active || !form.version" @click="publish">
                {{ busy ? '处理中…' : '上传并发布到 ' + (active || '—') }}</button>
              <span class="hint" style="margin:0">包落到 {{ cfg.updates_dir }}/{{ active }}/版本号/，只重建该产品的 latest.json。</span>
            </div>
            <div class="hint" style="margin-top:10px">
              超过 50MB 的包请用命令行：<code>node tools/publish-release.js --file 包路径 --version 版本号 --product {{ active }}</code>，
              或直接 scp 到目录后点「重建兜底清单」。
            </div>
          </div>
        </div>

        <div class="card" style="margin-bottom:16px">
          <div class="card-head"><h3>版本列表 · {{ active || '全部' }}</h3>
            <div style="display:flex;gap:8px">
              <button class="btn sm" @click="rebuild">重建兜底清单</button>
              <button class="btn sm" @click="load">刷新</button>
            </div></div>
          <div class="card-body" style="padding:0">
            <table class="table">
              <thead><tr>
                <th>版本</th><th>渠道 / 平台</th><th>全量包</th><th>增量</th>
                <th>策略</th><th>状态</th><th>发布时间</th><th style="width:210px">操作</th>
              </tr></thead>
              <tbody>
                <tr v-for="r in rows" :key="r.id">
                  <td><b>{{ r.version }}</b></td>
                  <td>{{ r.channel }}<div class="hint" style="margin:0">{{ r.platform }} / {{ r.arch }}</div></td>
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
                <tr v-if="!rows.length"><td colspan="8"><div class="empty">
                  {{ active ? ('「' + active + '」还没有发布记录，先在下面发布一个全量包') : '先在左侧选择一个产品' }}
                </div></td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="card" style="margin-bottom:16px">
          <div class="card-head"><h3>升级记录 · {{ active || '全部' }}</h3>
            <div style="display:flex;gap:8px">
              <button class="btn sm" @click="loadUpdates">刷新</button>
              <button class="btn sm danger" @click="openPurge">清理记录</button>
            </div></div>
          <div class="card-body" style="padding:0">
            <div style="display:flex;gap:10px;padding:12px 16px 0;flex-wrap:wrap">
              <span class="tag">清单命中 {{ upSummary.check }}</span>
              <span class="tag" style="color:#0a7"><b>升级成功 {{ upSummary.success }}</b></span>
              <span class="tag danger" v-if="upSummary.fail">升级失败 {{ upSummary.fail }}</span>
              <span class="tag" v-else>升级失败 0</span>
              <span class="tag" style="color:#b45309" v-if="upSummary.rollback">回滚 {{ upSummary.rollback }}</span>
            </div>
            <div style="display:flex;gap:8px;padding:10px 16px 12px;flex-wrap:wrap">
              <button class="btn sm" :class="!upAction ? 'primary' : ''" @click="setUpAction('')">全部</button>
              <button class="btn sm" :class="upAction === 'success' ? 'primary' : ''" @click="setUpAction('success')">成功</button>
              <button class="btn sm" :class="upAction === 'fail' ? 'primary' : ''" @click="setUpAction('fail')">失败</button>
              <button class="btn sm" :class="upAction === 'rollback' ? 'primary' : ''" @click="setUpAction('rollback')">回滚</button>
              <button class="btn sm" :class="upAction === 'check' ? 'primary' : ''" @click="setUpAction('check')">清单命中</button>
            </div>
            <table class="table">
              <thead><tr>
                <th>时间</th><th>机器码</th><th>版本变化</th><th>状态</th><th>IP</th><th>备注</th>
              </tr></thead>
              <tbody>
                <tr v-for="u in updates" :key="u.id">
                  <td>{{ when(u.created_at) }}</td>
                  <td style="font-family:ui-monospace,monospace">{{ u.machine || '-' }}</td>
                  <td>{{ u.from_version || '?' }} → <b>{{ u.to_version || '?' }}</b></td>
                  <td>
                    <span v-if="u.action === 'success'" class="tag" style="color:#0a7">成功</span>
                    <span v-else-if="u.action === 'rollback'" class="tag" style="color:#b45309">回滚</span>
                    <span v-else-if="u.action === 'fail'" class="tag danger">失败</span>
                    <span v-else class="tag">命中</span>
                    <div class="hint" style="margin:0" v-if="u.action !== 'success' && u.action !== 'check' && (u.result_code || u.stage)">
                      code {{ u.result_code }}<template v-if="codeText(u.result_code)"> {{ codeText(u.result_code) }}</template><template v-if="u.stage"> · {{ u.stage }}</template>
                    </div>
                  </td>
                  <td class="hint" style="margin:0">{{ u.ip || '-' }}</td>
                  <td class="hint" style="margin:0">
                    {{ u.note || '-' }}
                    <div v-if="u.duration_ms" class="hint" style="margin:0">耗时 {{ Math.round(u.duration_ms / 1000) }}s</div>
                    <div v-if="u.os_info || u.elevated" class="hint" style="margin:0">
                      {{ u.os_info || '' }}{{ u.elevated ? ' · 已提权' : '' }}
                    </div>
                  </td>
                </tr>
                <tr v-if="!updates.length"><td colspan="6"><div class="empty">
                  还没有升级记录（客户端查到新版、或升级后回调上报时会出现）
                </div></td></tr>
              </tbody>
            </table>
            <div class="hint" style="padding:10px 16px">
              「命中」= 这台机器被告知有新版（同一机器 10 分钟内同一目标只记一条）；「成功/失败」需要客户端升级后回调
              <code>report_url</code> 才会出现。记录默认保留 180 天，可在「数据留存」里调整。
            </div>
          </div>
        </div>

        <div class="card" style="margin-bottom:16px">
          <div class="card-head"><h3>客户端会看到什么</h3>
            <span class="tag">按版本号 + 机器码模拟一次 {{ active || '' }} 的检查</span></div>
          <div class="card-body">
            <div class="grid g4">
              <div class="field"><label>当前版本</label><input v-model.trim="probe.version" placeholder="V1.0.51" /></div>
              <div class="field"><label>机器码（灰度分桶用）</label><input v-model.trim="probe.machine" placeholder="BLBT-XXXX-XXXX" /></div>
              <div class="field" style="display:flex;align-items:flex-end">
                <button class="btn" :disabled="probing || !active" @click="runProbe">{{ probing ? '查询中…' : '查询' }}</button>
              </div>
            </div>
            <pre v-if="probeOut" style="margin-top:12px;background:var(--bg-2);border:1px solid var(--border);border-radius:10px;padding:12px;font-size:12px;line-height:1.6;overflow:auto;max-height:320px">{{ probeOut }}</pre>
            <div v-else class="hint" style="margin-top:10px">填版本号点查询，可验证「灰度是否命中」「强制升级是否生效」。</div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>对外地址</h3>
        <span class="tag">全站共用，latest.json 里的绝对下载地址用它拼</span></div>
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
          改这里 + 点保存，所有产品的清单下载地址会一次性刷新。
        </div>
      </div>
    </div>

    <div class="card" v-if="purgeTarget" style="margin-top:16px;border-color:var(--danger)">
      <div class="card-head"><h3>清理「{{ purgeTarget }}」的升级记录</h3>
        <span class="tag danger">不可撤销</span></div>
      <div class="card-body">
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="margin:0;width:220px">
            <label>只删早于（天）</label>
            <input class="input" type="number" min="0" v-model.number="purgeDays" />
            <div class="hint" style="margin:2px 0 0">填 0 = 清空该产品全部记录</div>
          </div>
          <div class="field" style="margin:0;width:200px">
            <label>输入「清除」确认</label>
            <input class="input" v-model="purgeConfirm" placeholder="清除" />
          </div>
          <button class="btn danger" :disabled="busy || purgeConfirm !== '清除'" @click="doPurge">确认清理</button>
          <button class="btn" :disabled="busy" @click="purgeTarget = ''">取消</button>
        </div>
        <div class="hint" style="margin-top:10px">
          只删这张流水表里的行，不影响版本记录与已发布的包；日常滚动清理在「数据留存」页统一配置。
        </div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const cfg = reactive({ updates_dir: '', site_url: '', detected_base: '', max_upload_mb: 64, default_product: 'LabelGo' });
    const allRows = ref([]);
    const meta = ref([]);
    const totalAllSize = ref(0);
    const active = ref(localStorage.getItem('admin_release_product') || '');
    const adding = ref(false);
    const newProduct = ref('');
    const busy = ref(false);
    const updates = ref([]);
    const upAction = ref('');
    const upSummary = reactive({ check: 0, success: 0, fail: 0, rollback: 0, machines: 0 });
    const FAIL_CODES = {
      1: '下载/校验失败', 2: '解包失败', 3: '已提权仍不可写', 4: '旧进程结束不掉',
      5: '覆盖失败', 6: '新版本未起来', 7: 'UAC 被取消', 8: '启动三兜底全挂',
    };
    function codeText(c) { return FAIL_CODES[Number(c)] || ''; }
    const probing = ref(false);
    const probeOut = ref('');
    const fullFile = ref(null);
    const deltaFile = ref(null);
    const purgeTarget = ref('');
    const purgeDays = ref(90);
    const purgeConfirm = ref('');

    const form = reactive({
      version: '', channel: 'stable', platform: 'win32', arch: 'x64',
      min_version: '', rollout: 100, mandatory: false, enabled: true, changelog: '', from: '',
    });
    const probe = reactive({ version: 'V1.0.51', machine: '' });

    const products = computed(() => meta.value);
    const curMeta = computed(() => meta.value.find((p) => p.product === active.value)
      || { product: active.value, versions: 0, latest: '', channels: [], platforms: [], bytes: 0, published: false });
    const rows = computed(() => allRows.value.filter((r) => !active.value || r.product === active.value));

    const checkUrl = computed(() => {
      const base = (cfg.detected_base || '').replace(/\/+$/, '');
      return base + '/api/open/v1/app/version?product=' + encodeURIComponent(active.value || '')
        + '&version=<当前版本>&platform=win32&arch=x64&channel=stable';
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

    function selectProduct(name) {
      if (active.value === name) return;
      active.value = name;
      localStorage.setItem('admin_release_product', name);
      upAction.value = '';
      loadUpdates();
    }

    async function load() {
      try {
        const [c, r] = await Promise.all([
          U.api.get('/api/releases/config'),
          U.api.get('/api/releases'),
        ]);
        Object.assign(cfg, c);
        allRows.value = r.list || [];
        meta.value = r.product_meta || (r.products || []).map((p) => ({ product: p, versions: 0, latest: '', channels: [], platforms: [], bytes: 0, published: false }));
        totalAllSize.value = r.total_all_size != null ? r.total_all_size : (r.total_size || 0);
        // 选中产品失效（被删/首次进入）时退回第一个
        if (!active.value || !meta.value.some((p) => p.product === active.value)) {
          active.value = meta.value.length ? meta.value[0].product : '';
        }
        if (active.value) localStorage.setItem('admin_release_product', active.value);
        await loadUpdates();
      } catch (e) { U.toast(U.failMsg(e, '加载失败'), 'error'); }
    }

    async function loadUpdates() {
      if (!active.value) { updates.value = []; return; }
      try {
        const q = new URLSearchParams({ product: active.value });
        if (upAction.value) q.set('action', upAction.value);
        const r = await U.api.get('/api/releases/updates?' + q.toString());
        updates.value = r.list || [];
        Object.assign(upSummary, { check: 0, success: 0, fail: 0, rollback: 0, machines: 0 }, r.summary || {});
      } catch (e) {
        updates.value = [];
        U.toast(U.failMsg(e, '升级记录加载失败'), 'error');
      }
    }

    async function setUpAction(a) {
      if (upAction.value === a) return;
      upAction.value = a;
      await loadUpdates();
    }

    async function addProduct() {
      const name = newProduct.value.trim();
      if (!name) return;
      busy.value = true;
      try {
        await U.api.post('/api/releases/config', { add_product: name });
        newProduct.value = '';
        adding.value = false;
        await load();
        selectProduct(name);
        U.toast('已添加产品线 ' + name, 'success');
      } catch (e) { U.toast(U.failMsg(e, '添加失败'), 'error'); }
      finally { busy.value = false; }
    }

    function goRetention() { location.hash = '#/retention'; }

    function pickFull(ev) {
      fullFile.value = (ev.target.files || [])[0] || null;
      const f = fullFile.value;
      if (f && !form.version) {
        const m = /(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)/.exec(f.name);
        if (m) form.version = 'V' + m[1].replace(/^V/i, '');
      }
    }
    function pickDelta(ev) {
      deltaFile.value = (ev.target.files || [])[0] || null;
      if (deltaFile.value && !form.from) {
        const m = /from-(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)/.exec(deltaFile.value.name);
        if (m) form.from = 'V' + m[1].replace(/^V/i, '');
      }
    }

    async function publish() {
      if (!active.value) { U.toast('请先选择产品', 'error'); return; }
      if (!form.version) { U.toast('请填写版本号', 'error'); return; }
      busy.value = true;
      try {
        const fd = new FormData();
        fd.append('product', active.value);
        for (const k of ['version', 'channel', 'platform', 'arch', 'min_version', 'changelog']) {
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
        const n = (r.files || []).length;
        U.toast('已重建 ' + n + ' 份兜底清单', 'success');
      } catch (e) { U.toast(U.failMsg(e, '重建失败'), 'error'); }
    }

    async function saveSite() {
      try {
        await U.api.post('/api/releases/config', { site_url: cfg.site_url || '' });
        U.toast('已保存并重建清单', 'success');
        await load();
      } catch (e) { U.toast(U.failMsg(e, '保存失败'), 'error'); }
    }

    function openPurge() {
      purgeTarget.value = active.value;
      purgeDays.value = 90;
      purgeConfirm.value = '';
    }

    async function doPurge() {
      busy.value = true;
      try {
        const r = await U.api.post('/api/releases/updates/purge', {
          product: purgeTarget.value, days: purgeDays.value, confirm: purgeConfirm.value,
        });
        U.toast(r.deleted ? `已清理 ${r.deleted} 行` : '没有符合条件的记录', r.deleted ? 'success' : 'info');
        purgeTarget.value = '';
        purgeConfirm.value = '';
        await loadUpdates();
        await load();
      } catch (e) { U.toast(U.failMsg(e, '清理失败'), 'error'); }
      finally { busy.value = false; }
    }

    async function runProbe() {
      probing.value = true;
      probeOut.value = '';
      try {
        const q = new URLSearchParams({
          product: active.value || '',
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
          () => U.toast('已复制', 'success'),
          () => U.toast(s, 'info')
        );
      } else {
        U.toast(s, 'info');
      }
    }

    onMounted(async () => {
      await load();
      if (!probe.version && curMeta.value.latest) probe.version = curMeta.value.latest;
    });

    return {
      cfg, allRows, meta, products, curMeta, rows, totalAllSize, active, adding, newProduct,
      busy, form, probe, probeOut, probing, updates, upAction, upSummary,
      fullFile, deltaFile, checkUrl, purgeTarget, purgeDays, purgeConfirm,
      bytes, when, short, load, loadUpdates, setUpAction, codeText, selectProduct, addProduct,
      goRetention, pickFull, pickDelta, publish, toggle, verify, remove,
      rebuild, saveSite, runProbe, copy, openPurge, doPurge,
    };
  },
};
})();

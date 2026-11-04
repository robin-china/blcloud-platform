(function () {
const { ref, reactive, onMounted, computed } = Vue;

window.PageBackup = {
  template: `
  <div>
    <div class="grid g4" style="margin-bottom:16px">
      <div class="stat"><div class="label">数据库大小</div><div class="value">{{ bytes(sum.db_bytes) }}</div>
        <div class="delta">{{ sum.db_file }}</div></div>
      <div class="stat"><div class="label">业务数据量</div><div class="value">{{ sum.rows }} 行</div>
        <div class="delta">用户 {{ count('users') }} · 订单 {{ count('orders') }} · 授权 {{ count('licenses') }}</div></div>
      <div class="stat"><div class="label">备份份数</div><div class="value">{{ sum.backup_count }}</div>
        <div class="delta">{{ sum.last_backup ? '最近 ' + when(sum.last_backup.mtime) : '还没有备份' }}</div></div>
      <div class="stat"><div class="label">加密主密钥</div>
        <div class="value" :style="sum.has_appsecret ? '' : 'color:var(--danger)'">{{ sum.has_appsecret ? '已存在' : '缺失' }}</div>
        <div class="delta">data/.appsecret，丢失则加密配置全部作废</div></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>账套备份</h3>
        <span class="tag">数据库 + 加密主密钥，可下载到本地留存</span></div>
      <div class="card-body">
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <button class="btn primary" :disabled="busy" @click="create">立即备份</button>
          <label class="switch">
            <input type="checkbox" v-model="withUploads" />
            <span class="track"></span><span>包含上传文件（图标等，包会变大）</span>
          </label>
          <span class="hint" style="margin:0">每天首次启动会自动留一份，最多保留 30 份。</span>
        </div>
        <div class="hint" style="margin-top:10px">
          备份包是 zip：app.db（VACUUM 快照）+ .appsecret + manifest.json。请同时保存到本机以外的位置 ——
          只放在服务器上，服务器被删就一起没了。
        </div>
        <table class="table" style="margin-top:14px">
          <thead><tr><th>备份文件</th><th>时间</th><th>大小</th><th>数据量</th><th>说明</th><th style="width:150px">操作</th></tr></thead>
          <tbody>
            <tr v-for="b in list" :key="b.name">
              <td style="font-family:ui-monospace,monospace;font-size:12px">{{ b.name }}</td>
              <td>{{ when(b.mtime) }}</td>
              <td>{{ bytes(b.size) }}</td>
              <td>{{ b.manifest ? b.manifest.rows + ' 行' : '-' }}</td>
              <td style="color:var(--text-3);font-size:12.5px">{{ b.manifest ? b.manifest.note : '' }}</td>
              <td>
                <div class="table-actions">
                  <button class="btn sm" @click="download(b.name)">下载</button>
                  <button class="btn sm danger" @click="removeBackup(b.name)">删除</button>
                </div>
              </td>
            </tr>
            <tr v-if="!list.length"><td colspan="6"><div class="empty">还没有备份，点「立即备份」生成第一份</div></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>从备份恢复</h3>
        <span class="tag danger">覆盖现有数据</span></div>
      <div class="card-body">
        <div class="hint" style="margin-top:0">
          上传备份包 → 先校验并预览 → 输入 RESTORE 确认后才真正写入。
          恢复在单个事务内完成，失败会自动回滚；执行前系统会自动再备份一份当前数据。
        </div>
        <div class="field" style="margin-top:12px">
          <label>备份包（.zip）</label>
          <input type="file" accept=".zip" @change="pick" />
        </div>
        <div v-if="stage">
          <div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin:10px 0;font-size:13px">
            <div><b>{{ stage.source_name || '已上传' }}</b> · {{ bytes(stage.size) }}</div>
            <div style="color:var(--text-3);margin-top:6px">
              备份时间 {{ stage.manifest ? stage.manifest.created_at : '未知' }}
              · 数据量 {{ stage.manifest && stage.manifest.db ? stage.manifest.db.rows : '?' }} 行
              · 包含 {{ stage.tables.length }} 张表<template v-if="stage.has_appsecret"> · 含加密主密钥</template>
            </div>
            <div v-if="stage.warning" style="color:var(--danger);margin-top:8px">{{ stage.warning }}</div>
          </div>
          <div class="field">
            <label>输入 RESTORE 确认覆盖</label>
            <input class="input" v-model="restoreConfirm" placeholder="RESTORE" />
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn danger" :disabled="busy || restoreConfirm.toUpperCase() !== 'RESTORE'" @click="apply">确认恢复</button>
            <button class="btn" :disabled="busy" @click="cancel">取消</button>
          </div>
        </div>
        <div v-if="restoreResult" class="hint" style="margin-top:12px;color:var(--success)">
          恢复完成：覆盖 {{ Object.keys(restoreResult.tables).length }} 张表、{{ restoreResult.rows }} 行；
          恢复前备份 {{ restoreResult.pre_backup }}。请刷新页面确认数据。
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>清理演示 / 测试数据</h3>
        <span class="tag danger">不可撤销</span></div>
      <div class="card-body">
        <div class="hint" style="margin-top:0">
          只删数据行，不删表、不删管理员、不删站点与接入配置。执行前会自动备份一份。
          勾选「用户账号」会连带清空该用户产生的订单、授权、佣金与设备。
        </div>
        <table class="table" style="margin-top:12px">
          <thead><tr><th style="width:56px">清理</th><th>分组</th><th>包含内容</th><th style="width:100px">行数</th></tr></thead>
          <tbody>
            <tr v-for="g in groups" :key="g.key">
              <td><input type="checkbox" :value="g.key" v-model="picked" /></td>
              <td><b>{{ g.name }}</b></td>
              <td style="color:var(--text-3);font-size:12.5px">{{ g.desc }}</td>
              <td>{{ g.rows }}</td>
            </tr>
          </tbody>
        </table>
        <div style="display:flex;gap:12px;align-items:center;margin-top:14px;flex-wrap:wrap">
          <input class="input" style="width:200px" v-model="purgeConfirm" placeholder="输入「清除」确认" />
          <button class="btn danger" :disabled="busy || purgeConfirm !== '清除' || !picked.length" @click="purge">执行清理</button>
          <span class="hint" style="margin:0">将删除 {{ pickedRows }} 行</span>
        </div>
        <div v-if="purgeResult" class="hint" style="margin-top:12px;color:var(--success)">
          已删除 {{ purgeResult.total }} 行；清理前备份 {{ purgeResult.backup || '（未备份）' }}。
        </div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const sum = reactive({ tables: {}, db_bytes: 0, rows: 0, backup_count: 0, last_backup: null, has_appsecret: false, db_file: '' });
    const list = ref([]);
    const groups = ref([]);
    const picked = ref(['transactions', 'licenses', 'agents', 'devices', 'users', 'logs', 'stats']);
    const withUploads = ref(false);
    const busy = ref(false);
    const stage = ref(null);
    const restoreConfirm = ref('');
    const restoreResult = ref(null);
    const purgeConfirm = ref('');
    const purgeResult = ref(null);

    const pickedRows = computed(() => groups.value
      .filter((g) => picked.value.includes(g.key))
      .reduce((s, g) => s + g.rows, 0));

    function bytes(n) {
      const v = Number(n) || 0;
      if (v < 1024) return v + ' B';
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
      if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
      return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }
    function when(ms) {
      if (!ms) return '-';
      const d = new Date(Number(ms));
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function count(t) {
      return sum.tables[t] || 0;
    }

    async function load() {
      const [s, l, p] = await Promise.all([
        U.api.get('/api/backup/summary'),
        U.api.get('/api/backup/list'),
        U.api.get('/api/maintenance/purge/preview'),
      ]);
      Object.assign(sum, s);
      list.value = l.list || [];
      groups.value = p.groups || [];
    }

    async function create() {
      busy.value = true;
      try {
        const r = await U.api.post('/api/backup/create', { uploads: withUploads.value });
        U.toast('备份完成：' + r.name, 'success');
        await load();
      } catch (e) { U.toast(e.message, 'error'); } finally { busy.value = false; }
    }

    async function download(name) {
      try {
        const token = U.api.getToken('admin');
        const res = await fetch(U.basePath + '/api/backup/download/' + encodeURIComponent(name),
          { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) throw new Error('下载失败 ' + res.status);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
      } catch (e) { U.toast(e.message, 'error'); }
    }

    async function removeBackup(name) {
      if (!(await U.confirm('删除备份 ' + name + '？删除后无法找回。'))) return;
      try {
        await U.api.del('/api/backup/' + encodeURIComponent(name));
        U.toast('已删除', 'success');
        await load();
      } catch (e) { U.toast(e.message, 'error'); }
    }

    function pick(e) {
      const file = e.target.files[0];
      if (!file) return;
      stage.value = null;
      restoreResult.value = null;
      restoreConfirm.value = '';
      upload(file);
    }

    async function upload(file) {
      busy.value = true;
      try {
        const fd = new FormData();
        fd.append('file', file);
        const token = U.api.getToken('admin');
        const res = await fetch(U.basePath + '/api/backup/restore', {
          method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '上传失败');
        stage.value = data;
      } catch (e) {
        U.toast(e.message, 'error');
      } finally { busy.value = false; }
    }

    async function apply() {
      if (!stage.value) return;
      busy.value = true;
      try {
        const r = await U.api.post('/api/backup/restore/apply', {
          token: stage.value.token, confirm: restoreConfirm.value,
        });
        restoreResult.value = r;
        stage.value = null;
        restoreConfirm.value = '';
        U.toast('恢复完成', 'success');
        await load();
      } catch (e) {
        U.toast(e.message, 'error');
      } finally { busy.value = false; }
    }

    async function cancel() {
      if (stage.value) await U.api.post('/api/backup/restore/cancel', { token: stage.value.token }).catch(() => {});
      stage.value = null;
      restoreConfirm.value = '';
    }

    async function purge() {
      if (purgeConfirm.value !== '清除') return;
      const names = groups.value.filter((g) => picked.value.includes(g.key)).map((g) => g.name).join('、');
      if (!(await U.confirm('将清理：' + names + '\n共 ' + pickedRows.value + ' 行。\n执行前会自动备份一份，确认继续？'))) return;
      busy.value = true;
      try {
        const r = await U.api.post('/api/maintenance/purge', {
          groups: picked.value, confirm: purgeConfirm.value, backup: true,
        });
        purgeResult.value = r;
        purgeConfirm.value = '';
        U.toast('已删除 ' + r.total + ' 行', 'success');
        await load();
      } catch (e) {
        U.toast(e.message, 'error');
      } finally { busy.value = false; }
    }

    onMounted(load);
    return {
      sum, list, groups, picked, pickedRows, withUploads, busy,
      stage, restoreConfirm, restoreResult, purgeConfirm, purgeResult,
      bytes, when, count, load, create, download, removeBackup, pick, apply, cancel, purge,
    };
  },
};
})();

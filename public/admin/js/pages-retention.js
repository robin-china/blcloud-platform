(function () {
const { ref, reactive, computed, onMounted } = Vue;

/* 数据留存：把「只增不删」的流水表变成可维护的
 *
 * 之前后台只有「备份与恢复」里的「清空整表」：
 *  - 看不到这张表到底多少行、最早一条是哪年的
 *  - 没有「按时间滚动清理」，要么不管、要么全清
 * 所以这里按表给出：行数、最早一行、保留天数（可改）、到期行数、清空入口。
 */
window.PageRetention = {
  template: `
  <div>
    <div class="grid g4" style="margin-bottom:16px">
      <div class="stat"><div class="label">流水表总行数</div>
        <div class="value">{{ rows.length ? fmt.int(totalRows) : '-' }}</div>
        <div class="delta">{{ policies.length }} 张表纳入统计</div></div>
      <div class="stat"><div class="label">自动清理覆盖</div>
        <div class="value">{{ autoCount }}</div>
        <div class="delta">按保留天数每天滚动删除</div></div>
      <div class="stat"><div class="label">下次将删除</div>
        <div class="value" :style="totalDue ? 'color:var(--danger)' : ''">{{ fmt.int(totalDue) }}</div>
        <div class="delta">按当前保留天数计算，含已到期记录</div></div>
      <div class="stat"><div class="label">上次清理</div>
        <div class="value" style="font-size:15px">{{ lastRun.at ? when(lastRun.at) : '尚未执行' }}</div>
        <div class="delta">{{ lastRun.total ? '删除 ' + fmt.int(lastRun.total) + ' 行' : '启动时会自动跑一次' }}</div></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>留存策略</h3>
        <div style="display:flex;gap:8px">
          <button class="btn sm" @click="load">刷新</button>
          <button class="btn sm primary" :disabled="busy || !dirty" @click="saveDays">
            {{ dirty ? '保存保留天数' : '天数未修改' }}</button>
        </div></div>
      <div class="card-body" style="padding:0">
        <div class="hint" style="padding:12px 16px 0;margin:0">
          保留天数 = 超过这么多天的记录会被删除；填 0 表示<b>不自动清理</b>（台账、审计日志默认就是 0）。
          在线会话永远不删，只清「已失效/已过期」的。订单、支付、授权、积分、佣金属于账本，不在本页自动清理范围内。
        </div>
        <table class="table" style="margin-top:10px">
          <thead><tr>
            <th>数据表</th><th style="width:96px">行数</th><th style="width:150px">最早一行</th>
            <th style="width:130px">保留天数</th><th style="width:100px">到期行数</th>
            <th style="width:210px">操作</th>
          </tr></thead>
          <tbody>
            <tr v-for="p in policies" :key="p.key">
              <td>
                <b>{{ p.name }}</b>
                <span v-if="p.auto" class="tag" style="margin-left:6px">自动</span>
                <span v-else class="tag" style="margin-left:6px;color:var(--text-3)">手动</span>
                <div class="hint" style="margin:2px 0 0">{{ p.desc }}</div>
              </td>
              <td>{{ fmt.int(p.rows) }}
                <div v-if="p.session" class="hint" style="margin:0">失效 {{ fmt.int(p.expired) }}</div>
              </td>
              <td class="hint" style="margin:0">{{ p.oldest ? when(p.oldest) : (p.rows ? '-' : '空') }}</td>
              <td>
                <input class="input" type="number" min="0" max="3650" style="width:86px"
                  v-model.number="days[p.key]" @change="markDirty" :disabled="busy" />
                <div class="hint" style="margin:2px 0 0">默认 {{ p.default_days || '不清' }}</div>
              </td>
              <td>
                <span v-if="p.due" style="color:var(--danger)"><b>{{ fmt.int(p.due) }}</b></span>
                <span v-else class="hint">0</span>
              </td>
              <td>
                <div class="table-actions">
                  <button class="btn sm" :disabled="busy || !p.auto" @click="runOne(p)">清理到期</button>
                  <button class="btn sm danger" :disabled="busy || !p.rows" @click="pickClear(p)">清空</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="hint" style="padding:10px 16px 14px">
          说明：客户端更新页的「升级记录」、开放接口页的「鉴权模式」都读这些流水表，
          清早了就查不到历史 —— 默认值是按「够排障、不占地方」定的，别随手改成 1 天。
        </div>
      </div>
    </div>

    <div class="card" v-if="clearTarget" style="margin-bottom:16px;border-color:var(--danger)">
      <div class="card-head"><h3>清空「{{ clearTarget.name }}」</h3>
        <span class="tag danger">不可撤销</span></div>
      <div class="card-body">
        <div class="hint" style="margin-top:0">
          将删除全部 {{ fmt.int(clearTarget.rows) }} 行，执行前会自动备份一份账套（备份包名会写进操作日志）。
          <template v-if="clearTarget.key === 'client_sessions'">在线客户端会被强制下线，需要重新登录。</template>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:12px">
          <div class="field" style="margin:0;width:220px">
            <label>输入「清除」确认</label>
            <input class="input" v-model="clearConfirm" placeholder="清除" />
          </div>
          <button class="btn danger" :disabled="busy || clearConfirm !== '清除'" @click="doClear">确认清空</button>
          <button class="btn" :disabled="busy" @click="clearTarget = null">取消</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>整体操作</h3>
        <span class="tag">按上面的保留天数立即执行一次</span></div>
      <div class="card-body">
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <button class="btn primary" :disabled="busy" @click="runAll">立即清理所有到期记录</button>
          <span class="hint" style="margin:0">预计删除 {{ fmt.int(totalDue) }} 行；每天服务启动时与运行中每 6 小时自动执行一次</span>
        </div>
        <div v-if="lastResult" class="hint" style="margin-top:10px;color:var(--success)">
          已删除 {{ fmt.int(lastResult) }} 行
        </div>
        <div class="hint" style="margin-top:10px">
          整表清空（含订单、授权、用户等账本）仍在「备份与恢复 → 清理演示 / 测试数据」，
          这里只做流水表的滚动留存。
        </div>
      </div>
    </div>
  </div>
  `,
  setup() {
    const policies = ref([]);
    const days = reactive({});
    const lastRun = reactive({ at: '', total: 0, deleted: {} });
    const busy = ref(false);
    const dirty = ref(false);
    const clearTarget = ref(null);
    const clearConfirm = ref('');
    const lastResult = ref(0);
    const totalRows = ref(0);
    const fmt = U.fmt;

    const autoCount = computed(() => policies.value.filter((p) => p.auto).length);
    const totalDue = computed(() => policies.value.reduce((s, p) => s + Number(p.due || 0), 0));

    function when(s) {
      if (!s) return '-';
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return s;
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    function markDirty() { dirty.value = true; }

    async function load() {
      try {
        const r = await U.api.get('/api/maintenance/retention');
        policies.value = r.policies || [];
        totalRows.value = r.total_rows || 0;
        for (const p of policies.value) days[p.key] = p.days;
        Object.assign(lastRun, r.last_run || {});
        dirty.value = false;
      } catch (e) { U.toast(U.failMsg(e, '加载失败'), 'error'); }
    }

    async function saveDays() {
      busy.value = true;
      try {
        const patch = {};
        for (const p of policies.value) if (Number(days[p.key]) !== Number(p.days)) patch[p.key] = Number(days[p.key]);
        if (!Object.keys(patch).length) { U.toast('没有需要保存的修改', 'info'); dirty.value = false; return; }
        await U.api.post('/api/maintenance/retention', { days: patch });
        U.toast('保留天数已保存', 'success');
        await load();
      } catch (e) { U.toast(U.failMsg(e, '保存失败'), 'error'); }
      finally { busy.value = false; }
    }

    async function runOne(p) {
      busy.value = true;
      try {
        const r = await U.api.post('/api/maintenance/retention/run', { keys: [p.key] });
        lastResult.value = r.total || 0;
        U.toast(r.total ? `已清理 ${r.total} 行` : '没有到期记录', r.total ? 'success' : 'info');
        await load();
      } catch (e) { U.toast(U.failMsg(e, '清理失败'), 'error'); }
      finally { busy.value = false; }
    }

    async function runAll() {
      busy.value = true;
      try {
        const r = await U.api.post('/api/maintenance/retention/run', {});
        lastResult.value = r.total || 0;
        U.toast(r.total ? `已清理 ${r.total} 行` : '没有到期记录', r.total ? 'success' : 'info');
        await load();
      } catch (e) { U.toast(U.failMsg(e, '清理失败'), 'error'); }
      finally { busy.value = false; }
    }

    function pickClear(p) {
      clearTarget.value = p;
      clearConfirm.value = '';
    }

    async function doClear() {
      const p = clearTarget.value;
      if (!p) return;
      busy.value = true;
      try {
        const r = await U.api.post('/api/maintenance/retention/clear', { key: p.key, confirm: clearConfirm.value });
        U.toast(`已清空 ${r.deleted} 行${r.backup ? '（备份 ' + r.backup + '）' : ''}`, 'success');
        clearTarget.value = null;
        clearConfirm.value = '';
        await load();
      } catch (e) { U.toast(U.failMsg(e, '清空失败'), 'error'); }
      finally { busy.value = false; }
    }

    onMounted(load);

    return {
      policies, days, lastRun, busy, dirty, clearTarget, clearConfirm, lastResult,
      totalRows, autoCount, totalDue, fmt, when,
      load, markDirty, saveDays, runOne, runAll, pickClear, doClear,
    };
  },
};
})();

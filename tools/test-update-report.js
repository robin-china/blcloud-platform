/* 升级结果上报契约测试（2026-11-10 契约 v2，与 LabelGo 客户端逐字段对齐）：
 * 1) POST /api/open/v1/app/update-report 免鉴权可用
 * 2) snake_case 字段：machine_code / from_version / to_version / result / code / stage /
 *    duration_ms / elevated / os / at 全部落库
 * 3) result 归一化：success / fail / rollback；旧字段（machine/from/status）兼容
 * 4) 去重口径 = 覆盖不累加：同 machine+from+to 重复上报覆盖旧结果（deduped=true）
 * 5) 回滚后重升成功：fail → 覆盖成 success，失败数不虚增
 * 6) check 清单命中流水不受覆盖影响
 */
process.env.NODE_ENV = 'test';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', 'test-update-report.db');
process.env.ADMIN_INIT_PASSWORD = 'admin123';
try { require('fs').unlinkSync(process.env.DB_PATH); } catch { /* 不存在更好 */ }

const { build } = require('../server/index');
const db = require('../server/db');

let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`  ✗   ${name}${detail ? ' → ' + detail : ''}`); }
}
const rows = (where, args) =>
  db.prepare(`SELECT * FROM app_update_log WHERE ${where} ORDER BY id DESC`).all(...args);

(async () => {
  const app = build();
  await app.ready();
  const URL = '/api/open/v1/app/update-report';

  // ── 1. 新契约完整 payload（客户端草案原样） ──
  const r1 = await app.inject({
    method: 'POST', url: URL,
    payload: {
      product: 'LabelGo',
      machine_code: 'HW-ABC-001',
      from_version: '1.0.49',
      to_version: '1.0.50',
      result: 'fail',
      code: 4,
      stage: 'close',
      duration_ms: 23400,
      elevated: true,
      os: '10.0.19045',
      at: '2026-11-10T14:14:24Z',
    },
  });
  const j1 = r1.json();
  t('免鉴权可上报（200）', r1.statusCode === 200, `${r1.statusCode} ${r1.body.slice(0, 100)}`);
  t('响应 ok + action=fail', j1.ok === true && j1.action === 'fail', r1.body);
  t('响应 deduped=false（首次插入）', j1.deduped === false, r1.body);
  const [row1] = rows('product=? AND machine=?', ['LabelGo', 'HW-ABC-001']);
  t('from_version/to_version 落库', row1.from_version === '1.0.49' && row1.to_version === '1.0.50', JSON.stringify(row1));
  t('失败码 code=4 落库', row1.result_code === 4, String(row1.result_code));
  t('stage=close 落库', row1.stage === 'close', row1.stage);
  t('duration_ms 落库', row1.duration_ms === 23400, String(row1.duration_ms));
  t('elevated 落库', row1.elevated === 1, String(row1.elevated));
  t('os 落库为 os_info', row1.os_info === '10.0.19045', row1.os_info);
  t('客户端时间 at 落库为 client_at', row1.client_at === '2026-11-10T14:14:24Z', row1.client_at);

  // ── 2. 覆盖去重：同机器同版本重试上报失败，覆盖不新增 ──
  const before = rows('product=? AND machine=?', ['LabelGo', 'HW-ABC-001']).length;
  const r2 = await app.inject({
    method: 'POST', url: URL,
    payload: { product: 'LabelGo', machine_code: 'HW-ABC-001', from_version: '1.0.49', to_version: '1.0.50', result: 'fail', code: 5, stage: 'copy' },
  });
  const j2 = r2.json();
  const after = rows('product=? AND machine=?', ['LabelGo', 'HW-ABC-001']);
  t('重复上报返回 deduped=true', j2.deduped === true, r2.body);
  t('重复上报覆盖同一条记录', before === 1 && after.length === 1, `${before} → ${after.length}`);
  t('覆盖后取最新结果（code 4→5）', after[0].result_code === 5 && after[0].stage === 'copy', JSON.stringify({ c: after[0].result_code, s: after[0].stage }));

  // ── 3. 回滚后重升成功：fail 被覆盖成 success（同键） ──
  const r3 = await app.inject({
    method: 'POST', url: URL,
    payload: { product: 'LabelGo', machine_code: 'HW-ABC-001', from_version: '1.0.49', to_version: '1.0.50', result: 'success', code: 0, stage: 'alive', duration_ms: 45600 },
  });
  const j3 = r3.json();
  const [row3] = rows('product=? AND machine=?', ['LabelGo', 'HW-ABC-001']);
  t('回滚重升成功覆盖为 success', j3.action === 'success' && j3.deduped === true, r3.body);
  t('最终只剩一条结果记录', rows('product=? AND machine=?', ['LabelGo', 'HW-ABC-001']).length === 1);
  t('覆盖后 result_code=0、duration 更新', row3.result_code === 0 && row3.duration_ms === 45600, JSON.stringify({ c: row3.result_code, d: row3.duration_ms }));

  // ── 4. result=rollback 归一化 ──
  await app.inject({
    method: 'POST', url: URL,
    payload: { product: 'LabelGo', machine_code: 'HW-XYZ-002', from_version: '1.0.50', to_version: '1.0.50', result: 'rollback', code: 6, stage: 'launch' },
  });
  const [row4] = rows('machine=?', ['HW-XYZ-002']);
  t('rollback 作为独立 action 落库', row4.action === 'rollback', row4.action);

  // ── 5. 旧字段兼容（machine / from / status） ──
  const r5 = await app.inject({
    method: 'POST', url: URL,
    payload: { product: 'LabelGo', machine: 'HW-OLD-003', from: '1.0.48', to: '1.0.50', status: 'success' },
  });
  const [row5] = rows('machine=?', ['HW-OLD-003']);
  t('旧字段 machine/from/to/status 兼容', r5.statusCode === 200 && row5.action === 'success' && row5.from_version === '1.0.48', `${r5.statusCode} ${JSON.stringify(row5 && { a: row5.action, f: row5.from_version })}`);

  // ── 6. check 清单命中不受结果覆盖影响 ──
  const chk = db.prepare(`INSERT INTO app_update_log (product, machine, from_version, to_version, action, created_at)
    VALUES ('LabelGo','HW-ABC-001','1.0.49','1.0.50','check',datetime('now'))`).run();
  const r6 = await app.inject({
    method: 'POST', url: URL,
    payload: { product: 'LabelGo', machine_code: 'HW-ABC-001', from_version: '1.0.49', to_version: '1.0.50', result: 'fail', code: 7, stage: 'elevate' },
  });
  const cnt = db.prepare('SELECT action, COUNT(*) AS n FROM app_update_log WHERE id=?').get(chk.lastInsertRowid);
  t('check 流水未被结果覆盖', cnt.action === 'check' && cnt.n === 1, JSON.stringify(cnt));
  const resultRows = rows("product='LabelGo' AND machine='HW-ABC-001' AND action<>'check'", []);
  t('结果记录仍只有一条且被覆盖', resultRows.length === 1 && resultRows[0].result_code === 7, JSON.stringify(resultRows.map((x) => x.result_code)));
  t('重复上报（覆盖 check 后的结果）仍 200', r6.statusCode === 200, r6.body);

  // ── 7. 缺 product 报 400；缺 machine 不覆盖直接追加 ──
  const r7 = await app.inject({ method: 'POST', url: URL, payload: { result: 'success' } });
  t('缺 product 返回 400', r7.statusCode === 400, r7.body);
  await app.inject({ method: 'POST', url: URL, payload: { product: 'LabelGo', result: 'fail' } });
  await app.inject({ method: 'POST', url: URL, payload: { product: 'LabelGo', result: 'fail' } });
  t('无 machine 的上报不去重（老客户端兜底）', rows("product='LabelGo' AND machine=''", []).length === 2);

  // ── 8. 后台升级记录接口带出 rollback 与新字段 ──
  const login = (await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' } })).json();
  const AH = { authorization: `Bearer ${login.token}` };
  const list = (await app.inject({ method: 'GET', url: '/api/releases/updates?product=LabelGo', headers: AH })).json();
  t('后台升级记录含 rollback 汇总', typeof (list.summary || {}).rollback === 'number', JSON.stringify(list.summary));
  const rb = (list.list || []).find((x) => x.action === 'rollback');
  t('后台记录行带 result_code/stage/duration_ms', !!(rb && rb.result_code === 6 && rb.stage === 'launch'), JSON.stringify(rb && { c: rb.result_code, s: rb.stage }));
  const filtered = (await app.inject({ method: 'GET', url: '/api/releases/updates?product=LabelGo&action=rollback', headers: AH })).json();
  t('按 rollback 筛选可用', (filtered.list || []).every((x) => x.action === 'rollback') && filtered.list.length >= 1, String(filtered.list && filtered.list.length));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  if (fail > 0) process.exitCode = 1;
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });

/* 系统维护：账套备份 / 恢复 / 演示数据清理
 *
 * 全部为超管操作，每一步都写 admin_logs —— 谁来恢复过数据、清空过什么，事后必须查得到。
 */
const fs = require('fs');
const backup = require('../lib/backup');
const purge = require('../lib/purge');
const { requireAdmin } = require('../lib/auth');
const { logAdmin } = require('../lib/adminlog');

function clientIp(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
}

module.exports = async function backupRoutes(app) {
  app.get('/api/backup/summary', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return backup.summary();
  });

  app.get('/api/backup/list', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return {
      list: backup.list().map((b) => ({
        name: b.name, size: b.size, mtime: b.mtime,
        manifest: b.manifest ? {
          created_at: b.manifest.created_at,
          note: b.manifest.note || '',
          rows: b.manifest.db ? b.manifest.db.rows : 0,
          has_appsecret: !!b.manifest.has_appsecret,
          uploads: b.manifest.uploads || { files: 0, bytes: 0 },
        } : null,
      })),
      dir: backup.BACKUP_DIR,
    };
  });

  app.post('/api/backup/create', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    const uploads = !!b.uploads;
    try {
      const pkg = backup.createPackage({ uploads, note: String(b.note || '手动备份') });
      logAdmin(req, '创建账套备份',
        `${pkg.name}（${Math.round(pkg.size / 1024)} KB，${pkg.manifest.db.rows} 行${uploads ? '，含上传文件' : ''}）`);
      return {
        ok: true, name: pkg.name, size: pkg.size,
        rows: pkg.manifest.db.rows,
        uploads: pkg.manifest.uploads,
      };
    } catch (e) {
      return reply.code(500).send({ error: `备份失败：${e.message}` });
    }
  });

  app.get('/api/backup/download/:name', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const file = backup.backupFile(req.params.name);
    if (!file) return reply.code(404).send({ error: '备份不存在' });
    logAdmin(req, '下载账套备份', req.params.name);
    const buf = fs.readFileSync(file);
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${req.params.name}"`)
      .send(buf);
  });

  app.delete('/api/backup/:name', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    // 「全部备份」是唯一非文件名的合法参数：换服务器前清场用
    if (req.params.name === 'all') {
      const all = backup.list();
      for (const b of all) backup.remove(b.name);
      logAdmin(req, '删除全部账套备份', `共 ${all.length} 份`);
      return { ok: true, removed: all.length };
    }
    const ok = backup.remove(req.params.name);
    if (!ok) return reply.code(404).send({ error: '备份不存在' });
    logAdmin(req, '删除账套备份', req.params.name);
    return { ok: true };
  });

  /* ---------------- 恢复 ---------------- */

  app.post('/api/backup/restore', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    let data;
    try {
      data = await req.file();
    } catch (e) {
      return reply.code(400).send({ error: `上传失败：${e.message}` });
    }
    if (!data) return reply.code(400).send({ error: '未收到备份文件' });
    let buf;
    try {
      buf = await data.toBuffer();
    } catch (e) {
      return reply.code(400).send({ error: `读取文件失败：${e.message}（备份包上限 64MB）` });
    }
    try {
      backup.cleanStaged();
      const info = backup.stage(buf, data.filename);
      logAdmin(req, '上传账套备份（待确认）',
        `${data.filename || ''}，${Math.round(buf.length / 1024)} KB，来自 IP ${clientIp(req)}`);
      return {
        ok: true,
        ...info,
        warning: backup.secretNote(info.manifest),
      };
    } catch (e) {
      return reply.code(400).send({ error: String(e.message || '备份包不可用') });
    }
  });

  app.post('/api/backup/restore/apply', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    const confirm = String(b.confirm || '').trim().toUpperCase();
    if (confirm !== 'RESTORE' && confirm !== '恢复') {
      return reply.code(400).send({ error: '请输入 RESTORE 确认恢复' });
    }
    const token = String(b.token || '');
    if (!token) return reply.code(400).send({ error: '缺少暂存凭证，请重新上传' });
    try {
      const res = backup.applyRestore(token);
      logAdmin(req, '账套恢复完成',
        `覆盖 ${Object.keys(res.tables).length} 张表 / ${res.rows} 行；恢复前备份 ${res.pre_backup}`);
      return { ok: true, ...res };
    } catch (e) {
      return reply.code(500).send({ error: `恢复失败（已回滚，数据未改动）：${e.message}` });
    }
  });

  app.post('/api/backup/restore/cancel', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const ok = backup.dropStaged((req.body || {}).token);
    return { ok };
  });

  /* ---------------- 清理演示数据 ---------------- */

  app.get('/api/maintenance/purge/preview', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    return purge.preview();
  });

  app.post('/api/maintenance/purge', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    const groups = Array.isArray(b.groups) ? b.groups.map(String) : [];
    const confirm = String(b.confirm || '').trim();
    if (confirm !== '清除' && confirm.toUpperCase() !== 'DELETE') {
      return reply.code(400).send({ error: '请输入「清除」二字确认' });
    }
    try {
      const res = purge.purge(groups, { backup: b.backup !== false });
      logAdmin(req, '清理业务数据',
        `${res.groups.map((g) => g.name).join('、')}：共删除 ${res.total} 行；清理前备份 ${res.backup || '（未备份）'}`);
      return { ok: true, ...res };
    } catch (e) {
      return reply.code(400).send({ error: `清理失败（已回滚）：${e.message}` });
    }
  });
};

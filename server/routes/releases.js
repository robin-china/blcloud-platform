/* 桌面客户端更新包：发布与管理（仅超管）
 *
 * 发布 = 文件落 data/updates/<版本>/ + 写 app_release + 重建 latest.json。
 * 三个动作一次做完，避免「包传上去了但清单没更新」这种半成品状态。
 */
const fs = require('fs');
const path = require('path');

const release = require('../lib/release');
const { requireAdmin } = require('../lib/auth');
const { logAdmin } = require('../lib/adminlog');
const { publicUrl, getSetting, setSetting } = require('../lib/config');

function clientIp(req) {
  return String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
}

function baseFrom(req) {
  return publicUrl(req, '/').replace(/\/+$/, '');
}

function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}

function isPkgName(name) {
  return release.PKG_EXT.includes(path.extname(String(name || '')).toLowerCase());
}

module.exports = async function releaseRoutes(app) {
  /* ---------------- 配置 ---------------- */
  app.get('/api/releases/config', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const tgt = release.defaultTarget();
    return {
      updates_dir: release.ROOT,
      site_url: getSetting('release_site_url', '') || '',
      detected_base: baseFrom(req),
      default_product: tgt.product,
      default_channel: tgt.channel,
      max_upload_mb: 64,
      file_exists: fs.existsSync(release.ROOT),
    };
  });

  app.post('/api/releases/config', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    if (b.site_url !== undefined) {
      const v = String(b.site_url || '').trim().replace(/\/+$/, '');
      if (v && !/^https?:\/\/[^/]+/i.test(v)) {
        return reply.code(400).send({ error: '站点地址要以 http:// 或 https:// 开头' });
      }
      setSetting('release_site_url', v);
    }
    if (b.default_product) setSetting('release_default_product', String(b.default_product).trim());
    if (b.default_channel) setSetting('release_default_channel', String(b.default_channel).trim());
    logAdmin(req, '修改更新包设置', `站点地址 ${getSetting('release_site_url', '') || '（跟随请求）'}`);
    const latest = release.writeLatest(baseFrom(req));
    return { ok: true, latest };
  });

  /* ---------------- 列表 ---------------- */
  app.get('/api/releases', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const q = req.query || {};
    // 产品/渠道等筛选：产品下拉和筛选 chips 永远给全量，列表给筛选后的
    const all = release.list({});
    const rows = (q.product || q.channel || q.platform || q.arch)
      ? all.filter((r) => (!q.product || r.product === q.product)
        && (!q.channel || r.channel === q.channel)
        && (!q.platform || r.platform === q.platform)
        && (!q.arch || r.arch === q.arch))
      : all;
    const base = baseFrom(req);
    const withFiles = (r) => {
      const file = r.full_path ? release.absPath(r.full_path) : '';
      return {
        ...r,
        full_exists: !!file && fs.existsSync(file),
        full_url_public: release.fileUrl(base, r.full_url || r.full_path),
        delta: (r.delta || []).map((d) => ({
          ...d,
          url_public: release.fileUrl(base, d.url || d.path),
          exists: d.path ? fs.existsSync(release.absPath(d.path)) : false,
        })),
      };
    };
    const list = rows.map(withFiles);
    return {
      list,
      products: [...new Set(all.map((r) => r.product))],
      total_size: list.reduce((s, r) => s + Number(r.full_size || 0), 0),
      total_all_size: all.reduce((s, r) => s + Number(r.full_size || 0), 0),
      site_url: getSetting('release_site_url', '') || '',
      detected_base: base,
    };
  });

  /* ---------------- 发布（multipart） ---------------- */
  app.post('/api/releases/publish', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    if (!req.isMultipart || !req.isMultipart()) {
      return reply.code(400).send({ error: '请用 multipart/form-data 上传安装包' });
    }

    const fields = {};
    const tmp = { full: null, delta: null };
    const errors = [];

    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const key = part.fieldname === 'delta' ? 'delta' : 'full';
          if (!part.filename) { part.file.resume(); continue; }
          if (!isPkgName(part.filename)) {
            part.file.resume();
            errors.push(`不支持的文件类型：${path.basename(part.filename)}（允许 ${release.PKG_EXT.join(' ')}）`);
            continue;
          }
          if (tmp[key]) { part.file.resume(); continue; }
          const ext = path.extname(part.filename).toLowerCase();
          // 必须在本轮循环内把流读完：busboy 不允许带着未消费的 part 进入下一段
          const rel = release.tmpRel(ext);
          const info = await release.storeUpload(part.file, rel);
          tmp[key] = { ...info, rel, name: path.basename(part.filename) };
        } else {
          fields[part.fieldname] = String(part.value == null ? '' : part.value);
        }
      }
    } catch (e) {
      // 清理已经落地的临时文件，别把半截包留在磁盘上
      for (const t of Object.values(tmp)) {
        if (t && t.rel) { try { fs.rmSync(release.absPath(t.rel), { force: true }); } catch { /* ignore */ } }
      }
      if (e && (e.code === 'FST_REQ_FILE_TOO_LARGE' || /file too large/i.test(e.message || ''))) {
        return reply.code(413).send({ error: '安装包超过单次上传上限（64MB），请用命令行工具或改用 nginx 直传' });
      }
      return reply.code(400).send({ error: `解析上传失败：${e.message}` });
    }

    if (errors.length) {
      for (const t of Object.values(tmp)) {
        if (t && t.rel) { try { fs.rmSync(release.absPath(t.rel), { force: true }); } catch { /* ignore */ } }
      }
      return reply.code(400).send({ error: errors[0] });
    }

    const product = String(fields.product || '').trim();
    const version = String(fields.version || '').trim();
    if (!product) return reply.code(400).send({ error: '缺少产品名（product）' });
    if (!release.validVersion(version)) {
      return reply.code(400).send({ error: `版本号格式不对：${version || '（空）'}，示例 1.0.21` });
    }

    const channel = String(fields.channel || 'stable').trim() || 'stable';
    const platform = String(fields.platform || 'win32').trim() || 'win32';
    const arch = String(fields.arch || 'x64').trim() || 'x64';
    const from = String(fields.from || '').trim();

    // 已有记录（同版本重发）允许只补增量包
    const exist = release.list({ product, channel, platform, arch })
      .find((r) => r.version === version);
    if (!tmp.full && !(exist && exist.full_sha256)) {
      if (tmp.delta) fs.rmSync(release.absPath(tmp.delta.rel), { force: true });
      return reply.code(400).send({ error: '首次发布必须上传全量包；只补增量包前请先发布该版本的全量包' });
    }
    if (tmp.delta && !from) {
      fs.rmSync(release.absPath(tmp.delta.rel), { force: true });
      return reply.code(400).send({ error: '增量包必须填写来源版本（from），例如 1.0.20' });
    }
    if (tmp.delta && release.cmpVersion(from, version) >= 0) {
      fs.rmSync(release.absPath(tmp.delta.rel), { force: true });
      return reply.code(400).send({ error: '增量来源版本必须低于目标版本' });
    }

    try {
      const patch = {
        product, channel, platform, arch, version,
        mandatory: truthy(fields.mandatory),
        min_version: String(fields.min_version || '').trim(),
        changelog: String(fields.changelog || ''),
        rollout: fields.rollout === undefined || fields.rollout === ''
          ? 100 : Math.max(0, Math.min(100, Number(fields.rollout) || 0)),
        enabled: fields.enabled === undefined || fields.enabled === ''
          ? true : truthy(fields.enabled),
      };
      if (patch.min_version && !release.validVersion(patch.min_version)) {
        throw new Error(`最低版本格式不对：${patch.min_version}`);
      }
      if (patch.min_version && release.cmpVersion(patch.min_version, version) > 0) {
        throw new Error('最低版本不能高于当前发布版本');
      }

      let rec;
      if (tmp.full) {
        const rel = release.relFor(product, version, 'full');
        release.moveFile(tmp.full.rel, rel);
        rec = release.saveRecord({
          ...patch,
          full_path: rel,
          full_sha256: tmp.full.sha256,
          full_size: tmp.full.size,
          full_url: String(fields.full_url || '').trim(),
          delta: exist ? exist.delta : [],
          // 重新上传包视为重新发布，发布时间刷新
          published_at: new Date().toISOString(),
        });
      } else {
        rec = release.saveRecord({ ...patch, delta: exist ? exist.delta : [] });
      }

      if (tmp.delta) {
        const rel = release.relFor(product, version, 'delta', from);
        release.moveFile(tmp.delta.rel, rel);
        rec = release.attachDelta(rec.id, {
          from, path: rel, sha256: tmp.delta.sha256, size: tmp.delta.size,
        });
      }

      const latest = release.writeLatest(baseFrom(req));
      logAdmin(req, '发布客户端更新',
        `${product} ${version}（${channel}/${platform}/${arch}）`
        + `${tmp.full ? `，全量 ${Math.round(tmp.full.size / 1024)} KB` : ''}`
        + `${tmp.delta ? `，增量 from ${from} ${Math.round(tmp.delta.size / 1024)} KB` : ''}`
        + `，强制=${patch.mandatory ? '是' : '否'}，灰度=${patch.rollout}%`);

      return {
        ok: true,
        release: {
          ...rec,
          full_url_public: release.fileUrl(baseFrom(req), rec.full_url || rec.full_path),
        },
        latest,
        // 客户端拿到的一定是绝对地址，这里回显便于管理员直接复制验证
        check_url: `${baseFrom(req)}/api/open/v1/app/version?product=${encodeURIComponent(product)}`
          + `&version=${encodeURIComponent(String(fields.check_version || ''))}&platform=${encodeURIComponent(platform)}`
          + `&arch=${encodeURIComponent(arch)}&channel=${encodeURIComponent(channel)}`,
      };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  /* ---------------- 改状态 / 校验 / 删除 ---------------- */
  app.patch('/api/releases/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const b = req.body || {};
    const rec = release.get(Number(req.params.id));
    if (!rec) return reply.code(404).send({ error: '版本记录不存在' });
    try {
      const next = release.update(rec.id, b);
      release.writeLatest(baseFrom(req));
      logAdmin(req, '修改客户端版本',
        `${rec.product} ${rec.version}：${Object.keys(b).map((k) => `${k}=${b[k]}`).join(' ')}`);
      return { ok: true, release: next };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.post('/api/releases/:id/verify', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const rec = release.get(Number(req.params.id));
    if (!rec) return reply.code(404).send({ error: '版本记录不存在' });
    const r = release.verify(rec.id);
    logAdmin(req, '校验客户端安装包', `${rec.product} ${rec.version}：${r.ok ? '通过' : '不一致'}`);
    return r;
  });

  app.delete('/api/releases/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const rec = release.get(Number(req.params.id));
    if (!rec) return reply.code(404).send({ error: '版本记录不存在' });
    const withFiles = truthy((req.query || {}).files) || truthy((req.body || {}).files);
    release.remove(rec.id, { files: withFiles });
    release.writeLatest(baseFrom(req));
    logAdmin(req, '删除客户端版本',
      `${rec.product} ${rec.version}${withFiles ? '（含安装包文件）' : '（保留文件）'}`);
    return { ok: true, files_removed: withFiles };
  });

  /* ---------------- 重建兜底清单（每产品一份 latest.json + 产品索引） ---------------- */
  app.post('/api/releases/latest.json', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const body = release.writeLatest(baseFrom(req));
    const info = release.getLastWriteInfo();
    logAdmin(req, '重建更新清单', `共 ${info.files.length} 份：${info.files.join('、')}`);
    return { ok: true, latest: body, files: info.files };
  });

  /* ---------------- 预览：这台机器现在会看到什么 ---------------- */
  app.get('/api/releases/preview', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const q = req.query || {};
    const tgt = release.defaultTarget();
    return release.manifest({
      product: q.product || tgt.product,
      channel: q.channel || tgt.channel,
      platform: q.platform || tgt.platform,
      arch: q.arch || tgt.arch,
      current: q.version || '',
      machine: q.machine || '',
    }, baseFrom(req));
  });
};

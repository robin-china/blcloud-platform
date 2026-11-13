/* 内置卡通头像全链路自测：node tools/test-avatars.js
 *
 * 覆盖：共享库 → 校验 → 写库短标识 → 对外展开 → 微信无头像自动分配
 *      → 扫码登录响应 → 软件端 /user/profile 同步。
 * 库里存 preset:01，对外一律给 data URI（软件端离线也能渲染）。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'test-avatars.db');
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
}
const KEY_FILE = path.join(__dirname, '..', 'data', 'test-avatars-key.json');
if (fs.existsSync(KEY_FILE)) fs.rmSync(KEY_FILE, { force: true });
process.env.DB_PATH = DB_FILE;
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.OFFLINE_KEY_PATH = KEY_FILE;

const { build } = require('../server');
const db = require('../server/db');
const { now } = require('../server/lib/util');
const profileLib = require('../server/lib/profile');
const avatarsLib = require('../server/lib/avatars');
const AP = require('../public/assets/avatars.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else { fail += 1; console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 260) : '')); }
}
function signReq(secret, appKey, method, url, bodyObj) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(6).toString('hex');
  const raw = bodyObj && Object.keys(bodyObj).length ? JSON.stringify(bodyObj) : '';
  const sig = crypto.createHmac('sha256', secret)
    .update([appKey, method.toUpperCase(), url, timestamp, nonce, raw].join('\n'))
    .digest('hex');
  const headers = { 'x-app-key': appKey, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-signature': sig };
  if (raw) headers['content-type'] = 'application/json';
  return { headers, body: raw || undefined };
}
function insertUser(openid, avatar = '') {
  const info = db.prepare(`INSERT INTO users
    (openid, nickname, avatar, phone, points, status, tb_username, tb_password, tb_status, created_at, last_login_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(openid, '头像测试', avatar, null, 0, 'active', `${openid}@tb.cn`, openid, 'none', now(), now());
  return Number(info.lastInsertRowid);
}

(async () => {
  console.log('\n共享头像库（前后端同一份 UMD 定义）');
  // 2026-11-13：新增一张中性默认头像，老 preset:01~08 继续保留兼容历史数据
  check('内置 9 张头像（含 1 张中性默认）', AP.PRESETS.length === 9, AP.PRESETS.length);
  check('每张都是可直接 <img> 的 SVG data URI',
    AP.PRESETS.every((p) => /^data:image\/svg\+xml;base64,/.test(p.dataUri)));
  const decoded = Buffer.from(AP.PRESETS[0].dataUri.split(',')[1], 'base64').toString('utf8');
  check('SVG 内含脸/眼睛/嘴（不是空图）',
    /<svg/.test(decoded) && /<ellipse/.test(decoded) && /<circle/.test(decoded) && decoded.length > 400,
    decoded.length);
  check('byValue 命中与不命中', !!AP.byValue('preset:03') && !AP.byValue('preset:99'));
  check('默认头像恒为中性 preset:00', AP.defaultValue('openid-a') === 'preset:00'
    && AP.defaultValue('openid-b') === 'preset:00' && !!AP.byValue('preset:00'));
  check('中性默认不再按 openid 分男女款',
    new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((s) => AP.defaultValue(s))).size === 1);

  console.log('\n服务端展开与校验');
  check('isPreset 只认存在的预设',
    avatarsLib.isPreset('preset:01') && !avatarsLib.isPreset('preset:99') && !avatarsLib.isPreset('https://x/a.png'));
  check('toDisplay 展开预设', avatarsLib.toDisplay('preset:01').startsWith('data:image/svg+xml;base64,'));
  check('toDisplay 透传自定义链接', avatarsLib.toDisplay('https://x/a.png') === 'https://x/a.png');
  check('toDisplay 空值不炸', avatarsLib.toDisplay('') === '' && avatarsLib.toDisplay(null) === '');
  const sa = profileLib.safeAvatar;
  check('预设标识通过且原样写库', sa('preset:01').ok && sa('preset:01').value === 'preset:01');
  check('不存在的预设被拒', !sa('preset:99').ok, sa('preset:99'));
  check('preset: 任意字符串被拒', !sa('preset:evil').ok);
  check('XSS 被拒', !sa('javascript:alert(1)').ok && !sa('https://x/" onerror="x"').ok);
  check('http(s) 与站内路径仍可用', sa('https://x/a.png').ok && sa('/assets/a.png').ok);
  check('SVG / 位图 data URI 可用',
    sa('data:image/svg+xml;base64,PHN2Zy8+').ok && sa('data:image/png;base64,AAAA').ok);
  check('超长值被拒', !sa('https://x/' + 'a'.repeat(5000)).ok);

  console.log('\n库里存短标识、对外展开');
  const app = build();
  await app.ready();
  const uid = insertUser('avatar-unit-1', 'preset:02');
  const pub = profileLib.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(uid));
  check('publicUser.avatar 是 data URI', pub.avatar.startsWith('data:image/svg+xml;base64,'), pub.avatar.slice(0, 40));
  check('publicUser.avatar_preset 回传原值供选择器高亮', pub.avatar_preset === 'preset:02', pub.avatar_preset);
  check('publicUser 不含内部物联凭据', !('tb_username' in pub) && !('tb_password' in pub));
  const urlUid = insertUser('avatar-unit-2', 'https://wx.qlogo.cn/a.png');
  const pubUrl = profileLib.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(urlUid));
  check('自定义链接原样对外、avatar_preset 为空',
    pubUrl.avatar === 'https://wx.qlogo.cn/a.png' && pubUrl.avatar_preset === '');
  const upd = profileLib.updateByUser(uid, { nickname: '改过的名字', avatar: 'preset:05' });
  const raw = db.prepare('SELECT avatar, profile_custom FROM users WHERE id = ?').get(uid);
  check('updateByUser 写库的是短标识而非 data URI', raw.avatar === 'preset:05', raw.avatar);
  check('用户改过后 profile_custom=1', Number(raw.profile_custom) === 1);
  check('updateByUser 返回展开后的头像', upd.user.avatar.startsWith('data:image/svg+xml;base64,'));
  check('非法预设写入被拒', profileLib.updateByUser(uid, { avatar: 'preset:99' }).ok === false);

  console.log('\n微信无头像时自动分配');
  const emptyUid = insertUser('avatar-wx-empty', '');
  const before = db.prepare('SELECT * FROM users WHERE id = ?').get(emptyUid);
  const changed = profileLib.syncFromWechat(before, { nickname: '', avatar: '' });
  const after = db.prepare('SELECT avatar FROM users WHERE id = ?').get(emptyUid);
  check('空头像用户被补上卡通头像', changed && avatarsLib.isPreset(after.avatar), after);
  check('分配结果与 openid 稳定映射一致', after.avatar === avatarsLib.defaultValue(before.openid));
  const again = profileLib.syncFromWechat(db.prepare('SELECT * FROM users WHERE id = ?').get(emptyUid),
    { nickname: '', avatar: '' });
  check('再次登录不会换头像', again === false);
  const wxUid = insertUser('avatar-wx-has', 'https://wx.qlogo.cn/b.png');
  profileLib.syncFromWechat(db.prepare('SELECT * FROM users WHERE id = ?').get(wxUid), { nickname: '', avatar: '' });
  check('已有头像不被清空', db.prepare('SELECT avatar FROM users WHERE id = ?').get(wxUid).avatar === 'https://wx.qlogo.cn/b.png');
  db.prepare('UPDATE users SET profile_custom = 1 WHERE id = ?').run(wxUid);
  profileLib.syncFromWechat(db.prepare('SELECT * FROM users WHERE id = ?').get(wxUid),
    { nickname: '微信新昵称', avatar: 'https://wx.qlogo.cn/c.png' });
  check('用户自定义过后微信重登不覆盖',
    db.prepare('SELECT nickname, avatar FROM users WHERE id = ?').get(wxUid).avatar === 'https://wx.qlogo.cn/b.png');

  console.log('\n扫码登录响应与软件端同步');
  const scene = (await app.inject({ method: 'POST', url: '/api/wechat/qrcode', payload: {} })).json().scene;
  const newOpenid = 'avatar-new-' + Math.random().toString(36).slice(2, 8);
  await app.inject({ method: 'POST', url: `/api/wechat/simulate/${scene}`, payload: { openid: newOpenid, nickname: '新用户' } });
  const qr = (await app.inject({ method: 'GET', url: `/api/wechat/qrcode/${scene}` })).json();
  check('扫码登录响应头像已展开', String(qr.user && qr.user.avatar).startsWith('data:image/svg+xml;base64,'), qr.user && qr.user.avatar);
  check('扫码登录响应带 avatar_preset', avatarsLib.isPreset(qr.user && qr.user.avatar_preset), qr.user && qr.user.avatar_preset);
  check('扫码登录响应不含内部物联凭据',
    !('tb_username' in (qr.user || {})) && !('tb_password' in (qr.user || {})));
  const newRow = db.prepare('SELECT * FROM users WHERE openid = ?').get(newOpenid);
  check('新用户入库的是短标识', avatarsLib.isPreset(newRow.avatar), newRow.avatar);

  const product = db.prepare("SELECT * FROM products WHERE type = 'software' LIMIT 1").get();
  const licKey = 'AVTEST-' + Math.random().toString(36).slice(2, 10).toUpperCase();
  db.prepare(`INSERT INTO licenses (license_key, user_id, product_id, type, max_devices, start_at, end_at, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(licKey, newRow.id, product.id, 'subscription', 2, now(),
      new Date(Date.now() + 30 * 86400000).toISOString(), 'active', now());
  const adminToken = (await app.inject({
    method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'admin123' },
  })).json().token;
  const created = (await app.inject({
    method: 'POST', url: '/api/open-apps', headers: { authorization: 'Bearer ' + adminToken },
    payload: { name: '头像同步测试应用', product_id: product.id, version: '1.0.0' },
  })).json();
  const AK = created.app_key;
  const AS = created.app_secret;
  const actBody = { license_key: licKey, machine_id: 'MAC-AVATAR-01' };
  const act = await app.inject({
    method: 'POST', url: '/api/open/v1/auth/activate',
    ...signReq(AS, AK, 'POST', '/api/open/v1/auth/activate', actBody),
  });
  check('软件端激活成功', act.statusCode === 200 && !!act.json().access_token, act.json());
  const sdkToken = act.json().access_token;
  const prof = (await app.inject({
    method: 'GET', url: '/api/open/v1/user/profile',
    headers: { authorization: 'Bearer ' + sdkToken },
  })).json();
  check('软件端 /user/profile 拿到展开的头像',
    String(prof.user && prof.user.avatar).startsWith('data:image/svg+xml;base64,'), prof.user && prof.user.avatar);
  check('软件端 /user/profile 带 avatar_preset',
    avatarsLib.isPreset(prof.user && prof.user.avatar_preset), prof.user && prof.user.avatar_preset);
  const changedBody = { nickname: '软件端改名', avatar: 'preset:07' };
  const changedRes = await app.inject({
    method: 'POST', url: '/api/open/v1/user/profile',
    headers: { authorization: 'Bearer ' + sdkToken }, payload: changedBody,
  });
  check('软件端改头像成功且返回展开值',
    changedRes.statusCode === 200 && String(changedRes.json().user.avatar).startsWith('data:image/svg+xml;base64,'),
    changedRes.json());
  const me = (await app.inject({
    method: 'GET', url: '/api/portal/me', headers: { authorization: 'Bearer ' + qr.token },
  })).json();
  check('网页端 /api/portal/me 同步到软件端改的头像', me.user && me.user.avatar_preset === 'preset:07', me.user);

  await app.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  if (fail > 0) process.exitCode = 1;
})().catch((e) => { console.error('测试异常：', e); process.exitCode = 1; });

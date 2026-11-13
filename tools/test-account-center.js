/* 账户中心改造自测（2026-11-13）
 * 运行：node tools/test-account-center.js
 *
 * 覆盖：个人 ID（9 位唯一、openid 不外泄）、中性默认头像、用户头像上传安全、
 *       ¥1=100 积分充值下单/发货/返积分隔离/退款回收、新页面 Vue 模板编译。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TMP = path.join(__dirname, '..', 'data', 'test-account-tmp');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.MARKET_DIR = path.join(TMP, 'market');
process.env.MARKET_THUMB_DIR = path.join(TMP, 'thumbs');
process.env.ADMIN_INIT_PASSWORD = 'admin123';
process.env.NODE_ENV = 'test';
process.env.BASE_PATH = 'platform';

const { build } = require('../server');
const db = require('../server/db');
const { now } = require('../server/lib/util');
const { setSetting } = require('../server/lib/config');
const { signUser } = require('../server/lib/auth');
const profileLib = require('../server/lib/profile');
const userid = require('../server/lib/userid');
const avatarsLib = require('../server/lib/avatars');
const AP = require('../public/assets/avatars.js');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); }
  else {
    fail += 1;
    console.log('  \u2717 ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra).slice(0, 320) : ''));
  }
}
const B = '/platform';
const json = (r) => { try { return JSON.parse(r.body); } catch { return { raw: String(r.body).slice(0, 200) }; } };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function multipart(filename, content) {
  const boundary = '----acct' + Date.now() + crypto.randomBytes(3).toString('hex');
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, Buffer.from(content), tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}
function insertUser(openid) {
  const info = db.prepare(`INSERT INTO users
    (openid, nickname, avatar, phone, points, status, tb_username, tb_password, tb_status, created_at, last_login_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(openid, '账户测试', 'preset:00', null, 500, 'active', `${openid}@tb.cn`, openid, 'none', now(), now());
  return Number(info.lastInsertRowid);
}

(async () => {
  console.log('\n[1] 个人 ID：9 位数字、唯一、不公开 openid');
  const ids = [];
  for (let i = 0; i < 120; i += 1) {
    const uid = insertUser(`acct-openid-${i}-xyz`);
    const pub = profileLib.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(uid));
    ids.push(pub.publicId);
  }
  ok('每个用户都拿到 9 位数字个人 ID', ids.every((v) => /^\d{9}$/.test(String(v || ''))), ids.slice(0, 3));
  ok('120 个用户无重号', new Set(ids).size === 120, new Set(ids).size);
  const uid1 = db.prepare('SELECT id FROM users WHERE openid = ?').get('acct-openid-0-xyz').id;
  const pub1 = profileLib.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(uid1));
  ok('同一用户重复查询 ID 不变', pub1.publicId === ids[0], [ids[0], pub1.publicId]);
  ok('对外资料不含 openid', !('openid' in pub1), Object.keys(pub1));
  ok('对外资料不含内部物联凭据', !('tb_username' in pub1) && !('tb_password' in pub1));
  ok('userid.isValid 只认 9 位数字', userid.isValid('123456789') && !userid.isValid('12345678') && !userid.isValid('abc'));
  ok('库里建了 public_id 唯一索引',
    !!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_public_id'").get());
  ok('ID 不是 openid 尾段的明文', !String(ids[0]).includes('xyz') && pub1.publicId !== 'acct-openid-0-xyz');

  console.log('\n[2] 中性默认头像');
  ok('默认头像恒为 preset:00 且中性', AP.defaultValue('a') === 'preset:00'
    && AP.defaultValue('b') === 'preset:00' && !!AP.byValue('preset:00'));
  ok('老预设仍兼容', avatarsLib.isPreset('preset:01') && avatarsLib.isPreset('preset:08'));
  const noAvatar = insertUser('acct-no-avatar');
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run('', noAvatar);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(noAvatar);
  profileLib.syncFromWechat(row, { nickname: '', avatar: '' });
  ok('微信没给头像时补中性默认', db.prepare('SELECT avatar FROM users WHERE id = ?').get(noAvatar).avatar === 'preset:00');
  const wxUid = insertUser('acct-wx-avatar');
  profileLib.syncFromWechat(db.prepare('SELECT * FROM users WHERE id = ?').get(wxUid),
    { nickname: '', avatar: 'https://wx.qlogo.cn/a.png' });
  ok('微信给了头像会覆盖默认', db.prepare('SELECT avatar FROM users WHERE id = ?').get(wxUid).avatar === 'https://wx.qlogo.cn/a.png');

  const app = build();
  await app.ready();
  const UH = { authorization: 'Bearer ' + signUser({ id: uid1, openid: 'acct-openid-0-xyz' }), 'content-type': 'application/json' };
  const adminLogin = json(await app.inject({ method: 'POST', url: `${B}/api/admin/login`, payload: { username: 'admin', password: 'admin123' } }));
  const AH = { authorization: 'Bearer ' + adminLogin.token, 'content-type': 'application/json' };

  const me = json(await app.inject({ method: 'GET', url: `${B}/api/portal/me`, headers: UH }));
  ok('/api/portal/me 下发个人 ID 且不含 openid', /^\d{9}$/.test(String(me.user.publicId)) && !('openid' in me.user), me.user);
  ok('软件端 userPayload 源码已去掉 openid', !/openid: u\.openid/.test(fs.readFileSync(path.join(__dirname, '..', 'server/routes/open.js'), 'utf8')));

  console.log('\n[3] 用户头像上传');
  const upOk = multipart('me.png', PNG);
  const rUp = json(await app.inject({
    method: 'POST', url: `${B}/api/portal/avatar`,
    headers: { authorization: UH.authorization, 'content-type': upOk.contentType, 'x-file-sha256': sha(PNG) },
    payload: upOk.body,
  }));
  ok('合法 PNG 上传成功并返回头像 URL', rUp.ok === true && /^\/platform\/uploads\/mkt-[0-9a-f]{20}\.png$/.test(rUp.user.avatar), rUp);
  ok('上传后置 profile_custom=1（微信不再覆盖）',
    Number(db.prepare('SELECT profile_custom FROM users WHERE id = ?').get(uid1).profile_custom) === 1);
  ok('头像文件确实落盘', fs.existsSync(path.join(TMP, 'thumbs', path.basename(rUp.user.avatar))));
  const badSvg = multipart('evil.png', '<svg onload="alert(1)">');
  const rSvg = json(await app.inject({
    method: 'POST', url: `${B}/api/portal/avatar`,
    headers: { authorization: UH.authorization, 'content-type': badSvg.contentType }, payload: badSvg.body,
  }));
  ok('SVG 改名成 png 被拒', /只支持|图片/.test(rSvg.error || ''), rSvg);
  const wrongExt = multipart('me.gif', PNG);
  const rExt = json(await app.inject({
    method: 'POST', url: `${B}/api/portal/avatar`,
    headers: { authorization: UH.authorization, 'content-type': wrongExt.contentType }, payload: wrongExt.body,
  }));
  ok('扩展名与真实内容不符被拒', /扩展名/.test(rExt.error || ''), rExt);
  const badSha = multipart('me.png', PNG);
  const rSha = json(await app.inject({
    method: 'POST', url: `${B}/api/portal/avatar`,
    headers: { authorization: UH.authorization, 'content-type': badSha.contentType, 'x-file-sha256': sha('WRONG') },
    payload: badSha.body,
  }));
  ok('sha256 不符被拒且不覆盖', /sha256|不一致/.test(rSha.error || '')
    && db.prepare('SELECT avatar FROM users WHERE id = ?').get(uid1).avatar === rUp.user.avatar);
  const noAuth = await app.inject({ method: 'POST', url: `${B}/api/portal/avatar`, headers: { 'content-type': upOk.contentType }, payload: upOk.body });
  ok('未登录上传 401', noAuth.statusCode === 401, noAuth.statusCode);
  const reset = json(await app.inject({
    method: 'POST', url: `${B}/api/portal/profile`, headers: UH,
    payload: { nickname: '账户测试', avatar: 'preset:00' },
  }));
  ok('可恢复中性默认头像', reset.ok === true && reset.user.avatar_preset === 'preset:00', reset.user);

  console.log('\n[4] 积分充值 ¥1 = 100 积分');
  for (const v of [0, -1, 1.5, 1001, 'abc']) {
    const r = json(await app.inject({
      method: 'POST', url: `${B}/api/portal/orders`, headers: UH,
      payload: { kind: 'points_recharge', points_amount: v },
    }));
    ok(`非法金额 ${JSON.stringify(v)} 被拒`, /整数元/.test(r.error || ''), r);
  }
  const r10 = json(await app.inject({
    method: 'POST', url: `${B}/api/portal/orders`, headers: UH,
    payload: { kind: 'points_recharge', points_amount: 10, use_points: 500 },
  }));
  ok('¥10 下单成功、积分 1000', r10.ok !== false && r10.points === 1000 && r10.pay_amount === 10, r10);
  const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(r10.order_no);
  ok('订单 kind=points_recharge 且禁止积分抵扣', order.kind === 'points_recharge' && Number(order.discount) === 0, order.discount);
  ok('下单不扣用户已有积分', db.prepare('SELECT points FROM users WHERE id = ?').get(uid1).points === 500);
  ok('订单 items 带积分数量但不信前端传值',
    JSON.parse(order.items)[0].points === 1000 && /积分充值 1000 积分/.test(JSON.parse(order.items)[0].product_name));

  setSetting('pay_simulate', '1');
  const sim = await app.inject({ method: 'POST', url: `${B}/api/pay/simulate/${r10.order_no}`, headers: UH, payload: {} });
  ok('模拟支付成功', sim.statusCode === 200 && json(sim).status === 'paid', json(sim));
  const afterPay = db.prepare('SELECT * FROM users WHERE id = ?').get(uid1);
  ok('支付后积分 +1000（500 → 1500）', Number(afterPay.points) === 1500, afterPay.points);
  const logs = db.prepare('SELECT * FROM points_logs WHERE user_id = ? ORDER BY id DESC').all(uid1);
  ok('有「积分充值」流水且余额快照正确', logs.some((l) => /积分充值/.test(l.reason) && l.change === 1000 && l.balance === 1500), logs.slice(0, 3));
  ok('充值订单不叠加「消费返积分」', !logs.some((l) => /消费返积分/.test(l.reason)), logs.map((l) => l.reason));
  const delivered = JSON.parse(db.prepare('SELECT deliver_result FROM orders WHERE id = ?').get(order.id).deliver_result);
  ok('发货结果 type=points 且记录数量', delivered[0] && delivered[0].type === 'points' && delivered[0].points === 1000, delivered);

  console.log('\n[5] 退款反向回收');
  const refund = json(await app.inject({
    method: 'POST', url: `${B}/api/orders/${order.id}/refund`, headers: AH, payload: {},
  }));
  ok('退款接口成功', refund.ok === true, refund);
  ok('回收充值积分 1000', Number(refund.recharge_points_back) === 1000, refund);
  ok('余额回到 500', db.prepare('SELECT points FROM users WHERE id = ?').get(uid1).points === 500);
  const refundLogs = db.prepare('SELECT * FROM points_logs WHERE user_id = ? ORDER BY id DESC').all(uid1);
  ok('退款写回收流水（不是「退款收回积分」重复扣）',
    refundLogs.some((l) => /退款收回充值积分/.test(l.reason) && l.change === -1000)
    && !refundLogs.some((l) => /订单 .* 退款收回积分$/.test(l.reason)), refundLogs.slice(0, 4).map((l) => l.reason));

  console.log('\n[6] 展示与前端');
  const adminTrade = fs.readFileSync(path.join(__dirname, '..', 'public/admin/js/pages-trade.js'), 'utf8');
  const userPages = fs.readFileSync(path.join(__dirname, '..', 'public/user/js/pages.js'), 'utf8');
  const accountJs = fs.readFileSync(path.join(__dirname, '..', 'public/user/js/page-account.js'), 'utf8');
  ok('后台订单展示覆盖 points 类型', /c\.type === 'points'/.test(adminTrade));
  ok('用户订单展示覆盖 points 类型', /c\.type === 'points'/.test(userPages));
  // 注释里可以解释「openid 不外泄」，但模板/setup 里不能出现 openid 字段引用
  ok('账户中心不显示 openid、显示个人 ID', !/\.openid\b|openid:/.test(accountJs) && /publicId/.test(accountJs));
  ok('充值档位与汇率写在前端', /¥1 = 100 积分/.test(accountJs) && /tiers = \[10, 30, 50, 100, 200, 500\]/.test(accountJs));
  ok('手机绑定是模态框而非独立卡片', /<teleport to="body">/.test(accountJs) && !/card-head"><h3>绑定手机号/.test(accountJs));

  await app.close();
  console.log(`\n账户中心改造测试：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows WAL 占用不影响结果 */ }
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});

/* 测试辅助：为 /api/portal/phone/code 领一张图形挑战并算出 PoW。
 *
 * 图形码答案只在服务端以 HMAC 留存，正常客户端靠人眼看 SVG 输入。
 * 测试是白盒：读 answer_hmac 后穷举 4 位数字反查答案（与 test-admin-security.js
 * 同一手法），再用前后端共用的 pow.js 解出 nonce。绝不改生产代码来开后门。
 *
 * 用法：
 *   const { passSmsCaptcha } = require('./helpers/sms-challenge');
 *   const extra = await passSmsCaptcha(app, db, headers, basePath);
 *   // extra = { challengeId, answer, powNonce }，展开进 phone/code 的 payload
 */
const adminsec = require('../../server/lib/adminsec');
const pow = require('../../public/assets/pow.js');

async function passSmsCaptcha(app, db, headers, basePath = '') {
  const B = basePath || '';
  const res = await app.inject({ method: 'GET', url: `${B}/api/portal/sms/challenge`, headers });
  if (res.statusCode !== 200) {
    throw new Error(`领挑战失败 ${res.statusCode}: ${res.body}`);
  }
  const c = res.json();
  const row = db.prepare('SELECT answer_hmac FROM admin_challenges WHERE id = ?').get(c.challengeId);
  let answer = '';
  for (let i = 0; i < 10000; i += 1) {
    const s = String(i).padStart(4, '0');
    if (adminsec.hmac(s) === row.answer_hmac) { answer = s; break; }
  }
  if (!answer) throw new Error('无法从 HMAC 反查图形码答案（测试白盒失败）');
  return {
    challengeId: c.challengeId,
    answer,
    powNonce: pow.solve(c.powSeed, c.difficulty),
    // 展开进 payload 时多余字段会被 Fastify 忽略；测试里也可用它断言 svg/有效期
    raw: c,
  };
}

module.exports = { passSmsCaptcha };

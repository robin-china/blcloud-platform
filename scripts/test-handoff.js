#!/usr/bin/env node
/**
 * 「软件端 → 用户中心」免登链接端到端自测。
 *
 * 走一遍真实链路：
 *   应用签名 → 扫码登录（simulate）→ 拿 access_token
 *   → POST /auth/handoff 换一次性链接 → POST /api/portal/handoff 兑换网页登录态
 *   → GET /api/portal/me 验身份
 * 再验四个必须成立的约束：票据只能用一次、无令牌不给发、跳转页白名单、过期即废。
 *
 * 用法：
 *   node scripts/test-handoff.js                       # 连本机 3399（DB_PATH 默认 data/app.db）
 *   BASE=https://www.bliot.cn/platform node scripts/test-handoff.js
 *   APP_KEY=ak_xxx APP_SECRET=sk_xxx node scripts/test-handoff.js
 */
const path = require('path')
const crypto = require('crypto')
const Database = require('better-sqlite3')

const BASE = (process.env.BASE || 'http://127.0.0.1:3399').replace(/\/+$/, '')
const PREFIX = '/api/open/v1'

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass += 1
    console.log('  ✓ ' + name)
  } else {
    fail += 1
    console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : ''))
  }
}

function sign(appKey, appSecret, method, p, bodyObj) {
  const timestamp = String(Date.now())
  const nonce = crypto.randomBytes(6).toString('hex')
  const raw = bodyObj && Object.keys(bodyObj).length ? JSON.stringify(bodyObj) : ''
  const payload = [appKey, method.toUpperCase(), p, timestamp, nonce, raw].join('\n')
  const signature = crypto.createHmac('sha256', appSecret).update(payload).digest('hex')
  const headers = {
    'x-app-key': appKey,
    'x-timestamp': timestamp,
    'x-nonce': nonce,
    'x-signature': signature,
  }
  // 空 body 绝不能带 content-type: application/json —— Fastify 会直接回
  // FST_ERR_CTP_EMPTY_JSON_BODY（400），签名没错也进不去。
  if (raw) headers['content-type'] = 'application/json'
  return { headers, raw }
}

async function call(method, fullPath, bodyObj, token) {
  const { headers, raw } = sign(AK, AS, method, fullPath, bodyObj)
  if (token) headers.authorization = 'Bearer ' + token
  const res = await fetch(BASE + fullPath, { method, headers, body: raw || undefined })
  const text = await res.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }
  return { status: res.status, data }
}

/** 不带应用签名的直连（网页端接口） */
async function plain(method, fullPath, bodyObj, token) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = 'Bearer ' + token
  const res = await fetch(BASE + fullPath, {
    method,
    headers,
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  })
  const text = await res.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }
  return { status: res.status, data }
}

/** 没有传 APP_KEY 时，从本地库里挑一个启用的应用（只用于本机自测） */
function pickLocalApp() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db')
  const db = new Database(dbPath, { readonly: true })
  const row = db
    .prepare("SELECT app_key, app_secret, name FROM open_apps WHERE status = 'active' ORDER BY id DESC LIMIT 1")
    .get()
  db.close()
  if (!row) throw new Error('本地库里没有启用中的应用，请先在后台「开放接口」建一个')
  return { appKey: row.app_key, appSecret: row.app_secret, name: row.name }
}

let AK = process.env.APP_KEY || ''
let AS = process.env.APP_SECRET || ''

async function main() {
  if (!AK || !AS) {
    const a = pickLocalApp()
    AK = a.appKey
    AS = a.appSecret
    console.log(`使用本地应用：${a.name} (${AK})`)
  }
  console.log(`接口基址：${BASE}${PREFIX}\n`)

  // 1) 扫码登录（simulate：本机没接服务号时用它造一个 confirmed 会话）
  const qr = await call('POST', PREFIX + '/auth/qrcode', {})
  ok('创建扫码会话', qr.status === 200 && !!qr.data.scene, qr)
  const scene = qr.data.scene

  const sim = await plain('POST', `/api/wechat/simulate/${scene}`, { openid: 'handoff_test_' + Date.now(), nickname: '免登测试' })
  ok('模拟扫码确认（仅本地/未接服务号可用）', sim.status === 200 && sim.data.ok, sim)

  const poll = await call('GET', `${PREFIX}/auth/qrcode/${scene}?app_key=${AK}&machine_id=TEST-MACHINE-1&machine_name=测试机`, null)
  ok('轮询拿到 confirmed', poll.data.status === 'confirmed', poll.data)
  ok('返回 access_token', !!poll.data.access_token, poll.data)
  ok('返回 refresh_token（保持登录的关键）', !!poll.data.refresh_token, poll.data)
  const accessToken = poll.data.access_token

  // 2) 换一次性链接
  const h1 = await call('POST', PREFIX + '/auth/handoff', { to: 'account' }, accessToken)
  ok('handoff 返回 200', h1.status === 200, h1)
  ok('返回可点开的 url', typeof h1.data.url === 'string' && h1.data.url.includes('/user/?t=ho_'), h1.data)
  ok('指向账户中心', h1.data.url && h1.data.url.endsWith('#/account'), h1.data.url)
  ok('有效期 5 分钟', h1.data.expires_in === 300, h1.data.expires_in)

  const t1 = new URL(h1.data.url).searchParams.get('t')

  // 3) 浏览器侧兑换
  const claim = await plain('POST', '/api/portal/handoff', { t: t1 })
  ok('兑换成功拿到网页令牌', claim.status === 200 && !!claim.data.token, claim)
  const me = await plain('GET', '/api/portal/me', null, claim.data.token)
  ok('用网页令牌能读到自己的资料', me.status === 200 && !!me.data.user, me.data)
  ok('资料里的昵称对得上', me.data.user && me.data.user.nickname === '免登测试', me.data.user)

  // 4) 票据只能用一次
  const again = await plain('POST', '/api/portal/handoff', { t: t1 })
  ok('同一张票据第二次兑换被拒（400）', again.status === 400, again)

  // 5) 后发的票会顶掉先发的（用户连点三次只留最后一个链接有效）
  const h2 = await call('POST', PREFIX + '/auth/handoff', { to: 'licenses' }, accessToken)
  const t2 = new URL(h2.data.url).searchParams.get('t')
  ok('第二张票指向我的授权', h2.data.url.endsWith('#/licenses'), h2.data.url)
  const cl2 = await plain('POST', '/api/portal/handoff', { t: t2 })
  ok('第二张票可兑换', cl2.status === 200 && !!cl2.data.token, cl2)

  // 6) 没有令牌不许发链接
  const noAuth = await call('POST', PREFIX + '/auth/handoff', {}, '')
  ok('未登录（无 access_token）被拒 401', noAuth.status === 401, noAuth)

  // 7) 跳转页白名单：乱填落到 account，不会被当成开放重定向
  const weird = await call('POST', PREFIX + '/auth/handoff', { to: '../../admin' }, accessToken)
  ok('非法 to 被收敛成 account', weird.status === 200 && weird.data.page === 'account', weird.data)

  // 8) 过期票据
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db')
  const h3 = await call('POST', PREFIX + '/auth/handoff', {}, accessToken)
  const t3 = new URL(h3.data.url).searchParams.get('t')
  const db = new Database(dbPath)
  db.prepare('UPDATE handoff_tickets SET expires_at = ? WHERE code = ?').run(new Date(Date.now() - 1000).toISOString(), t3)
  db.close()
  const expired = await plain('POST', '/api/portal/handoff', { t: t3 })
  ok('过期票据被拒 400', expired.status === 400 && expired.data.code === 'HANDOFF_EXPIRED', expired)

  // 9) 乱码 code 直接拒，不去查库
  const junk = await plain('POST', '/api/portal/handoff', { t: 'ho_' + 'x'.repeat(48) })
  ok('格式不对的 code 被拒 400', junk.status === 400, junk)

  console.log(`\n免登链接自测：${pass} 通过，${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('自测异常：', e.message)
  process.exit(1)
})

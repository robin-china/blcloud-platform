# 软件端接入 API 文档

> 面向你自己开发的软件客户端（PC 客户端 / App / 小程序）接入本系统。
> 目标：**用户的登录、授权、激活、机器绑定由本系统统一管理；硬件设备仍走 ThingsBoard（TB），本系统只负责把 TB 凭据安全地下发给客户端。**

- 接口基址：`{你的域名}/api/open/v1`
- 接口前缀：`/api/open/v1/*`
- 管理端入口：后台 → 系统 → **开放接口**（创建应用、拿凭证、看在线客户端）

---

## 1. 三件事先搞清楚

| 概念 | 是什么 | 谁生成 | 用在哪 |
|---|---|---|---|
| `app_key` / `app_secret` | 应用凭证，一个软件产品一对 | 后台「开放接口」页面创建 | 激活、登录等无用户登录态的接口，做 HMAC 签名 |
| `access_token` / `refresh_token` | 客户端登录后的用户令牌 | 激活或登录成功时下发 | 访问用户个人数据（资料、授权、硬件、心跳） |
| `license_key` + `machine_id` | 授权码 + 机器指纹 | 授权码由系统发放；机器码由客户端生成 | 激活软件、限制一台授权能用几台机器 |

**令牌有效期**：`access_token` 2 小时，`refresh_token` 30 天。客户端应在过期前用 `refresh_token` 静默续期。

---

## 2. 快速开始

### 2.1 创建应用

后台 → 开放接口 → 新建应用：

- 应用名称：例如「花盆卫士 PC 客户端」
- 绑定产品：选对应软件产品（选了之后，非该产品的授权码会被拒绝）
- 最新版本号 / 下载地址 / 更新说明：客户端调 `/app/version` 时返回，用于更新提示

保存后**立刻复制 AppSecret**——关闭弹窗后无法再次查看明文，只能重置。

### 2.2 应用级签名（每次无令牌调用都要带）

请求头：

| 头 | 说明 |
|---|---|
| `X-App-Key` | 应用 key |
| `X-Timestamp` | 毫秒时间戳，与服务器相差超过 5 分钟会被拒 |
| `X-Nonce` | **每次请求必须唯一的随机串**，重复使用该 nonce 会被判定为重放并拒绝 |
| `X-Signature` | 签名，见下 |
| `Content-Type` | 固定 `application/json`（有 body 时必填） |

签名内容（用 `\n` 拼接 6 段）：

```
appKey \n METHOD(大写) \n path(含查询串) \n timestamp \n nonce \n bodyRaw
```

`bodyRaw` 是**请求体的原始 JSON 字符串**（紧凑、无空格、无尾换行）；没有 body 时为空串。
算法 `signature = HMAC_SHA256(app_secret, 拼接串)`，取 16 进制小写。

Node 示例：

```js
const crypto = require('crypto');

function sign(appKey, appSecret, method, path, bodyObj) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(6).toString('hex');
  const raw = bodyObj && Object.keys(bodyObj).length ? JSON.stringify(bodyObj) : '';
  const payload = [appKey, method.toUpperCase(), path, timestamp, nonce, raw].join('\n');
  const signature = crypto.createHmac('sha256', appSecret).update(payload).digest('hex');
  return {
    'content-type': 'application/json',
    'x-app-key': appKey,
    'x-timestamp': timestamp,
    'x-nonce': nonce,
    'x-signature': signature,
  };
}

// 调用
const body = { license_key: 'LIC-XXXX', machine_id: 'MAC-ABC', version: '1.2.0' };
const headers = sign(AK, AS, 'POST', '/api/open/v1/auth/activate', body);
const res = await fetch(BASE + '/api/open/v1/auth/activate', {
  method: 'POST', headers, body: JSON.stringify(body),
}).then((r) => r.json());
```

Python 示例：

```python
import hashlib, hmac, json, time, secrets

def sign(app_key, app_secret, method, path, body_obj=None):
    ts = str(int(time.time() * 1000))
    nonce = secrets.token_hex(6)
    raw = json.dumps(body_obj, separators=(',', ':'), ensure_ascii=False) if body_obj else ''
    payload = "\n".join([app_key, method.upper(), path, ts, nonce, raw])
    sig = hmac.new(app_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return {
        'Content-Type': 'application/json',
        'X-App-Key': app_key, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signature': sig,
    }, raw
```

> 注意：
> 1. 签名用的 `path` 必须与实际请求行完全一致：含 `/api/open/v1` 前缀，**带查询参数时要把查询串一起签进去**（例如 `/api/open/v1/user/devices?page=0`）。查询串被篡改会导致签名校验失败。
> 2. `nonce` 每次请求都要重新生成。服务端会记录已使用的 nonce（保留 5 分钟），重复提交同一 nonce 会返回 `401 APP_SIGN_INVALID`，错误为「nonce 已使用，请求重复」。
> 3. `timestamp` 与服务器相差超过 5 分钟即被拒，客户端需保证时钟准确。

---

## 3. 用户级令牌

登录（激活 / 扫码 / 手机号）成功后返回：

```json
{
  "access_token": "ct_xxx",
  "refresh_token": "ct_yyy",
  "expires_in": 7200,
  "refresh_expires_in": 2592000,
  "user": { "id": 1, "nickname": "李雷", "points": 120, "tb_username": "oabc@tb.cn" },
  "license": { "license_key": "LIC-XXX", "product_name": "花盆卫士 Pro", "end_at": "2027-01-01T00:00:00.000Z", "max_devices": 2 }
}
```

调用用户级接口时带：`Authorization: Bearer <access_token>`

---

## 4. 接口清单

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/app/version` | 应用签名 | 版本号、安装包地址、更新说明 |
| POST | `/auth/activate` | 应用签名 | **激活码 + 机器码激活**，返回令牌 |
| POST | `/auth/qrcode` | 应用签名 | 生成微信扫码登录场景 |
| GET | `/auth/qrcode/:scene` | 无（query 带 app_key） | 轮询扫码结果，确认后返回令牌 |
| POST | `/auth/sms/send` | 应用签名 | 发送短信验证码 |
| POST | `/auth/login/phone` | 应用签名 | 手机号验证码登录（新手机号自动建档） |
| POST | `/auth/refresh` | 无 | 用 refresh_token 换新令牌 |
| POST | `/auth/logout` | 用户令牌 | 退出，令牌作废 |
| GET | `/user/profile` | 用户令牌 | 用户资料、积分、TB 账号 |
| GET | `/user/licenses` | 用户令牌 | 我的全部授权及绑定机器数 |
| GET | `/user/devices` | 用户令牌 | **我的硬件 + TB 连接凭据** |
| POST | `/license/verify` | 令牌 或 应用签名 | 校验授权是否有效 |
| POST | `/license/heartbeat` | 用户令牌 | 心跳，刷新在线状态与版本 |
| POST | `/license/unbind` | 用户令牌 | 解绑某台机器，释放名额 |
| POST | `/telemetry` | 用户令牌 | 上报使用数据（可选） |

---

## 5. 接口详解

### 5.1 激活（最核心）

`POST /auth/activate`

请求：

```json
{
  "license_key": "LIC-2026-XXXX-XXXX",
  "machine_id": "A1B2C3D4E5F6",
  "machine_name": "李雷的笔记本",
  "version": "1.2.0"
}
```

成功响应：

```json
{
  "valid": true,
  "access_token": "ct_xxx", "refresh_token": "ct_yyy",
  "expires_in": 7200, "refresh_expires_in": 2592000,
  "user": { "id": 12, "nickname": "李雷", "phone": "138****8888", "points": 320 },
  "license": {
    "license_key": "LIC-2026-XXXX-XXXX",
    "product_id": 3, "product_name": "花盆卫士 Pro",
    "type": "subscription", "end_at": "2027-01-01T00:00:00.000Z",
    "max_devices": 2, "bound_devices": 1
  },
  "server_time": "2026-10-21T06:00:00.000Z"
}
```

行为要点：

- 同一台机器重复激活**不会**重复占用名额（幂等）
- 绑定机器数达到 `max_devices` 时返回 `409 MACHINE_LIMIT`
- 授权被吊销 / 过期 / 产品不匹配时返回 403，见错误码表

**机器码怎么生成**：建议取稳定硬件指纹（主板序列号 + CPU ID + 主硬盘序列号 + 首个网卡 MAC）做一次 SHA-256，取前 16~32 位。不要包含会变的信息（IP、系统时间、临时目录）。生成后本地持久化，重装系统时才重新生成。

### 5.2 授权校验

`POST /license/verify`

两种方式二选一：

1. 带 `Authorization: Bearer <access_token>`（推荐，body 可空，可选传 `machine_id`）
2. 应用签名 + body 传 `license_key` 与 `machine_id`

响应：

```json
{
  "valid": true,
  "license": { "license_key": "...", "end_at": "...", "max_devices": 2, "bound_devices": 1 },
  "user": { "id": 12, "nickname": "李雷" },
  "machine": { "machine_id": "A1B2C3D4", "bound_at": "2026-10-01T..." },
  "server_time": "..."
}
```

若该机器码未绑定此授权，返回 `403 MACHINE_NOT_BOUND`。

### 5.3 心跳

`POST /license/heartbeat`，body `{ "version": "1.2.0" }`

建议每 5~10 分钟一次。服务端会更新最后活跃时间、客户端版本，并返回授权最新状态——**这是后台吊销/过期能否及时生效的关键**。

### 5.4 我的硬件与 TB 凭据

`GET /user/devices`

```json
{
  "tb": {
    "url": "https://tb.example.com",
    "enabled": true,
    "username": "oabc@tb.cn",
    "password": "oabc",
    "status": "active"
  },
  "list": [
    {
      "id": 8, "sn": "SN20260001", "name": "客厅花盆",
      "product_name": "花盆卫士",
      "status": "online",
      "tb_device_id": "9f2c...",
      "tb_token": "DEVICE_TOKEN_XXX",
      "last_seen_at": "2026-10-21T05:00:00.000Z"
    }
  ]
}
```

客户端拿到 `tb_token` 后**直连 TB**，不再经过本系统：

```
MQTT 地址：tcp://<tb.url 的域名>:1883（或 8883 走 TLS）
用户名：设备的 tb_token（密码留空）
订阅：v1/devices/me/rpc/request/+      ← 接收下行指令
订阅：v1/devices/me/attributes        ← 接收属性更新
发布：v1/devices/me/telemetry         ← 上报遥测
```

若软件需要 RBAC / 多设备汇总（而不是单设备直连），用 `tb.username` + `tb.password` 登录 TB REST API 即可（登录接口 `/api/auth/login`）。

### 5.5 扫码登录

1. `POST /auth/qrcode` → `{ scene, qrcode_url, url, mode, expires_at }`
   - `mode: "wechat"` 时把 `qrcode_url` 渲染成二维码给用户扫
   - `mode: "simulate"` 表示服务号未配置，仅本地联调可用
2. 客户端每 2 秒轮询 `GET /auth/qrcode/{scene}?app_key={AK}&machine_id={MAC}`（可加 `version`、`machine_name`）
3. 用户扫码确认后返回 `{ status: "confirmed", access_token, refresh_token, user }`
4. `status` 还可能为 `pending` / `expired`

### 5.6 手机号登录

1. `POST /auth/sms/send` body `{ "phone": "13800138000" }` → 返回 `{ ok: true }`（未接短信网关时响应里还有 `dev_code`，联调可直接用）
2. `POST /auth/login/phone` body `{ "phone": "...", "code": "123456", "machine_id": "..." }`

新手机号会**自动建档**，并按规则生成 TB 账户（`p_13800138000@tb.cn`，密码 `p_13800138000`）。

### 5.7 刷新令牌

`POST /auth/refresh`，body `{ "refresh_token": "ct_yyy" }` → 返回新的一对令牌，旧令牌立即失效。

---

## 6. 错误码

统一响应格式：`{ "error": "中文提示", "code": "错误码" }`；授权类还有 `{ "valid": false, "reason": "...", "code": "..." }`。

| HTTP | code | 含义 | 客户端建议 |
|---|---|---|---|
| 400 | `PARAM_MISSING` / `PARAM_INVALID` | 参数缺失或格式错 | 检查参数 |
| 401 | `APP_SIGN_INVALID` | 签名错/时间戳超窗 | 校准本机时间，重算签名 |
| 401 | `APP_DISABLED` | 应用被停用 | 提示联系客服 |
| 401 | `UNAUTHORIZED` | 令牌过期或无效 | 用 refresh_token 续期，失败则重新登录 |
| 401 | `REFRESH_INVALID` / `REFRESH_EXPIRED` | 刷新令牌无效/过期 | 强制重新登录或重新激活 |
| 403 | `LICENSE_NOT_FOUND` | 授权码不存在 | 提示激活码错误 |
| 403 | `LICENSE_REVOKED` | 授权被吊销 | 提示联系客服 |
| 403 | `LICENSE_INACTIVE` | 授权未激活 | 同上 |
| 403 | `LICENSE_EXPIRED` | 授权过期 | 引导续费 |
| 403 | `PRODUCT_MISMATCH` | 授权与当前应用不匹配 | 提示用错软件 |
| 403 | `MACHINE_NOT_BOUND` | 机器未绑定该授权 | 重新激活 |
| 403 | `FORBIDDEN` | 越权操作 | — |
| 404 | `USER_NOT_FOUND` / `SCENE_NOT_FOUND` | 资源不存在 | — |
| 409 | `MACHINE_LIMIT` | 超出机器数上限 | 提示先解绑旧机器 |

---

## 7. 推荐的客户端接入流程

```
首次启动
  ├─ 本地有令牌？ ── 有 → 调 /license/verify ── 有效 → 进入主界面
  │                                        └─ 无效 → 到激活页
  └─ 无 → 显示激活页（输入 license_key）
        └─ 生成 machine_id → POST /auth/activate → 持久化令牌与授权信息
                                                  （失败按错误码提示）

运行中
  ├─ 每 5~10 分钟 POST /license/heartbeat
  ├─ access_token 剩余 < 5 分钟 → POST /auth/refresh
  └─ 心跳返回 valid=false → 弹窗提示并锁定功能

退出 / 换机器
  └─ POST /license/unbind { machine_id }  释放名额
```

**离线可用策略**（可选）：把 `end_at` 和上次成功校验的时间存本地，在后台配置的「离线宽限天数」内允许离线使用；超过宽限必须联网校验一次。这样断网用户不会被立刻踢掉，也堵不住长期白嫖。

---

## 8. 最小可用客户端示例（Node）

```js
const crypto = require('crypto');
const BASE = 'http://localhost:3000';
const AK = 'ak_xxx';
const AS = 'sk_xxx';
const LICENSE = 'LIC-2026-XXXX-XXXX';
const MACHINE = 'A1B2C3D4E5F6';

function signedHeaders(method, path, bodyObj) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(6).toString('hex');
  const raw = bodyObj && Object.keys(bodyObj).length ? JSON.stringify(bodyObj) : '';
  const sig = crypto.createHmac('sha256', AS)
    .update([AK, method.toUpperCase(), path, timestamp, nonce, raw].join('\n'))
    .digest('hex');
  const h = { 'x-app-key': AK, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-signature': sig };
  if (raw) h['content-type'] = 'application/json';
  return { headers: h, raw };
}

async function call(method, path, bodyObj, token) {
  const { headers, raw } = signedHeaders(method, path, bodyObj);
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: raw || undefined });
  return res.json();
}

(async () => {
  // 1. 激活
  const act = await call('POST', '/api/open/v1/auth/activate',
    { license_key: LICENSE, machine_id: MACHINE, machine_name: '测试机', version: '1.0.0' });
  const token = act.access_token;
  console.log('激活:', act.valid, act.license?.product_name, '到期', act.license?.end_at);

  // 2. 校验
  const verify = await call('POST', '/api/open/v1/license/verify', {}, token);
  console.log('校验:', verify.valid);

  // 3. 拉硬件与 TB 凭据
  const dev = await call('GET', '/api/open/v1/user/devices', null, token);
  console.log('TB:', dev.tb.username, '设备数', dev.list.length);
  const d = dev.list[0];
  if (d) console.log('MQTT 用户名即设备 token:', d.tb_token);

  // 4. 心跳
  const hb = await call('POST', '/api/open/v1/license/heartbeat', { version: '1.0.0' }, token);
  console.log('心跳:', hb.valid, '令牌过期', hb.expires_at);

  // 5. 续期
  const rf = await call('POST', '/api/open/v1/auth/refresh', { refresh_token: act.refresh_token });
  console.log('续期:', !!rf.access_token);
})();
```

---

## 9. 后台对应能力

后台 → 开放接口 页面可以：

- 创建/编辑应用，绑定产品，设置版本号与安装包地址（客户端 `/app/version` 直接读到）
- 重置 AppSecret（会使该应用下所有客户端令牌立即失效）
- 停用应用（客户端全部被挡在门外）
- 查看客户端会话：用户、机器码、客户端版本、IP、最后活跃时间，并可**单台踢下线**
- 顶部看板：应用数、在线客户端数、今日 API 调用、已激活机器数

授权侧（授权管理页面）可以吊销/延期/查看某授权绑了哪些机器。客户端下一次心跳或校验就会立刻感知。

---

## 10. 联调自测

```bash
node tools/test-open.js
```

会走完整链路：创建应用 → 签名校验 → 激活 → 重复激活 → 超出机器数 → 取资料/授权/硬件 → 校验 → 心跳 → 刷新令牌 → 手机号登录 → 扫码登录 → 解绑 → 吊销后失效，共 28 项断言。

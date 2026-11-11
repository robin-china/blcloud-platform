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

### 2.2.1 公开模式（新客户端：不内置共享密钥）

2026-11-11 起，`/api/open/v1/*` 同时接受三种身份，客户端按自己的能力选一种：

| 模式 | 请求头 | 用途 |
|---|---|---|
| 公开模式 | `X-App-Key`（写请求再加 `X-Nonce`） | 新客户端登录前调用（激活 / 扫码 / 短信 / 清单） |
| HMAC 签名 | `X-App-Key` + `X-Timestamp` + `X-Nonce` + `X-Signature` | 旧客户端，双模期保留 |
| 用户令牌 | `Authorization: Bearer <access_token>` | 登录后调个人数据 |

公开模式的边界不是「没有鉴权」，而是**不再把共享密钥发到客户端**：

- 频控：每 IP 300 次/分钟、每 app+IP 120 次/分钟，超了回 `429 RATE_LIMITED`
- 写请求必须带 `X-Nonce`（一次性），缺了回 `401 NONCE_REQUIRED`；重放回 `NONCE_REUSED`
- 每次请求记 `auth_mode`（`public` / `hmac` / `hmac_legacy` / `token`），后台「开放应用」页可看报表

**密钥轮换（后台操作）**：先「轮换密钥」→ 新值生效、旧值进 `app_secret_prev` 继续放行 →
看 `hmac_legacy` 连续归零 → 「关旧密钥」。关闭后旧值请求统一
`401 APP_SECRET_RETIRED`（客户端能分辨「该升级」而不是「密钥写错了」）。
日常不要用「重置密钥」（硬重置会立即作废旧值并踢掉全部会话）。

### 2.2.2 旧 HMAC 通道关停时间表（2026-11-11 书面确认）

**签名口径确认**：`path` 是**原始请求行**（`req.url`），含 `/api/open/v1` 前缀，
**带查询串时必须把查询串一起签**（`/api/open/v1/app/version?product=LabelGo` 整串入签）。
实测：签名只算 pathname → `401 APP_SIGN_INVALID`；含查询串 → 200。这是预期行为，不会改。

关停分四步，每一步都可回滚。**时间基准是「首个正式发售版本」的发布日 T0**，
不是内部测试包（1.0.52 / 1.0.53 仍内置明文 `appSecret`、未对外分发，不参与统计）：

| 阶段 | 动作 | 通过条件 | 服务端表现 |
|---|---|---|---|
| S0 现在 | 双模：`hmac` + `hmac_legacy` + `public` + `token` 全放行 | — | 旧客户端 0 报错 |
| S1 = **T0** | 随首个正式发售包一次性落地 C 批：去 `appSecret` + 清单强制验签 + 双产物隔离 | 发售包通过验收、且是唯一对外可分发的包 | 后台 `auth_mode` 开始只应出现 `public` / `token` |
| S2 = **T0 + 7d** | 后台「关旧密钥」（`legacy_hmac=0`） | 发售日起 `hmac_legacy` 连续 7 天为 0 | 旧值请求回 `401 APP_SECRET_RETIRED`（可随时重新打开） |
| S3 = **S2 + 30d** | 代码层移除 `hmac_legacy` 分支 | 期间无回滚 | 只剩 `token` / `public` / 新密钥 HMAC |

为什么不再用「新版覆盖 ≥95%」：发售前外部用户为 0，覆盖率没有分母，
任何百分比都不成立。S1 的判据只能是「发售包本身」，而不是装机量。
`hmac_legacy` 的 7 天观察期实际只覆盖**内部测试机 / 未升级的自有设备**——
外部客户从第一天起就在发售包上，本来就不会走旧通道。

建议在 T0 之前**做一次密钥轮换**（后台「轮换密钥」，不是「重置密钥」）：
测试包里的那个明文值从此只剩 `app_secret_prev` 一个身份，S2 关掉它即彻底失效；
若不做轮换，测试包用过的值会一直以「当前密钥」身份存在，等于把测试期泄露面留到线上。
轮换时 `legacy_hmac` 会自动置 1（旧值继续放行），所以「T0 轮换 → T0+7d 关闭」这个窗口是自然成立的；
「重置密钥」是硬重置：清空旧值 + 踢掉全部会话，双模期不要用。

S2 之前**不要**让客户端删 `appSecret`——`APP_SECRET_RETIRED` 是给「已停用旧密钥」用的信号，
客户端要能按这个码识别「该升级」，而不是把「密钥配错」和「该升级」混成一个 401。
发售包按契约本就不带密钥，这条只约束内部测试包的清理节奏。


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
| GET | `/app/version` | 应用签名 | 版本号、安装包地址、更新说明、**离线宽限天数** |
| GET | `/app/pubkey` | 应用签名 | 离线票据验签公钥（排障用，客户端应内置公钥） |
| POST | `/auth/activate` | 应用签名 | **激活码 + 机器码激活**，返回令牌 |
| POST | `/auth/qrcode` | 应用签名 | 生成微信扫码登录场景 |
| GET | `/auth/qrcode/:scene` | 无（query 带 app_key） | 轮询扫码结果，确认后返回令牌 |
| POST | `/auth/handoff` | 用户令牌 | **免登跳转用户中心**：发一张 5 分钟一次性链接 |
| POST | `/auth/sms/send` | 应用签名 | 发送短信验证码 |
| POST | `/auth/login/phone` | 应用签名 | 手机号验证码登录（新手机号自动建档） |
| POST | `/auth/refresh` | 无 | 用 refresh_token 换新令牌 |
| POST | `/auth/logout` | 用户令牌 | 退出，令牌作废 |
| GET | `/user/profile` | 用户令牌 | 用户资料（昵称、头像、积分、TB 状态），实时读库 |
| POST | `/user/profile` | 用户令牌 | **修改昵称 / 头像**，与网页端共用校验 |
| GET | `/user/licenses` | 用户令牌 | 我的全部授权及绑定机器数；`?app_key=` 过滤本产品并标出 `effective` |
| GET | `/user/devices` | 用户令牌 | **我的硬件 + TB 连接凭据** |
| POST | `/license/verify` | 令牌 或 应用签名 | 校验授权是否有效 |
| POST | `/license/heartbeat` | 用户令牌 | 心跳，刷新在线状态与版本 |
| POST | `/license/unbind` | 用户令牌 | 解绑某台机器，释放名额 |
| POST | `/license/bind` | 用户令牌 | **绑定卡密**（渠道印的未分配码） |
| POST | `/license/ticket` | 用户令牌 | **离线票据**（Ed25519 签名，断网自证） |
| POST | `/telemetry` | 用户令牌 | 上报使用数据（可选） |

---

## 5. 接口详解

### 应用信息

`GET /app/version`（应用签名）

```json
{
  "id": 3,
  "app_key": "ak_xxxxxxxxxxxx",
  "name": "标签打印 PC 客户端",
  "version": "1.2.0",
  "download_url": "https://cdn.example.com/app-1.2.0.exe",
  "release_note": "修复了断网后无法保存的问题",
  "offline_days": 7,
  "plan_catalog": [
    { "app_id": 3, "product_id": 7, "code": "free", "name": "在线免费版", "tier": 0,
      "billing": "free", "price": 0, "period_days": 0, "offline_days": 0,
      "max_devices": 1, "seats": 1, "features": ["labelgo.basic"],
      "limits": { "labelgo.library": 30 } }
  ],
  "force_update": false,
  "server_time": "2026-11-02T06:00:00.000Z"
}
```

`id` / `app_key`：**客户端只有 app_key，而 `/user/licenses` 可能返回全产品列表**；用响应里的 `id` 与每张授权的 `license.app_id`（或过滤参数配合 `effective` 标记）对上，才能判断哪张码属于本产品。

`offline_days` 是后台「开放接口 → 编辑应用 → 离线宽限（天）」配的值，**客户端要按它实现断网策略**：

- `0` = 必须联网校验，断网即锁功能
- `> 0` = 允许离线使用这么多天，超期必须联网校验一次

`plan_catalog` **只包含本应用自己那一套档位**（每个软件产品的档位各自独立，`app_id` 标明归属），仅用于展示可购买档位；真正的权益判定必须以离线票据签名里的字段为准。产品还没配套餐时会回退到通用模板档位，此时 `app_id` 为 `null`，授权码本身仍受 `licenses.app_id` 约束，不会因此跨产品通用。

> 服务端不代管离线状态，它只负责把这个数字准确地告诉你。

### 三类验签公钥（构建期内嵌，运行时不要拉）

`GET /app/keys` → `{ manifest, entitlement, offline }`，每项含 `alg` / `kid` / `public_key` / `created_at`。
仅用于构建期比对与排障；客户端必须把公钥**内置**并固定（pinning），否则等于让中间人决定验签结果。

### 更新清单（同一路径的第二种用法）

带 `product` 参数时，`GET /app/version` 变成**公开的更新清单接口**（不鉴权、不签名），返回 `latest / full / delta / mandatory`，供桌面端每次启动轮询：

```
GET /api/open/v1/app/version?product=LabelGo&version=1.0.20&platform=win32&arch=x64&channel=stable&machine=BLBT-XXXX
```

两种用法互不干扰：**不带 `product` 时仍按应用签名走上面那套**（老客户端不受影响）。

完整契约、静态目录、发布与灰度流程见 **[客户端更新包接入.md](./客户端更新包接入.md)**。

### 5.1 激活（最核心）

`POST /auth/activate`

请求：

```json
{
  "license_key": "LIC-XXXXXXXX-XXXXXXXX-XXXXXXXX",
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
  "user": { "id": 12, "nickname": "李雷",
    "avatar": "data:image/svg+xml;base64,PHN2Zy8+...", "avatar_preset": "preset:01",
    "phone": "138****8888", "points": 320 },
  "license": {
    "license_key": "LIC-XXXXXXXX-XXXXXXXX-XXXXXXXX",
    "app_id": 3, "product_id": 3, "product_name": "花盆卫士 Pro",
    "type": "subscription", "end_at": "2027-01-01T00:00:00.000Z",
    "max_devices": 2, "bound_devices": 1,
    "plan": "member",
    "entitlement": { "plan_code": "member", "plan_name": "在线会员版", "tier": 10,
      "features": ["labelgo.basic", "labelgo.library"], "limits": { "labelgo.library": 30 },
      "seats": 1, "offline_days": 3, "online_required": 1, "app_id": 3 },
    "entitlement_version": "a1b2c3d4e5f6",
    "downgraded_from": "", "downgraded_at": ""
  },
  "server_time": "2026-10-21T06:00:00.000Z"
}
```

行为要点：

- 同一台机器重复激活**不会**重复占用名额（幂等）
- 绑定机器数达到 `max_devices` 时返回 `409 MACHINE_LIMIT`
- 授权被吊销 / 过期 / 产品不匹配时返回 403，见错误码表
- **套餐授权按软件产品隔离**：`license.app_id` 和档位的 `app_id` 必须等于当前应用，否则返回 `403 PRODUCT_MISMATCH` —— A 软件的码不能在 B 软件里激活。`app_id` 为空的历史通用码继续放行，不锁死老客户
- **功能判定走能力码 token，不要解析档位名或比较 tier**：`entitlement.features.includes('labelgo.concat')`。`plan_name`/`tier` 只用于展示与排序。后台加档、改名、调价，客户端不用发版
- `entitlement.limits` 是数量配额（`{ "labelgo.library": 30 }`）：features 只能表达「有/没有」，「标签库 30 个 / Excel 100 行」这类量化上限看这里
- `entitlement_version` 是权益内容哈希（12 位）：心跳带上它即可增量感知权益变化，不用整包 diff
- `downgraded_from` 非空 = 这张授权的订阅已到期、被服务端降到免费档（原档位 code 见该字段）。**客户端要明说「订阅到期已降级为免费版」**，不要静默切到免费版让用户以为功能丢了
- **订阅到期会在服务端明确降级**：过期瞬间（verify / heartbeat / 列表读取时）授权落到该应用 free 档，原授权码与已绑机器全部保留，续费后原地升回
- `user.nickname` / `user.avatar` 默认来自微信资料，用户在网页端「账户中心」改过之后这里实时返回最新值（软件端可用 `POST /user/profile` 改，与网页端共用校验）
- `user.avatar` 是**可直接渲染的图片地址**：微信头像是 URL，内置卡通头像已展开成 `data:image/svg+xml;base64,...`。客户端拿去直接 `<img src>` 即可，**离线也能显示**，不要自己再处理 `avatar_preset`——它只是回传的预设编号，供网页端选择器高亮用
- **卡密还没被绑定**（渠道印的卡、用户还没领）返回 `403 LICENSE_UNASSIGNED`，此时应引导用户先登录绑定，而不是重新激活

> 卡密池的码在**绑定那一刻**才起算有效期。一张印了半年的卡不会被白白扣掉半年，所以「先绑后激活」是正常流程。

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
  "user": { "id": 12, "nickname": "李雷", "avatar": "data:image/svg+xml;base64,..." },
  "machine": { "machine_id": "A1B2C3D4", "bound_at": "2026-10-01T..." },
  "server_time": "..."
}
```

若该机器码未绑定此授权，返回 `403 MACHINE_NOT_BOUND`。

> 订阅过期的授权在 verify 前会被服务端降到该应用的 free 档：返回 `valid: true` + `license.downgraded_from`（原档位 code）。客户端据此提示「订阅到期已降级为免费版」，别把它当成静默的权限缩小。无档位的历史授权过期仍返回 `LICENSE_EXPIRED`。

### 5.2.1 我的授权列表

`GET /user/licenses?app_key={AK}`（用户令牌）：只返回**该软件产品下可用**的授权，按 tier 高 → 有效期晚 → id 大排序，并标出哪张当前生效：

```json
{
  "app": { "id": 3, "app_key": "ak_xxx", "name": "标签打印 PC 客户端" },
  "list": [
    { "license_key": "LIC-…", "plan": "member", "effective": true, "valid": true,
      "entitlement": { "...": "…" }, "entitlement_version": "…", "downgraded_from": "" },
    { "license_key": "LIC-…", "plan": "free", "effective": false, "valid": true }
  ]
}
```

**客户端应使用 `effective: true` 的那张**。不带 `app_key` 则返回全产品列表（兼容老客户端，此时没有 `effective` 字段）。

### 5.3 心跳

`POST /license/heartbeat`，body `{ "version": "1.2.0", "entitlement_version": "a1b2c3d4e5f6" }`

建议每 5~10 分钟一次。服务端会更新最后活跃时间、客户端版本，并返回授权最新状态——**这是后台吊销/过期能否及时生效的关键**。

响应额外带权益版本比对结果：

```json
{
  "valid": true,
  "license": { "...": "完整 license payload（含 entitlement / downgraded_from）" },
  "entitlement_version": "b2c3d4e5f6a7",
  "entitlement_changed": true,
  "expires_at": "…", "server_time": "…"
}
```

- 带 `entitlement_version`（上次拿到的值）时返回 `entitlement_changed: true|false`；不带时为 `null`（老客户端不受影响）
- `true` = 升级 / 降级 / 后台改了配置，**必须重新解析 `license.entitlement` 并刷新功能开关**；`downgraded_from` 非空时向用户明示「订阅到期已降级」
- 没实现版本比对的客户端：每次心跳都整体解析 `license.entitlement` 也行，字段集是稳定的

三种失败要分开处理：

| HTTP | code | 含义 | 客户端动作 |
|---|---|---|---|
| 401 | `SESSION_REVOKED` | 这台机器已被解绑，或授权被吊销 | 回激活页，提示「设备已解绑/授权已失效」 |
| 401 | `UNAUTHORIZED` | 令牌过期 | 先 refresh，失败再回登录页 |
| 200 | `valid: false` + `LICENSE_EXPIRED` 等 | 授权本身失效 | 弹窗提示并锁定功能 |

> 解绑是**即时生效**的：后台或用户端一解绑，这台机器手上的旧令牌下次请求就会被拒，不用等令牌自然过期。

### 5.3.1 删码 / 降档响应契约 v2（LabelGo，2026-11-09）

> **v1 第 3 条已废弃**：`valid:true + license:null` **不再**表示「明确无授权」。
> 客户端按 v2 判定：`license: null` / `{}` / 字段整个省略 = **后台没给结论**，
> 沿用旧权益快照、**不降档**；只有同时带 `license_revoked: true` 时，null 才是明确撤回。
> v1 写法曾导致「一次正常刷新把在线授权全清成免费版」，且后台不下发完整 license
> 就再也同步不回来。

**服务端给结论只有两种方式**（`verify` 与 `heartbeat` 一致）：

| 场景 | HTTP | 响应体 | 客户端动作 |
|---|---|---|---|
| 授权被删 / 吊销 / 停用 / 到期 / 账号无授权 | **200** | `valid:false` + `reason` 标准码 + `license:null` + **`license_revoked:true`** + `entitlement_changed:true` | 立即清快照 → 免费版、标签库回 5 个 |
| 授权仍在但降到免费档 | 200 | `valid:true` + **完整 license**（含 `entitlement`） | 解析新 entitlement |
| 有授权且未变档 | 200 | `valid:true` + 完整 license，`entitlement_version` 稳定 | 连点刷新不掉档 |
| 令牌过期 / 签名错 / appKey 权限 | 401 | 纯错误体（`error` + `code`），**不带** `valid` / `license` 字段 | 不降档，保留快照走 7 天离线宽限 |
| 断网 / 部署故障 | 5xx（或 404 / 405 / 408 / 429） | 纯错误体 | 不降档，走离线宽限 |

> 也允许 `403` + 明确授权级 `code`，但 v2 推荐统一 200 —— 403 在部分客户端里容易和
> 「部署故障」分支混淆。**服务端故障绝不能用 403**，会把全网付费客户降成免费版。

`reason` 用契约标准短码（客户端按白名单判断），`code` 保留内部完整码供诊断与老客户端，
中文文案在 `message` / `reason_text`：

| reason | code | 触发 |
|---|---|---|
| `LICENSE_NOT_FOUND` | `LICENSE_NOT_FOUND` | 会话绑定的码被后台删除 |
| `REVOKED` | `LICENSE_REVOKED` | 授权被吊销 |
| `EXPIRED` | `LICENSE_EXPIRED` | 到期且无免费档可降级 |
| `INACTIVE` | `LICENSE_INACTIVE` | 停用 |
| `NO_LICENSE` | `NO_LICENSE` / `LICENSE_UNASSIGNED` / `PRODUCT_MISMATCH` | 账号无可用授权 / 码未绑定 / 产品不匹配 |
| `MACHINE_NOT_BOUND` | `MACHINE_NOT_BOUND` / `SESSION_REVOKED` / `MACHINE_LIMIT` | 机器未绑定、被解绑、机器超限 |

删码 / 无授权的响应体：

```json
{
  "valid": false,
  "license": null,
  "license_revoked": true,
  "reason": "LICENSE_NOT_FOUND",
  "code": "LICENSE_NOT_FOUND",
  "message": "授权不存在",
  "reason_text": "授权不存在",
  "entitlement": null,
  "entitlement_version": "",
  "entitlement_changed": true,
  "server_time": "..."
}
```

**硬边界**：删码时不能只回 `valid:true` + 省略 `license` 字段，也不能回
`valid:true + license:null` 而不带 `license_revoked` —— 客户端一律当「老后台没下发」，
沿用旧快照，删了码降不下来。服务端已删除 v1 的 `noLicense()` 辅助函数，
「账号一张授权都没有」现在也回 `valid:false + NO_LICENSE`。

降档 / 免费档一定下发完整权益，**不能只给 `license_key`**（客户端会回退显示
「在线授权」，档位歧义）：

```json
{
  "valid": true,
  "license": {
    "license_key": "LIC-…",
    "downgraded_from": "member",
    "entitlement": {
      "plan_code": "free",
      "plan_name": "免费版",
      "plan_display_name": "在线免费版",
      "billing": "free",
      "is_free": true,
      "features": ["labelgo.basic"],
      "limits": { "labelgo.library": 5 }
    },
    "entitlement_version": "a1b2c3d4e5f6"
  },
  "entitlement": { "...": "同上，冗余一份便于客户端直读" },
  "entitlement_version": "a1b2c3d4e5f6"
}
```

- `plan_name` 对 `billing=free` 的档位**固定为「免费版」**（后台自定义名放 `plan_display_name`），
  功能判定仍应走 `entitlement.features` 的能力码，不要解析档位名或比较 tier。
- 心跳额外带 `entitlement_version` / `entitlement_changed`：客户端上报上次版本即可增量感知，
  不上报也没关系，5 分钟一拍的心跳会整体解析 `license.entitlement`。
- 401 / 5xx 响应体里**不得出现** `valid:false`，否则客户端可能一边按状态码保留快照、
  一边按 body 清快照。解绑 / 吊销属于授权级撤销，心跳**不走** `requireClient` 的 401，
  而是回 200 + `MACHINE_NOT_BOUND` 明确结论（否则「不点刷新等一拍心跳」永远降不下来）；
  只有真正的令牌过期 / 签名失败才回 401。
- 续费 / 重新激活是同一个授权码原地升回：`plan_code`、`features`、`limits` 全部回到付费档，
  `downgraded_from` 清空；客户端本地模板与数据源不受影响，无需重新初始化。
- 登录类响应（扫码确认 / 手机号登录 / refresh）有授权时下发完整 license；无授权给 `null`
  表示「本接口不下发结论」，随后 verify / heartbeat 会给出明确判定，**不要**在这里加
  `license_revoked` —— 机器超限时账号其实还有授权，会误降付费客户。

**验收**：① 有授权连点 3 次「刷新授权」档位不掉 ② 删码后点刷新立即免费版、
不点刷新等一拍心跳也自动降 ③ 续费 / 重新激活原地升回，模板与数据源不丢。
服务端自测见 `tools/test-license-verdict.js`（81 项）；运行后末尾会打印可直接回传的
verify / heartbeat 响应 body（刷新前、删码后、账号无授权、401、免费档、续费恢复）。
客户端日志中心「手动同步授权」会打印 valid / license 形状 / plan / caps，便于逐项对齐。

### 5.4 我的硬件与 TB 凭据

`GET /user/devices`

```json
{
  "tb": {
    "url": "https://tb.example.com",
    "enabled": true,
    "status": "active",
    "note": "设备直连使用每台设备的 tb_token（MQTT 用户名）；账户级访问请使用 blcloud API 密钥"
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

### 5.5 绑定卡密（未分配的码）

`POST /license/bind`，需要 `Authorization: Bearer <access_token>`（用户必须已登录）

```json
{ "license_key": "LIC-XXXXXXXX-XXXXXXXX-XXXXXXXX" }
```

```json
{ "ok": true, "already": false, "license": { "license_key": "...", "type": "subscription", "end_at": "2027-11-02T..." } }
```

- `already: true` 表示这张码本来就在该账号下，重复调用是安全的
- 别人的码、不存在的码**都返回** `400 LICENSE_TAKEN / LICENSE_NOT_FOUND` 且提示语一致（「授权码无效或已被使用」）—— 不要试图从中区分，这是防枚举设计
- 同一账号 10 分钟内失败 10 次会返回 `429 TOO_MANY_ATTEMPTS`
- 绑定成功后这张码的 `start_at` = 当前时间，`end_at` = 当前时间 + 卡面时长

> 面向最终用户时，"绑定"这个动作也可以完全交给网页端「我的授权」页面，客户端只需在激活失败拿到 `LICENSE_UNASSIGNED` 时把用户引导过去。

### 5.6 离线票据（断网也能用，且改时间骗不过）

`POST /license/ticket`，需要 `Authorization: Bearer <access_token>`

```json
{
  "ticket": "v1.<payload_base64url>.<signature_base64url>",
  "alg": "Ed25519",
  "kid": "9f3a1c7b2d40e851",
  "seq": 12,
  "epoch": 1,
  "entitlement_sig": "base64…",
  "entitlement_kid": "ent-2026-11",
  "payload": {
    "v": 2,
    "license_id": 42,
    "license_key": "LIC-XXXXXXXX-XXXXXXXX-XXXXXXXX",
    "user_id": 12,
    "machine_id": "A1B2C3D4E5F6",
    "machine_code": "A1B2C3D4E5F6",
    "build_hash": "9f2c…",
    "seq": 12,
    "epoch": 1,
    "product": "LabelGo",
    "sku": "online-standard",
    "product_id": 0,
    "app_id": 3,
    "plan": "member",
    "plan_code": "member",
    "plan_name": "在线会员版",
    "tier": 10,
    "features": ["labelgo.basic", "labelgo.library", "labelgo.excel"],
    "limits": { "labelgo.library": 30, "labelgo.excel_rows": 100 },
    "seats": 1,
    "online_required": 1,
    "max_devices": 2,
    "offline_days": 3,
    "downgraded_from": "",
    "entitlement_version": "a1b2c3d4e5f6",
    "iat": 1793600000,
    "exp": 1794204800
  },
  "public_key": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
  "expires_in": 604800,
  "server_time": "2026-11-02T08:00:00.000Z"
}
```

**套餐权益字段**：`plan_code` / `plan_name` / `tier` / `features` / `limits` / `seats` / `online_required` / `app_id` / `entitlement_version` / `downgraded_from` 都随签名一起下发，`app_id` 标明档位归属哪个软件产品。客户端断网时问不了服务端，**功能开关只能以验签通过的 `features` 为准、数量上限以 `limits` 为准**，不要用本地缓存的旧档位，也不要相信接口单独返回的目录。`entitlement_version` 断网后没有用处，但它保证「同一张票内权益自洽」。套餐授权的 `product_id=0`（不绑定具体商品），激活时改由 `licenses.app_id` / 档位 `app_id` 做产品匹配；`app_id` 为空的历史通用码按「不限应用」放行。历史商品授权与卡密池码没有档位，这些字段为 `""` / `0` / `[]` / `null`，`offline_days` 回退到开放应用里的「离线宽限」。

`/app/version` 额外返回 `plan_catalog`（**只包含本应用自己的档位**），仅供展示可购买档位；权益判定仍以票据签名字段为准。

**签名算法（客户端自行实现，不要依赖网络）**

1. `ticket` 按 `.` 切成三段：`v1` / `payload` / `signature`
2. `payload` 是 base64url 解码后的 JSON —— 但**验签用的是原始的 payload 字符串**，不要重新序列化
3. 用内置公钥验证 `Ed25519(payload_base64url_bytes, signature)`
4. 校验 `payload.machine_id` 与本地机器码一致
5. 校验 `now <= payload.exp`，且 `now >= payload.iat`（后者不满足说明系统时间被往回拨了）

```js
// Node 示例
const crypto = require('crypto');
const [ver, body, sig] = ticket.split('.');
const ok = crypto.verify(null, Buffer.from(body, 'utf8'),
  crypto.createPublicKey(EMBEDDED_PUBLIC_KEY),
  Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
```

**换票序号（2026-11-11 新增，v2）**

| 字段 | 含义 |
|---|---|
| `seq` | 同一 `(license_id, machine_code)` 单调递增；客户端必须持久化「见过的最大 seq」 |
| `epoch` | 停票时服务端 +1；**epoch 变了老票整批作废**，即使还没到期 |
| `build_hash` | 请求里带上来，票里原样签回去；用于定位「哪个构建出的问题」 |
| `machine_code` | 票只签给会话所在机器，换机换票直接 `403 MACHINE_MISMATCH` |

客户端的硬规则（缺一条就等于留了旁路）：

1. 收到的票必须 `payload.seq > 本地记录的最大 seq`，否则视为重放，**丢弃并保持现有权益不变**；
2. `payload.epoch` 与本地记录不同 → 视为已停票，走降级/提示，不要沿用旧票；
3. `payload.machine_code` 必须等于本地机器码；
4. 宽限计时用票里的 `iat`（服务端签发时刻），不要用本地 `Date.now()` 反推。

服务端行为：停票后下一次换票回 `403 TICKET_STOPPED`（带 `stopped_at` / `reason`），
**已发的票靠 epoch 失效**；恢复换票后 seq 继续从原值递增，不会回到 1。

响应里的两个时间字段别混：

| 字段 | 含义 |
|---|---|
| `expires_in` | 票本身的有效期（=`exp - now`），断网能用多久 |
| `refresh_in` | **建议多久来换一次票**（默认 24h，后台 `ticket_ttl_hours` 可调，且不超过有效期） |

`offline_days` 仍然决定断网可用时长（3 天就真给 3 天），`refresh_in` 只是「该来换票了」的节拍，
不是有效期上限 —— 用 24h 去 cap 离线宽限等于把后台配的宽限偷偷砍掉。

**权益快照签名 `entitlement_sig`**

`license.entitlement`（以及票响应顶层的 `entitlement`）旁边多两个字段：

| 字段 | 说明 |
|---|---|
| `entitlement_sig` | 对 entitlement 对象做 Ed25519（base64），canonical 规则同清单签名（去掉 `entitlement_sig`） |
| `entitlement_kid` | 形如 `ent-2026-11`，**在签名内容里** |

断网期间保留的旧快照必须验签通过才可用：本地改一个 JSON 就能解锁全部功能，
这正是「离线宽限」最容易被利用的地方。验签失败 → 按无结论处理（保留上一份**验签通过**的快照）。
注意：`entitlement_sig` 与 `.lic` 文件签名、清单签名**不是同一把密钥**，公钥分别内嵌。

**有效期语义**

| `offline_days` | 票据 `exp` | 客户端策略 |
|---|---|---|
| `0` | 本次会话到期时间（≤2 小时） | 断网即锁功能，必须联网校验 |
| `> 0` | `iat + offline_days` 天，且不超过授权到期时间 | 断网可用到 `exp`，超期必须联网换新票 |

**公钥固定（重要）**：把 `public_key` 打进安装包，并用 `kid` 校验是否是同一把钥匙。**不要**在运行时从 `/app/pubkey` 拉公钥来验签 —— 那等于让中间人决定验签结果；该接口只用于排障与核对 `kid`。

**服务端密钥**：私钥在 `data/offline-signing-key.json`（0600）。它丢失不影响登录，只让已发出的票据全部失效（客户端退化为联网校验），所以备份 `data` 目录时要一起备份。

### 5.7 扫码登录

1. `POST /auth/qrcode` → `{ scene, qrcode_url, url, mode, expires_at }`
   - `mode: "wechat"` 时把 `qrcode_url` 渲染成二维码给用户扫
   - `mode: "simulate"` 表示服务号未配置，仅本地联调可用
2. 客户端每 2 秒轮询 `GET /auth/qrcode/{scene}?app_key={AK}&machine_id={MAC}`（可加 `version`、`machine_name`）
3. 用户扫码确认后返回 `{ status: "confirmed", access_token, refresh_token, user, license }`
4. `status` 还可能为 `pending` / `expired`

**确认即选码 + 绑机**：服务端会挑出该用户在本产品下**当前生效**的授权（tier 最高且未过期的那张），返回完整 `license` payload，并顺手把 `machine_id` 绑上去——免费用户扫码后**不需要再走激活**，直接进入已授权状态。会话也绑定了这张授权，心跳 / 离线票据开箱即用。

- 机器超出 `max_devices` 时登录仍成功，但返回 `license_bind_error: { code: "MACHINE_LIMIT", reason: "…" }` 且会话不带授权——引导用户去网页端解绑或走卡密激活流程
- 没有任何可用授权时会先自动补发一张本产品免费档授权码

### 5.7.1 免登跳转用户中心（`/auth/handoff`）

软件里已经有用户登录态了，点「用户中心」不该在浏览器里再扫一次码。

`POST /auth/handoff`，需要 `Authorization: Bearer <access_token>`

```json
{ "to": "space", "app": "ak_xxxxxxxxxxxx" }
```

`to` 走白名单：`account`（默认）/ `licenses` / `devices` / `orders` / `space` / `earnings`（我的收益），填别的会被收敛成 `account`（防开放重定向）。

`to: "space"` 时可带 `app: "<自己的 app_key>"`：用户点「升级套餐」直接落到**自己的那张产品卡片**（网页端高亮定位），不用在「我的空间」里自己找。

响应：

```json
{
  "url": "https://www.bliot.cn/platform/user/?t=ho_9f3a…c7#/account",
  "page": "account",
  "expires_in": 300,
  "user": { "id": 12, "nickname": "李雷" }
}
```

客户端拿到 `url` 直接 `shell.openExternal` / `startActivity` 打开即可。网页端 `app.js` 启动时会把 `?t=` 拿去兑换：

`POST /api/portal/handoff`（body `{ "t": "ho_…" }`）→ `{ "token": "<网页 JWT>", "user": {...} }`

换完立刻写进 localStorage 并把 `t` 从地址栏抹掉，所以**同一张票只能换一次**。

要点：

- 票据 5 分钟有效，用一次即作废；同一用户再发一次会让**旧票提前失效**（连点三次只有一个链接有效）
- 不要把 `access_token` 直接拼进 URL：会留在浏览历史、代理日志和 Referer 里，而且网页端用的是另一套 JWT，根本认不了
- 网页端兑换失败给的是同一句「链接无效或已过期」——区分「不存在 / 用过 / 过期」等于白送一个试探入口

### 5.8 手机号登录
1. `POST /auth/sms/send` body `{ "phone": "13800138000" }` → 返回 `{ ok: true }`（未接短信网关时响应里还有 `dev_code`，联调可直接用）
2. `POST /auth/login/phone` body `{ "phone": "...", "code": "123456", "machine_id": "..." }`

新手机号会**自动建档**，并按规则生成 TB 账户（`p_13800138000@tb.cn`，密码 `p_13800138000`）。

### 5.9 刷新令牌

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
| 401 | `SESSION_REVOKED` | **该机器已被解绑，或授权被吊销/后台踢下线** | 不要重试、不要刷新，直接回激活页并说明原因 |
| 403 | `LICENSE_UNASSIGNED` | 卡密还没绑定账号 | 引导用户登录后绑定（`/license/bind` 或网页「我的授权」） |
| 400 | `LICENSE_TAKEN` | 这张码已绑到别的账号 | 提示「授权码无效或已被使用」，不要提示「属于别人」 |
| 429 | `TOO_MANY_ATTEMPTS` | 绑定尝试过于频繁 | 提示 10 分钟后再试 |
| 403 | `LICENSE_NOT_FOUND` | 授权码不存在 | 提示激活码错误 |
| 403 | `LICENSE_REVOKED` | 授权被吊销 | 提示联系客服 |
| 403 | `LICENSE_INACTIVE` | 授权未激活 | 同上 |
| 403 | `LICENSE_EXPIRED` | 授权过期 | 引导续费 |
| 403 | `PRODUCT_MISMATCH` | 授权与当前应用不匹配 | 提示用错软件 |
| 403 | `MACHINE_NOT_BOUND` | 机器未绑定该授权 | 重新激活 |
| 403 | `FORBIDDEN` | 越权操作 | — |
| 404 | `USER_NOT_FOUND` / `SCENE_NOT_FOUND` | 资源不存在 | — |
| 409 | `MACHINE_LIMIT` | 超出机器数上限 | 提示先解绑旧机器 |
| 401 | `APP_SECRET_RETIRED` | **旧应用密钥已被后台关闭**（双模期结束） | 升级客户端到新凭证/公开模式，别当成密钥写错 |
| 401 | `PUBLIC_AUTH_DISABLED` | 该应用未开启公开模式 | 改用 HMAC 或令牌模式 |
| 401 | `NONCE_REQUIRED` / `NONCE_REUSED` | 公开模式写请求缺 nonce / nonce 重放 | 每次请求生成新 nonce |
| 429 | `RATE_LIMITED` | 公开模式频控命中 | 退避重试（指数退避，别死循环） |
| 403 | `MACHINE_MISMATCH` | 换票机器码与会话不一致 | 重新激活，不要拿别的机器的票 |
| 403 | `TICKET_STOPPED` | 该机器换票已被后台停用 | 提示联系客服；已发的票按 epoch 失效 |
| 400 | `MACHINE_REQUIRED` | 换票缺 machine_code | 补上机器码 |

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
const LICENSE = 'LIC-XXXXXXXX-XXXXXXXX-XXXXXXXX';
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

- 创建/编辑应用，绑定产品，设置版本号与安装包地址（客户端 `/app/version` 直接读到）；列表会显示每个应用已配的**套餐档位数**
- 「产品运营 → 套餐档位」按应用分组管理档位，支持「从模板复制到该产品」、按产品导出/导入 JSON；同一 code 在不同产品下可重复
- 重置 AppSecret（会使该应用下所有客户端令牌立即失效）
- 停用应用（客户端全部被挡在门外）
- 查看客户端会话：用户、机器码、客户端版本、IP、最后活跃时间，并可**单台踢下线**
- 顶部看板：应用数、在线客户端数、今日 API 调用、已激活机器数

授权侧（授权管理页面）：

- **发放授权**：选用户 + 产品 + 类型（永久/订阅/试用）+ 设备上限；「数量」填 N 可**批量发码**（一次最多 200 个，整批一个事务，码可一键复制）
- 授权列表按授权码 / 用户 / 产品搜索，按状态筛选
- 点「设备数」列可查看该授权绑定的机器（机器码、名称、版本、IP、最后活跃），并**逐台解绑**——解绑会连带作废该机器的客户端会话
- 续期 / 吊销 / 恢复 / 删除；吊销会同时作废该授权下**所有**客户端会话
- 服务类商品（API 额度包）不允许发授权码，会直接报错提醒

用户端「我的授权」也能自助解绑：用户换电脑、重装系统后自己解绑旧机器，不必找客服。

客户端下一次心跳或校验就会立刻感知以上任何变化。

---

## 10. 联调自测

```bash
node tools/test-open.js
```

会走完整链路：创建应用 → 签名校验 → 激活 → 重复激活 → 超出机器数 → 取资料/授权/硬件 → 校验 → 心跳 → 刷新令牌 → 手机号登录 → 扫码登录 → 解绑 → 吊销后失效，共 28 项断言。

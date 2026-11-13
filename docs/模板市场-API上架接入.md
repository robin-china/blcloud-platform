# 模板市场 · API 上架接入（2026-11-13）

> 面向：官方批量上架脚本、设计工具导出插件、第三方模板投稿方。
> **不是** LabelGo 客户端用的接口（客户端读接口见《软件端接入API.md》§11）。

接口基址：

```
https://www.bliot.cn/platform/api/market/v1
```

本地/测试环境把 `/platform` 换成实际 `BASE_PATH`（不设则为空）。

---

## 0. 为什么不是「把后台接口开出来」

后台 `/api/market/templates` 靠管理员 JWT，12 小时过期、等于把整个后台权限交给脚本、
不能单独吊销、审计只能记到人，而且**没有幂等键、不校验字典**。批量接入会踩三个坑：
超时重试建出重复模板、脏枚举污染客户端筛选栏、脚本出问题直接影响已购用户。

所以另开一条独立通道，与管理员登录、客户端 `X-App-Key` 三套身份完全隔离：

| | 客户端读 | 后台管理 | **API 上架（本文）** |
|---|---|---|---|
| 前缀 | `/api/open/v1` | `/api/market` | `/api/market/v1` |
| 凭据 | `X-App-Key`（公开） | 管理员 Bearer | `X-Market-Key`（保密） |
| 能做什么 | 浏览 / 兑换 / 下载 | 增删改、上下架、字典 | **只建/改自己提交的模板、传文件、查状态** |
| 删除 / 下架 | 无 | 有 | **无**（防止脚本误伤已购用户） |

---

## 1. 拿密钥

后台「**扩展功能 → LabelGo模板API上架**」→ 新建密钥。

- 名称写清是谁在用（如「设计部投稿」「官方批量脚本」）；
- **「允许直接上架」默认关闭**：新模板落到「待审」（下架状态），运营在
  「LabelGo模板市场」页审核后点「上架」才对外可见。只有可信的官方脚本才打开；
- 明文密钥 `mkt_…` **只在创建弹窗显示一次**，后台和数据库里只存 sha256，丢了只能重建。

> 生产必须走 HTTPS。密钥等同于「往你的市场上架内容的权限」，不要进 Git、不要打日志、
> 不要放进任何客户端安装包。轮换方式：新建一把 → 脚本切换 → 后台停用/删除旧密钥。

---

## 2. 通用请求约定

| 头 | 何时需要 | 说明 |
|---|---|---|
| `X-Market-Key` | **所有请求** | 明文密钥；缺失 `401 MARKET_KEY_REQUIRED`，错 `401 MARKET_KEY_INVALID`，停用 `403 MARKET_KEY_DISABLED` |
| `X-Nonce` | **所有写请求**（POST） | 每次一个新值（UUID 即可）；缺失 `401 NONCE_REQUIRED`，重放 `401 NONCE_REUSED` |
| `Content-Type: application/json` | JSON 请求 | 见 §4 |
| `X-File-Sha256` | 分步上传时可选 | 声明文件 sha256，服务端比对，不一致拒收 |

- 限流：**每密钥 120 次/分钟**（`429 RATE_LIMITED`）。批量上架请自行限速，别靠重试硬怼。
- 每次调用（含失败）都写 `market_api_logs`，后台「API 上架」页可查最近 50 条；
  流水按 **30 天** 滚动清理，模板与已购账本永不自动清。
- 所有响应都带 `serverTime`（ISO 8601，UTC）。

---

## 3. 上架状态机

```
POST /templates
   ├─ 密钥 auto_publish=0（默认）→ status='off' 待审
   │      └─ 运营在后台点「上架」→ status='on'，客户端可见
   └─ 密钥 auto_publish=1        → status='on'，立即对外可见

之后脚本重跑：
   ├─ 内容没变            → no-op，version 不动，status 保持现状
   ├─ 内容变了            → 更新元数据/文件，version +1，status 保持现状
   └─ 运营人工下架过      → 脚本重跑【不会】把它重新推上线（重要）
```

`needsReview` 只在**首次创建且需要审核**时为 `true`，可直接作为脚本提示语。
**下架与删除只能由管理员在后台操作**，API 不提供，也不允许 API 改后台人工创建的模板。

---

## 4. POST `/templates` — 创建或幂等更新

### 请求字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `externalId` | string ≤120 | **是** | **幂等键**，你们系统里的模板唯一编号。同一密钥下重复提交不会建第二份 |
| `name` | string | **是** | 模板名 |
| `widthMm` / `heightMm` | number >0 | **是** | 标签尺寸，客户端按精确值筛选 |
| `industry` | string | 否 | **必须在「LabelGo模板字典」的行业清单内**，否则 `400` |
| `paperType` | string | 否 | **必须在字典的纸型清单内**，否则 `400` |
| `dpi` | number | 否 | **203 / 300 / 600**，默认 203（2026-11-13 补 600） |
| `columns` | number | 否 | 一纸列数，默认 1 |
| `price` | int ≥0 | 否 | 所需积分，0 = 免费，默认 0 |
| `description` | string ≤500 | 否 | 列表展示 + 关键词检索 |
| `tags` | string[] ≤20 | 否 | 增强检索，也支持逗号分隔字符串 |
| `author` | string | 否 | 上架者 / 作者（UGC 预留） |
| `thumbnailUrl` | string | 否 | 缩略图公开 URL，如 `/platform/uploads/xxx.png` |
| `fileBase64` | string | 否 | `.blls` 文件内容的 base64（可带 `data:` 前缀）；建议 ≤10MB 用这种一步式 |
| `fileSha256` | string | 否 | **强烈建议**：声明文件 sha256，服务端比对，防传输损坏 |

> 不传 `fileBase64` 时只建/改元数据，之后用 §5 的分步接口传大文件（上限 64MB）。
> 服务端不解析 `.blls`（它是加密二进制，由客户端自行导入），只校验扩展名、非空、大小和哈希。

### 响应

```json
{
  "ok": true,
  "created": true,
  "changed": true,
  "needsReview": true,
  "externalId": "shelf-50x30-001",
  "item": {
    "id": "tpl_mkt_a1b2c3d4e5f6",
    "externalId": "shelf-50x30-001",
    "name": "仓储货架标签",
    "status": "off",
    "source": "api",
    "version": 1,
    "fileSha256": "",
    "fileSize": 0,
    "hasFile": false,
    "createdAt": 1763000000000,
    "updatedAt": 1763000000000
  },
  "serverTime": "2026-11-13T05:00:00.000Z"
}
```

**响应永远不含 `file_path` / `fileUrl` / `downloadUrl`。** 模板文件仍只存 `data/market/`
私有目录，用户兑换成功后由后端签发 5 分钟一次性短链。

### 幂等语义（重试就看这段）

| 场景 | `created` | `changed` | 副作用 |
|---|---|---|---|
| 首次提交 | `true` | `true` | 建模板 |
| 同一 `externalId` 原样重发 | `false` | `false` | **无**，version 都不动 |
| 同一 `externalId` 改了字段 / 换了文件 | `false` | `true` | 更新，version +1 |
| 运营已把它下架，脚本原样重发 | `false` | `false` | status 仍是 `off` |

网络超时 / 5xx / 拿不到响应，**用同一个 `externalId` + 新的 `X-Nonce` 直接重发即可**，
不会产生重复模板、不会重复推进 version。不要自己生成新 `externalId` 去重试。

---

## 5. POST `/templates/:id/file` — 分步上传大文件

`multipart/form-data`，字段名 `file`，文件名必须以 `.blls` 结尾。

```bash
curl -X POST "https://www.bliot.cn/platform/api/market/v1/templates/tpl_mkt_a1b2c3d4e5f6/file" \
  -H "X-Market-Key: mkt_…" -H "X-Nonce: <新的 UUID>" \
  -H "X-File-Sha256: <sha256>" \
  -F "file=@shelf.blls"
```

- 只能改**本密钥自己通过 API 建的模板**，跨密钥 / 改后台人工模板一律 `403 TEMPLATE_FORBIDDEN`；
- `X-File-Sha256` 不一致回 `400 FILE_SHA_MISMATCH`，**不覆盖旧文件**；
- 成功覆盖后 `version +1`，响应同 §4 的 `item`。

---

## 6. GET `/templates?externalId=…` — 查上架状态

```json
{ "found": true, "item": { "id": "…", "status": "on", "version": 2, "hasFile": true, "…": "…" },
  "serverTime": "…" }
```

查不到返回 `found:false`（**不是 404**），方便脚本写「没有就创建」的逻辑。
GET 不需要 `X-Nonce`。

---

## 7. 错误码

| HTTP | code | 处理 |
|---|---|---|
| 400 | `EXTERNAL_ID_REQUIRED` | 补 `externalId` |
| 400 | `PARAM_INVALID` | 字段不合法：字典外行业/纸型、非法 dpi、尺寸 ≤0、名称为空。按 `error` 提示改 |
| 400 | `FILE_REQUIRED` / `FILE_EMPTY` / `FILE_INVALID` | 检查 `fileBase64` |
| 400 | `FILE_TOO_LARGE` | 单文件 >64MB；或 JSON 体超过服务端 20MB（改用分步上传） |
| 400 | `FILE_TYPE_INVALID` | 分步上传的文件名必须是 `.blls` |
| 400 | `FILE_SHA_MISMATCH` | 重新读文件、重算 sha256 再传 |
| 401 | `MARKET_KEY_REQUIRED` / `MARKET_KEY_INVALID` | 检查密钥头 |
| 401 | `NONCE_REQUIRED` / `NONCE_REUSED` | 每个写请求生成新 UUID |
| 403 | `MARKET_KEY_DISABLED` | 密钥被后台停用，联系管理员 |
| 403 | `TEMPLATE_FORBIDDEN` | 该模板不属于当前密钥，或不是 API 创建的 |
| 404 | `TEMPLATE_NOT_FOUND` | 分步上传时模板 ID 不存在 |
| 429 | `RATE_LIMITED` | 退避后重试，别硬怼 |

---

## 8. 最小示例（Node）

```js
const crypto = require('crypto');
const BASE = 'https://www.bliot.cn/platform/api/market/v1';
const KEY = process.env.MARKET_API_KEY;               // 别写死在源码里
const buf = require('fs').readFileSync('shelf.blls');
const body = {
  externalId: 'shelf-50x30-001',
  name: '仓储货架标签', industry: '物流仓储', paperType: '间隙纸',
  widthMm: 50, heightMm: 30, dpi: 203, columns: 1, price: 20,
  author: '官方', tags: ['条码', '货架'],
  fileBase64: buf.toString('base64'),
  fileSha256: crypto.createHash('sha256').update(buf).digest('hex'),
};
const res = await fetch(`${BASE}/templates`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Market-Key': KEY,
    'X-Nonce': crypto.randomUUID(),   // 每次都要新
  },
  body: JSON.stringify(body),
});
const data = await res.json();
if (!res.ok) throw new Error(`${res.status} ${data.code}: ${data.error}`);
console.log(data.item.id, data.item.status, data.needsReview ? '待审核' : '已上架');
```

---

## 9. 上线检查（后台侧）

- [ ] 生产走 HTTPS，密钥只放在服务端环境变量 / 密钥管理里；
- [ ] Nginx **没有**给 `data/market/` 配 `alias` / 静态映射（模板文件绝不能直出）；
- [ ] 备份包含 `data/market/*.blls`（`server/lib/backup.js` 已纳入 `market/`）；
- [ ] 「LabelGo模板字典」已改成实际词表；`dpis` 勾选与客户端支持情况一致；
- [ ] 第三方投稿密钥保持 `auto_publish=0`，「LabelGo模板市场」页定期处理「待审」；
- [ ] 有已购记录的模板**不能删**，只能下架（后台已做 409 拦截）。

---

## 10. 与客户端读接口的字段对应

API 上架用 camelCase，客户端 `/market/list` 拿到的也是 camelCase，一一对应：
`widthMm/heightMm/dpi/columns/price/author/tags/thumbnailUrl/industry/paperType/description`。
`externalId`、`source`、`apiKeyId` 只在 API / 后台可见，客户端列表与详情不下发。
`dpi` 可选值也通过 `GET /api/open/v1/market/meta` 的 `dpis` 下发给客户端，客户端不要写死。

# blcloud 设备 API 接入文档

> 面向用户与开发者：在个人中心 **blcloud** 板块生成 API 密钥，直接访问自己物联账户下的设备接口，系统按调用次数计费并统计。

## 1. 命名约定

| 层级 | 名称 |
|---|---|
| 对外统一名称 | **blcloud**（物联服务 / API 密钥 / 调用额度），全小写 |
| 底层实现 | ThingsBoard（不向用户暴露，账户由平台按租户规则**内部自动创建与打通**） |
| 内部映射规则 | 仅供管理员在后台查看，任何用户端 / 软件端接口均**不返回**物联账户名与密码 |

## 2. 整体链路

```
用户个人中心 blcloud 板块
   └─ 生成 API 密钥 blc_xxxx（绑定自己的 blcloud 账户）
        │
        ▼
自有系统 / 脚本  ──X-BLC-Key──▶  本系统 /api/blcloud/v1/*
                                     │ 1 校验密钥
                                     │ 2 校验额度（账户池 + 密钥配额 + 每日上限）
                                     │ 3 用用户的 blcloud 账户换 JWT
                                     │ 4 转发设备平台（路径白名单）
                                     │ 5 记账 + 写调用明细
                                     ▼
                                 返回设备平台原始数据
```

失败（4xx/5xx）**不扣额度**，但会留痕，便于排查。

## 3. 快速开始

1. 登录用户中心 → 左侧「blcloud」
2. 点击「新建密钥」，填写名称、分配额度、权限（只读 / 读写）、有效期
3. **立即保存明文密钥**（只显示一次，之后只能看到前缀和重置）
4. 调用：

```bash
curl "https://{域名}/api/blcloud/v1/devices" -H "X-BLC-Key: blc_xxxxxxxxxxxx"
```

响应统一为：

```json
{
  "ok": true,
  "cost": 1,
  "elapsed_ms": 42,
  "data": { "data": [ { "id": { "id": "..." }, "name": "花盆卫士-01" } ], "totalPages": 1 }
}
```

`data` 即设备平台原始返回，不做结构改写，方便迁移现有代码。

## 4. 鉴权

请求头任选其一：

```
X-BLC-Key: blc_xxxxxxxxxxxx
Authorization: Bearer blc_xxxxxxxxxxxx
```

## 5. 接口清单

基础路径：`/api/blcloud/v1`

| 方法 | 路径 | 端点名 | 消耗 | 说明 |
|---|---|---|---|---|
| GET | `/devices` | devices.list | 1 | 我的设备列表（pageSize / page / textSearch / type） |
| GET | `/devices/{deviceId}` | devices.get | 1 | 设备详情 |
| GET | `/devices/{deviceId}/credentials` | devices.credentials | 2 | 设备 MQTT 凭据（token） |
| GET | `/devices/{deviceId}/telemetry` | telemetry.read | 1 | 历史遥测（keys / startTs / endTs / limit / interval / agg） |
| GET | `/devices/{deviceId}/telemetry/latest` | telemetry.latest | 1 | 最新遥测 |
| POST | `/devices/{deviceId}/telemetry` | telemetry.write | 2 | 上报遥测，body: `{ts, values, scope}` |
| GET | `/devices/{deviceId}/attributes` | attributes.read | 1 | 属性（keys / scope） |
| POST | `/devices/{deviceId}/attributes` | attributes.write | 2 | 写属性，body: `{scope, values}` |
| POST | `/devices/{deviceId}/rpc` | rpc.send | 5 | 下发指令，body: `{method, params, mode: oneway\|twoway, timeout}` |
| POST | `/proxy` | proxy.passthrough | 1 | 通用透传，body: `{method, path, query, body}`，限白名单 |
| POST | `/token` | token.issue | 10 | 签发设备平台 JWT（直连用） |
| GET | `/me` | — | 0 | 密钥信息 + 额度 |
| GET | `/usage?days=14` | — | 0 | 用量统计 |
| GET | `/_endpoints` | — | 0 | 接口自描述 |

### 透传白名单（`/proxy`）

仅允许以下前缀，其余返回 `403 PATH_FORBIDDEN`：

```
/api/user/   /api/device/   /api/devices   /api/plugins/telemetry/
/api/rpc/   /api/tenant/devices   /api/customer/
```

即使路径合法，设备平台本身的权限仍然生效（CUSTOMER_USER 只能看到分配给自己的设备）。

### 直连模式（`/token`）

返回设备平台 JWT 与地址（**不含账户名**），客户端可绕过本系统直连。优点：延迟最低；缺点：**后续调用无法统计与计费**，因此按 10 次/次签发扣费。仅建议调试或高吞吐内部服务使用。

## 6. 额度与计费

- **账户额度池**：`blcloud_quota`（累计获得）− `blcloud_used`（累计消耗）
- **密钥配额**：创建时从账户池划拨，用完后仅该密钥受限，可再分配或新建
- **免费额度**：用户首次使用 blcloud 时一次性发放（默认 10000 次，后台可配）
- **积分兑换**：`POST /api/portal/blcloud/exchange {points}`，默认 1 积分 = 100 次
- **管理员赠送**：后台「blcloud 调用 → 用户额度」填写用户 ID 与增减次数
- **每日上限**：可配置单用户每日调用上限，0 为不限
- 调用失败不扣费；成功才扣

计费码：

| HTTP | code | 含义 |
|---|---|---|
| 401 | KEY_MISSING / KEY_INVALID | 密钥缺失或无效 |
| 402 | QUOTA_EXHAUSTED | 账户额度不足 |
| 402 | KEY_QUOTA_EXCEEDED | 该密钥配额用完 |
| 402 | DAILY_LIMIT | 触发每日上限 |
| 402 | BLCLOUD_DISABLED | 平台已停用接口 |
| 403 | KEY_DISABLED / KEY_EXPIRED | 密钥停用或过期 |
| 403 | SCOPE_DENIED | 只读密钥执行写操作 |
| 403 | PATH_FORBIDDEN | 透传路径不在白名单 |
| 503 | BLCLOUD_ACCOUNT_UNAVAILABLE | 用户物联账户未开通或平台不可达 |

## 7. 统计

**用户端**（个人中心 blcloud）：剩余额度、今日调用、14 天趋势图、接口分布、密钥用量明细。

**管理端**（blcloud 调用）：密钥总数/启用数、累计调用、今日调用、已分配额度、调用趋势、用户排行、接口分布与失败数、用户额度榜单与调整、密钥停用/删除、额度策略配置（免费额度 / 兑换比例 / 每日上限 / 总开关）。

数据落在 `blcloud_usage`（逐条明细，含 endpoint、path、状态码、消耗、时间）与 `stats_daily.api_calls`（全局日累计）。

## 8. 代码示例

### Node.js

```js
const KEY = 'blc_xxxxxxxxxxxx';
const BASE = 'https://{域名}/api/blcloud/v1';

async function blc(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { 'X-BLC-Key': KEY, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${data.code}: ${data.error}`);
  return data.data;
}

const devices = await blc('/devices');
const t = await blc(`/devices/${devices.data[0].id.id}/telemetry?keys=temperature&limit=10`);
await blc(`/devices/${devices.data[0].id.id}/rpc`, {
  method: 'POST',
  body: JSON.stringify({ method: 'setPump', params: { on: true } }),
});
```

### Python

```python
import requests
KEY = "blc_xxxxxxxxxxxx"
BASE = "https://{域名}/api/blcloud/v1"
s = requests.Session()
s.headers.update({"X-BLC-Key": KEY})

devices = s.get(f"{BASE}/devices").json()["data"]["data"]
did = devices[0]["id"]["id"]
tele = s.get(f"{BASE}/devices/{did}/telemetry", params={"keys": "temperature,humidity", "limit": 10}).json()
print(tele["data"])
```

## 9. 安全建议

- 密钥只在服务端或受控环境使用，不要写进前端/小程序包体
- 为不同用途创建不同密钥（只读监控、写入控制分离），便于单独吊销与限额
- 定期「重置」轮换密钥；泄露后立即停用
- 机器/服务侧建议加缓存，遥测类查询优先用 `limit`/`interval` 聚合，减少调用量

## 10. 相关接口（用户端会话态）

个人中心页面使用，需 `Authorization: Bearer <user_token>`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/portal/blcloud/overview` | 额度、密钥、物联账户、14 天统计 |
| GET | `/api/portal/blcloud/keys` | 密钥列表 |
| POST | `/api/portal/blcloud/keys` | 创建，返回一次性明文 |
| POST | `/api/portal/blcloud/keys/{id}` | 改名 / 改权限 / 停用启用 / 追加配额 |
| POST | `/api/portal/blcloud/keys/{id}/reset` | 重置密钥（旧密钥立即失效） |
| DELETE | `/api/portal/blcloud/keys/{id}` | 删除 |
| GET | `/api/portal/blcloud/usage?days=14` | 用量统计 |
| POST | `/api/portal/blcloud/exchange` | 积分兑换额度 |

自测脚本：`node tools/test-blcloud.js`（33 项断言，含权限、配额、白名单、统计、兑换、管理端）。

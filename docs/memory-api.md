# Memory API 对外函数接口

给外部 agent 产品（门店智能体等）调用的 IM 上下文记忆服务。随 bot 进程启动（多用户模式），通过 HTTP + Bearer Service Token 暴露稳定的 JSON 函数接口。

- 实现位置：`src/memory-api/`（server.ts / handlers.ts / entity-queries.ts / refresh-jobs.ts / rate-limit.ts）
- 启动条件：`.env` 中 `IM_BOT_PI_MEMORY_API_PORT>0` 且配置了 `IM_BOT_PI_MEMORY_API_KEYS`，详见 `.env.example`
- 设计讨论与约束决策见 `.handoff/handoff-2026-09-20-graph-viewer.md` 及后续会话

## 调用约定

- 所有函数：`POST /v1/<function>`，`Authorization: Bearer <service-token>`，JSON body
- **工具清单：`GET /v1/tools`**（同样需要 Bearer）——返回 8 个函数的 LLM function-calling 格式定义（name/description/JSON Schema），可直接程序化注册为 agent 工具，无需手工翻译本文档
- 响应封套：成功 `{"version":1,"ok":true,"data":{...}}`；失败 `{"version":1,"ok":false,"error":{"code","message"}}`
- 每个请求必须带 `ownerOpenId` 或 `ownerUnionId` **二选一**：
  - `ownerOpenId`：目标用户在本机器人应用下的 open_id
  - `ownerUnionId`：目标用户的飞书 union_id（推荐外部产品使用，见下方"身份映射"）
- 健康检查：`GET /v1/health`（免鉴权，无数据）

错误码：`unauthorized`(401) / `owner_not_authorized`(403) / `owner_reauth_required`(403, 需用户重新授权) / `invalid_params`(400) / `rate_limited`(429) / `refresh_cooldown`(429) / `internal_error`(500)

限流（按 token）：默认 60 次/分钟、10000 次/日；refresh 类对同一 owner+时间窗有 5 分钟冷却（`IM_BOT_PI_MEMORY_API_REFRESH_COOLDOWN_SECONDS`）。

## 身份映射（ownerUnionId）

飞书 ID 规则：同一用户在不同应用下 **open_id 不同**；**union_id 在同一开发者账号下的所有应用间一致**（不是租户维度）。因此：

- 调用方应用与本机器人应用属于**同一飞书开放平台开发者账号** → 对方飞书登录拿到的 union_id 可直接作为 `ownerUnionId` 传入，服务端自动映射到对应 owner
- 两个应用属于**不同开发者账号** → union_id 也不一致。此时用租户内稳定的 `user_id`（需通讯录读取权限）或通讯录（手机号/邮箱）查询做映射，由调用方在执行器里维护映射关系

本服务的 union_id 映射数据来自 owner OAuth 授权与令牌刷新时飞书返回的 union_id（`var/tenant-user-tokens.json`），无需额外配置。

## 只读查询函数（6 个）

### search_facts

混合检索事实与消息（词法/结构/近因/图路由，RRF 融合）。问答主力。

```json
{
  "ownerOpenId": "ou_xxx",
  "query": "52MD 选品方案",
  "start": "2026-09-01T00:00:00+08:00",
  "end": "2026-09-20T00:00:00+08:00",
  "dueStart": "…", "dueEnd": "…",
  "chatType": "p2p|group",
  "factTypes": ["ACTION_ITEM", "REQUEST"],
  "statuses": ["open"],
  "currentOnly": true,
  "limit": 20,
  "tokenBudget": 12000
}
```

返回 `data.hits[]`（`ref`/`kind`/`text`/`factType`/`dueAt`/`entities`/`evidence[]`）+ `estimatedTokens`/`truncated`。除 `query` 外均可选；factTypes/statuses 枚举见 `src/memory/semantic-types.ts`。

### search_messages

原始消息全文检索。参数：`query`（可选，缺省按时间窗倒序）、`start`/`end`/`chatType`、`limit`(1-50)。返回 `data.hits[]`（`ref`/`chat`/`sender`/`sentAt`/`content`/`isSelf`）。

### get_evidence

展开 `search_*` 返回的 `ref` 引用（`mem_…`/`fact_…`），参数 `refs[]`(1-20)。返回 `data.messages[]` + `data.facts[]`（含证据链）。refs 是回源核验的句柄，不应在你们产品给用户的最终回复中展示。

### search_entities

按名称/别名解析实体。参数：`query`(必填)、`limit`(1-20，默认10)。返回 `data.entities[]`（`id`/`name`/`entityType`/`mentionCount`/`aliases`/`firstSeenAt`/`lastSeenAt`）。重名时请先让用户/上层逻辑消歧。

### get_entity

实体档案点查。参数：`id`（来自 search_entities）。返回 `data.entity`：画像 + `relatedEntities[]` + `facts[]`（该实体相关、当前有效的事实，按时间倒序，上限 100）。不存在时 `data.entity` 为 null。

### get_status

参数：仅 `ownerOpenId`。返回记忆覆盖窗口（`lastCompleteWindow`）、消息量、当前事实/实体/边数量、抽取积压 `pendingExtractions`，以及该 owner 最近一次 `refresh_context` 任务状态。

## 刷新函数（2 个，快慢分离）

数据不够新时先调 `get_status` 看覆盖，再按需刷新。两函数都对同一 owner+时间窗有冷却（默认 5 分钟），重复调用返回 `refresh_cooldown`。

### refresh_messages（同步，秒级）

按时间窗实时从飞书拉原始消息，直接返回作为证据，**只入库不抽取**。参数：`start`/`end`（必填）、`query`/`chatType`（可选）。返回 `data.prepare`（覆盖/入库统计）+ `data.messages[]`（该窗口最多 50 条）。

### refresh_context（异步）

拉取 + 入库 + **触发事实/图谱抽取**（LLM 调用，分钟级）。参数同 refresh_messages。立即返回 `data.job`（`id`/`status`），完成后经 `get_status` 的 `lastRefreshJob` 查看结果（含抽取统计）。同一 owner 的任务串行执行。

## 对接指南（给调用方团队，如门店智能体）

前置：从 im_bot 侧获取 **服务地址**（如 `http://10.12.6.143:4320`）和 **service token**。

### 第 1 步：拉取工具清单

```bash
curl -s -H "Authorization: Bearer <service-token>" \
  http://10.12.6.143:4320/v1/tools > tools.json
```

返回的 `data.tools` 即 OpenAI function-calling 格式的工具数组（`{type:"function", function:{name, description, parameters}}`），`data.instructions` 是给 agent 的整体使用说明。

### 第 2 步：注册为 agent 工具

- **OpenAI 兼容框架**：`data.tools` 可直接作为 chat completions 的 `tools` 参数传入
- **LangGraph / LangChain**：`llm.bind_tools()` 接受 OpenAI 格式，清单即原生输入，见下方"LangGraph 最小接入示例"
- **自研/其他框架**：按 `name` + `parameters` 注册工具定义；description/parameters 语义自明

### 第 3 步：实现执行器（工具调用 → HTTP）

每个工具的执行就是一次 HTTP POST，伪代码：

```js
async function executeTool(name, args) {
  const res = await fetch(`${BASE}/v1/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(args),   // args 即 LLM 生成的工具参数（含 ownerUnionId）
  })
  const envelope = await res.json()
  if (!envelope.ok) return `调用失败: ${envelope.error.code} ${envelope.error.message}`
  return envelope.data            // 交回给 LLM 继续推理
}
```

注意：把 LLM 给的参数原样作为 body 即可（校验由服务端完成）；错误封套也作为工具结果回给 LLM，让它自行处理（如冷却中改为用已有数据回答）。

### 第 4 步：确认用户身份映射

用你们应用里一个真实用户验证 union_id 是否与 im_bot 侧一致（调 `get_status` 带 `ownerUnionId`）：
- 200 → 一致，直接用
- 403 `owner_not_authorized` → union_id 维度不同（开发商账号不同），需改用 user_id 或通讯录映射，与 im_bot 侧确认方案

### 自检清单

```bash
curl -s http://10.12.6.143:4320/v1/health                                  # 服务存活（免鉴权）
curl -s -H "Authorization: Bearer <token>" http://.../v1/tools | head -c 300  # 清单可拉
curl -s -H "Authorization: Bearer <token>" -X POST http://.../v1/get_status \
  -H 'content-type: application/json' -d '{"ownerUnionId":"<测试用户union_id>"}' # 身份路由通
```

### LangGraph 最小接入示例（Python）

LangChain/LangGraph 的工具层最终按 OpenAI tools 格式与模型交互，`bind_tools()` 接受本服务清单的原生结构，无需任何格式转换：

```python
import requests
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

BASE = "http://10.12.6.143:4320"
TOKEN = "<service-token>"

manifest = requests.get(
    f"{BASE}/v1/tools", headers={"Authorization": f"Bearer {TOKEN}"}
).json()["data"]
tools = manifest["tools"]            # 已是 OpenAI function-calling 格式
instructions = manifest["instructions"]

def execute_tool(name: str, args: dict) -> dict | str:
    response = requests.post(
        f"{BASE}/v1/{name}",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json=args,
    )
    envelope = response.json()
    if not envelope.get("ok"):
        return f"调用失败: {envelope['error']['code']} {envelope['error']['message']}"
    return envelope["data"]

llm = ChatOpenAI(model="<你们的模型>")  # 任意 OpenAI 兼容接入均可

agent = create_react_agent(
    model=llm.bind_tools(tools),
    tools=tools,
    prompt=instructions,
)

# 每个 agent 会话注入当前用户的 union_id（由你们的应用层传入）
config = {"configurable": {"user_union_id": "<当前用户union_id>"}}
```

要点：
1. `tools` 原样进 `bind_tools`，LLM 生成的参数（含 `ownerUnionId`）原样 POST，校验由服务端完成
2. 错误封套作为工具结果回给 LLM（如 `refresh_cooldown` 时模型会改用已有数据回答）
3. 会话→用户的身份注入在你们的应用层完成：把当前用户的 `ownerUnionId` 追加进每次工具调用的 args（或包装 `execute_tool` 时合并）
4. 若用 Anthropic 原生 SDK 或 MCP 运行时，需一层字段映射（`function.name` → 顶层 `name`），联系 im_bot 侧确认清单消费方式

## 集成注意

1. **owner 授权边界**：`ownerOpenId` 必须是已向本 bot 完成 OAuth 授权的用户；未授权返回 `owner_not_authorized`，token 失效返回 `owner_reauth_required`（需引导用户重新授权）
2. **脱敏**：出口文本中的内部标识（`ou_`/`oc_`/`cli_` 等）已自动替换为 `[内部标识已隐藏]`；ref 句柄不在用户可见回复中展示
3. **数据语义**：事实记忆是派生索引；判断"是否已完成"请核对 `statuses` 与证据，勿仅凭旧待办
4. 服务在 bot 进程内（单写者），随 bot 生命周期启停，勿并发多实例指向同一 DB

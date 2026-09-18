# 办公上下文记忆

记忆数据库默认位于 `var/office-memory.db`，权限 `0600`，目录被 Git 忽略。单进程 SQLite（WAL 模式），宿主在 ingest 时同一事务保存原始响应、规范化消息和 Outbox 变更，再由独立游标增量更新 FTS。

## 知识图谱结构定义

Schema 来源：`src/memory/migrations.ts`（迁移版本 3），类型枚举来源：`src/memory/semantic-types.ts`。

### 节点（事实层，memory_facts）

事实是图谱的核心节点——每条事实是"从消息证据中抽取的一个结构化结论"：

| 字段 | 说明 |
|---|---|
| `fact_type` | 8 种类型之一（见下表） |
| `topic_key` | 同主题归并键（`fact_type + topic_key` 相同视为同一事实的演化） |
| `text` | 提炼后的事实文本 |
| `status` | 7 种状态之一（见下表） |
| `subject/object/assignee_entity_id` | 外键 → `memory_entities`，三元组角色 |
| `due_at` / `occurred_at` | 截止时间 / 发生时间（检索路由的结构化过滤字段） |
| `confidence` | 置信度（重复确认会合并提升） |
| `owner_relevance` | `direct`（与 owner 直接相关）/ `contextual`（上下文相关） |
| `is_current` + `supersedes_fact_id` + `valid_from/valid_to` | 生命周期：新事实不删旧的，标记旧的非 current 并回指 |
| `source_chunk_id` | 抽取来源 chunk |
| `extraction_model` / `prompt_version` | 溯源 |

**事实类型**（OFFICE_FACT_TYPES）：`ACTION_ITEM`（行动项）、`REQUEST`（请求）、`DELEGATION`（委托）、`COMMITMENT`（承诺）、`DECISION`（决策）、`STATUS`（状态）、`DEADLINE`（期限）、`RISK`（风险）

**事实状态**（OFFICE_FACT_STATUSES）：`open` / `done` / `cancelled` / `active` / `resolved` / `uncertain` / `superseded`。任务类（ACTION_ITEM/REQUEST/DELEGATION/COMMITMENT）用 open/done；状态类用 active/resolved。

### 节点（实体层，memory_entities）

| 字段 | 说明 |
|---|---|
| `entity_type` | `Person` / `Project` / `System` / `Organization` / `Document` / `Event` / `Unknown` |
| `normalized_key` | 归一化名（NFKC 小写去符号），去重主键的一部分 |
| `name` + `aliases_json` | 显示名与别名（别名可跨次抽取合并） |
| `mention_count` / `first_seen_at` / `last_seen_at` | 热度与时间范围 |

实体由抽取模型输出，或由结构边投影自动生成（如消息发送人必为 Person 实体）。

### 边（memory_edges）

统一 `source_type:source_id →(edge_type)→ target_type:target_id` 结构，端点类型为 `fact` / `message` / `entity` / `conversation`。按来源分两类：

**事实投影边**（`source_fact_id` 非空，随事实置信度）：

| edge_type | 语义 | 方向 |
|---|---|---|
| `ABOUT` | 事实关于某实体（properties 区分 subject/object 角色） | fact → entity |
| `ASSIGNED_TO` | 事实指派给某实体（人） | fact → entity |
| `EVIDENCE_FROM` | 事实的证据来自哪条消息 | fact → message |
| `SUPERSEDES` | 新事实取代旧事实 | fact → fact |

**结构投影边**（抽取时从会话结构自动生成，置信度 1）：

| edge_type | 语义 | 方向 |
|---|---|---|
| `PART_OF` | 消息属于会话 | message → conversation |
| `AUTHORED_BY` | 消息作者 | message → entity(Person) |
| `MENTIONS` | 消息 @ 了某人 | message → entity(Person) |
| `REPLY_TO` | 回复关系（解析 parent/root） | message → message |
| `TEMPORAL` | 同 chunk 内时序相邻 | message → message |

### 证据绑定（memory_fact_evidence + memory_chunk_messages）

- 每条事实**必须**绑定至少一条 primary 证据（写入前强制校验，只引 context 的事实被拒绝）
- `memory_chunks`：会话切片（90 分钟空闲边界 / 1400 Token / 20 条 primary 消息），`content_hash` 做幂等键
- `memory_chunk_messages`：chunk 与消息的多对多，`role` 区分 `primary`（被抽取）/ `context`（仅作上下文）——pending 判定依据 primary + completed

### 图上的检索路径

`search_office_context` 的 `graph.entity` 路由走两跳：查询 token 匹配 `memory_entities`（`mention_count` 优先）→ 沿 `ABOUT` 边（`source_type='fact' AND target_type='entity'`）取 current facts。`getFactEvidence` 展开事实时沿 `EVIDENCE_FROM` 取源消息，同时读 `ABOUT` 边的关联实体名。

### 运维表

`memory_sync_runs`（窗口同步审计）、`memory_extraction_runs`（每次抽取的模型/token/成本/原始输出）、`memory_retrieval_runs`（检索路由调试）、`memory_knowledge_changelog` + `memory_consumer_cursors`（变更日志与 FTS/语义游标，支持增量消费）。

## 分层结构

| 层 | 内容 | 写入者 |
|---|---|---|
| 原始层 | `memory_raw_records`：飞书 API 原始响应 | 任何 ingest |
| 消息层 | `memory_messages` / `memory_conversations`：规范化消息、revision | ingest |
| 索引层 | `memory_messages_fts`：全文检索 | FTS 游标 |
| 语义层 | `memory_chunks` / `memory_facts` / `memory_entities` / `memory_edges` | 事实抽取 |
| 运维层 | `memory_sync_runs` / `memory_extraction_runs` / `memory_retrieval_runs` | 各子系统 |

## 上下文准备（ContextPreparer）

`prepare_office_context` 是 Agent 唯一需要了解的准备入口（`src/agent/context-preparer.ts`）。单次调用内部完成：

1. `coverageFor` 计算已有覆盖，得出缺失时间窗列表
2. 逐窗调 `lark-cli im +messages-search` 拉取，截断时二分拆窗（`splitWindow`）
3. 对缺正文的消息批量 `+messages-mget` 水合
4. 幂等入库：相同消息重复拉取不重复入库，编辑产生新 revision
5. 最多一次有界事实更新（`semantic.enrich`），同 run 相同请求直接复用缓存

返回值只表达 `ready/partial`、消息覆盖和语义可用性，不暴露游标、水位或抽取开关。

### 时间戳约束

飞书 messages-search API 拒绝任何带毫秒段的 ISO 时间戳（包括 `.000`）。所有面向该 API 的窗口——预热范围、`splitWindow` 分裂结果、`missingRanges` 输出——统一使用秒级序列化（`floor(ms/1000)` + 去 `.SSS`）。秒边界处子窗口可能重叠 ≤1 秒，ingest 幂等使其无害。回归测试见 `test/context-preparer.test.ts`。

## 事实抽取（SemanticMemory.enrich）

- 只处理尚未由成功 chunk 覆盖的消息 revision（`pendingMessageCount`）
- 切片：按会话分组，90 分钟空闲边界、单 chunk 上限 1400 Token / 20 条 primary 消息，每片段补最多 5 条前文作 context（`src/memory/sessionizer.ts`）
- 抽取模型复用当前真实模型，思考强度 `low`，单 chunk 限时 2 分钟 / 4096 输出 Token
- 事实类型：ACTION_ITEM、REQUEST、DELEGATION、COMMITMENT、DECISION、STATUS、DEADLINE、RISK，必须绑定至少一条 primary 证据，否则写库前拒绝（`src/memory/fact-extractor.ts`）
- 事实生命周期：同一 `fact_type + topic_key` 的新事实不删除旧记录，而是标记非 current 并写 `SUPERSEDES` 边；消息编辑产生新 revision 时旧 revision 独占的事实失效；相同结论被新消息重复确认时合并证据与置信度
- 单 chunk 失败只留下可重试的 failed run，不阻塞 Agent 使用已同步的原文

## 混合检索（HybridMemoryRetriever.search）

`search_office_context` 并行召回五路，各路分数不可比，只用排名做 RRF 融合（k=60）：

- 事实 FTS（`local.fact_fts`）
- 原消息 FTS（`local.message_fts`）
- 一跳实体图（`graph.entity`）：查询 token 匹配实体 → 实体关联的 current facts
- 结构化过滤（`structured.facts` / `structured.owner_open`）：状态、期限、fact_type、owner 直接相关
- 时序最近消息（`recency.messages`，空 query 时）

融合后去重（含"已作为 fact evidence 出现的重复消息"），按 token 预算（默认 12000）装配。fact hit 返回压缩后的事实文本 + 实体 + 证据引用；message hit 返回截断 1500 字符的原文。`fact_...`/`mem_...` 仅作内部回查句柄，宿主脱敏层在最终回复强制移除。

## 防污染（guards.ts）

准入规则在数据库写入层执行，不依赖模型提示词：

- 收到 owner P2P 指令时宿主先把该 chat 标记 `assistant_control`，此会话所有消息不可检索
- `once` 等无事件 chat_id 的路径优先用应用 ID 识别自己的 P2P Bot 会话；取不到时仅在应用名唯一精确匹配一个会话时保守回填
- `origin=agent` 内容永久排除；空消息、Bot 会话、禁学习会话各有独立拒绝原因，保留审计能力
- 原始响应可保留用于重放，但只有通过准入守卫的消息进入 FTS 和证据检索

## 后台预热（MemoryWarmer）

- 启动后延迟（默认 30 秒）跑一次初始预热，之后按 `IM_BOT_PI_MEMORY_WARM_SCHEDULE`（默认 `07:30,12:30,23:00`，上海时区）固定时刻运行
- 每次把「回看窗口（默认 14 天）→ 当前」交给 `ContextPreparer`，单次抽取配额 10 chunk（在线 3）
- 并发安全：与在线请求共享 `ContextPreparer` 请求缓存；语义更新经 `semanticUpdate` 互斥——在线调用撞上后台抽取时复用/等待同一任务，不重复、不并发写
- schedule 在 `service:install`（`scripts/launchd.mjs validateConfig`）与运行时构造器双重校验，非法 HH:MM 拒绝启动
- 每次运行写 `memory_warmer_run_completed` 结构化日志；副作用可从 `memory_sync_runs` / `memory_chunks` 查证

## 稳态数据流

```
后台预热（固定时刻）──同步 14 天窗口──► 消息层+索引层热
       │
       └──抽取 pending──► 语义层（facts/entities/edges）

在线提问 ──agent 判断──► 记忆够 → search_office_memory/context（纯查库）
       │
       └─► 时效/缺口 → prepare_office_context（只补缺窗，在线配额 3 chunk）
                        或 run_lark_cli 直查（日历/任务/审批等不走记忆）
```

两次预热之间的新增消息由在线路径按缺窗补拉；实时直查成功的消息读取也会被 ingest 入库（不抽取，保持 pending）。

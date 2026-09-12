# 服务运行与消息处理

## 消息生命周期（src/service.ts）

```
飞书事件 im.message.receive_v1
  → acceptEvent: owner P2P 闸 + 去重（processed-messages.json / inFlight）
  → 入队（上限 maxQueue，超出回"请求较多"）
  → 立即回"正在处理"回执（幂等 key: messageId:stage）
  → drain 串行处理 processMessage：
      1. verifyUserAuthWithRetry（默认 3 次、线性退避 2s/4s，吸收 lark-cli 瞬时抖动）
      2. runtime.run()（Pi Agent，见下）
      3. 回复最终答案 → 写对话历史 → 记 processed → 写 usage ledger
      失败 → 按 replyOnError 回错误文案；台账记 runtime_failed/host_failed/delivery_failed
```

## 对话历史（多轮连续性）

- `conversationHistory`：内存中有界数组，默认 8 轮（4 组问答），60 分钟空闲自动清空
- 每轮注入 system prompt 末尾的 `<RECENT_CONVERSATION_JSON>` 块，单条截断 4000 字符
- 只记录成功投递的最终回复；历史仅用于指代消解与追问（system.md "Conversation continuity" 节），不作为办公证据
- 进程重启即清空（不落盘），与记忆系统完全隔离——assistant-control 会话仍被记忆准入排除

## Pi Agent 运行时（src/agent/pi-runtime.ts）

- 每条消息新建 `Agent`（`messages: []`），`sessionId` 仅为 provider 缓存标识
- system prompt = `runtime/system.md` + skill 目录 + `RUNTIME_CONTEXT_JSON`（上海时区、requestId 等）+ `RECENT_CONVERSATION_JSON`
- 工具白名单校验（`beforeToolCall`），`toolExecution: "parallel"`，最大 50 turn / 10 分钟超时
- 最终回复过脱敏（`redactInternalIdentifiers`：`oc_/om_/ou_/mem_/fact_` 等前缀替换）+ 截断（12000 字符）

## 鉴权与身份（src/adapters/lark-cli.ts）

- `ensureUserIdentity`：`auth status --json --verify`，要求 bot + user 双身份 verified，校验 owner open_id 未变
- 后台每 10 分钟定时校验（失败仅记日志）；消息处理路径走重试版
- `runReadOnlyCli`：执行前读命令声明的 Risk，仅放行 `Risk: read`；写命令、认证、事件消费、`--yes` 一律拒绝
- 事件消费：`event consume im.message.receive_v1`（NDJSON 流），退出后指数退避重启（上限 30 秒）

## 成本台账（src/infra/usage-ledger.ts）

- 每条飞书消息完成后聚合一条记录到 `var/usage-ledger.jsonl`（0600）
- 覆盖：Agent 主循环 usage + 事实抽取 usage（含后台预热触发的部分，经 onUsage 回传）
- 价格从 `.env` 读取，标记 `reference_estimate`（DMall Router 未返回价格，非实际结算）

## launchd 常驻（scripts/launchd.mjs）

- `install`：校验凭据存在 → `validateConfig`（含 warm schedule 格式）→ bootout 旧实例 → 写 plist（0600）→ bootstrap
- `KeepAlive` 崩溃自愈，`ThrottleInterval` 节流；配置错误在安装时即失败，不加载坏配置任务
- 日志：`logs/launchd.out.log`（stdout/stderr 合流）

## 配置速查

所有配置经 `.env`（`process.loadEnvFile`，shell 环境优先），完整清单见 `.env.example`。关键项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `IM_BOT_PI_MODEL` | gpt-5.6-luna | 模型 |
| `IM_BOT_PI_TIMEOUT_MS` | 600000 | 单请求总超时 |
| `IM_BOT_PI_MAX_TURNS` | 50 | Agent 轮数上限 |
| `IM_BOT_PI_HISTORY_TURNS` | 8 | 对话历史轮数（0 关闭） |
| `IM_BOT_PI_CONVERSATION_IDLE_RESET_MINUTES` | 60 | 历史空闲清空阈值 |
| `IM_BOT_PI_AUTH_VERIFY_MESSAGE_ATTEMPTS` | 3 | 消息路径鉴权重试次数 |
| `IM_BOT_PI_MEMORY_WARM_SCHEDULE` | 07:30,12:30,23:00 | 预热时刻（空=禁用） |
| `IM_BOT_PI_MEMORY_WARM_MAX_CHUNKS` | 10 | 后台单次抽取配额 |
| `IM_BOT_PI_MEMORY_MAX_CHUNKS` | 3 | 在线单次抽取配额 |

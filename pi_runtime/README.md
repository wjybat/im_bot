# Feishu Pi Agent Runtime

这是当前个人办公助手 Runtime。它以 `@earendil-works/pi-agent-core` 替代 `codex exec`，加载项目内版本化的集成 Skills 与流程 Skills，并由真实模型自主选择 Skill、参考资源和工具。当前首先接入飞书，真实运行默认使用 DMall AI Router 的 `gpt-5.6-luna`。

## 已实现

- TypeScript/Node.js 运行时，Node 要求 `>=22.19.0`。
- 每次请求创建独立 Pi `Agent`，上下文不会继承 Codex 的全局 Skills/插件。
- 完整同步本机 27 个 `lark-*` 集成 Skills，涵盖 IM、日历、任务、邮件、文档、云盘、审批、会议、妙记、OKR、表格、知识库等域。
- `load_skill` 渐进加载完整 `SKILL.md`，`read_skill_file` 读取任意 Skill 的引用、模板或工作流资源，`run_lark_cli` 执行飞书 Skill 选择的命令。
- 不维护自定义的飞书流程摘要 Skill，不在宿主里预设消息、日历或任务路由。
- Agent 自主选择工具；宿主不存在关键词到固定命令的路由。
- User 身份只用于个人数据读取；事件接收和最终回复使用 Bot 身份。
- Owner-only P2P 输入闸、串行队列、消息 ID 去重、幂等回复、定期用户凭据验证。
- 收到消息后立即发送“正在读取办公上下文”回执；处理完成后再发送最终回答。
- Runtime 超时、最大 turn、分页、工具输出和回复长度上限。
- Pi Token、缓存 Token、工具轨迹和基于官方价格的参考成本统计。
- 每条飞书消息一条聚合 Token/成本台账，记录成功、Runtime 失败和最终回复失败产生的实际用量。

## 验证

```bash
cd im_bot/pi_runtime
npm install --ignore-scripts
npm run verify
npm run demo
npm run smoke:lark
npm run test:real
```

`npm test` 中的 Faux Provider 只承担确定性的工具协议单元测试，不作为运行效果验收。

`smoke:lark` 仍使用本地 Faux 模型，但会通过真实 `lark-cli --as user` 执行当天消息只读检索；它只输出工具轨迹，不展示消息内容，也不发送飞书回复。

`test:real` 使用真实 `gpt-5.6-luna` 和真实飞书只读消息，检查模型自主加载 Skill、选择消息工具、执行多轮推理并生成不泄露内部 ID 的办公助理回答。

同步本机最新版官方 Skills：

```bash
npm run skills:sync
```

同步结果写入 `runtime/skills/integrations/lark/`，应随项目一起版本管理。后续平台集成放在 `integrations/`，稳定工作流放在 `workflows/`，项目定制能力放在 `custom/`。

当前项目工作流：

- `daily-work-brief`：当用户询问每日简报、日报、今日总结、目前要做什么或跨来源待办时，综合授权账号的消息、日历、任务及相关邮件、审批、会议和文档，形成昨日小结、今日规划、本周关注、备注四模块简报。

## 接入真实模型

项目启动时通过 Node.js 原生 `process.loadEnvFile()` 自动读取根目录 `.env`。显式 shell 或 launchd 环境变量优先，`.env` 只补充未设置项。`.env` 保存本机非敏感配置并被 Git 忽略；只提交 `.env.example`。

### DMall AI Router（当前）

```bash
export IM_BOT_PI_PROVIDER=dmall-ai
export IM_BOT_PI_BASE_URL=https://ai-router.dmall.com/v1
export IM_BOT_PI_MODEL=gpt-5.6-luna
npm run auth:set-dmall-key
```

`auth:set-dmall-key` 从标准输入读取密钥，写入 Git 忽略的 `var/pi-auth/auth.json`，文件权限为 `0600`。不要把密钥写进 `.env.example`、源码、launchd plist 或命令行参数。

### OpenAI Codex / ChatGPT Plus-Pro OAuth

```bash
export IM_BOT_PI_PROVIDER=openai-codex
npm run models
export IM_BOT_PI_MODEL='<从上一步输出选择的模型 ID>'
npm run auth:openai-codex
```

OAuth 凭据写入 `var/pi-auth/auth.json`，目录权限 `0700`、文件权限 `0600`。Runtime 使用 Pi 的自动刷新流程，不复用 `lark-cli` 或旧 Codex 的凭据。

### OpenAI 或 Anthropic API Key

```bash
export IM_BOT_PI_PROVIDER=openai
export IM_BOT_PI_MODEL='<model-id>'
export OPENAI_API_KEY='<secret>'
```

或设置 `IM_BOT_PI_PROVIDER=anthropic`、`ANTHROPIC_API_KEY`。不要把任何密钥写入仓库。

### 只运行一次，不回复飞书

```bash
npm run check
npm run once -- '整理一下今天有什么需要我处理的事情'
```

`once` 会真实读取当前用户可见的飞书数据，但只把回答打印到本地，不发送消息。

### 前台监听并回复

```bash
npm run listen
```

该命令会消费 `im.message.receive_v1`，只接受当前授权 owner 发给 Bot 的 P2P 文本/富文本消息，并由宿主以 Bot 身份发送处理中回执和最终回复。

### macOS 常驻服务

```bash
npm run service:install
npm run service:status
npm run service:uninstall
```

当前服务标签为 `com.local.im-data-collection.pi-bot`。launchd plist 只保存 HOME、PATH、`lark-cli` 和程序路径；Provider、模型、API 地址、思考强度及运行限制统一从 `.env` 读取。API Key 仍只保存在权限为 `0600` 的凭据文件中。

## 代码边界

```text
src/adapters/lark-cli.ts  飞书 CLI、User/Bot 身份与事件连接
src/service.ts            Owner 闸、队列、去重、刷新、回复
src/agent/pi-runtime.ts   Pi Agent 生命周期、turn/timeout/usage
src/agent/tools.ts        load/read/run 三个通用受控工具
runtime/system.md         Runtime 身份、安全和自主规划提示词
runtime/skills/integrations/lark/  版本化的飞书集成 Skills
runtime/skills/workflows/          稳定可复用的业务工作流 Skills
runtime/skills/custom/             项目自定义 Skills
src/demo/                 无外部写入的离线流程
```

Pi 没有获得通用 Bash、文件编辑或飞书写工具。`run_lark_cli` 会在执行前读取命令声明的 Risk，仅允许 `Risk: read`、Schema、事件元数据和通用 GET；写命令、认证变更、事件消费者和 `--yes` 会被宿主拒绝。模型不能直接发送回复；唯一远端写入路径仍是宿主的 `replyToMessage()`。

默认单次请求最多允许 50 个 Agent turn（可通过 `IM_BOT_PI_MAX_TURNS` 配置到 100），同时仍受 10 分钟 Runtime 总超时约束。

## Token 与成本台账

Pi 从 OpenAI Responses usage 中读取普通输入、缓存读取、缓存写入、输出和 reasoning Token。项目不会保存逐 turn 台账，只在每条飞书消息完成后把所有 turns 汇总为一条记录：

```text
var/usage-ledger.jsonl
```

台账文件权限为 `0600`，不包含消息正文或原始消息 ID。每条记录包括请求哈希、成功/失败状态、模型、总 turns、工具调用次数、聚合 Token、分项成本、总成本、价格快照和最终回复是否送达。

GPT-5.6 Luna 的参考价格从 `.env` 读取。默认采用 OpenAI 官方公开价格；DMall AI Router 未在 `/models` 返回价格，因此台账成本标记为 `reference_estimate`，不代表 DMall 内部实际结算账单。

## 当前生产化缺口

- Mac 睡眠时本地长连接仍会暂停；尚未实现唤醒后的消息补拉 checkpoint。
- 当前会话按请求隔离，尚未接入长期会话/SQLite 和记忆压缩策略。
- JSON 凭据存储只做进程内串行和原子替换，生产多进程部署需要跨进程文件锁或密钥服务。
- 日历读取权限当前可能缺失；Agent 会把它当可选来源并继续使用消息/任务。
- 已有处理中回执；尚未加入流式增量回答、失败分类卡片、重试队列和死信队列。
- 生产部署前需要容器/服务账户权限收敛、审计、指标、告警和依赖安全扫描。

Pi 源码固定信息见 [`THIRD_PARTY.md`](THIRD_PARTY.md)。

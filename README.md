# Feishu Pi Agent Runtime

个人飞书办公助手 Runtime。以 `@earendil-works/pi-agent-core` 驱动真实模型自主选择 Skill、参考资源和工具；宿主只负责身份校验、消息队列、记忆管线和回复发送，不做关键词路由。当前接入飞书，默认使用 DMall AI Router 的 `gpt-5.6-luna`。

## 能做什么

- **即时问答**：基于本地办公记忆（消息、事实、轻量图谱）回答消息/待办/决策类问题，必要时实时查飞书校验
- **每日工作简报**：`daily-work-brief` 工作流综合消息、日历、任务、审批、会议生成昨日小结/今日规划/本周关注
- **自主多域检索**：27 个 `lark-*` 集成 Skill 覆盖 IM、日历、任务、邮件、文档、云盘、审批、会议、妙记、OKR、表格、知识库等域
- **持续学习**：后台固定时刻预热同步消息并抽取事实，构建知识图谱；多轮对话连续性（追问可用）
- **成本可观测**：每条消息聚合 Token/成本台账

## 快速开始

```bash
cd im_bot/pi_runtime
npm install --ignore-scripts
npm run verify        # typecheck + 单测 + build
npm run demo          # 离线 Faux 演示
npm run smoke:lark    # 真实 lark-cli 只读链路冒烟
npm run test:real     # 真实模型 + 真实飞书只读验收
npm run test:real:memory  # 内存库跑通完整记忆链路
```

## 配置与运行

项目启动时通过 `process.loadEnvFile()` 自动读取根目录 `.env`（shell 环境优先，`.env` 只补充）。`.env` 被 Git 忽略，只提交 `.env.example`。完整配置清单见 `.env.example` 与 [`docs/runtime.md`](docs/runtime.md#配置速查)。

### 接入模型

- **DMall AI Router（当前）**：`IM_BOT_PI_PROVIDER=dmall-ai` + `npm run auth:set-dmall-key`，密钥写入 `var/pi-auth/auth.json`（0600）
- **OpenAI Codex OAuth**：`IM_BOT_PI_PROVIDER=openai-codex` + `npm run auth:openai-codex`
- **API Key**：`openai` / `anthropic` + 对应 `*_API_KEY`

不要把任何密钥写进仓库、plist 或命令行参数。

### 运行方式

```bash
npm run check                          # 只验连通，不回复
npm run once -- '今天有什么要处理的'    # 真实读取，回答只打印本地
npm run listen                         # 前台监听并回复
npm run reset                          # 预览要清空的记忆库文件
npm run reset -- --yes                 # 清空记忆库（聊天记录 + 图谱，不可恢复；先停 listen）
npm run graph                          # 本地起知识图谱可视化（只读，默认 http://127.0.0.1:4319）
npm run graph -- --host 0.0.0.0 --port 4319   # 服务器上开放局域网访问
npm run service:install                # macOS launchd 常驻
npm run service:status
npm run service:uninstall
```

服务标签 `com.local.im-data-collection.pi-bot`。只接受当前授权 owner 发给 Bot 的 P2P 文本/富文本消息；launchd 安装时会校验配置（含预热 schedule 格式），坏配置拒绝安装。

## 架构索引

```text
src/main.ts               入口：demo/smoke/check/models/once/listen 子命令
src/service.ts            消息闸、队列、鉴权重试、对话历史、回复编排
src/adapters/lark-cli.ts  飞书 CLI、User/Bot 身份、事件流、只读风控
src/agent/pi-runtime.ts   Pi Agent 生命周期、turn/timeout/usage 聚合
src/agent/tools.ts        Skill 加载与受控工具的组合入口
src/agent/memory-tools.ts 五个记忆工具（status/prepare/search×2/evidence）
src/agent/context-preparer.ts  覆盖计算、缺窗同步、水合、单次事实更新
src/agent/memory-warmer.ts     固定时刻后台预热调度
src/memory/               SQLite 记忆库：规范化、切片、抽取、图、FTS、RRF
src/infra/                状态去重、成本台账、安全脱敏、日志
runtime/system.md         Runtime 身份、安全和自主规划提示词
runtime/skills/           版本化 Skills（integrations/workflows/custom）
test/                     单测 + 真实链路集成测试
```

**详细设计文档**：

- [`docs/runtime.md`](docs/runtime.md) —— 消息生命周期、对话历史、鉴权、launchd、配置速查
- [`docs/memory.md`](docs/memory.md) —— 记忆分层、上下文准备、事实抽取、混合检索、防污染、后台预热

## 安全边界

- Pi 没有通用 Bash、文件编辑或飞书写工具。`run_lark_cli` 执行前读命令声明的 Risk，仅放行 `Risk: read`；写命令、认证变更、`--yes` 一律拒绝
- 唯一远端写入路径是宿主的 `replyToMessage()`；模型不能自发消息
- 防污染硬闸在数据库写入层执行：助手控制私聊、Agent 自产内容、空内容不进入可检索记忆（详见 [`docs/memory.md`](docs/memory.md#防污染guards)）
- 最终回复强制脱敏内部标识（app/open/chat/message ID、token、内存句柄）

## 当前限制

- Mac 睡眠时长连接暂停，尚未实现唤醒后补拉 checkpoint
- 记忆已覆盖消息/事实/图谱与后台预热；日历/任务/邮件/文档暂不走记忆，每次实时查
- 尚未实现流式增量回答、失败分类卡片、重试/死信队列
- 多进程部署需要跨进程文件锁或密钥服务（当前单进程假设）

Pi 源码固定信息见 [`THIRD_PARTY.md`](THIRD_PARTY.md)。

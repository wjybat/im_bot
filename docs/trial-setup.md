# 同事试用接入指南（单租户多用户模式）

> 一个飞书自建应用 + 多个同事各自 OAuth 授权。数据按用户完全隔离（记忆图谱、对话历史、成本台账独立）。

## 前置条件（管理员/你操作一次）

1. **应用可用范围**：飞书开发者后台 → 应用 → 应用可用范围 → 添加试用同事（或整个部门）
2. **事件订阅**：事件与回调 → 订阅方式选"使用长连接接收事件" → 添加事件：
   - `im.message.receive_v1`（接收消息）
   - `card.action.trigger`（卡片回调）
3. **权限（scope）**：权限管理中开通下方"用户授权 scope 清单"里的全部权限（应用侧开通后用户授权页才会出现）
4. **重定向 URL**：安全设置 → 重定向 URL 添加 `https://<你的域名或隧道地址>/oauth/callback`（本地试用可用 ngrok/cloudflared 隧道）

## 启动多用户模式

`.env` 配置：

```bash
# 同事的 open_id 列表（逗号分隔；为空则回退单用户模式）
IM_BOT_PI_ALLOWED_USER_OPEN_IDS=ou_xxx,ou_yyy
# 应用凭据（开发者后台 凭证与基本信息 页）
IM_BOT_PI_MULTI_APP_ID=cli_xxx
IM_BOT_PI_MULTI_APP_SECRET=xxx
# OAuth 回调（本地试用：先起隧道，把公网地址填这里）
IM_BOT_PI_OAUTH_CALLBACK_PORT=37731
IM_BOT_PI_OAUTH_PUBLIC_BASE_URL=https://your-tunnel.example.com
```

启动：

```bash
npm run listen
```

日志出现 `pi_multi_user_service_starting` 和 `oauth_server_listening` 即就绪。

## 同事首次使用流程

1. 同事在飞书里找到机器人，发送任意消息
2. 机器人回复一张**授权卡片**（"首次使用需要授权"）
3. 点击"点击授权"→ 浏览器打开飞书授权页 → 同意
4. 授权页显示"授权成功"→ 机器人紧接着发送欢迎卡片（含"今天的工作简报"按钮）
5. 之后正常问答，与单用户体验一致

用户 token 存储于 `var/tenant-user-tokens.json`（0600），自动刷新（2 小时过期、30 天 refresh 窗口）。超过 30 天未活跃的用户需要重新授权（会自动再次收到授权卡片）。

## 隔离边界

| 数据 | 隔离方式 |
|---|---|
| 记忆图谱（消息/事实/实体/边） | SQLite 按 `owner_key`（open_id 哈希）行级分区，同一 DB 文件 |
| 对话历史（多轮上下文） | 进程内按用户独立数组，60 分钟空闲各自重置 |
| 用户 token | `var/tenant-user-tokens.json` 每用户一条 |
| 成本台账 | 每条消息记录独立（暂无按用户汇总视图） |
| 消息去重 | 消息 ID 全局唯一，天然隔离 |
| 预热调度 | `MultiUserWarmer` 按授权用户逐个预热（顺序执行，配额与单用户相同） |

## 与单用户模式的关系

- `.env` 不设 `IM_BOT_PI_ALLOWED_USER_OPEN_IDS`（或为空）→ 原有单用户模式（lark-cli 通道），行为完全不变
- 多用户模式使用 **OpenApiGateway**（直连飞书 OpenAPI + 官方 SDK WebSocket），不再依赖 lark-cli

## 已知限制（PoC 阶段）

- 预热按用户串行，N 个用户一轮预热时长 ≈ N × 单用户时长
- `searchMessages` 水合为逐条 `message.get`（飞书未开放批量 mget 的 OpenAPI 等价物），大批量同步比 lark-cli 慢
- 无按用户成本配额/限流（所有人的 LLM 调用共用你的 key）
- `runReadOnlyCli` 在多用户模式不可用（agent 的 `run_lark_cli` 工具返回错误）；skills 引导的 CLI 读取需改走结构化工具——当前记忆工具（search/prepare/evidence/status）不受影响
- OAuth state 校验仅绑定发起用户，未加 CSRF 时效窗（PoC 可接受）

# Handoff: 多用户服务器部署调试（单租户，公司内部试用）

Date: 2026-09-15
Workspace: `im_bot/pi_runtime`（最新 commit `d7d7017 deployment support`；本机有 2 个未提交文件：503 重试增强，见下文"未提交改动"）
Previous handoff: `.handoff/2026-09-12-warming-welcome-card-reliability.md`
架构文档：`docs/memory.md`、`docs/runtime.md`、试用指南 `docs/trial-setup.md`

## 背景（本次会话主线）

用户要给公司内部同事试用工作简报机器人。决策路径：放弃多租户/上云方案 → 聚焦**单租户多用户**（一个飞书自建应用 + 同事各自 OAuth 授权），部署在**内网服务器**（无公网 IP，OAuth 回调用内网地址可行）。

## 已完成的实现（全部已提交，除注明外）

- `src/tenant/` 模块族：`OpenApiGateway`（直连飞书 OpenAPI + WSClient 长连接，替代 lark-cli）、`TenantTokenStore`（多用户 token 持久化 `var/tenant-user-tokens.json`）、`UserTokenManager`（OAuth code 交换 + 刷新）、`MultiUserService`（允许名单 + token 双闸 + OAuth 授权卡片 + 回调 HTTP 端点）、`OwnerMemoryRouter`（按 owner_key 懒加载隔离的记忆实例）、`MultiUserWarmer`
- `service.ts` 可覆写钩子化：`resolveOwner`/`isAllowedUser`/`beforeProcessMessage`/`enqueueAccepted`；对话历史按用户 Map
- `run_lark_cli` 在 OpenApiGateway 下优雅降级（`RunLarkCliUnsupportedError` → 引导文本）
- 流中断重试（`runtimeStreamRetries`，默认 2 次）；检索配额（`memorySearchCallsPerRun`，默认 8 次/run，两搜索工具共享）
- 预热窗口拆分：初始预热 `memoryWarmInitialLookbackDays`（默认 7 天），常规滚动 `memoryWarmLookbackDays`（默认 14 天，幂等前滚）
- 测试 52 个全绿（`npm run verify`）

## 未提交改动（本机工作区）

- `src/agent/pi-runtime.ts`：`isRetryableStreamError` 扩展覆盖网关过载（`OpenAI API error (503/502/500/504/429)` → 整轮重试）
- `test/stream-retry.test.ts`：新增 503 重试测试
- **需要 commit + 同步到服务器**（服务器还跑的旧版没有 503 重试）
- `.playwright-mcp/`、`bot.log` 是误入工作区的杂项，应加 .gitignore 或删除

## 飞书应用状态（关键事实）

- 新应用：**门店智能体im上下文总结工具** `cli_aa2d25b9eff6dd18`，1.0.0 **已发布**（审核通过）
- 已配置：机器人能力、长连接事件订阅（`im.message.receive_v1` ✅ / `card.action.trigger` ❌ **未添加**——卡片按钮会无响应）、重定向 URL（内网 IP:37731）、可用范围=部分成员（**疑似成员列表为空，用户在排查消息收不到时未最终确认**）
- 权限已开通：消息/日程/任务全套用户身份 + `im:message:send_as_bot`；mail 未开（有意暂缓）
- 旧应用 `cli_aae695e79eb8dcee` = 用户个人单用户模式，仍在但本机 launchd 服务已停

## 服务器部署进展（当前卡点）

**已通**：消息事件接收（WS connected）→ 授权卡片 → OAuth 回调换 token → 欢迎卡片。多用户链路全通。

**踩过的坑（已解决）**：
1. 服务器曾误跑单用户模式（`.env` 漏多用户三件套）→ 连上旧应用发了欢迎卡
2. OAuth 20029 重定向不匹配 → 后台重定向 URL 与 `.env` 的 `OAUTH_PUBLIC_BASE_URL` 对齐后解决
3. `ECONNREFUSED 127.0.0.1:9999`：服务器 shell 有死代理环境变量 → `unset http_proxy https_proxy ...` 解决

**当前正在排查**：服务器连接 DMall AI Router 报
`Cannot connect to API: The socket connection was closed unexpectedly`
（Node 原生 fetch/undici 错误，出现在启动时 `runtime.check()` 或运行中）。已给用户三步排查（env proxy 残留 / curl 直连测试 / node fetch 测试），**等用户回结果**。疑似同代理问题域：OAuth 那次是 axios 吃代理变量，这次可能是 undici；另外注意 Node undici 不认小写 `http_proxy` 环境变量（只认 HTTP_PROXY 或全局 dispatcher 配置），若 env 里确有残留，unset 后必须**重启服务进程**。

**另一未决**：模型 503（DMall Router upstream_error）已通过本机重试代码缓解，但服务器未同步。

## 下一步清单（按序）

1. 等用户回服务器网络排查结果，解决 Router 连接问题
2. commit 未提交的 503 重试改动，同步服务器（git pull + 重启）
3. 后台补订阅 `card.action.trigger`（否则欢迎卡片按钮点了没反应）
4. 确认可用范围成员列表包含用户 + 试用同事
5. 用户首次完整问答验证（注意：授权后首问慢属预期——在线做 7 天窗口同步+抽取；或授权后重启服务让初始预热覆盖）
6. 稳定后：systemd 常驻 unit（`Restart=always`，journald 日志）、同事拉入试用

## 非显而易见的事实

- 多用户模式判定：`IM_BOT_PI_ALLOWED_USER_OPEN_IDS` 非空 或 `IM_BOT_PI_MULTI_USER=1`；名单留空+MULTI_USER=1 = 应用可用范围内所有人可授权试用
- 服务器 `.env` 最小配置见会话中（12 行版本）；凭据走 `npm run auth:set-dmall-key` 而非 .env
- 本机图谱数据：1567 facts / 2133 entities / 12186 edges，pending ~1（回填已清完）
- Playwright 浏览器已登录飞书开发者后台（用户扫码过），可直接操作后台页面；快照在 `.playwright-mcp/`
- lark-cli 不支持显式传 user token（已调研确认），多用户必须走 OpenApiGateway
- 日志：服务器前台/tmux 跑看 stdout 或重定向文件；本机 launchd 是 `logs/launchd.out.log`

## Suggested skills

- **lark-shared**：处理服务器上任何 lark-cli/auth/代理类问题时先读（鉴权、权限边界）
- **lark-im**：卡片回调（`card.action.trigger` 订阅问题）、消息发送语义相关时
- **lark-event**：事件订阅/长连接行为排查时
- **diagnosing-bugs**：继续排查 Router 连接失败（socket closed unexpectedly）时
- **implement**：落实下一步清单的代码改动（systemd unit、授权后触发预热等）

## 验证命令

```bash
cd im_bot/pi_runtime && npm run verify          # 52 tests
# 服务器侧：
env | grep -i proxy                             # 必须为空
curl -s https://ai-router.dmall.com/v1/models -o /dev/null -w "%{http_code}\n"
node -e "fetch('https://ai-router.dmall.com/v1/models').then(r=>console.log(r.status)).catch(e=>console.log(e.cause?.code))"
```

## Sensitivity

应用 App ID 属于内部标识非机密；App Secret、DMALL_AI_API_KEY、用户 token 均不在本文档中。不要提交 `.env`、`var/`、`bot.log`、`.playwright-mcp/`。

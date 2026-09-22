# Handoff: memory-api 对外函数接口（im_bot）

**Date:** 2026-09-22
**Workspace:** `/Users/wangjuanyi/repo/im_data_collection/im_bot`（Mac 本地开发；生产在服务器 `10.12.6.143`，systemd 部署，GitHub 同步）
**Prior handoffs:** `.handoff/handoff-2026-09-18-im-bot.md`（机器人运维）、`.handoff/handoff-2026-09-20-graph-viewer.md`（图谱可视化，已提交为 `674a0ab`）

## What this session did

1. **实现 memory-api**（未提交，本次会话全部改动）：`src/memory-api/`（server/handlers/entity-queries/refresh-jobs/rate-limit/tools 六个文件）+ config/types/main 接线 + `.env.example`（memory-api 配置已全部启用）+ `test/memory-api.test.ts` + `docs/memory-api.md`。8 个 Bearer 鉴权函数、per-token 限流、owner 校验、快慢刷新分离、出口脱敏（`redactInternalIdentifiers`）。设计决策与函数清单见 `docs/memory-api.md`，不在此重复。verify 全绿 64/64；曾对真实 DB 副本做过只读冒烟（搜索孙海洋 → 40 事实/41 关联）。
2. **`GET /v1/tools` 工具清单端点**（`src/memory-api/tools.ts`）：8 个函数的 OpenAI function-calling 格式（JSON Schema + instructions），供门店智能体团队程序化注册工具。注意其中 statuses/factTypes 枚举必须与 `src/memory/semantic-types.ts` 的 `OFFICE_FACT_TYPES`/`OFFICE_FACT_STATUSES` 同步维护。
3. **union_id 身份映射**：`UserTokenRecord` 新增 `ownerUnionId`，OAuth exchange/refresh 时从飞书响应捕获（token 2h 过期，存量用户下次刷新自动回填）；memory-api 请求支持 `ownerOpenId` 或 `ownerUnionId` 二选一；`main.ts` 通过 `resolveOwnerByUnionId` 接线。
4. **生产部署改造**：新增 `systemd/im-bot.service.template`（占位符 `__NODE__/__ROOT__/__USER__`，ExecStart 用 `dist/src/main.js listen`——注意 dist 路径含 `src/`）；README 全面修订（新增 systemd 部署章节、删除所有 Mac/launchd 内容、修正过时路径 `cd im_bot/pi_runtime`→`cd im_bot`）。launchd 目录与 npm scripts 保留（本地开发可用），仅 README 不再记载。
5. **用户已确认的架构事实**（问答沉淀，后续会话直接引用）：
   - 不打包 npm 库、不暴露 prepare_office_context 原样语义；服务必须与 bot 同进程（单写者假设）
   - graph-viewer 是给人的调试台，不对外；agent 走 memory-api
   - 飞书 ID 语义：open_id 应用维度、union_id **开发商账号维度（不是租户维度）**、user_id 租户维度（需通讯录权限）；同租户自建应用 ≈ 同开发商 ≈ union_id 一致；验证方法是拿真实用户两边各查一次 union_id 对值

## Repo state / open items

- **全部 memory-api 相关改动未提交**（用户上轮确认过"直接 main 提交、不新开分支"，本轮尚未要求提交；`git status` 有 M: .env.example/README/src/config.ts/src/main.ts/src/types.ts，??: src/memory-api/、test/memory-api.test.ts、docs/memory-api.md、systemd/、本 handoff）
- 服务器部署步骤见 README「生产部署」一节；上线时 `.env` 只需改 `IM_BOT_PI_MEMORY_API_HOST`（内网 IP）和 `IM_BOT_PI_MEMORY_API_KEYS`
- 门店智能体对接前必须先确认 union_id 前提（同开发商与否），403 即需映射层（user_id 或通讯录）
- token 失效返回 `owner_reauth_required` 的判定目前是错误消息正则（`src/memory-api/server.ts`），较脆弱，可考虑结构化错误码
- 次要遗留：memory-api 的 token 换 tokenStore 里 user token 刷新与 bot 内部刷新可能并发（低风险，WAL 承受）；graph-viewer 仍有 favicon 404、`.playwright-mcp/` 未清理

## Suggested skills

- **implement** —— 继续迭代 memory-api（如 user_id 映射支持、MCP 薄封装）或机器人侧 fact-extraction-async 待办（见 prior handoff 2026-09-18）。
- **code-review** —— 用户要求提交或评审本次未提交改动时。
- **diagnosing-bugs** —— 门店智能体对接后报告的调用异常；套路：只读探针脚本放 `/var/folders/.../T/opencode/`（本机临时目录），改完 `npm run verify`。
- **handoff** —— 下个长会话结束时照例写交接。

## Sensitive-info notes

`.env`、`var/pi-auth/`、`var/tenant-user-tokens.json`（含 owner open_id/union_id）未读取未泄露；owner 内部标识不落文档。规则同 prior handoffs。

# Handoff: 知识图谱可视化 graph-viewer（im_bot）

**Date:** 2026-09-20
**Workspace:** `/Users/wangjuanyi/repo/im_data_collection/im_bot`（Mac 本地；机器人本体 24/7 跑在服务器 `10.12.6.143`，本仓与服务器通过 GitHub 同步）
**Prior handoffs:** `.handoff/handoff-2026-09-18-im-bot.md`（机器人运维上下文，不在此重复）

## What this session did

1. **选型决策**：针对记忆库图谱可视化，调研后选定 AntV G6 4.8.24（CDN）+ node:http 只读接口方案；否决了 Sigma.js（量级不够）、React Flow（无需编辑）、OpenSPG 等重型平台。依据：语义子图只有几千节点/几千边，canvas 力导向足够。
2. **实现 `src/graph-viewer.ts`**（新文件，单文件零新依赖，约 870 行）：
   - 服务端：`node:sqlite` 只读打开记忆库；`GET /api/graph?limit=&types=&showFacts=&owner=` 与 `GET /api/entity?id=&owner=`
   - 数据设计：默认视图从 `memory_facts`（`is_current=1`）投影实体↔实体边（主体→对象 label=fact_type；主体→受理人橙色虚线）；`showFacts=1` 切换实体-事实-实体三部图；**结构/溯源边（PART_OF/EVIDENCE_FROM/TEMPORAL/SUPERSEDES）刻意不导出**——画出来是毛球
   - 前端：内嵌单页（TS 模板字符串 `PAGE_HTML`），力导向布局、`entity_type` 着色（Unknown 默认隐藏）、节点大小=mention_count 对数、hover tooltip、点击高亮相邻+详情面板、搜索（含别名）、Top-N（100/300/600/all）、owner 下拉（多用户时出现）、边标签开关
   - G6 CDN：alipay（gw.alipayobjects.com）优先，unpkg 兜底，均失败显示错误提示
3. **npm script**：`"graph": "tsx src/graph-viewer.ts"`（package.json），参数 `--port`（默认 4319）/`--host`（默认 127.0.0.1）/`--db`（默认跟随 `IM_BOT_PI_MEMORY_FILE`）。README 运行方式一节已加两行用法。
4. **验证**：`npm run verify` 全绿（typecheck + 62 tests + build）；Playwright 实测默认视图 300 节点/269 边、事实视图 1236 节点/1497 边、全量+事实 3668 节点/1.8MB payload 可承受；搜索"孙海洋"定位+详情（40 事实+关联实体）正常。唯一 console 错误是 favicon 404（无害，未处理）。

## 数据事实（本地 `var/office-memory.db`，只读探测结果）

- **这份本地 DB 是服务器数据的副本**：用户 9-20 10:38 ssh 服务器做 commit `5ad1c96`（add reset sqllite data），10:59 本地 pull，11:00 启动 opencode，11:04 var/ 目录整体从服务器同步（所有文件同一时间戳；backfill2.log 记录 messages=2299/entities=2133/edges=12186 与本地规模吻合）。本地从未跑过 bot listen（ps/lsof 无进程，launchd 未安装）。
- 库内：2,156 实体（Unknown 1184/Project 248/System 219/Person 169/Document 167/Event 94/Organization 75）、1,514 当前事实（1,506 条同时有主体+对象实体）、12,308 边（其中语义边 ABOUT/AUTHORED_BY/ASSIGNED_TO 共 5,822，其余为结构边）。
- `-wal`/`-shm` 是 WAL 模式伴生文件，非独立数据库，无需清理。

## Known open items / next steps

- **未提交**：`git status` 有未提交改动（README.md、package.json 修改，新增 `src/graph-viewer.ts`、`.handoff/2026-09-15-multi-user-server-deployment.md`）。用户未要求提交，勿主动 commit。
- `.playwright-mcp/` 目录是浏览器测试产物，未清理、未 ignore。
- 可能的后续（用户未确认要做）：服务器部署（`npm run graph -- --host 0.0.0.0`，需服务器浏览器能访问外网 CDN）；边点击详情；节点拖拽后布局重算；favicon 404。
- 事实抽取异步化仍是机器人侧的待办（见 prior handoff）。

## Suggested skills

- **implement** —— 继续迭代 graph-viewer 功能（如上 open items）或机器人侧 fact-extraction-async 工作。
- **diagnosing-bugs** —— 用户报告图谱页面/接口异常时；套路同 prior handoff：只读探针脚本放临时目录、改完 `npm run verify`。
- **code-review** —— 提交 graph-viewer 前若用户想审查本次改动。
- **handoff** —— 下个长会话结束时照例写交接。

## Sensitive-info notes

owner_key、实体人名等为库内数据，已在文档中尽量少引；`.env`、`var/pi-auth/auth.json`、`var/tenant-user-tokens.json` 均未读取/未泄露，规则同 prior handoff。

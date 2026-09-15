# 调研：SQLite 知识图谱 vs Markdown 目录式知识库（OKF 形态）

> 调研日期：2026-09-12。对比本项目的 SQLite 知识图谱实现与 Google Open Knowledge Format（OKF）为代表的"markdown 目录 + YAML frontmatter"式知识库。
> 本库结构见 `docs/memory.md`，能力概述见 `docs/knowledge-graph-overview.md`。

## 参考来源

- OKF 官方 spec（v0.2）：`https://github.com/GoogleCloudPlatform/open-knowledge-format`（原 `GoogleCloudPlatform/knowledge-catalog/okf` 已冻结迁移）
- AIX Format（OKF 严格超集，社区）：`https://github.com/DavidROliverBA/aix-format`
- 生态示例：wiki-as-an-mcp、okf-conformance、gemini-okf-compiler 等

## 两种形态的本质

**OKF 形态**：知识 = 目录树里的 `.md` 文件。YAML frontmatter 放可查询字段（`type` 唯一必填，可选 `status`/`sources`/`verified`/`stale_after`），正文放给人读的 markdown，文件间用普通 markdown 链接构成"图"（超越目录父子关系的关联），每层 `index.md` 做渐进式披露——agent 逐层浏览而非全量加载。

**本实现**：知识 = SQLite 里的结构化行。四类节点（消息/事实/实体/会话）+ 有类型边，检索走五路混合路由（双 FTS + 实体图一跳 + 结构化过滤 + 时序），RRF 融合后按 token 预算装配，消费方是确定的单一 agent runtime。

## OKF 形态的优势

1. **零依赖可读**：`cat` 即读，无 SDK/查询语言门槛，人和 agent 消费同一份产物
2. **git 原生协作**：diff/blame/PR/review 直接用于知识治理——本实现需靠 `memory_sync_runs`/`extraction_runs` 审计表间接模拟
3. **可移植可交换**：bundle 是目录，跨组织、跨 agent 框架共享；本实现绑定自有 schema
4. **生态现成**：Obsidian/Notion/MkDocs 直接渲染浏览，无需自建 UI
5. **信任与生命周期 first-class**（v0.2 核心设计）：
   - `sources` 记录逐源可信度信号（author/usage_count/last_modified），消费方自行推断信任，而非存储主观分数
   - `verified` 三级信任档（unverified / machine-confirmed / human-reviewed）
   - `stale_after` 显式过期声明——本实现只有 `confidence` 数值和 `is_current` 标志，缺少"过期时间"语义
6. **Attested Computation**（§10，独有能力）：概念可携带"如何重算这个值"的确定性代码 + 验证器（executor/attester/receipt 三件套），知识自带可复算性

## OKF 形态的劣势（正是本实现做成数据库的理由）

1. **检索天花板低**：靠 frontmatter 扫描和全文 grep。无 BM25 排序融合、无多路 RRF、无 token 预算装配——简报类查询（"今天所有 open 的行动项"）需遍历目录树过滤，数千文件即数千次 IO
2. **高频写入不可用**：每条事实一个文件（400+ facts = 400+ 文件 + 目录管理）；消息的幂等去重、revision 替换、事务一致性在文件系统上无法实现
3. **图遍历弱**：链接无类型（AIX 的核心批评，其以 `depends-on`/`supersedes`/`contradicts` 类型边作为超集扩展）；"实体 → 关联事实一跳"需爬文件解析链接
4. **一致性无保障**：无事务；并发更新与部分失败靠 git 手工收拾

## 结论：不是替代关系，是分层关系

| 维度 | 适合 OKF 形态 | 适合 SQLite 图 |
|---|---|---|
| 内容性质 | 策划过的稳定知识（数据目录、Playbook、文档） | 高频流动的事实（消息流、待办状态） |
| 写入频率 | 低频、人审 | 每分钟、自动 |
| 查询模式 | 导航式浏览、逐层披露 | 过滤式检索、多路召回 |
| 消费者 | 异构（多人/多 agent/多工具） | 单一运行时 |

## 对本项目的两个可借鉴点

1. **信任三层设计**：sources 逐源信号 → 推断信任档 → `stale_after` 过期。OKF 承认"agent 生产的知识需要可衰减的可信度"，比单一 `confidence` 数值更合理。可考虑给 `memory_facts` 增加 `stale_after` 类字段（如按事实类型设定默认保鲜期：STATUS 短、DECISION 长）。
2. **导出格式**：若未来要把图谱产出（如每周简报结论）沉淀为可分享、可 review 的知识资产，导出成 OKF bundle 是正确出口，而非让人读 SQLite。图谱做热数据，OKF 做冷沉淀。

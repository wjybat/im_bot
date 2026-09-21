import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { resolve } from "node:path"
import { projectRoot } from "./config.js"

type SqlRow = Record<string, unknown>

function row<T extends SqlRow>(value: unknown): T | null {
  return typeof value === "object" && value !== null ? (value as T) : null
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return value
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, Math.max(0, max - 1)) + "…" : value
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

interface ViewerOptions {
  host: string
  port: number
  dbPath: string
}

interface GraphParams {
  limit: number
  types: string[] | null
  showFacts: boolean
  owner: string | null
}

interface GraphNodePayload {
  id: string
  nodeType: "entity" | "fact"
  label: string
  entityType: string | null
  factType: string | null
  mentions: number
  degree: number
  text: string | null
  aliases: string[]
}

interface AggregatedEdge {
  source: string
  target: string
  kind: "rel" | "assigned" | "subject" | "object" | "assignee"
  label: string
  count: number
  samples: string[]
  factTypes: Record<string, number>
}

interface EntityRow extends SqlRow {
  id: string
  entity_type: string
  name: string
  aliases_json: string
  mention_count: number
}

interface FactRow extends SqlRow {
  id: string
  fact_type: string
  text: string
  subject_entity_id: string | null
  object_entity_id: string | null
  assignee_entity_id: string | null
}

function parseArgs(argv: readonly string[]): ViewerOptions {
  const options: ViewerOptions = {
    host: "127.0.0.1",
    port: 4319,
    dbPath: resolve(projectRoot, process.env.IM_BOT_PI_MEMORY_FILE || "var/office-memory.db"),
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === "--port") {
      const value = argv[++i]
      const port = value === undefined ? Number.NaN : Number.parseInt(value, 10)
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail("--port 需要一个 1-65535 的端口号")
      options.port = port
    } else if (arg === "--host") {
      const value = argv[++i]
      if (value === undefined || value === "") fail("--host 需要一个监听地址")
      options.host = value
    } else if (arg === "--db") {
      const value = argv[++i]
      if (value === undefined || value === "") fail("--db 需要一个数据库文件路径")
      options.dbPath = resolve(value)
    } else {
      fail(`未知参数 ${arg}；用法: npm run graph -- [--port N] [--host H] [--db PATH]`)
    }
  }
  return options
}

function parseGraphParams(url: URL): GraphParams {
  const limitRaw = url.searchParams.get("limit") ?? "300"
  let limit = 0
  if (limitRaw !== "all" && limitRaw !== "0") {
    const parsed = Number.parseInt(limitRaw, 10)
    limit = Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100000) : 300
  }
  const typesRaw = url.searchParams.get("types")
  const types =
    typesRaw === null
      ? null
      : typesRaw
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value !== "")
  const showFacts = url.searchParams.get("showFacts") === "1"
  const ownerRaw = url.searchParams.get("owner")
  const owner = ownerRaw !== null && ownerRaw !== "" ? ownerRaw : null
  return { limit, types, showFacts, owner }
}

function parseAliases(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === "string").slice(0, 12)
    }
  } catch {
    return []
  }
  return []
}

function listOwners(db: DatabaseSync): Array<{ key: string; entities: number }> {
  return db
    .prepare("SELECT owner_key, COUNT(*) AS entities FROM memory_entities GROUP BY owner_key ORDER BY entities DESC")
    .all()
    .map((value) => {
      const ownerRow = row<{ owner_key: unknown; entities: unknown }>(value)
      return { key: text(ownerRow?.owner_key), entities: numberValue(ownerRow?.entities) }
    })
}

function listEntityTypes(db: DatabaseSync, owner: string | null): Array<{ type: string; count: number }> {
  const sql =
    "SELECT entity_type AS type, COUNT(*) AS count FROM memory_entities" +
    (owner !== null ? " WHERE owner_key = ?" : "") +
    " GROUP BY entity_type ORDER BY count DESC"
  const args = owner !== null ? [owner] : []
  return db.prepare(sql).all(...args).map((value) => {
    const typeRow = row<{ type: unknown; count: unknown }>(value)
    return { type: text(typeRow?.type), count: numberValue(typeRow?.count) }
  })
}

function loadEntities(db: DatabaseSync, params: GraphParams): EntityRow[] {
  const conditions: string[] = []
  const args: Array<string | number> = []
  if (params.owner !== null) {
    conditions.push("owner_key = ?")
    args.push(params.owner)
  }
  if (params.types !== null) {
    conditions.push("entity_type IN (" + params.types.map(() => "?").join(",") + ")")
    args.push(...params.types)
  }
  let sql = "SELECT id, entity_type, name, aliases_json, mention_count FROM memory_entities"
  if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ")
  sql += " ORDER BY mention_count DESC, name ASC"
  if (params.limit > 0) {
    sql += " LIMIT ?"
    args.push(params.limit)
  }
  return db.prepare(sql).all(...args).flatMap((value) => {
    const entityRow = row<EntityRow>(value)
    return entityRow === null ? [] : [entityRow]
  })
}

function loadCurrentFacts(db: DatabaseSync, owner: string | null): FactRow[] {
  const sql =
    "SELECT id, fact_type, text, subject_entity_id, object_entity_id, assignee_entity_id FROM memory_facts WHERE is_current = 1" +
    (owner !== null ? " AND owner_key = ?" : "")
  const args = owner !== null ? [owner] : []
  return db.prepare(sql).all(...args).flatMap((value) => {
    const factRow = row<FactRow>(value)
    return factRow === null ? [] : [factRow]
  })
}

function countEntities(db: DatabaseSync, owner: string | null): number {
  const sql = "SELECT COUNT(*) AS count FROM memory_entities" + (owner !== null ? " WHERE owner_key = ?" : "")
  const args = owner !== null ? [owner] : []
  return numberValue(row<{ count: unknown }>(db.prepare(sql).get(...args))?.count)
}

function countCurrentFacts(db: DatabaseSync, owner: string | null): number {
  const sql = "SELECT COUNT(*) AS count FROM memory_facts WHERE is_current = 1" + (owner !== null ? " AND owner_key = ?" : "")
  const args = owner !== null ? [owner] : []
  return numberValue(row<{ count: unknown }>(db.prepare(sql).get(...args))?.count)
}

function buildGraph(db: DatabaseSync, params: GraphParams): Record<string, unknown> {
  const owners = listOwners(db)
  const entityTypes = listEntityTypes(db, params.owner)
  const entities = loadEntities(db, params)
  const facts = loadCurrentFacts(db, params.owner)

  const selected = new Set<string>()
  const nodes = new Map<string, GraphNodePayload>()
  for (const entity of entities) {
    selected.add(entity.id)
    nodes.set(entity.id, {
      id: entity.id,
      nodeType: "entity",
      label: entity.name,
      entityType: entity.entity_type,
      factType: null,
      mentions: numberValue(entity.mention_count),
      degree: 0,
      text: null,
      aliases: parseAliases(entity.aliases_json),
    })
  }

  const edges = new Map<string, AggregatedEdge>()
  const addEdge = (
    source: string,
    target: string,
    kind: AggregatedEdge["kind"],
    label: string,
    factType: string,
    sample: string,
  ): void => {
    const key = [source, target, kind, factType].join("\u0000")
    const existing = edges.get(key)
    if (existing === undefined) {
      edges.set(key, {
        source,
        target,
        kind,
        label,
        count: 1,
        samples: [truncate(sample, 120)],
        factTypes: { [factType]: 1 },
      })
      return
    }
    existing.count += 1
    existing.factTypes[factType] = (existing.factTypes[factType] ?? 0) + 1
    if (existing.samples.length < 5) existing.samples.push(truncate(sample, 120))
  }

  for (const fact of facts) {
    const subject = nullableText(fact.subject_entity_id)
    const object = nullableText(fact.object_entity_id)
    const assignee = nullableText(fact.assignee_entity_id)
    if (params.showFacts) {
      const related = [subject, object, assignee].some((id) => id !== null && selected.has(id))
      if (!related) continue
      const factNodeId = "f:" + fact.id
      nodes.set(factNodeId, {
        id: factNodeId,
        nodeType: "fact",
        label: truncate(fact.text, 30),
        entityType: null,
        factType: fact.fact_type,
        mentions: 0,
        degree: 0,
        text: fact.text,
        aliases: [],
      })
      if (subject !== null && selected.has(subject)) addEdge(factNodeId, subject, "subject", "主体", fact.fact_type, fact.text)
      if (object !== null && selected.has(object)) addEdge(factNodeId, object, "object", "对象", fact.fact_type, fact.text)
      if (assignee !== null && selected.has(assignee)) addEdge(factNodeId, assignee, "assignee", "受理", fact.fact_type, fact.text)
    } else {
      if (subject !== null && object !== null && selected.has(subject) && selected.has(object)) {
        addEdge(subject, object, "rel", fact.fact_type, fact.fact_type, fact.text)
      }
      if (subject !== null && assignee !== null && selected.has(subject) && selected.has(assignee)) {
        addEdge(subject, assignee, "assigned", "受理", fact.fact_type, fact.text)
      }
    }
  }

  const edgeList = Array.from(edges.values())
  for (const edge of edgeList) {
    const source = nodes.get(edge.source)
    const target = nodes.get(edge.target)
    if (source !== undefined) source.degree += 1
    if (target !== undefined) target.degree += 1
  }

  const nodeList = Array.from(nodes.values())
  const factNodes = nodeList.filter((node) => node.nodeType === "fact").length
  return {
    owners,
    entityTypes,
    stats: {
      entitiesSelected: nodeList.length - factNodes,
      entitiesTotal: countEntities(db, params.owner),
      factsTotal: countCurrentFacts(db, params.owner),
      nodes: nodeList.length,
      edges: edgeList.length,
    },
    nodes: nodeList,
    edges: edgeList,
  }
}

function entityDetail(db: DatabaseSync, url: URL): Record<string, unknown> | null {
  const id = url.searchParams.get("id")
  if (id === null || id === "") return null
  const ownerRaw = url.searchParams.get("owner")
  const owner = ownerRaw !== null && ownerRaw !== "" ? ownerRaw : null

  const entityRow = row<EntityRow & { first_seen_at: unknown; last_seen_at: unknown }>(
    db
      .prepare(
        "SELECT id, entity_type, name, aliases_json, mention_count, first_seen_at, last_seen_at FROM memory_entities WHERE id = ?",
      )
      .get(id),
  )
  if (entityRow === null) return null

  const factSql =
    "SELECT id, fact_type, text, status, due_at, occurred_at, owner_relevance FROM memory_facts " +
    "WHERE is_current = 1 AND (subject_entity_id = ? OR object_entity_id = ? OR assignee_entity_id = ?)" +
    (owner !== null ? " AND owner_key = ?" : "") +
    " ORDER BY occurred_at DESC LIMIT 100"
  const factArgs: string[] = owner !== null ? [id, id, id, owner] : [id, id, id]
  const facts = db.prepare(factSql).all(...factArgs).map((value) => {
    const fact = row<SqlRow>(value) ?? {}
    return {
      factType: text(fact.fact_type),
      text: text(fact.text),
      status: text(fact.status),
      dueAt: numberValue(fact.due_at),
      occurredAt: numberValue(fact.occurred_at),
      ownerRelevance: text(fact.owner_relevance),
    }
  })

  const factFilter = owner !== null ? "is_current = 1 AND owner_key = ?" : "is_current = 1"
  const subquery = (column: string, target: string): string =>
    "SELECT " + column + " FROM memory_facts WHERE " + factFilter + " AND " + target + " = ?"
  const relatedSql =
    "SELECT DISTINCT e.id, e.name, e.entity_type FROM memory_entities e WHERE e.id IN (" +
    [
      subquery("object_entity_id", "subject_entity_id"),
      subquery("assignee_entity_id", "subject_entity_id"),
      subquery("subject_entity_id", "object_entity_id"),
      subquery("assignee_entity_id", "object_entity_id"),
      subquery("subject_entity_id", "assignee_entity_id"),
      subquery("object_entity_id", "assignee_entity_id"),
    ].join(" UNION ") +
    ") LIMIT 100"
  const relatedArgs: string[] = []
  for (let i = 0; i < 6; i++) {
    if (owner !== null) relatedArgs.push(owner)
    relatedArgs.push(id)
  }
  const related = db.prepare(relatedSql).all(...relatedArgs).map((value) => {
    const relatedRow = row<SqlRow>(value) ?? {}
    return { name: text(relatedRow.name), entityType: text(relatedRow.entity_type) }
  })

  return {
    entity: {
      id: entityRow.id,
      name: entityRow.name,
      entityType: entityRow.entity_type,
      mentions: numberValue(entityRow.mention_count),
      aliases: parseAliases(entityRow.aliases_json),
      firstSeenAt: numberValue(entityRow.first_seen_at),
      lastSeenAt: numberValue(entityRow.last_seen_at),
    },
    facts,
    related,
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(payload))
}

function handleRequest(db: DatabaseSync, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "GET only" })
    return
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(PAGE_HTML)
    return
  }
  if (url.pathname === "/api/graph") {
    sendJson(res, 200, buildGraph(db, parseGraphParams(url)))
    return
  }
  if (url.pathname === "/api/entity") {
    const detail = entityDetail(db, url)
    if (detail === null) {
      sendJson(res, 404, { error: "entity not found" })
      return
    }
    sendJson(res, 200, detail)
    return
  }
  sendJson(res, 404, { error: "not found" })
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  if (!existsSync(options.dbPath)) {
    fail(`数据库不存在: ${options.dbPath}（用 --db 指定，或设置 IM_BOT_PI_MEMORY_FILE）`)
  }
  const db = new DatabaseSync(options.dbPath, { readOnly: true })
  const server = createServer((req, res) => {
    try {
      handleRequest(db, req, res)
    } catch (error) {
      sendJson(res, 500, { error: String(error) })
    }
  })
  server.listen(options.port, options.host, () => {
    console.log(`知识图谱视图: http://${options.host}:${options.port}`)
    console.log(`数据库: ${options.dbPath}（只读）`)
  })
  const shutdown = (): void => {
    server.close()
    db.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

const PAGE_PART_1 = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>记忆知识图谱</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  #app { display: flex; height: 100%; }
  #side { width: 330px; min-width: 330px; border-right: 1px solid #e3e6ea; background: #fafbfc; padding: 14px; overflow-y: auto; }
  #container { flex: 1; position: relative; }
  h1 { font-size: 16px; margin: 0 0 12px; color: #22303f; }
  .group { margin-bottom: 14px; font-size: 12px; color: #333; }
  .group .head { display: block; font-weight: 600; margin-bottom: 4px; color: #555; }
  select, input[type=text] { width: 100%; padding: 4px 6px; border: 1px solid #ccd2d8; border-radius: 4px; font-size: 12px; }
  .checks label { display: inline-flex; align-items: center; gap: 4px; margin: 2px 8px 2px 0; cursor: pointer; white-space: nowrap; font-size: 12px; }
  .checks input { margin: 0; }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
  #stats { font-size: 12px; color: #666; margin-bottom: 14px; line-height: 1.7; }
  #stats .warn { color: #c0392b; }
  #legend { font-size: 11px; color: #555; line-height: 2; margin-bottom: 14px; border-top: 1px dashed #e0e4e8; padding-top: 10px; }
  #legend b { display: block; font-size: 12px; margin-bottom: 2px; }
  #legend .sw { margin-right: 4px; }
  #legend span { margin-right: 12px; white-space: nowrap; }
  #detail { font-size: 12px; }
  #detail h3 { margin: 0 0 4px; font-size: 14px; }
  .sec { font-weight: 600; color: #555; margin: 12px 0 4px; border-top: 1px dashed #ddd; padding-top: 8px; }
  .fact { padding: 4px 0; border-bottom: 1px solid #f0f2f4; line-height: 1.5; }
  .tip-sub { font-size: 11px; color: #999; }
  .fact .tip-sub { display: block; }
  .chip { display: inline-block; border: 1px solid #bbb; border-radius: 10px; padding: 0 8px; margin: 2px 4px 2px 0; font-size: 11px; }
  #search-row { display: flex; gap: 6px; }
  #search-row button { padding: 4px 10px; font-size: 12px; cursor: pointer; }
  #search-msg { font-size: 11px; color: #c0392b; min-height: 14px; }
  #loading { position: absolute; top: 10px; left: 10px; background: rgba(255,255,255,0.92); border: 1px solid #d8dce0; border-radius: 4px; padding: 4px 10px; font-size: 12px; color: #555; }
  #hint { position: absolute; bottom: 10px; left: 10px; font-size: 11px; color: #98a0a8; }
  #cdn-error { background: #fdecea; color: #b71c1c; border: 1px solid #f5c6cb; border-radius: 4px; padding: 8px; font-size: 12px; margin-bottom: 10px; }
  .g6-tooltip { background: rgba(255,255,255,0.96) !important; border: 1px solid #d8dce0; border-radius: 6px; padding: 8px 10px !important; font-size: 12px; color: #333; max-width: 340px; box-shadow: 0 2px 8px rgba(0,0,0,0.12); line-height: 1.5; }
</style>
</head>
<body>
<div id="app">
  <aside id="side">
    <h1>记忆知识图谱</h1>
    <div id="cdn-error" hidden>G6 加载失败，请检查浏览器能否访问外网 CDN（gw.alipayobjects.com / unpkg.com），或手动下载 g6.min.js 后替换页面内引用。</div>
    <div class="group">
      <label class="head">数据归属（owner）</label>
      <select id="owner" hidden></select>
    </div>
    <div class="group">
      <label class="head">实体规模上限</label>
      <select id="limit">
        <option value="100">Top 100（按提及次数）</option>
        <option value="300" selected>Top 300</option>
        <option value="600">Top 600</option>
        <option value="all">全部</option>
      </select>
    </div>
    <div class="group">
      <label class="head">实体类型</label>
      <div class="checks" id="types"></div>
    </div>
    <div class="group">
      <label class="head">视图</label>
      <div class="checks">
        <label><input type="checkbox" id="showFacts"> 显示事实节点（实体-事实-实体）</label><br>
        <label><input type="checkbox" id="edgeLabels"> 显示边标签</label>
      </div>
    </div>
    <div class="group">
      <label class="head">搜索实体</label>
      <div id="search-row">
        <input type="text" id="search" placeholder="名称或别名，回车搜索">
        <button id="search-btn">定位</button>
      </div>
      <div id="search-msg"></div>
    </div>
    <div id="stats">加载中…</div>
    <div id="legend"></div>
    <div id="detail"></div>
  </aside>
  <main id="container">
    <div id="loading" hidden>加载中…</div>
    <div id="hint">拖拽平移 · 滚轮缩放 · 拖动节点 · 点击节点看详情</div>
  </main>
</div>
<script>
function g6Fallback() {
  if (window.__g6FallbackTried) return
  window.__g6FallbackTried = true
  var s = document.createElement('script')
  s.src = 'https://unpkg.com/@antv/g6@4.8.24/dist/g6.min.js'
  s.onerror = function () { document.getElementById('cdn-error').hidden = false }
  document.head.appendChild(s)
}
</script>
<script src="https://gw.alipayobjects.com/os/lib/antv/g6/4.8.24/dist/g6.min.js" onerror="g6Fallback()"></script>
<script>
(function () {
  var TYPE_COLORS = { Person: '#5B8FF9', Project: '#5AD8A6', System: '#F6BD16', Document: '#7262FD', Event: '#6DC8EC', Organization: '#9270CA', Unknown: '#C2C8D2' }
  var FACT_COLOR = '#FF9D4D'
  var state = { limit: '300', showFacts: false, edgeLabels: false, owner: '', payload: null, graph: null, typesBuilt: false }

  function el(id) { return document.getElementById(id) }
  function esc(v) { var d = document.createElement('div'); d.textContent = v == null ? '' : String(v); return d.innerHTML }
  function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s }
  function fmtDate(ms) {
    if (!ms) return ''
    var d = new Date(ms)
    function p(x) { return x < 10 ? '0' + x : '' + x }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }

  function checkedTypes() {
    var boxes = document.querySelectorAll('#types input[type=checkbox]')
    var all = true
    var checked = []
    boxes.forEach(function (b) {
      if (b.checked) checked.push(b.value)
      else all = false
    })
    return all ? null : checked
  }

  function buildQuery() {
    var p = new URLSearchParams()
    p.append('limit', state.limit)
    p.append('showFacts', state.showFacts ? '1' : '0')
    var types = checkedTypes()
    if (types !== null) p.append('types', types.join(','))
    if (state.owner) p.append('owner', state.owner)
    return p.toString()
  }

  function ownerQuery() { return state.owner ? '&owner=' + encodeURIComponent(state.owner) : '' }

  function reload() {
    el('loading').hidden = false
    fetch('/api/graph?' + buildQuery())
      .then(function (r) { return r.json() })
      .then(function (payload) {
        state.payload = payload
        renderOwnerSelect(payload.owners)
        buildTypeChecks(payload.entityTypes)
        renderStats(payload)
        renderLegend()
        draw(payload)
      })
      .catch(function (err) { el('stats').textContent = '加载失败: ' + err })
      .finally(function () { el('loading').hidden = true })
  }

  function renderOwnerSelect(owners) {
    var sel = el('owner')
    if (!owners || owners.length < 2) { sel.hidden = true; return }
    sel.hidden = false
    if (sel.options.length === owners.length) return
    owners.forEach(function (o) {
      var opt = document.createElement('option')
      opt.value = o.key
      opt.textContent = trunc(o.key, 8) + '… (' + o.entities + ')'
      sel.appendChild(opt)
    })
  }

  function buildTypeChecks(types) {
    var box = el('types')
    var prev = {}
    if (state.typesBuilt) {
      box.querySelectorAll('input').forEach(function (b) { prev[b.value] = b.checked })
    }
    box.innerHTML = ''
    types.forEach(function (t) {
      var label = document.createElement('label')
      var cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.value = t.type
      cb.checked = state.typesBuilt ? (prev[t.type] !== undefined ? prev[t.type] : t.type !== 'Unknown') : t.type !== 'Unknown'
      cb.addEventListener('change', reload)
      var sw = document.createElement('span')
      sw.className = 'sw'
      sw.style.background = TYPE_COLORS[t.type] || '#bbb'
      label.appendChild(cb)
      label.appendChild(sw)
      label.appendChild(document.createTextNode(' ' + t.type + ' '))
      var count = document.createElement('span')
      count.className = 'tip-sub'
      count.textContent = '(' + t.count + ')'
      label.appendChild(count)
      box.appendChild(label)
    })
    state.typesBuilt = true
  }

  function renderStats(p) {
    var s = p.stats
    var html = '当前视图: <b>' + s.nodes + '</b> 节点 / <b>' + s.edges + '</b> 边<br>库内: 实体 ' + s.entitiesTotal + ' · 当前事实 ' + s.factsTotal
    if (s.nodes > 2000) html += '<br><span class="warn">节点较多，布局可能较慢，建议缩小规模上限</span>'
    el('stats').innerHTML = html
  }

  function renderLegend() {
    var html = '<b>图例</b><div>'
    Object.keys(TYPE_COLORS).forEach(function (k) {
      html += '<span><span class="sw" style="background:' + TYPE_COLORS[k] + '"></span>' + k + '</span>'
    })
    html += '</div><div><span><span class="sw" style="background:' + FACT_COLOR + '"></span>事实节点</span><span><span class="sw" style="background:#F6903D"></span>受理关系</span><span><span class="sw" style="background:#C4CAD6"></span>主体→对象</span></div>'
    el('legend').innerHTML = html
  }

  function nodeSize(n) {
    if (n.nodeType === 'fact') return 10
    return Math.max(14, Math.min(46, 12 + 7 * Math.log2(1 + (n.mentions || 0))))
  }

  function nodeColor(n) {
    return n.nodeType === 'fact' ? FACT_COLOR : (TYPE_COLORS[n.entityType] || '#B8BEC9')
  }

  function toG6Data(payload) {
    var factNodeCount = 0
    payload.nodes.forEach(function (n) { if (n.nodeType === 'fact') factNodeCount++ })
    var showFactLabels = factNodeCount <= 150
    var nodes = payload.nodes.map(function (n) {
      var isFact = n.nodeType === 'fact'
      var showLabel = isFact ? showFactLabels : (n.degree >= 3 || n.mentions >= 30)
      return {
        id: n.id,
        label: showLabel ? trunc(n.label, 14) : '',
        size: nodeSize(n),
        style: { fill: nodeColor(n), stroke: isFact ? '#E8863A' : '#fff', lineWidth: 1.5 },
        labelCfg: { position: 'bottom', offset: 4, style: { fill: isFact ? '#a05e2c' : '#444', fontSize: isFact ? 9 : 10 } },
        raw: n
      }
    })
    var edges = payload.edges.map(function (e) {
      var color = e.kind === 'assigned' ? '#F6903D' : (e.kind === 'rel' ? '#C4CAD6' : '#DFC9B2')
      var style = { stroke: color, lineWidth: 1 + Math.min(3, Math.log2(1 + e.count)) }
      if (e.kind === 'assigned') style.lineDash = [4, 4]
      return {
        source: e.source,
        target: e.target,
        label: state.edgeLabels ? (e.label + (e.count > 1 ? ' ×' + e.count : '')) : '',
        style: style,
        raw: e
      }
    })
    return { nodes: nodes, edges: edges }
  }

  function buildTooltip() {
    return new G6.Tooltip({
      itemTypes: ['node', 'edge'],
      getContent: function (e) {
        var m = e.item.getModel()
        var r = m.raw
        if (!r) return ''
        if (r.nodeType === 'fact') return '<b>[' + esc(r.factType) + ']</b><br>' + esc(r.text)
        if (r.nodeType === 'entity') {
          var alias = (r.aliases && r.aliases.length) ? '<br><span style="color:#999">别名: ' + esc(r.aliases.join(', ')) + '</span>' : ''
          return '<b>' + esc(r.label) + '</b><br><span style="color:#999">' + esc(r.entityType) + ' · 提及 ' + r.mentions + ' · 度 ' + r.degree + '</span>' + alias
        }
        var samples = r.samples.slice(0, 3).map(function (s) {
          return '<br><span style="color:#999">· ' + esc(s) + '</span>'
        }).join('')
        return '<b>' + esc(r.label) + (r.count > 1 ? ' ×' + r.count : '') + '</b>' + samples
      }
    })
  }

  function clearStates(graph) {
    graph.getNodes().forEach(function (n) { graph.clearItemStates(n) })
    graph.getEdges().forEach(function (e) { graph.clearItemStates(e) })
  }

  function highlightNeighbors(graph, id) {
    clearStates(graph)
    graph.getNodes().forEach(function (n) { graph.setItemState(n, 'inactive', true) })
    graph.getEdges().forEach(function (e) { graph.setItemState(e, 'inactive', true) })
    var node = graph.findById(id)
    if (!node) return
    graph.setItemState(node, 'inactive', false)
    graph.setItemState(node, 'active', true)
    graph.getNeighbors(node).forEach(function (nb) {
      graph.setItemState(nb, 'inactive', false)
      graph.setItemState(nb, 'active', true)
    })
    graph.getEdges().forEach(function (e) {
      var m = e.getModel()
      if (m.source === id || m.target === id) {
        graph.setItemState(e, 'inactive', false)
        graph.setItemState(e, 'active', true)
      }
    })
  }

  function draw(payload) {
    var data = toG6Data(payload)
    if (!state.graph) {
      state.graph = new G6.Graph({
        container: 'container',
        modes: { default: ['drag-canvas', 'zoom-canvas', 'drag-node'] },
        defaultNode: { type: 'circle' },
        defaultEdge: { type: 'line', style: { endArrow: true } },
        nodeStateStyles: { active: { stroke: '#1c2733', lineWidth: 2.5 }, inactive: { opacity: 0.12 } },
        edgeStateStyles: { active: { stroke: '#334455' }, inactive: { opacity: 0.05 } },
        layout: { type: 'force', linkDistance: 80, nodeStrength: -80, collide: 18, alphaDecay: 0.02 },
        plugins: [buildTooltip()],
        minZoom: 0.05,
        maxZoom: 20
      })
      state.graph.on('node:click', function (e) {
        var model = e.item.getModel()
        highlightNeighbors(state.graph, model.id)
        showDetail(model.raw)
      })
      state.graph.on('canvas:click', function () { clearStates(state.graph) })
      state.graph.data(data)
      state.graph.render()
    } else {
      state.graph.changeData(data)
    }
    setTimeout(function () {
      if (state.graph) state.graph.fitView(20)
    }, 1000)
  }

  function showDetail(r) {
    var d = el('detail')
    if (r.nodeType === 'fact') {
      d.innerHTML = '<h3>[' + esc(r.factType) + ']</h3><div class="fact">' + esc(r.text) + '</div>'
      return
    }
    d.innerHTML = '<h3>' + esc(r.label) + '</h3><p class="tip-sub">' + esc(r.entityType) + ' · 提及 ' + r.mentions + '</p><p id="detail-body" class="tip-sub">加载详情…</p>'
    fetch('/api/entity?id=' + encodeURIComponent(r.id) + ownerQuery())
      .then(function (res) { return res.json() })
      .then(renderEntityDetail)
      .catch(function (err) {
        var body = document.getElementById('detail-body')
        if (body) body.textContent = '加载失败: ' + err
      })
  }

  function renderEntityDetail(p) {
    var e = p.entity
    var html = '<h3>' + esc(e.name) + '</h3>'
    html += '<p class="tip-sub">' + esc(e.entityType) + ' · 提及 ' + e.mentions + ' · 首见 ' + fmtDate(e.firstSeenAt) + ' · 最近 ' + fmtDate(e.lastSeenAt) + '</p>'
    if (e.aliases && e.aliases.length) html += '<p class="tip-sub">别名: ' + esc(e.aliases.join(', ')) + '</p>'
    if (p.related && p.related.length) {
      html += '<p class="sec">关联实体 (' + p.related.length + ')</p><p>'
      p.related.forEach(function (re) {
        html += '<span class="chip" style="border-color:' + (TYPE_COLORS[re.entityType] || '#bbb') + '">' + esc(re.name) + '</span>'
      })
      html += '</p>'
    }
    html += '<p class="sec">相关事实 (' + p.facts.length + (p.facts.length >= 100 ? '，已达上限' : '') + ')</p>'
    p.facts.forEach(function (f) {
      html += '<div class="fact"><b>[' + esc(f.factType) + ']</b> ' + esc(f.text) +
        '<span class="tip-sub">' + fmtDate(f.occurredAt) + (f.dueAt ? ' · 截止 ' + fmtDate(f.dueAt) : '') + ' · ' + esc(f.ownerRelevance) + '</span></div>'
    })
    el('detail').innerHTML = html
  }

  function doSearch() {
    var q = el('search').value.trim().toLowerCase()
    var msg = el('search-msg')
    msg.textContent = ''
    if (!q || !state.payload) return
    var hit = null
    var nodes = state.payload.nodes
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      if (n.nodeType !== 'entity') continue
      if (n.label.toLowerCase().indexOf(q) >= 0) { hit = n; break }
      var aliases = n.aliases || []
      for (var j = 0; j < aliases.length; j++) {
        if (aliases[j].toLowerCase().indexOf(q) >= 0) { hit = n; break }
      }
      if (hit) break
    }
    if (!hit) { msg.textContent = '未找到匹配实体'; return }
    var item = state.graph && state.graph.findById(hit.id)
    if (!item) { msg.textContent = '不在当前筛选结果中，请调整类型/规模上限'; return }
    state.graph.focusItem(item, true, { duration: 300 })
    highlightNeighbors(state.graph, hit.id)
    showDetail(hit)
  }

  function init() {
    el('limit').addEventListener('change', function (e) { state.limit = e.target.value; reload() })
    el('showFacts').addEventListener('change', function (e) { state.showFacts = e.target.checked; reload() })
    el('edgeLabels').addEventListener('change', function (e) { state.edgeLabels = e.target.checked; if (state.payload) draw(state.payload) })
    el('owner').addEventListener('change', function (e) { state.owner = e.target.value; reload() })
    el('search-btn').addEventListener('click', doSearch)
    el('search').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch() })
    reload()
  }

  var bootTries = 0
  function boot() {
    if (window.G6) { init(); return }
    if (bootTries++ < 20) { setTimeout(boot, 300); return }
    el('cdn-error').hidden = false
  }
  boot()
})()
</script>
</body>
</html>`

const PAGE_HTML = PAGE_PART_1

main()

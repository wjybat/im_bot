import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { OfficeMemory } from "./office-memory.js"
import { toFtsMatch, toSearchTokens } from "./normalize.js"
import { estimateMemoryTokens } from "./sessionizer.js"
import type {
  HybridSearchEvidence,
  HybridSearchHit,
  HybridSearchInput,
  HybridSearchResult,
  OfficeFactStatus,
  OfficeFactType,
} from "./semantic-types.js"

type SqlRow = Record<string, unknown>

interface RankedList {
  source: string
  ids: string[]
}

interface FusedCandidate {
  id: string
  score: number
  routes: Array<{ source: string; rank: number }>
}

interface FactRow extends SqlRow {
  id: string
  fact_type: OfficeFactType
  topic_key: string
  text: string
  status: OfficeFactStatus
  due_at: number | null
  occurred_at: number
  confidence: number
  is_current: number
}

interface MessageRow extends SqlRow {
  id: string
  content_text: string
  sent_at: number
  sender_display_name: string | null
  is_self: number | null
  conversation_type: string
  conversation_title: string | null
}

function row<T extends SqlRow>(value: unknown): T | null {
  return typeof value === "object" && value !== null ? (value as T) : null
}

function parseBoundary(value: string | undefined, field: string): number | null {
  if (value === undefined || value.trim() === "") return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be an ISO-8601 date-time`)
  return parsed
}

function shanghaiTime(timestamp: number): string {
  return `${new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ")} +08:00`
}

function memoryRef(id: string): string {
  return `mem_${id}`
}

function factRef(id: string): string {
  return `fact_${id}`
}

function normalizeForDedup(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "")
}

export function fuseRrf(lists: readonly RankedList[], topK: number, k = 60): FusedCandidate[] {
  const values = new Map<string, FusedCandidate>()
  for (const list of lists) {
    list.ids.forEach((id, index) => {
      const rank = index + 1
      const current = values.get(id) ?? { id, score: 0, routes: [] }
      current.score += 1 / (k + rank)
      current.routes.push({ source: list.source, rank })
      values.set(id, current)
    })
  }
  return [...values.values()]
    .sort((a, b) => b.score - a.score || b.routes.length - a.routes.length || a.id.localeCompare(b.id))
    .slice(0, topK)
}

export class HybridMemoryRetriever {
  private readonly db: DatabaseSync
  private readonly ownerKey: string

  constructor(memory: OfficeMemory) {
    this.db = memory.semanticDatabase()
    this.ownerKey = memory.semanticOwnerKey()
  }

  search(input: HybridSearchInput = {}): HybridSearchResult {
    const query = input.query?.trim() ?? ""
    const start = parseBoundary(input.start, "start")
    const end = parseBoundary(input.end, "end")
    const dueStart = parseBoundary(input.dueStart, "dueStart")
    const dueEnd = parseBoundary(input.dueEnd, "dueEnd")
    if (start !== null && end !== null && start > end) throw new Error("start must not be after end")
    if (dueStart !== null && dueEnd !== null && dueStart > dueEnd) throw new Error("dueStart must not be after dueEnd")
    const limit = Math.max(1, Math.min(input.limit ?? 20, 50))
    const tokenBudget = Math.max(500, Math.min(input.tokenBudget ?? 12_000, 64_000))
    const lists = this.buildRoutes(query, input, start, end, dueStart, dueEnd, Math.max(limit * 3, 30))
    const fused = fuseRrf(lists, Math.max(limit * 4, 60))
    const resolved = this.resolveCandidates(fused, limit * 2, input, start, end, dueStart, dueEnd)
    const deduped = this.deduplicate(resolved).slice(0, limit)
    const packed = this.packContext(deduped, tokenBudget)
    const debug = {
      routes: lists.map((list) => ({ source: list.source, count: list.ids.length })),
      fusedCount: fused.length,
      packedCount: packed.hits.length,
    }
    this.db.prepare(
      `INSERT INTO memory_retrieval_runs
       (id, owner_key, query, filters_json, route_debug_json, selected_refs_json,
        estimated_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      this.ownerKey,
      query,
      JSON.stringify({
        start: input.start ?? null,
        end: input.end ?? null,
        dueStart: input.dueStart ?? null,
        dueEnd: input.dueEnd ?? null,
        chatType: input.chatType ?? null,
        factTypes: input.factTypes ?? [],
        statuses: input.statuses ?? [],
        currentOnly: input.currentOnly ?? true,
      }),
      JSON.stringify(debug),
      JSON.stringify(packed.hits.map((hit) => hit.ref)),
      packed.tokens,
      Date.now(),
    )
    return {
      query,
      hits: packed.hits,
      contextText: packed.text,
      estimatedTokens: packed.tokens,
      truncated: packed.truncated,
      debug,
    }
  }

  getFactEvidence(refs: readonly string[]): HybridSearchHit[] {
    const hits: HybridSearchHit[] = []
    for (const ref of [...new Set(refs)].slice(0, 20)) {
      if (!/^fact_[a-f0-9]{64}$/u.test(ref)) continue
      const fact = this.readFact(ref.slice(5))
      if (fact !== null) hits.push({ ...fact, score: 1, routes: [{ source: "direct", rank: 1 }] })
    }
    return hits
  }

  private buildRoutes(
    query: string,
    input: HybridSearchInput,
    start: number | null,
    end: number | null,
    dueStart: number | null,
    dueEnd: number | null,
    routeLimit: number,
  ): RankedList[] {
    const lists: RankedList[] = []
    const match = query === "" ? null : toFtsMatch(query)
    if (match !== null) {
      const facts = this.db.prepare(
        `SELECT fact_id FROM memory_facts_fts
         WHERE memory_facts_fts MATCH ? AND owner_key = ?
         ORDER BY bm25(memory_facts_fts) ASC LIMIT ?`,
      ).all(match, this.ownerKey, routeLimit)
      lists.push({
        source: "local.fact_fts",
        ids: facts.flatMap((value) => {
          const item = row<{ fact_id: string }>(value)
          return item === null ? [] : [`fact:${item.fact_id}`]
        }),
      })
      const messagesWhere = ["memory_messages_fts MATCH ?", "m.owner_key = ?", "m.learning_eligible = 1"]
      const messageParams: Array<string | number> = [match, this.ownerKey]
      if (start !== null) {
        messagesWhere.push("m.sent_at >= ?")
        messageParams.push(start)
      }
      if (end !== null) {
        messagesWhere.push("m.sent_at <= ?")
        messageParams.push(end)
      }
      if (input.chatType) {
        messagesWhere.push("c.type = ?")
        messageParams.push(input.chatType)
      }
      const messages = this.db.prepare(
        `SELECT m.id FROM memory_messages_fts
         JOIN memory_messages m ON m.id = memory_messages_fts.message_id
         JOIN memory_conversations c ON c.id = m.conversation_id
         WHERE ${messagesWhere.join(" AND ")}
         ORDER BY bm25(memory_messages_fts) ASC, m.sent_at DESC LIMIT ?`,
      ).all(...messageParams, routeLimit)
      lists.push({
        source: "local.message_fts",
        ids: messages.flatMap((value) => {
          const item = row<{ id: string }>(value)
          return item === null ? [] : [`message:${item.id}`]
        }),
      })
      const graphIds = this.graphFactIds(query, routeLimit)
      if (graphIds.length > 0) lists.push({ source: "graph.entity", ids: graphIds.map((id) => `fact:${id}`) })
    }

    const factWhere = ["owner_key = ?"]
    const factParams: Array<string | number> = [this.ownerKey]
    if (input.currentOnly ?? true) factWhere.push("is_current = 1")
    if (start !== null) {
      factWhere.push("occurred_at >= ?")
      factParams.push(start)
    }
    if (end !== null) {
      factWhere.push("occurred_at <= ?")
      factParams.push(end)
    }
    if (dueStart !== null) {
      factWhere.push("due_at >= ?")
      factParams.push(dueStart)
    }
    if (dueEnd !== null) {
      factWhere.push("due_at <= ?")
      factParams.push(dueEnd)
    }
    if (input.factTypes && input.factTypes.length > 0) {
      factWhere.push(`fact_type IN (${input.factTypes.map(() => "?").join(",")})`)
      factParams.push(...input.factTypes)
    }
    if (input.statuses && input.statuses.length > 0) {
      factWhere.push(`status IN (${input.statuses.map(() => "?").join(",")})`)
      factParams.push(...input.statuses)
    }
    const structured = this.db.prepare(
      `SELECT id FROM memory_facts WHERE ${factWhere.join(" AND ")}
       ORDER BY CASE owner_relevance WHEN 'direct' THEN 0 ELSE 1 END,
                CASE status WHEN 'open' THEN 0 WHEN 'active' THEN 1 WHEN 'uncertain' THEN 2 ELSE 3 END,
                CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, occurred_at DESC
       LIMIT ?`,
    ).all(...factParams, routeLimit)
    lists.push({
      source: "structured.facts",
      ids: structured.flatMap((value) => {
        const item = row<{ id: string }>(value)
        return item === null ? [] : [`fact:${item.id}`]
      }),
    })

    if (query === "") {
      const ownerOpen = this.db.prepare(
        `SELECT id FROM memory_facts
         WHERE owner_key = ? AND is_current = 1 AND owner_relevance = 'direct'
           AND fact_type IN ('ACTION_ITEM','REQUEST','DELEGATION','COMMITMENT','DEADLINE','RISK')
           AND status IN ('open','active','uncertain')
         ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, occurred_at DESC
         LIMIT ?`,
      ).all(this.ownerKey, routeLimit)
      lists.push({
        source: "structured.owner_open",
        ids: ownerOpen.flatMap((value) => {
          const item = row<{ id: string }>(value)
          return item === null ? [] : [`fact:${item.id}`]
        }),
      })
    }

    const messageWhere = ["m.owner_key = ?", "m.learning_eligible = 1"]
    const recencyParams: Array<string | number> = [this.ownerKey]
    if (start !== null) {
      messageWhere.push("m.sent_at >= ?")
      recencyParams.push(start)
    }
    if (end !== null) {
      messageWhere.push("m.sent_at <= ?")
      recencyParams.push(end)
    }
    if (input.chatType) {
      messageWhere.push("c.type = ?")
      recencyParams.push(input.chatType)
    }
    if (query === "") {
      const recentMessages = this.db.prepare(
        `SELECT m.id FROM memory_messages m JOIN memory_conversations c ON c.id = m.conversation_id
         WHERE ${messageWhere.join(" AND ")} ORDER BY m.sent_at DESC LIMIT ?`,
      ).all(...recencyParams, routeLimit)
      lists.push({
        source: "recency.messages",
        ids: recentMessages.flatMap((value) => {
          const item = row<{ id: string }>(value)
          return item === null ? [] : [`message:${item.id}`]
        }),
      })
    }
    return lists.filter((list) => list.ids.length > 0)
  }

  private graphFactIds(query: string, limit: number): string[] {
    const tokens = toSearchTokens(query).split(/\s+/u).filter((token) => token.length >= 2).slice(0, 12)
    if (tokens.length === 0) return []
    const conditions = tokens.map(() => "normalized_key LIKE ?")
    const entities = this.db.prepare(
      `SELECT id FROM memory_entities WHERE owner_key = ? AND (${conditions.join(" OR ")})
       ORDER BY mention_count DESC, last_seen_at DESC LIMIT 20`,
    ).all(this.ownerKey, ...tokens.map((token) => `%${token}%`))
    const ids = entities.flatMap((value) => {
      const item = row<{ id: string }>(value)
      return item === null ? [] : [item.id]
    })
    if (ids.length === 0) return []
    const facts = this.db.prepare(
      `SELECT edge.source_id AS id, MAX(edge.confidence) AS score, MAX(f.occurred_at) AS occurred_at
       FROM memory_edges edge JOIN memory_facts f ON f.id = edge.source_id
       WHERE edge.owner_key = ? AND edge.source_type = 'fact' AND edge.target_type = 'entity'
         AND edge.target_id IN (${ids.map(() => "?").join(",")}) AND f.is_current = 1
       GROUP BY edge.source_id ORDER BY score DESC, occurred_at DESC LIMIT ?`,
    ).all(this.ownerKey, ...ids, limit)
    return facts.flatMap((value) => {
      const item = row<{ id: string }>(value)
      return item === null ? [] : [item.id]
    })
  }

  private resolveCandidates(
    candidates: readonly FusedCandidate[],
    cap: number,
    input: HybridSearchInput,
    start: number | null,
    end: number | null,
    dueStart: number | null,
    dueEnd: number | null,
  ): HybridSearchHit[] {
    const hits: HybridSearchHit[] = []
    for (const candidate of candidates) {
      if (hits.length >= cap) break
      const [kind, id] = candidate.id.split(":", 2)
      if (!id) continue
      if (
        (input.query?.trim() ?? "") !== "" &&
        !candidate.routes.some((route) =>
          ["local.fact_fts", "local.message_fts", "graph.entity"].includes(route.source),
        )
      ) {
        continue
      }
      const base = kind === "fact" ? this.readFact(id) : kind === "message" ? this.readMessage(id) : null
      if (base === null) continue
      if (kind === "fact") {
        const fact = row<FactRow>(this.db.prepare(
          `SELECT id, fact_type, topic_key, text, status, due_at, occurred_at, confidence, is_current
           FROM memory_facts WHERE id = ? AND owner_key = ?`,
        ).get(id, this.ownerKey))
        if (fact === null || !this.factMatches(fact, input, start, end, dueStart, dueEnd)) continue
      } else {
        const message = row<MessageRow>(this.db.prepare(
          `SELECT m.id, m.content_text, m.sent_at, m.sender_display_name, m.is_self,
                  c.type AS conversation_type, c.title AS conversation_title
           FROM memory_messages m JOIN memory_conversations c ON c.id = m.conversation_id
           WHERE m.id = ? AND m.owner_key = ? AND m.learning_eligible = 1`,
        ).get(id, this.ownerKey))
        if (message === null || !this.messageMatches(message, input, start, end)) continue
      }
      hits.push({ ...base, score: candidate.score, routes: candidate.routes })
    }
    return hits
  }

  private readFact(id: string): Omit<HybridSearchHit, "score" | "routes"> | null {
    const fact = row<FactRow>(this.db.prepare(
      `SELECT id, fact_type, topic_key, text, status, due_at, occurred_at, confidence, is_current
       FROM memory_facts WHERE id = ? AND owner_key = ?`,
    ).get(id, this.ownerKey))
    if (fact === null) return null
    const entities = this.db.prepare(
      `SELECT DISTINCT entity.name FROM memory_edges edge
       JOIN memory_entities entity ON entity.id = edge.target_id
       WHERE edge.owner_key = ? AND edge.source_type = 'fact' AND edge.source_id = ?
         AND edge.target_type = 'entity' ORDER BY entity.name LIMIT 20`,
    ).all(this.ownerKey, id).flatMap((value) => {
      const entity = row<{ name: string }>(value)
      return entity === null ? [] : [entity.name]
    })
    const evidence = this.factEvidence(id)
    if (evidence.length === 0) return null
    return {
      ref: factRef(id),
      kind: "fact",
      text: fact.text,
      factType: fact.fact_type,
      status: fact.status,
      dueAt: fact.due_at === null ? null : shanghaiTime(fact.due_at),
      occurredAt: shanghaiTime(fact.occurred_at),
      entities,
      evidence,
    }
  }

  private factMatches(
    fact: FactRow,
    input: HybridSearchInput,
    start: number | null,
    end: number | null,
    dueStart: number | null,
    dueEnd: number | null,
  ): boolean {
    if ((input.currentOnly ?? true) && fact.is_current !== 1) return false
    if (start !== null && fact.occurred_at < start) return false
    if (end !== null && fact.occurred_at > end) return false
    if (dueStart !== null && (fact.due_at === null || fact.due_at < dueStart)) return false
    if (dueEnd !== null && (fact.due_at === null || fact.due_at > dueEnd)) return false
    if (input.factTypes && input.factTypes.length > 0 && !input.factTypes.includes(fact.fact_type)) return false
    if (input.statuses && input.statuses.length > 0 && !input.statuses.includes(fact.status)) return false
    if (input.chatType) {
      const evidence = this.db.prepare(
        `SELECT 1 FROM memory_fact_evidence fe
         JOIN memory_messages m ON m.id = fe.message_id
         JOIN memory_conversations c ON c.id = m.conversation_id
         WHERE fe.fact_id = ? AND c.type = ? AND m.learning_eligible = 1 LIMIT 1`,
      ).get(fact.id, input.chatType)
      if (evidence === undefined) return false
    }
    return true
  }

  private messageMatches(
    message: MessageRow,
    input: HybridSearchInput,
    start: number | null,
    end: number | null,
  ): boolean {
    if (start !== null && message.sent_at < start) return false
    if (end !== null && message.sent_at > end) return false
    if (input.chatType && message.conversation_type !== input.chatType) return false
    return true
  }

  private readMessage(id: string): Omit<HybridSearchHit, "score" | "routes"> | null {
    const message = row<MessageRow>(this.db.prepare(
      `SELECT m.id, m.content_text, m.sent_at, m.sender_display_name, m.is_self,
              c.type AS conversation_type, c.title AS conversation_title
       FROM memory_messages m JOIN memory_conversations c ON c.id = m.conversation_id
       WHERE m.id = ? AND m.owner_key = ? AND m.learning_eligible = 1`,
    ).get(id, this.ownerKey))
    if (message === null) return null
    const evidence = [this.messageEvidence(message)]
    return {
      ref: memoryRef(id),
      kind: "message",
      text: message.content_text.slice(0, 1_500),
      occurredAt: shanghaiTime(message.sent_at),
      evidence,
    }
  }

  private factEvidence(factId: string): HybridSearchEvidence[] {
    const values = this.db.prepare(
      `SELECT m.id, m.content_text, m.sent_at, m.sender_display_name, m.is_self,
              c.type AS conversation_type, c.title AS conversation_title
       FROM memory_fact_evidence fe
       JOIN memory_messages m ON m.id = fe.message_id
       JOIN memory_conversations c ON c.id = m.conversation_id
       WHERE fe.fact_id = ? AND m.owner_key = ? AND m.learning_eligible = 1
       ORDER BY m.sent_at ASC LIMIT 20`,
    ).all(factId, this.ownerKey)
    return values.flatMap((value) => {
      const message = row<MessageRow>(value)
      return message === null ? [] : [this.messageEvidence(message)]
    })
  }

  private messageEvidence(message: MessageRow): HybridSearchEvidence {
    const type = message.conversation_type
    return {
      memoryRef: memoryRef(message.id),
      chat: message.conversation_title?.trim() || (type === "p2p" ? "未命名单聊" : "未命名群聊"),
      sender: message.is_self === 1 ? "我" : message.sender_display_name?.trim() || "未知发送人",
      sentAt: shanghaiTime(message.sent_at),
      content: message.content_text.slice(0, 2_000),
    }
  }

  private deduplicate(hits: readonly HybridSearchHit[]): HybridSearchHit[] {
    const seen = new Set<string>()
    const factEvidence = new Set(
      hits.filter((hit) => hit.kind === "fact").flatMap((hit) => hit.evidence.map((item) => item.memoryRef)),
    )
    const result: HybridSearchHit[] = []
    for (const hit of hits) {
      if (hit.kind === "message" && factEvidence.has(hit.ref)) continue
      const key = `${hit.kind}:${hit.factType ?? ""}:${hit.status ?? ""}:${normalizeForDedup(hit.text)}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(hit)
    }
    return result
  }

  private packContext(
    hits: readonly HybridSearchHit[],
    tokenBudget: number,
  ): { hits: HybridSearchHit[]; text: string; tokens: number; truncated: boolean } {
    const selected: HybridSearchHit[] = []
    const sections: string[] = []
    let tokens = 0
    for (const hit of hits) {
      const header = hit.kind === "fact"
        ? `[${hit.ref}] ${hit.factType}/${hit.status} ${hit.occurredAt ?? ""}${hit.dueAt ? ` due=${hit.dueAt}` : ""}`
        : `[${hit.ref}] MESSAGE ${hit.occurredAt ?? ""}`
      const evidence = hit.evidence
        .map((item) => `- [${item.memoryRef}] ${item.sentAt} ${item.chat} / ${item.sender}：${item.content}`)
        .join("\n")
      const section = `${header}\n${hit.text}${hit.entities?.length ? `\nEntities: ${hit.entities.join("、")}` : ""}\nEvidence:\n${evidence}`
      const cost = estimateMemoryTokens(section)
      if (selected.length > 0 && tokens + cost > tokenBudget) break
      if (cost > tokenBudget && selected.length === 0) {
        const clipped = section.slice(0, tokenBudget * 3)
        selected.push(hit)
        sections.push(clipped)
        tokens = estimateMemoryTokens(clipped)
        break
      }
      selected.push(hit)
      sections.push(section)
      tokens += cost
    }
    return {
      hits: selected,
      text: sections.join("\n\n---\n\n"),
      tokens,
      truncated: selected.length < hits.length,
    }
  }
}

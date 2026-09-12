import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { RuntimeUsage } from "../types.js"
import { FactExtractionError } from "./fact-extractor.js"
import { HybridMemoryRetriever } from "./hybrid-retrieval.js"
import type { OfficeMemory } from "./office-memory.js"
import { memoryLocalId, sha256Text, toSearchTokens } from "./normalize.js"
import {
  buildSemanticChunkPlans,
  type SemanticSourceMessage,
  type SessionizerOptions,
} from "./sessionizer.js"
import type {
  ExtractedEntity,
  ExtractedFact,
  FactExtractionResult,
  FactExtractor,
  OfficeEntityType,
  OfficeFactStatus,
  PersistExtractionResult,
  SemanticChunk,
  SemanticEnrichmentResult,
  HybridSearchInput,
  HybridSearchResult,
  SemanticEvidenceItem,
} from "./semantic-types.js"
import { addRuntimeUsage, emptyRuntimeUsage } from "./usage.js"

const SEMANTIC_CONSUMER_ID = "semantic-enrichment"
export const SEMANTIC_CHUNK_STRATEGY_VERSION = "chat-session-primary-context-v1"

type SqlRow = Record<string, unknown>

interface PendingMessageRow extends SqlRow {
  id: string
  revision: number
  conversation_id: string
  sender_display_name: string | null
  content_text: string
  sent_at: number
  is_self: number | null
  conversation_type: string
  conversation_title: string | null
  mentions_self: number
  source_seq: number
}

interface ExistingEntityRow extends SqlRow {
  id: string
  name: string
  aliases_json: string
  first_seen_at: number
  last_seen_at: number
}

interface ExistingFactRow extends SqlRow {
  id: string
  text: string
  status: string
  due_at: number | null
  occurred_at: number
  confidence: number
  assignee_entity_id: string | null
}

function row<T extends SqlRow>(value: unknown): T | null {
  return typeof value === "object" && value !== null ? (value as T) : null
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0)
}

export function normalizeMemoryKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .slice(0, 300)
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim()
}

function textSimilarity(left: string, right: string): number {
  const grams = (text: string): Set<string> => {
    const chars = [...normalizedText(text)]
    if (chars.length < 2) return new Set(chars)
    return new Set(chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1] ?? ""}`))
  }
  const a = grams(left)
  const b = grams(right)
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function parseTime(value: string | null, fallback: number): number {
  if (value === null) return fallback
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseOptionalTime(value: string | null): number | null {
  if (value === null) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

function normalizeStatus(fact: ExtractedFact): OfficeFactStatus {
  const taskLike = new Set(["ACTION_ITEM", "REQUEST", "DELEGATION", "COMMITMENT"])
  if (fact.status === "superseded") return "uncertain"
  if (taskLike.has(fact.type)) {
    if (fact.status === "active") return "open"
    if (fact.status === "resolved") return "done"
  } else {
    if (fact.status === "open") return "active"
    if (fact.status === "done") return "resolved"
    if (fact.status === "cancelled") return "resolved"
  }
  return fact.status
}

export interface SemanticMemoryOptions {
  memory: OfficeMemory
  extractor: FactExtractor
  ownerName: string | null
  sessionizer: SessionizerOptions
  maxAttempts: number
}

export class SemanticMemory {
  private readonly db: DatabaseSync
  private readonly ownerKey: string
  private readonly retriever: HybridMemoryRetriever

  constructor(private readonly options: SemanticMemoryOptions) {
    this.db = options.memory.semanticDatabase()
    this.ownerKey = options.memory.semanticOwnerKey()
    this.retriever = new HybridMemoryRetriever(options.memory)
  }

  /**
   * Extracts facts for up to `maxChunks` pending-message chunks and persists
   * them with entity edges and supersession. Safe to call concurrently from
   * callers that share the instance; chunk state is transactional and retried
   * per chunk, so a failing chunk never blocks the others.
   *
   * When `window` is provided, pending messages inside that time range are
   * chunked first (freshest-relevant priority) so interactive queries get the
   * newest evidence; remaining quota falls back to globally oldest pending.
   */
  async enrich(
    maxChunks: number,
    signal?: AbortSignal,
    onUsage?: (usage: RuntimeUsage) => void,
    window?: { start: number; end: number },
  ): Promise<SemanticEnrichmentResult> {
    const chunks = this.prepareChunks(Math.max(1, Math.min(maxChunks, 30)), window)
    const result: SemanticEnrichmentResult = {
      queuedChunks: chunks.length,
      completedChunks: 0,
      failedChunks: 0,
      factsCreated: 0,
      factsMerged: 0,
      factsSuperseded: 0,
      factsRejected: 0,
      entitiesUpserted: 0,
      usage: emptyRuntimeUsage(),
      failures: [],
    }
    for (const chunk of chunks) {
      if (signal?.aborted) break
      const startedAt = Date.now()
      this.markChunkProcessing(chunk.id)
      try {
        const extraction = await this.options.extractor.extract(chunk, signal)
        addRuntimeUsage(result.usage, extraction.usage)
        onUsage?.(extraction.usage)
        const persisted = this.persistExtraction(chunk, extraction, startedAt)
        result.completedChunks += 1
        result.factsCreated += persisted.factsCreated
        result.factsMerged += persisted.factsMerged
        result.factsSuperseded += persisted.factsSuperseded
        result.factsRejected += persisted.factsRejected
        result.entitiesUpserted += persisted.entitiesUpserted
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error)
        if (error instanceof FactExtractionError) {
          addRuntimeUsage(result.usage, error.usage)
          onUsage?.(error.usage)
        }
        this.failChunk(chunk, error, startedAt)
        result.failedChunks += 1
        result.failures.push(failure.slice(0, 300))
      }
    }
    this.refreshSemanticCursor()
    return result
  }

  pendingMessageCount(): number {
    const value = this.db.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_messages m
       WHERE m.owner_key = ? AND m.learning_eligible = 1
         AND NOT EXISTS (
           SELECT 1 FROM memory_chunk_messages cm
           JOIN memory_chunks c ON c.id = cm.chunk_id
           WHERE cm.message_id = m.id AND cm.message_revision = m.revision
             AND cm.role = 'primary' AND c.status = 'completed'
         )`,
    ).get(this.ownerKey)
    return numberValue(row<{ count: number }>(value)?.count)
  }

  search(input: HybridSearchInput = {}): HybridSearchResult {
    return this.retriever.search(input)
  }

  getFactEvidence(refs: readonly string[]) {
    return this.retriever.getFactEvidence(refs)
  }

  private prepareChunks(maxChunks: number, window?: { start: number; end: number }): SemanticChunk[] {
    const limit = Math.max(1, Math.min(maxChunks, 30))
    if (window === undefined) {
      return this.prepareChunksForRange(undefined, limit)
    }
    const relevant = this.prepareChunksForRange(window, limit)
    const remaining = limit - relevant.length
    if (remaining <= 0) return relevant
    const oldest = this.prepareChunksForRange(undefined, remaining)
    const seen = new Set(relevant.map((chunk) => chunk.id))
    return [...relevant, ...oldest.filter((chunk) => !seen.has(chunk.id))]
  }

  private prepareChunksForRange(
    window: { start: number; end: number } | undefined,
    maxChunks: number,
  ): SemanticChunk[] {
    const sourceLimit = maxChunks * Math.max(4, this.options.sessionizer.maxPrimaryMessages) * 3
    const windowClause = window === undefined ? "" : " AND m.sent_at >= ? AND m.sent_at <= ?"
    const windowParams = window === undefined ? [] : [window.start, window.end]
    const orderClause = window === undefined ? " ORDER BY source_seq ASC, m.sent_at ASC" : " ORDER BY m.sent_at DESC"
    const pendingValues = this.db.prepare(
      `SELECT m.id, m.revision, m.conversation_id, m.sender_display_name, m.content_text,
              m.sent_at, m.is_self, c.type AS conversation_type, c.title AS conversation_title,
              EXISTS(SELECT 1 FROM memory_message_mentions mm
                     WHERE mm.message_id = m.id AND mm.is_self = 1) AS mentions_self,
              COALESCE((SELECT MAX(k.seq) FROM memory_knowledge_changelog k
                        WHERE k.owner_key = m.owner_key AND k.entity_type = 'message'
                          AND k.entity_id = m.id), 0) AS source_seq
       FROM memory_messages m
       JOIN memory_conversations c ON c.id = m.conversation_id
       WHERE m.owner_key = ? AND m.learning_eligible = 1${windowClause}
         AND NOT EXISTS (
           SELECT 1 FROM memory_chunk_messages cm
           JOIN memory_chunks ch ON ch.id = cm.chunk_id
           WHERE cm.message_id = m.id AND cm.message_revision = m.revision
             AND cm.role = 'primary' AND ch.status = 'completed'
         )${orderClause}
       LIMIT ?`,
    ).all(this.ownerKey, ...windowParams, sourceLimit)
    const pendingRows = pendingValues.flatMap((value) => {
      const item = row<PendingMessageRow>(value)
      return item === null ? [] : [item]
    })
    if (pendingRows.length === 0) return []
    const pendingKeys = new Set(pendingRows.map((item) => `${item.id}:${item.revision}`))
    const conversationIds = [...new Set(pendingRows.map((item) => item.conversation_id))]
    const source: SemanticSourceMessage[] = []
    const statement = this.db.prepare(
      `SELECT m.id, m.revision, m.conversation_id, m.sender_display_name, m.content_text,
              m.sent_at, m.is_self, c.type AS conversation_type, c.title AS conversation_title,
              EXISTS(SELECT 1 FROM memory_message_mentions mm
                     WHERE mm.message_id = m.id AND mm.is_self = 1) AS mentions_self,
              COALESCE((SELECT MAX(k.seq) FROM memory_knowledge_changelog k
                        WHERE k.owner_key = m.owner_key AND k.entity_type = 'message'
                          AND k.entity_id = m.id), 0) AS source_seq
       FROM memory_messages m JOIN memory_conversations c ON c.id = m.conversation_id
       WHERE m.owner_key = ? AND m.conversation_id = ? AND m.learning_eligible = 1
         AND m.sent_at BETWEEN ? AND ?
       ORDER BY m.sent_at ASC`,
    )
    for (const conversationId of conversationIds) {
      const relevant = pendingRows.filter((item) => item.conversation_id === conversationId)
      const minimum = Math.min(...relevant.map((item) => item.sent_at)) - this.options.sessionizer.idleGapMs
      const maximum = Math.max(...relevant.map((item) => item.sent_at))
      for (const value of statement.all(this.ownerKey, conversationId, minimum, maximum)) {
        const item = row<PendingMessageRow>(value)
        if (item === null) continue
        source.push(this.toSourceMessage(item, pendingKeys.has(`${item.id}:${item.revision}`)))
      }
    }

    const plans = buildSemanticChunkPlans(source, this.options.sessionizer).slice(0, maxChunks)
    const chunks: SemanticChunk[] = []
    this.db.exec("BEGIN IMMEDIATE")
    try {
      for (const plan of plans) {
        const id = memoryLocalId(this.ownerKey, "chunk", plan.contentHash)
        const existing = row<{ status: string; extraction_attempts: number }>(this.db.prepare(
          "SELECT status, extraction_attempts FROM memory_chunks WHERE id = ? AND owner_key = ?",
        ).get(id, this.ownerKey))
        if (existing?.status === "completed" || (existing?.extraction_attempts ?? 0) >= this.options.maxAttempts) {
          continue
        }
        const now = Date.now()
        this.db.prepare(
          `INSERT INTO memory_chunks
           (id, owner_key, conversation_id, session_key, content, content_hash, start_at,
            end_at, source_seq, strategy_version, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = 'pending', last_error = NULL, updated_at = excluded.updated_at`,
        ).run(
          id,
          this.ownerKey,
          plan.conversationId,
          plan.sessionKey,
          plan.content,
          plan.contentHash,
          plan.startAt,
          plan.endAt,
          plan.sourceSeq,
          SEMANTIC_CHUNK_STRATEGY_VERSION,
          now,
          now,
        )
        const insertMembership = this.db.prepare(
          `INSERT OR IGNORE INTO memory_chunk_messages
           (chunk_id, message_id, message_revision, ordinal, role) VALUES (?, ?, ?, ?, ?)`,
        )
        for (const evidence of plan.evidence) {
          insertMembership.run(
            id,
            evidence.messageId,
            evidence.revision,
            evidence.ordinal,
            evidence.primary ? "primary" : "context",
          )
        }
        chunks.push({
          id,
          conversationId: plan.conversationId,
          sessionKey: plan.sessionKey,
          content: plan.content,
          contentHash: plan.contentHash,
          startAt: plan.startAt,
          endAt: plan.endAt,
          sourceSeq: plan.sourceSeq,
          strategyVersion: SEMANTIC_CHUNK_STRATEGY_VERSION,
          evidence: plan.evidence,
        })
      }
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
    return chunks.sort((a, b) => a.sourceSeq - b.sourceSeq || a.startAt - b.startAt)
  }

  private toSourceMessage(item: PendingMessageRow, pending: boolean): SemanticSourceMessage {
    return {
      ordinal: 0,
      messageId: item.id,
      revision: item.revision,
      primary: pending,
      sentAt: item.sent_at,
      sender: item.is_self === 1 ? "我" : item.sender_display_name?.trim() || "未知发送人",
      isSelf: item.is_self === null ? null : item.is_self === 1,
      mentionsSelf: item.mentions_self === 1,
      conversationType:
        item.conversation_type === "p2p" || item.conversation_type === "group"
          ? item.conversation_type
          : "unknown",
      conversationTitle:
        item.conversation_title?.trim() || (item.conversation_type === "p2p" ? "未命名单聊" : "未命名群聊"),
      content: item.content_text,
      conversationId: item.conversation_id,
      sourceSeq: item.source_seq,
      pending,
    }
  }

  private markChunkProcessing(chunkId: string): void {
    this.db.prepare(
      `UPDATE memory_chunks SET status = 'processing', extraction_attempts = extraction_attempts + 1,
       last_error = NULL, updated_at = ? WHERE id = ? AND owner_key = ?`,
    ).run(Date.now(), chunkId, this.ownerKey)
  }

  private persistExtraction(
    chunk: SemanticChunk,
    extraction: FactExtractionResult,
    startedAt: number,
  ): PersistExtractionResult {
    const result: PersistExtractionResult = {
      factsCreated: 0,
      factsMerged: 0,
      factsSuperseded: 0,
      factsRejected: 0,
      entitiesUpserted: 0,
    }
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const staleFactIds = this.editedEvidenceFactIds(chunk)
      const entityHints = new Map<string, ExtractedEntity>()
      for (const entity of extraction.data.entities) {
        const key = normalizeMemoryKey(entity.name)
        if (key !== "") entityHints.set(key, entity)
      }
      const entityCache = new Map<string, string>()
      for (const entity of extraction.data.entities) {
        if (normalizeMemoryKey(entity.name) === "") continue
        const stored = this.upsertEntity(entity.name, entity.type, entity.aliases, chunk.startAt, chunk.endAt)
        entityCache.set(normalizeMemoryKey(entity.name), stored.id)
        if (stored.changed) result.entitiesUpserted += 1
      }
      this.projectStructuralEdges(chunk, entityCache, result)

      for (const [index, fact] of extraction.data.facts.entries()) {
        const evidence = fact.evidenceOrdinals.flatMap((ordinal) => {
          const item = chunk.evidence.find((candidate) => candidate.ordinal === ordinal)
          return item === undefined ? [] : [item]
        })
        if (
          evidence.length === 0 ||
          evidence.length !== fact.evidenceOrdinals.length ||
          !evidence.some((item) => item.primary)
        ) {
          result.factsRejected += 1
          continue
        }
        const topicKey = normalizeMemoryKey(fact.key)
        if (topicKey === "" || fact.text.trim() === "") {
          result.factsRejected += 1
          continue
        }
        const fallbackOccurred = Math.max(...evidence.map((item) => item.sentAt))
        const occurredAt = parseTime(fact.occurredAt, fallbackOccurred)
        const dueAt = parseOptionalTime(fact.dueAt)
        const status = normalizeStatus(fact)
        const subjectId = this.resolveEntity(fact.subject, "Unknown", entityHints, entityCache, occurredAt, result)
        const objectId = this.resolveEntity(fact.object, "Unknown", entityHints, entityCache, occurredAt, result)
        const assigneeId = this.resolveEntity(fact.assignee, "Person", entityHints, entityCache, occurredAt, result)
        const ownerRelevance = this.ownerRelevance(fact, evidence)
        const confidence = ownerRelevance === "contextual" && assigneeId !== null
          ? Math.min(fact.confidence, 0.55)
          : fact.confidence
        const existing = row<ExistingFactRow>(this.db.prepare(
          `SELECT id, text, status, due_at, occurred_at, confidence, assignee_entity_id
           FROM memory_facts
           WHERE owner_key = ? AND fact_type = ? AND topic_key = ? AND is_current = 1
           ORDER BY occurred_at DESC LIMIT 1`,
        ).get(this.ownerKey, fact.type, topicKey))
        const predecessor = existing ?? row<ExistingFactRow>(this.db.prepare(
          `SELECT id, text, status, due_at, occurred_at, confidence, assignee_entity_id
           FROM memory_facts
           WHERE owner_key = ? AND fact_type = ? AND topic_key = ?
           ORDER BY occurred_at DESC LIMIT 1`,
        ).get(this.ownerKey, fact.type, topicKey))

        if (
          existing !== null &&
          !staleFactIds.includes(existing.id) &&
          existing.status === status &&
          existing.due_at === dueAt &&
          existing.assignee_entity_id === assigneeId &&
          textSimilarity(existing.text, fact.text) >= 0.88
        ) {
          this.db.prepare(
            `UPDATE memory_facts SET confidence = MAX(confidence, ?), updated_at = ? WHERE id = ?`,
          ).run(confidence, Date.now(), existing.id)
          this.attachFactEvidence(existing.id, evidence)
          this.projectFactEdges(existing.id, subjectId, objectId, assigneeId, evidence, confidence)
          this.reindexFact(existing.id)
          result.factsMerged += 1
          continue
        }

        const id = memoryLocalId(
          this.ownerKey,
          "fact",
          `${chunk.id}:${index}:${fact.type}:${topicKey}:${normalizedText(fact.text)}`,
        )
        const newIsCurrent = predecessor === null || occurredAt >= predecessor.occurred_at
        let supersedes: string | null = null
        if (existing !== null && newIsCurrent) {
          this.db.prepare(
            `UPDATE memory_facts SET is_current = 0, valid_to = ?, updated_at = ?
             WHERE id = ?`,
          ).run(occurredAt, Date.now(), existing.id)
          this.db.prepare("DELETE FROM memory_facts_fts WHERE fact_id = ? AND owner_key = ?").run(existing.id, this.ownerKey)
          result.factsSuperseded += 1
        }
        if (predecessor !== null && newIsCurrent) {
          supersedes = predecessor.id
          if (existing === null) result.factsSuperseded += 1
        }
        this.db.prepare(
          `INSERT OR IGNORE INTO memory_facts
           (id, owner_key, fact_type, topic_key, text, status, subject_entity_id,
            object_entity_id, assignee_entity_id, due_at, occurred_at, confidence,
            owner_relevance, source_chunk_id, extraction_model, prompt_version, is_current,
            supersedes_fact_id, valid_from, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          this.ownerKey,
          fact.type,
          topicKey,
          fact.text.trim(),
          status,
          subjectId,
          objectId,
          assigneeId,
          dueAt,
          occurredAt,
          confidence,
          ownerRelevance,
          chunk.id,
          extraction.model,
          extraction.promptVersion,
          newIsCurrent ? 1 : 0,
          supersedes,
          occurredAt,
          Date.now(),
          Date.now(),
        )
        this.attachFactEvidence(id, evidence)
        this.projectFactEdges(id, subjectId, objectId, assigneeId, evidence, confidence)
        if (predecessor !== null) {
          this.upsertEdge(
            newIsCurrent ? id : predecessor.id,
            "fact",
            newIsCurrent ? predecessor.id : id,
            "fact",
            "SUPERSEDES",
            confidence,
            newIsCurrent ? id : predecessor.id,
            {},
          )
        }
        if (newIsCurrent) this.reindexFact(id)
        this.emitChange("fact", id, occurredAt, sha256Text(`${fact.type}:${topicKey}:${fact.text}:${status}`))
        result.factsCreated += 1
      }

      result.factsSuperseded += this.invalidateRemainingFacts(staleFactIds, chunk.endAt)

      this.db.prepare(
        `UPDATE memory_chunks SET status = 'completed', last_error = NULL,
         completed_at = ?, updated_at = ? WHERE id = ? AND owner_key = ?`,
      ).run(Date.now(), Date.now(), chunk.id, this.ownerKey)
      this.insertExtractionRun(chunk.id, "success", extraction, startedAt, null)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
    return result
  }

  private editedEvidenceFactIds(chunk: SemanticChunk): string[] {
    const ids = new Set<string>()
    for (const evidence of chunk.evidence.filter((item) => item.primary)) {
      const facts = this.db.prepare(
        `SELECT DISTINCT f.id FROM memory_facts f
         JOIN memory_fact_evidence fe ON fe.fact_id = f.id
         WHERE f.owner_key = ? AND f.is_current = 1 AND fe.message_id = ?
           AND fe.message_revision <> ?`,
      ).all(this.ownerKey, evidence.messageId, evidence.revision)
      for (const value of facts) {
        const fact = row<{ id: string }>(value)
        if (fact === null) continue
        ids.add(fact.id)
      }
    }
    return [...ids]
  }

  private invalidateRemainingFacts(factIds: readonly string[], validTo: number): number {
    let count = 0
    for (const id of factIds) {
      const changed = this.db.prepare(
        `UPDATE memory_facts SET is_current = 0, valid_to = ?, updated_at = ?
         WHERE id = ? AND owner_key = ? AND is_current = 1`,
      ).run(validTo, Date.now(), id, this.ownerKey)
      if (numberValue(changed.changes) === 0) continue
      this.db.prepare("DELETE FROM memory_facts_fts WHERE fact_id = ? AND owner_key = ?").run(id, this.ownerKey)
      count += 1
    }
    return count
  }

  private resolveEntity(
    name: string | null,
    fallbackType: OfficeEntityType,
    hints: ReadonlyMap<string, ExtractedEntity>,
    cache: Map<string, string>,
    occurredAt: number,
    result: PersistExtractionResult,
  ): string | null {
    if (name === null || name.trim() === "") return null
    const key = normalizeMemoryKey(name)
    if (key === "") return null
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const hint = hints.get(key)
    const existing = row<{ id: string }>(this.db.prepare(
      `SELECT id FROM memory_entities WHERE owner_key = ? AND normalized_key = ?
       ORDER BY CASE WHEN entity_type = 'Unknown' THEN 1 ELSE 0 END, mention_count DESC LIMIT 1`,
    ).get(this.ownerKey, key))
    if (existing !== null) {
      cache.set(key, existing.id)
      return existing.id
    }
    const stored = this.upsertEntity(name, hint?.type ?? fallbackType, hint?.aliases ?? [], occurredAt, occurredAt)
    cache.set(key, stored.id)
    if (stored.changed) result.entitiesUpserted += 1
    return stored.id
  }

  private upsertEntity(
    name: string,
    type: OfficeEntityType,
    aliases: readonly string[],
    firstSeen: number,
    lastSeen: number,
  ): { id: string; changed: boolean } {
    const normalized = normalizeMemoryKey(name)
    if (normalized === "") throw new Error("entity name normalizes to an empty key")
    const id = memoryLocalId(this.ownerKey, `entity:${type}`, normalized)
    const existing = row<ExistingEntityRow>(this.db.prepare(
      `SELECT id, name, aliases_json, first_seen_at, last_seen_at
       FROM memory_entities WHERE owner_key = ? AND entity_type = ? AND normalized_key = ?`,
    ).get(this.ownerKey, type, normalized))
    const mergedAliases = [...new Set([...(existing ? safeJsonArray(existing.aliases_json) : []), ...aliases])]
      .filter((alias) => normalizeMemoryKey(alias) !== normalized)
      .slice(0, 30)
    if (existing === null) {
      this.db.prepare(
        `INSERT INTO memory_entities
         (id, owner_key, entity_type, normalized_key, name, aliases_json, first_seen_at,
          last_seen_at, mention_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(id, this.ownerKey, type, normalized, name.trim(), JSON.stringify(mergedAliases), firstSeen, lastSeen, Date.now(), Date.now())
      this.emitChange("entity", id, lastSeen, sha256Text(`${type}:${normalized}:${name}`))
      return { id, changed: true }
    }
    this.db.prepare(
      `UPDATE memory_entities SET aliases_json = ?, first_seen_at = MIN(first_seen_at, ?),
       last_seen_at = MAX(last_seen_at, ?), mention_count = mention_count + 1, updated_at = ?
       WHERE id = ?`,
    ).run(JSON.stringify(mergedAliases), firstSeen, lastSeen, Date.now(), existing.id)
    return { id: existing.id, changed: false }
  }

  private projectStructuralEdges(
    chunk: SemanticChunk,
    cache: Map<string, string>,
    result: PersistExtractionResult,
  ): void {
    let previous: SemanticEvidenceItem | null = null
    for (const evidence of chunk.evidence) {
      this.upsertEdge(
        evidence.messageId,
        "message",
        chunk.conversationId,
        "conversation",
        "PART_OF",
        1,
        "",
        {},
      )
      if (previous !== null && previous.sentAt <= evidence.sentAt) {
        this.upsertEdge(
          previous.messageId,
          "message",
          evidence.messageId,
          "message",
          "TEMPORAL",
          1,
          "",
          {},
        )
      }
      previous = evidence
      const reply = row<{ parent_external_id: string | null; root_external_id: string | null }>(this.db.prepare(
        "SELECT parent_external_id, root_external_id FROM memory_messages WHERE id = ? AND owner_key = ?",
      ).get(evidence.messageId, this.ownerKey))
      const replyExternalId = reply?.parent_external_id ?? reply?.root_external_id ?? null
      if (replyExternalId !== null) {
        const target = row<{ id: string }>(this.db.prepare(
          `SELECT id FROM memory_messages
           WHERE owner_key = ? AND platform = 'feishu' AND external_id = ?`,
        ).get(this.ownerKey, replyExternalId))
        if (target !== null) {
          this.upsertEdge(evidence.messageId, "message", target.id, "message", "REPLY_TO", 1, "", {})
        }
      }
      if (evidence.sender !== "未知发送人") {
        const key = normalizeMemoryKey(evidence.sender)
        let entityId = cache.get(key)
        if (entityId === undefined) {
          const name = evidence.isSelf === true && this.options.ownerName ? this.options.ownerName : evidence.sender
          const stored = this.upsertEntity(name, "Person", [], evidence.sentAt, evidence.sentAt)
          entityId = stored.id
          cache.set(normalizeMemoryKey(name), entityId)
          if (stored.changed) result.entitiesUpserted += 1
        }
        this.upsertEdge(evidence.messageId, "message", entityId, "entity", "AUTHORED_BY", 1, "", {})
      }
      if (evidence.mentionsSelf && this.options.ownerName?.trim()) {
        const owner = this.upsertEntity(
          this.options.ownerName,
          "Person",
          [],
          evidence.sentAt,
          evidence.sentAt,
        )
        if (owner.changed) result.entitiesUpserted += 1
        this.upsertEdge(evidence.messageId, "message", owner.id, "entity", "MENTIONS", 1, "", {})
      }
    }
  }

  private attachFactEvidence(factId: string, evidence: readonly SemanticEvidenceItem[]): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO memory_fact_evidence
       (fact_id, message_id, message_revision, ordinal, is_primary) VALUES (?, ?, ?, ?, ?)`,
    )
    for (const item of evidence) {
      insert.run(factId, item.messageId, item.revision, item.ordinal, item.primary ? 1 : 0)
    }
  }

  private projectFactEdges(
    factId: string,
    subjectId: string | null,
    objectId: string | null,
    assigneeId: string | null,
    evidence: readonly SemanticEvidenceItem[],
    confidence: number,
  ): void {
    for (const item of evidence) {
      this.upsertEdge(factId, "fact", item.messageId, "message", "EVIDENCE_FROM", confidence, factId, {})
    }
    if (subjectId !== null) {
      this.upsertEdge(factId, "fact", subjectId, "entity", "ABOUT", confidence, factId, { role: "subject" })
    }
    if (objectId !== null) {
      this.upsertEdge(factId, "fact", objectId, "entity", "ABOUT", confidence, factId, { role: "object" })
    }
    if (assigneeId !== null) {
      this.upsertEdge(factId, "fact", assigneeId, "entity", "ASSIGNED_TO", confidence, factId, {})
    }
  }

  private ownerRelevance(fact: ExtractedFact, evidence: readonly SemanticEvidenceItem[]): "direct" | "contextual" {
    if (
      evidence.some(
        (item) => item.isSelf === true || item.mentionsSelf || item.conversationType === "p2p",
      )
    ) {
      return "direct"
    }
    const assignee = normalizeMemoryKey(fact.assignee ?? "")
    const owner = normalizeMemoryKey(this.options.ownerName ?? "")
    if (assignee !== "" && (assignee === owner || ["我", "你", "当前授权用户", "owner"].includes(assignee))) {
      return "direct"
    }
    return "contextual"
  }

  private upsertEdge(
    sourceId: string,
    sourceType: string,
    targetId: string,
    targetType: string,
    edgeType: string,
    confidence: number,
    sourceFactId: string,
    properties: Record<string, unknown>,
  ): void {
    const id = memoryLocalId(
      this.ownerKey,
      "edge",
      `${sourceType}:${sourceId}:${edgeType}:${targetType}:${targetId}:${sourceFactId}`,
    )
    this.db.prepare(
      `INSERT INTO memory_edges
       (id, owner_key, source_type, source_id, target_type, target_id, edge_type,
        confidence, source_fact_id, properties_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET confidence = MAX(confidence, excluded.confidence),
         properties_json = excluded.properties_json, updated_at = excluded.updated_at`,
    ).run(
      id,
      this.ownerKey,
      sourceType,
      sourceId,
      targetType,
      targetId,
      edgeType,
      confidence,
      sourceFactId,
      JSON.stringify(properties),
      Date.now(),
      Date.now(),
    )
  }

  private reindexFact(factId: string): void {
    this.db.prepare("DELETE FROM memory_facts_fts WHERE fact_id = ? AND owner_key = ?").run(factId, this.ownerKey)
    const fact = row<{ id: string; text: string; topic_key: string; is_current: number }>(this.db.prepare(
      "SELECT id, text, topic_key, is_current FROM memory_facts WHERE id = ? AND owner_key = ?",
    ).get(factId, this.ownerKey))
    if (fact === null || fact.is_current !== 1) return
    const entities = this.db.prepare(
      `SELECT DISTINCT e.name FROM memory_edges edge
       JOIN memory_entities e ON e.id = edge.target_id
       WHERE edge.owner_key = ? AND edge.source_type = 'fact' AND edge.source_id = ?
         AND edge.target_type = 'entity'`,
    ).all(this.ownerKey, factId).flatMap((value) => {
      const entity = row<{ name: string }>(value)
      return entity === null ? [] : [entity.name]
    })
    this.db.prepare(
      `INSERT INTO memory_facts_fts(fact_id, owner_key, text_tokens, key_tokens, entity_tokens)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      fact.id,
      this.ownerKey,
      toSearchTokens(fact.text),
      toSearchTokens(fact.topic_key),
      toSearchTokens(entities.join(" ")),
    )
  }

  private emitChange(entityType: "fact" | "entity", entityId: string, occurredAt: number, digest: string): void {
    this.db.prepare(
      `INSERT INTO memory_knowledge_changelog
       (op, entity_type, entity_id, owner_key, occurred_at, emitted_at, payload_ref, digest)
       VALUES ('upsert', ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(entityType, entityId, this.ownerKey, occurredAt, Date.now(), digest)
  }

  private insertExtractionRun(
    chunkId: string,
    status: "success" | "failed",
    extraction: FactExtractionResult | null,
    startedAt: number,
    error: string | null,
    fallback?: { usage: RuntimeUsage; model: string; rawOutput: string },
  ): void {
    const usage = extraction?.usage ?? fallback?.usage ?? emptyRuntimeUsage()
    this.db.prepare(
      `INSERT INTO memory_extraction_runs
       (id, owner_key, chunk_id, status, model, prompt_version, input_tokens,
        output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
        total_tokens, estimated_cost_usd, raw_output, error, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      this.ownerKey,
      chunkId,
      status,
      extraction?.model ?? fallback?.model ?? "unknown",
      extraction?.promptVersion ?? "office-facts-zh-v1",
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      usage.reasoningTokens,
      usage.totalTokens,
      usage.estimatedCostUsd,
      (extraction?.rawOutput ?? fallback?.rawOutput ?? "").slice(0, 100_000) || null,
      error?.slice(0, 2_000) ?? null,
      startedAt,
      Date.now(),
    )
  }

  private failChunk(chunk: SemanticChunk, error: unknown, startedAt: number): void {
    const message = error instanceof Error ? error.message : String(error)
    const fallback = error instanceof FactExtractionError
      ? { usage: error.usage, model: error.model, rawOutput: error.rawOutput }
      : undefined
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.prepare(
        `UPDATE memory_chunks SET status = 'failed', last_error = ?, updated_at = ?
         WHERE id = ? AND owner_key = ?`,
      ).run(message.slice(0, 2_000), Date.now(), chunk.id, this.ownerKey)
      this.insertExtractionRun(chunk.id, "failed", null, startedAt, message, fallback)
      this.db.exec("COMMIT")
    } catch (persistError) {
      this.db.exec("ROLLBACK")
      throw persistError
    }
  }

  private refreshSemanticCursor(): void {
    const messageHead = numberValue(row<{ value: number }>(this.db.prepare(
      `SELECT COALESCE(MAX(seq), 0) AS value FROM memory_knowledge_changelog
       WHERE owner_key = ? AND entity_type = 'message'`,
    ).get(this.ownerKey))?.value)
    const pending = row<{ value: number | null }>(this.db.prepare(
      `SELECT MIN(COALESCE((SELECT MAX(k.seq) FROM memory_knowledge_changelog k
                            WHERE k.owner_key = m.owner_key AND k.entity_type = 'message'
                              AND k.entity_id = m.id), 0)) AS value
       FROM memory_messages m
       WHERE m.owner_key = ? AND m.learning_eligible = 1
         AND NOT EXISTS (
           SELECT 1 FROM memory_chunk_messages cm JOIN memory_chunks c ON c.id = cm.chunk_id
           WHERE cm.message_id = m.id AND cm.message_revision = m.revision
             AND cm.role = 'primary' AND c.status = 'completed'
         )`,
    ).get(this.ownerKey))?.value ?? null
    const acked = pending === null ? messageHead : Math.max(0, pending - 1)
    this.db.prepare(
      `UPDATE memory_consumer_cursors SET acked_seq = ?, last_error = NULL,
       last_success_at = ?, updated_at = ? WHERE consumer_id = ? AND owner_key = ?`,
    ).run(acked, Date.now(), Date.now(), SEMANTIC_CONSUMER_ID, this.ownerKey)
  }
}

import { createHash, randomUUID } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { evaluateOfficeMemoryEligibility } from "./guards.js"
import { migrateOfficeMemory, OFFICE_MEMORY_SCHEMA_VERSION } from "./migrations.js"
import {
  inspectLarkMessagePayload,
  memoryLocalId,
  sha256Text,
  toFtsMatch,
  toSearchTokens,
  type NormalizeLarkOptions,
} from "./normalize.js"
import type {
  LarkPayloadInspection,
  MemoryEvidence,
  MemoryIngestContext,
  MemoryIngestResult,
  MemorySearchHit,
  MemorySearchInput,
  MemoryStatus,
  NormalizedOfficeMessage,
  OfficeMemoryRejectionReason,
} from "./types.js"

const FTS_CONSUMER_ID = "local-index-fts"

type SqlRow = Record<string, unknown>

interface ConversationRow extends SqlRow {
  id: string
  type: string
  title: string | null
  is_assistant_control: number
  is_bot_channel: number
  learning_enabled: number
  first_seen_at: number
  last_seen_at: number
}

interface ExistingMessageRow extends SqlRow {
  id: string
  source_digest: string
  learning_eligible: number
  rejection_reason: string | null
  revision: number
}

interface SearchRow extends SqlRow {
  id: string
  type: string
  title: string | null
  sender_display_name: string | null
  content_text: string
  sent_at: number
  is_self: number | null
  revision: number
  relevance?: number | null
}

function ownerKeyFrom(externalId: string): string {
  return createHash("sha256").update(`feishu-owner\u0000${externalId}`).digest("hex")
}

function row<T extends SqlRow>(value: unknown): T | null {
  return typeof value === "object" && value !== null ? (value as T) : null
}

function numeric(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0)
}

function countOf(db: DatabaseSync, sql: string, ...parameters: Array<string | number>): number {
  return numeric(row<{ count: number }>(db.prepare(sql).get(...parameters))?.count)
}

function isoShanghai(timestamp: number): string {
  const shifted = new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 19)
  return `${shifted}+08:00`
}

function parseBoundary(value: string | undefined, field: string): number | null {
  if (value === undefined || value.trim() === "") return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be an ISO-8601 date-time`)
  return parsed
}

function memoryRef(id: string): string {
  return `mem_${id}`
}

function conversationLabel(type: string, title: string | null): string {
  if (title?.trim()) return title.trim()
  return type === "p2p" ? "未命名单聊" : type === "group" ? "未命名群聊" : "未命名会话"
}

function senderLabel(isSelf: number | null, displayName: string | null): string {
  if (isSelf === 1) return "我"
  return displayName?.trim() || "未知发送人"
}

function emptyIngestResult(messageIds: string[]): MemoryIngestResult {
  return {
    rawInserted: false,
    created: 0,
    updated: 0,
    unchanged: 0,
    eligible: 0,
    rejected: {},
    indexed: 0,
    discoveredMessageIds: messageIds,
  }
}

function incrementRejection(
  rejected: Partial<Record<OfficeMemoryRejectionReason, number>>,
  reason: OfficeMemoryRejectionReason,
): void {
  rejected[reason] = (rejected[reason] ?? 0) + 1
}

export interface OfficeMemoryOptions {
  path: string
  ownerExternalId: string
  assistantBotExternalId?: string | null
  assistantBotName?: string | null
}

export interface SyncRunInput {
  source: "lark-sync"
  start: string
  end: string
  query: string
  chatType?: "p2p" | "group"
  coverageComplete: boolean
  status: "success" | "failed"
  startedAt: number
  rawRecords: number
  messagesCreated: number
  messagesUpdated: number
  error?: string
}

export class OfficeMemory {
  private readonly db: DatabaseSync
  private readonly ownerExternalId: string
  private readonly ownerKey: string
  private readonly assistantBotExternalId: string | null
  private readonly assistantBotName: string | null
  private closed = false

  constructor(options: OfficeMemoryOptions) {
    if (options.ownerExternalId.trim() === "") throw new Error("office memory owner is required")
    this.ownerExternalId = options.ownerExternalId
    this.ownerKey = ownerKeyFrom(options.ownerExternalId)
    this.assistantBotExternalId = options.assistantBotExternalId?.trim() || null
    this.assistantBotName = options.assistantBotName?.trim() || null
    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
    }
    this.db = new DatabaseSync(options.path)
    this.db.exec("PRAGMA foreign_keys = ON")
    this.db.exec("PRAGMA busy_timeout = 5000")
    if (options.path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL")
      this.db.exec("PRAGMA synchronous = NORMAL")
    }
    migrateOfficeMemory(this.db)
    this.db.prepare(
      `INSERT OR IGNORE INTO memory_consumer_cursors
       (consumer_id, owner_key, acked_seq, updated_at) VALUES (?, ?, 0, ?)`,
    ).run(FTS_CONSUMER_ID, this.ownerKey, Date.now())
    if (options.path !== ":memory:") chmodSync(options.path, 0o600)
    this.discoverExistingAssistantControlConversation()
  }

  inspectLarkPayload(payload: unknown, fallbackConversationExternalId?: string): LarkPayloadInspection {
    const options: NormalizeLarkOptions = {
      ownerExternalId: this.ownerExternalId,
      ...(fallbackConversationExternalId ? { fallbackConversationExternalId } : {}),
    }
    return inspectLarkMessagePayload(payload, options)
  }

  ingestLarkPayload(payload: unknown, context: MemoryIngestContext): MemoryIngestResult {
    this.assertOpen()
    const inspected = this.inspectLarkPayload(payload, context.fallbackConversationExternalId)
    this.markAssistantControlFromPayload(inspected)
    const result = emptyIngestResult(inspected.messageIds)
    const payloadText = JSON.stringify(payload)
    const payloadHash = sha256Text(payloadText)
    const rawId = memoryLocalId(
      this.ownerKey,
      "raw",
      `${context.source}\u0000${context.resource}\u0000${payloadHash}`,
    )
    const now = Date.now()

    this.db.exec("BEGIN IMMEDIATE")
    try {
      const raw = this.db.prepare(
        `INSERT OR IGNORE INTO memory_raw_records
         (id, owner_key, platform, source, resource, payload, payload_hash, fetched_at)
         VALUES (?, ?, 'feishu', ?, ?, ?, ?, ?)`,
      ).run(rawId, this.ownerKey, context.source, context.resource, payloadText, payloadHash, now)
      result.rawInserted = numeric(raw.changes) > 0

      for (const message of inspected.messages) {
        this.upsertMessage(message, rawId, now, result)
      }
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }

    result.indexed = this.drainFts()
    return result
  }

  markAssistantControlConversation(externalChatId: string | null | undefined): number {
    this.assertOpen()
    if (!externalChatId?.trim()) return 0
    const externalId = externalChatId.trim()
    const conversationId = memoryLocalId(this.ownerKey, "conversation", externalId)
    const now = Date.now()
    let affected = 0
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const existing = row<ConversationRow>(this.db.prepare(
        `SELECT id, type, title, is_assistant_control, is_bot_channel, learning_enabled,
                first_seen_at, last_seen_at
         FROM memory_conversations WHERE id = ? AND owner_key = ?`,
      ).get(conversationId, this.ownerKey))
      if (existing === null) {
        this.db.prepare(
          `INSERT INTO memory_conversations
           (id, owner_key, platform, external_id, type, title, is_assistant_control,
            is_bot_channel, learning_enabled, first_seen_at, last_seen_at, created_at, updated_at)
           VALUES (?, ?, 'feishu', ?, 'p2p', NULL, 1, 0, 1, ?, ?, ?, ?)`,
        ).run(conversationId, this.ownerKey, externalId, now, now, now, now)
      } else if (existing.is_assistant_control !== 1) {
        this.db.prepare(
          `UPDATE memory_conversations SET is_assistant_control = 1, updated_at = ?
           WHERE id = ? AND owner_key = ?`,
        ).run(now, conversationId, this.ownerKey)
      }

      const messages = this.db.prepare(
        `SELECT id, source_digest FROM memory_messages
         WHERE owner_key = ? AND conversation_id = ?
           AND (learning_eligible <> 0 OR rejection_reason IS NOT 'assistant_control')`,
      ).all(this.ownerKey, conversationId)
      for (const value of messages) {
        const message = row<{ id: string; source_digest: string }>(value)
        if (message === null) continue
        this.db.prepare(
          `UPDATE memory_messages
           SET learning_eligible = 0, rejection_reason = 'assistant_control', updated_local_at = ?
           WHERE id = ?`,
        ).run(now, message.id)
        this.emitChange("message", message.id, now, now, null, sha256Text(`${message.source_digest}:control`))
        affected += 1
      }
      this.emitChange("conversation", conversationId, now, now, null, sha256Text(`${conversationId}:control`))
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
    this.drainFts()
    return affected
  }

  search(input: MemorySearchInput = {}): MemorySearchHit[] {
    this.assertOpen()
    this.drainFts()
    const limit = Math.max(1, Math.min(input.limit ?? 20, 50))
    const start = parseBoundary(input.start, "start")
    const end = parseBoundary(input.end, "end")
    if (start !== null && end !== null && start > end) throw new Error("start must not be after end")
    const match = input.query?.trim() ? toFtsMatch(input.query) : null
    const where: string[] = ["m.owner_key = ?", "m.learning_eligible = 1"]
    const parameters: Array<string | number> = [this.ownerKey]
    if (start !== null) {
      where.push("m.sent_at >= ?")
      parameters.push(start)
    }
    if (end !== null) {
      where.push("m.sent_at <= ?")
      parameters.push(end)
    }
    if (input.chatType) {
      where.push("c.type = ?")
      parameters.push(input.chatType)
    }

    let values: unknown[]
    if (match !== null) {
      where.unshift("memory_messages_fts MATCH ?")
      parameters.unshift(match)
      values = this.db.prepare(
        `SELECT m.id, c.type, c.title, m.sender_display_name, m.content_text,
                m.sent_at, m.is_self, m.revision, bm25(memory_messages_fts) AS relevance
         FROM memory_messages_fts
         JOIN memory_messages m ON m.id = memory_messages_fts.message_id
         JOIN memory_conversations c ON c.id = m.conversation_id
         WHERE ${where.join(" AND ")}
         ORDER BY relevance ASC, m.sent_at DESC
         LIMIT ?`,
      ).all(...parameters, limit)
    } else {
      values = this.db.prepare(
        `SELECT m.id, c.type, c.title, m.sender_display_name, m.content_text,
                m.sent_at, m.is_self, m.revision, NULL AS relevance
         FROM memory_messages m
         JOIN memory_conversations c ON c.id = m.conversation_id
         WHERE ${where.join(" AND ")}
         ORDER BY m.sent_at DESC
         LIMIT ?`,
      ).all(...parameters, limit)
    }
    return values.flatMap((value) => {
      const item = row<SearchRow>(value)
      if (item === null) return []
      return [this.toSearchHit(item)]
    })
  }

  getEvidence(refs: readonly string[]): MemoryEvidence[] {
    this.assertOpen()
    const unique = [...new Set(refs)].slice(0, 20)
    const evidence: MemoryEvidence[] = []
    const statement = this.db.prepare(
      `SELECT m.id, c.type, c.title, m.sender_display_name, m.content_text,
              m.sent_at, m.is_self, m.revision
       FROM memory_messages m
       JOIN memory_conversations c ON c.id = m.conversation_id
       WHERE m.owner_key = ? AND m.id = ? AND m.learning_eligible = 1`,
    )
    for (const ref of unique) {
      if (!/^mem_[a-f0-9]{64}$/u.test(ref)) continue
      const item = row<SearchRow>(statement.get(this.ownerKey, ref.slice(4)))
      if (item === null) continue
      evidence.push({
        ...this.toSearchHit(item),
        content: item.content_text,
      })
    }
    return evidence
  }

  status(): MemoryStatus {
    this.assertOpen()
    this.drainFts()
    const latest = row<{ value: number | null }>(this.db.prepare(
      "SELECT MAX(sent_at) AS value FROM memory_messages WHERE owner_key = ? AND learning_eligible = 1",
    ).get(this.ownerKey))?.value ?? null
    const fullSync = row<{ range_start: number | null; range_end: number | null }>(this.db.prepare(
      `SELECT range_start, range_end FROM memory_sync_runs
       WHERE owner_key = ? AND status = 'success' AND coverage_complete = 1
       ORDER BY completed_at DESC LIMIT 1`,
    ).get(this.ownerKey))
    const lastSuccessfulSyncAt = row<{ value: number | null }>(this.db.prepare(
      `SELECT MAX(completed_at) AS value FROM memory_sync_runs
       WHERE owner_key = ? AND status = 'success'`,
    ).get(this.ownerKey))?.value ?? null
    const head = numeric(row<{ value: number }>(this.db.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS value FROM memory_knowledge_changelog WHERE owner_key = ?",
    ).get(this.ownerKey))?.value)
    const acked = numeric(row<{ value: number }>(this.db.prepare(
      `SELECT acked_seq AS value FROM memory_consumer_cursors
       WHERE consumer_id = ? AND owner_key = ?`,
    ).get(FTS_CONSUMER_ID, this.ownerKey))?.value)
    return {
      schemaVersion: OFFICE_MEMORY_SCHEMA_VERSION,
      rawRecords: countOf(this.db, "SELECT COUNT(*) AS count FROM memory_raw_records WHERE owner_key = ?", this.ownerKey),
      conversations: countOf(this.db, "SELECT COUNT(*) AS count FROM memory_conversations WHERE owner_key = ?", this.ownerKey),
      assistantControlConversations: countOf(
        this.db,
        "SELECT COUNT(*) AS count FROM memory_conversations WHERE owner_key = ? AND is_assistant_control = 1",
        this.ownerKey,
      ),
      messages: countOf(this.db, "SELECT COUNT(*) AS count FROM memory_messages WHERE owner_key = ?", this.ownerKey),
      eligibleMessages: countOf(
        this.db,
        "SELECT COUNT(*) AS count FROM memory_messages WHERE owner_key = ? AND learning_eligible = 1",
        this.ownerKey,
      ),
      rejectedMessages: countOf(
        this.db,
        "SELECT COUNT(*) AS count FROM memory_messages WHERE owner_key = ? AND learning_eligible = 0",
        this.ownerKey,
      ),
      latestMessageAt: latest === null ? null : isoShanghai(numeric(latest)),
      fullSyncFrom:
        fullSync?.range_start === null || fullSync?.range_start === undefined
          ? null
          : isoShanghai(numeric(fullSync.range_start)),
      fullSyncThrough:
        fullSync?.range_end === null || fullSync?.range_end === undefined
          ? null
          : isoShanghai(numeric(fullSync.range_end)),
      lastSuccessfulSyncAt:
        lastSuccessfulSyncAt === null ? null : isoShanghai(numeric(lastSuccessfulSyncAt)),
      changelogHead: head,
      ftsAckedSeq: acked,
      ftsLag: Math.max(0, head - acked),
    }
  }

  recordSyncRun(input: SyncRunInput): void {
    this.assertOpen()
    const start = parseBoundary(input.start, "start")
    const end = parseBoundary(input.end, "end")
    this.db.prepare(
      `INSERT INTO memory_sync_runs
       (id, owner_key, source, range_start, range_end, query, status, raw_records,
        messages_created, messages_updated, started_at, completed_at, error, chat_type,
        coverage_complete)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      this.ownerKey,
      input.source,
      start,
      end,
      input.query,
      input.status,
      input.rawRecords,
      input.messagesCreated,
      input.messagesUpdated,
      input.startedAt,
      Date.now(),
      input.error?.slice(0, 1000) ?? null,
      input.chatType ?? null,
      input.coverageComplete ? 1 : 0,
    )
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("office memory is closed")
  }

  private markAssistantControlFromPayload(inspected: LarkPayloadInspection): void {
    if (this.assistantBotExternalId === null && this.assistantBotName === null) return
    const candidates = new Set(
      inspected.messages
        .filter(
          (message) =>
            message.conversationType === "p2p" &&
            (message.origin === "bot" || message.origin === "agent") &&
            (this.assistantBotExternalId !== null
              ? message.senderExternalId === this.assistantBotExternalId
              : message.senderDisplayName === this.assistantBotName ||
                message.conversationTitle === this.assistantBotName),
        )
        .map((message) => message.conversationExternalId),
    )
    if (candidates.size === 1) this.markAssistantControlConversation([...candidates][0])
  }

  private discoverExistingAssistantControlConversation(): void {
    if (this.assistantBotExternalId === null && this.assistantBotName === null) return
    const candidates = this.assistantBotExternalId !== null
      ? this.db.prepare(
          `SELECT DISTINCT c.external_id
           FROM memory_conversations c
           JOIN memory_messages m ON m.conversation_id = c.id
           WHERE c.owner_key = ? AND c.type = 'p2p' AND m.origin IN ('bot', 'agent')
             AND m.sender_external_id = ?`,
        ).all(this.ownerKey, this.assistantBotExternalId)
      : this.db.prepare(
          `SELECT DISTINCT c.external_id
           FROM memory_conversations c
           JOIN memory_messages m ON m.conversation_id = c.id
           WHERE c.owner_key = ? AND c.type = 'p2p' AND m.origin IN ('bot', 'agent')
             AND (m.sender_display_name = ? OR c.title = ?)`,
        ).all(this.ownerKey, this.assistantBotName, this.assistantBotName)
    if (candidates.length !== 1) return
    const candidate = row<{ external_id: string }>(candidates[0])
    if (candidate !== null) this.markAssistantControlConversation(candidate.external_id)
  }

  private upsertMessage(
    message: NormalizedOfficeMessage,
    rawId: string,
    now: number,
    result: MemoryIngestResult,
  ): void {
    const conversationId = memoryLocalId(this.ownerKey, "conversation", message.conversationExternalId)
    const conversation = this.upsertConversation(conversationId, message, now)
    const eligibility = evaluateOfficeMemoryEligibility({
      contentText: message.contentText,
      origin: message.origin,
      assistantControl: conversation.is_assistant_control === 1,
      botChannel: conversation.is_bot_channel === 1,
      learningEnabled: conversation.learning_enabled === 1,
    })
    if (eligibility.eligible) result.eligible += 1
    else incrementRejection(result.rejected, eligibility.reason)

    const id = memoryLocalId(this.ownerKey, "message", message.externalId)
    const existing = row<ExistingMessageRow>(this.db.prepare(
      `SELECT id, source_digest, learning_eligible, rejection_reason, revision
       FROM memory_messages WHERE id = ? AND owner_key = ?`,
    ).get(id, this.ownerKey))
    const eligibleValue = eligibility.eligible ? 1 : 0
    const rejectionReason = eligibility.reason
    if (
      existing !== null &&
      existing.source_digest === message.digest &&
      existing.learning_eligible === eligibleValue &&
      existing.rejection_reason === rejectionReason
    ) {
      result.unchanged += 1
      return
    }

    if (existing === null) {
      this.db.prepare(
        `INSERT INTO memory_messages
         (id, owner_key, platform, external_id, conversation_id, sender_external_id,
          sender_display_name, message_type, content_text, content_json, sent_at, updated_at,
          parent_external_id, root_external_id, thread_external_id, direction, is_self, origin,
          learning_eligible, rejection_reason, raw_record_id, source_digest, revision,
          created_at, updated_local_at)
         VALUES (?, ?, 'feishu', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        id,
        this.ownerKey,
        message.externalId,
        conversationId,
        message.senderExternalId,
        message.senderDisplayName,
        message.messageType,
        message.contentText,
        message.contentJson,
        message.sentAt,
        message.updatedAt,
        message.parentExternalId,
        message.rootExternalId,
        message.threadExternalId,
        message.direction,
        message.isSelf === null ? null : message.isSelf ? 1 : 0,
        message.origin,
        eligibleValue,
        rejectionReason,
        rawId,
        message.digest,
        now,
        now,
      )
      result.created += 1
    } else {
      this.db.prepare(
        `UPDATE memory_messages SET
           conversation_id = ?, sender_external_id = ?, sender_display_name = ?, message_type = ?,
           content_text = ?, content_json = ?, sent_at = ?, updated_at = ?, parent_external_id = ?,
           root_external_id = ?, thread_external_id = ?, direction = ?, is_self = ?, origin = ?,
           learning_eligible = ?, rejection_reason = ?, raw_record_id = ?, source_digest = ?,
           revision = revision + 1, updated_local_at = ?
         WHERE id = ? AND owner_key = ?`,
      ).run(
        conversationId,
        message.senderExternalId,
        message.senderDisplayName,
        message.messageType,
        message.contentText,
        message.contentJson,
        message.sentAt,
        message.updatedAt,
        message.parentExternalId,
        message.rootExternalId,
        message.threadExternalId,
        message.direction,
        message.isSelf === null ? null : message.isSelf ? 1 : 0,
        message.origin,
        eligibleValue,
        rejectionReason,
        rawId,
        message.digest,
        now,
        id,
        this.ownerKey,
      )
      result.updated += 1
    }

    this.db.prepare("DELETE FROM memory_message_mentions WHERE message_id = ?").run(id)
    const insertMention = this.db.prepare(
      `INSERT OR IGNORE INTO memory_message_mentions(message_id, actor_external_id, is_self)
       VALUES (?, ?, ?)`,
    )
    for (const mention of message.mentions) {
      insertMention.run(id, mention, mention === this.ownerExternalId ? 1 : 0)
    }
    this.emitChange("message", id, message.sentAt, now, rawId, sha256Text(`${message.digest}:${eligibleValue}`))
  }

  private upsertConversation(
    id: string,
    message: NormalizedOfficeMessage,
    now: number,
  ): ConversationRow {
    const existing = row<ConversationRow>(this.db.prepare(
      `SELECT id, type, title, is_assistant_control, is_bot_channel, learning_enabled,
              first_seen_at, last_seen_at
       FROM memory_conversations WHERE id = ? AND owner_key = ?`,
    ).get(id, this.ownerKey))
    if (existing === null) {
      this.db.prepare(
        `INSERT INTO memory_conversations
         (id, owner_key, platform, external_id, type, title, is_assistant_control,
          is_bot_channel, learning_enabled, first_seen_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, 'feishu', ?, ?, ?, 0, 0, 1, ?, ?, ?, ?)`,
      ).run(
        id,
        this.ownerKey,
        message.conversationExternalId,
        message.conversationType,
        message.conversationTitle,
        message.sentAt,
        message.sentAt,
        now,
        now,
      )
      this.emitChange("conversation", id, message.sentAt, now, null, sha256Text(`${id}:${message.conversationTitle ?? ""}`))
      return {
        id,
        type: message.conversationType,
        title: message.conversationTitle,
        is_assistant_control: 0,
        is_bot_channel: 0,
        learning_enabled: 1,
        first_seen_at: message.sentAt,
        last_seen_at: message.sentAt,
      }
    }

    const nextType = message.conversationType === "unknown" ? existing.type : message.conversationType
    const nextTitle = message.conversationTitle ?? existing.title
    const nextFirstSeen = Math.min(existing.first_seen_at, message.sentAt)
    const nextLastSeen = Math.max(existing.last_seen_at, message.sentAt)
    const indexChanged = nextType !== existing.type || nextTitle !== existing.title
    const changed =
      nextType !== existing.type ||
      nextTitle !== existing.title ||
      nextFirstSeen !== existing.first_seen_at ||
      nextLastSeen !== existing.last_seen_at
    if (changed) {
      this.db.prepare(
        `UPDATE memory_conversations
         SET type = ?, title = ?, first_seen_at = ?, last_seen_at = ?, updated_at = ?
         WHERE id = ? AND owner_key = ?`,
      ).run(nextType, nextTitle, nextFirstSeen, nextLastSeen, now, id, this.ownerKey)
      if (indexChanged) {
        this.emitChange("conversation", id, message.sentAt, now, null, sha256Text(`${id}:${nextTitle ?? ""}:${nextType}`))
      }
    }
    return { ...existing, type: nextType, title: nextTitle, first_seen_at: nextFirstSeen, last_seen_at: nextLastSeen }
  }

  private emitChange(
    entityType: "message" | "conversation",
    entityId: string,
    occurredAt: number,
    emittedAt: number,
    payloadRef: string | null,
    digest: string,
  ): void {
    this.db.prepare(
      `INSERT INTO memory_knowledge_changelog
       (op, entity_type, entity_id, owner_key, occurred_at, emitted_at, payload_ref, digest)
       VALUES ('upsert', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(entityType, entityId, this.ownerKey, occurredAt, emittedAt, payloadRef, digest)
  }

  private drainFts(): number {
    let indexed = 0
    while (true) {
      const cursor = numeric(row<{ acked_seq: number }>(this.db.prepare(
        `SELECT acked_seq FROM memory_consumer_cursors
         WHERE consumer_id = ? AND owner_key = ?`,
      ).get(FTS_CONSUMER_ID, this.ownerKey))?.acked_seq)
      const entries = this.db.prepare(
        `SELECT seq, entity_type, entity_id
         FROM memory_knowledge_changelog
         WHERE owner_key = ? AND seq > ? ORDER BY seq ASC LIMIT 500`,
      ).all(this.ownerKey, cursor)
      if (entries.length === 0) return indexed

      this.db.exec("BEGIN IMMEDIATE")
      try {
        let lastSeq = cursor
        for (const value of entries) {
          const entry = row<{ seq: number; entity_type: string; entity_id: string }>(value)
          if (entry === null) continue
          lastSeq = entry.seq
          if (entry.entity_type === "message") {
            indexed += this.reindexMessage(entry.entity_id)
          } else if (entry.entity_type === "conversation") {
            const messages = this.db.prepare(
              "SELECT id FROM memory_messages WHERE owner_key = ? AND conversation_id = ?",
            ).all(this.ownerKey, entry.entity_id)
            for (const item of messages) {
              const message = row<{ id: string }>(item)
              if (message !== null) indexed += this.reindexMessage(message.id)
            }
          }
        }
        this.db.prepare(
          `UPDATE memory_consumer_cursors
           SET acked_seq = ?, last_error = NULL, last_success_at = ?, updated_at = ?
           WHERE consumer_id = ? AND owner_key = ?`,
        ).run(lastSeq, Date.now(), Date.now(), FTS_CONSUMER_ID, this.ownerKey)
        this.db.exec("COMMIT")
      } catch (error) {
        this.db.exec("ROLLBACK")
        this.db.prepare(
          `UPDATE memory_consumer_cursors SET last_error = ?, updated_at = ?
           WHERE consumer_id = ? AND owner_key = ?`,
        ).run(error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000), Date.now(), FTS_CONSUMER_ID, this.ownerKey)
        throw error
      }
    }
  }

  private reindexMessage(messageId: string): number {
    this.db.prepare("DELETE FROM memory_messages_fts WHERE message_id = ? AND owner_key = ?").run(
      messageId,
      this.ownerKey,
    )
    const item = row<{
      id: string
      conversation_id: string
      content_text: string
      sender_display_name: string | null
      learning_eligible: number
      title: string | null
    }>(this.db.prepare(
      `SELECT m.id, m.conversation_id, m.content_text, m.sender_display_name,
              m.learning_eligible, c.title
       FROM memory_messages m JOIN memory_conversations c ON c.id = m.conversation_id
       WHERE m.id = ? AND m.owner_key = ?`,
    ).get(messageId, this.ownerKey))
    if (item === null || item.learning_eligible !== 1 || item.content_text.trim() === "") return 0
    this.db.prepare(
      `INSERT INTO memory_messages_fts
       (message_id, owner_key, conversation_id, content_tokens, sender_tokens, conversation_tokens)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      item.id,
      this.ownerKey,
      item.conversation_id,
      toSearchTokens(item.content_text),
      toSearchTokens(item.sender_display_name ?? ""),
      toSearchTokens(item.title ?? ""),
    )
    return 1
  }

  private toSearchHit(item: SearchRow): MemorySearchHit {
    return {
      memoryRef: memoryRef(item.id),
      source: "feishu",
      chatType: item.type === "p2p" || item.type === "group" ? item.type : "unknown",
      chat: conversationLabel(item.type, item.title),
      sender: senderLabel(item.is_self, item.sender_display_name),
      sentAt: isoShanghai(item.sent_at),
      content: item.content_text.slice(0, 1500),
      isSelf: item.is_self === null ? null : item.is_self === 1,
      revision: item.revision,
      relevance: typeof item.relevance === "number" ? item.relevance : null,
    }
  }
}

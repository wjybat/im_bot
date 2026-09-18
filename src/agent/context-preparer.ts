import { logger } from "../infra/logger.js"
import type { OfficeMemory, SemanticMemory } from "../memory/index.js"
import type { MemoryIngestResult } from "../memory/types.js"
import type { LarkGateway, RuntimeConfig, RuntimeUsage } from "../types.js"

interface TimeWindow {
  start: string
  end: string
}

export interface PrepareOfficeContextInput {
  start: string
  end: string
  query?: string
  chatType?: "p2p" | "group"
  freshness?: "current" | "cached_ok"
  semantic?: "messages" | "facts"
}

export interface PrepareOfficeContextResult {
  status: "ready" | "partial"
  coverage: {
    status: "complete" | "partial"
    source: "cache" | "feishu"
    requestedStart: string
    requestedEnd: string
  }
  semantic: {
    status: "not_requested" | "ready" | "partial"
    currentFacts: number
    factsChanged: number
  }
  evidence: {
    observedMessages: number
    changedMessages: number
    rejectedMessages: number
  }
  errors: number
}

function validateRange(start: string, end: string): { startAt: number; endAt: number } {
  const startAt = Date.parse(start)
  const endAt = Date.parse(end)
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) {
    throw new Error("start and end must be ISO-8601 date-times")
  }
  if (startAt > endAt) throw new Error("start must not be after end")
  return { startAt, endAt }
}

function payloadMayHaveMore(value: unknown): boolean {
  const visit = (current: unknown, depth: number): boolean => {
    if (depth > 4 || typeof current !== "object" || current === null) return false
    if (Array.isArray(current)) return current.some((item) => visit(item, depth + 1))
    const row = current as Record<string, unknown>
    if (row.truncated === true || row.has_more === true || row.hasMore === true) return true
    for (const key of ["next_page_token", "nextPageToken", "page_token", "pageToken"]) {
      if (typeof row[key] === "string" && row[key] !== "") return true
    }
    return ["data", "result"].some((key) => visit(row[key], depth + 1))
  }
  return visit(value, 0)
}

/** Collects chat ids and sender ids from a lark payload for name backfill. */
function collectChatAndSenderIds(payload: unknown, chatIds: Set<string>, senderIds: Set<string>): void {
  const visit = (current: unknown, depth: number): void => {
    if (depth > 4 || typeof current !== "object" || current === null) return
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1)
      return
    }
    const row = current as Record<string, unknown>
    const chat = row.chat_id ?? row.chatId
    if (typeof chat === "string" && chat.startsWith("oc_")) chatIds.add(chat)
    const sender = row.sender as Record<string, unknown> | undefined
    const senderId = sender?.open_id ?? row.sender_id ?? row.from_id
    if (typeof senderId === "string" && senderId.startsWith("ou_")) senderIds.add(senderId)
    for (const key of ["data", "result", "messages"]) visit(row[key], depth + 1)
  }
  visit(payload, 0)
}

export function splitWindow(window: TimeWindow, minWindowMs: number): [TimeWindow, TimeWindow] | null {
  const { startAt, endAt } = validateRange(window.start, window.end)
  if (endAt - startAt < minWindowMs) return null
  const middle = Math.trunc(startAt + (endAt - startAt) / 2)
  if (middle <= startAt || middle >= endAt) return null
  const toSecondPrecision = (value: number): string =>
    new Date(Math.floor(value / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
  return [
    { start: toSecondPrecision(startAt), end: toSecondPrecision(middle) },
    { start: toSecondPrecision(middle + 1), end: toSecondPrecision(endAt) },
  ]
}

function emptyAggregate(): MemoryIngestResult {
  return {
    rawInserted: false,
    created: 0,
    updated: 0,
    unchanged: 0,
    eligible: 0,
    rejected: {},
    indexed: 0,
    discoveredMessageIds: [],
  }
}

function mergeIngest(target: MemoryIngestResult, value: MemoryIngestResult): number {
  target.rawInserted = target.rawInserted || value.rawInserted
  target.created += value.created
  target.updated += value.updated
  target.unchanged += value.unchanged
  target.eligible += value.eligible
  target.indexed += value.indexed
  target.discoveredMessageIds.push(...value.discoveredMessageIds)
  for (const [reason, count] of Object.entries(value.rejected)) {
    if (count === undefined) continue
    const key = reason as keyof MemoryIngestResult["rejected"]
    target.rejected[key] = (target.rejected[key] ?? 0) + count
  }
  return value.rawInserted ? 1 : 0
}

export interface ContextPreparerOptions {
  config: RuntimeConfig
  gateway: LarkGateway
  memory: OfficeMemory
  semantic: SemanticMemory
  /** Owner whose user token backs gateway reads; null defers to the gateway's pinned owner. */
  ownerOpenId?: string | null
  onUsage?: (usage: RuntimeUsage) => void
  maxChunks?: number
  /** When true, semantic extraction prioritizes chunks inside the requested range. */
  prioritizeRequestWindow?: boolean
}

export class ContextPreparer {
  private readonly cache = new Map<string, Promise<PrepareOfficeContextResult>>()
  private semanticUpdate: Promise<Awaited<ReturnType<SemanticMemory["enrich"]>>> | null = null

  constructor(private readonly options: ContextPreparerOptions) {}

  /**
   * Brings the memory database up to the requested coverage: computes missing
   * time windows, syncs them from Lark (splitting on pagination), hydrates
   * bodies, then runs at most one bounded semantic update. Identical requests
   * within this preparer share a single in-flight promise.
   */
  prepare(input: PrepareOfficeContextInput, signal?: AbortSignal): Promise<PrepareOfficeContextResult> {
    validateRange(input.start, input.end)
    const normalized: Required<Pick<PrepareOfficeContextInput, "start" | "end" | "freshness" | "semantic">> &
      Pick<PrepareOfficeContextInput, "query" | "chatType"> = {
      start: input.start,
      end: input.end,
      freshness: input.freshness ?? "current",
      semantic: input.semantic ?? "facts",
      query: input.query?.trim() ?? "",
      ...(input.chatType === undefined ? {} : { chatType: input.chatType }),
    }
    const key = JSON.stringify(normalized)
    const existing = this.cache.get(key)
    if (existing) return existing
    const operation = this.run(normalized, signal)
    this.cache.set(key, operation)
    return operation
  }

  private async run(
    input: Required<Pick<PrepareOfficeContextInput, "start" | "end" | "freshness" | "semantic">> &
      Pick<PrepareOfficeContextInput, "query" | "chatType">,
    signal?: AbortSignal,
  ): Promise<PrepareOfficeContextResult> {
    const query = input.query ?? ""
    const initialCoverage = this.options.memory.coverageFor(input.start, input.end, query, input.chatType)
    const aggregate = emptyAggregate()
    let windowsRead = 0
    let errors = 0
    const attempted = new Set<string>()
    const chatIds = new Set<string>()
    const senderIds = new Set<string>()
    const queue: TimeWindow[] =
      input.freshness === "cached_ok" && initialCoverage.complete
        ? []
        : input.freshness === "current" && !initialCoverage.complete
          ? initialCoverage.missingRanges
          : input.freshness === "current"
            ? []
            : [{ start: input.start, end: input.end }]

    const syncWindow = async (window: TimeWindow): Promise<void> => {
      if (signal?.aborted) throw signal.reason
      const key = `${window.start}\u0000${window.end}`
      if (attempted.has(key)) return
      attempted.add(key)
      if (windowsRead >= this.options.config.memoryPrepareMaxWindows) return
      windowsRead += 1
      const startedAt = Date.now()
      let windowRawRecords = 0
      let windowCreated = 0
      let windowUpdated = 0
      try {
        const payload = await this.options.gateway.searchMessages(
          {
            query,
            start: window.start,
            end: window.end,
            ...(input.chatType ? { chatType: input.chatType } : {}),
            pageLimit: this.options.config.maxMessagePages,
            ...(this.options.ownerOpenId ? { ownerOpenId: this.options.ownerOpenId } : {}),
          },
          signal,
        )
        collectChatAndSenderIds(payload, chatIds, senderIds)
        const ingested = this.options.memory.ingestLarkPayload(payload, {
          source: "lark-sync",
          resource: "chat.message",
        })
        windowRawRecords += mergeIngest(aggregate, ingested)
        windowCreated += ingested.created
        windowUpdated += ingested.updated
        const inspected = this.options.memory.inspectLarkPayload(payload)
        const withBodies = new Set(
          inspected.messages
            .filter((message) => message.contentText.trim() !== "")
            .map((message) => message.externalId),
        )
        const unresolved = inspected.messageIds.filter((id) => !withBodies.has(id))
        let hydrationFailed = false
        for (let offset = 0; offset < unresolved.length; offset += 50) {
          try {
            const hydrated = await this.options.gateway.getMessagesByIds(
              unresolved.slice(offset, offset + 50),
              signal,
              this.options.ownerOpenId ?? undefined,
            )
            collectChatAndSenderIds(hydrated, chatIds, senderIds)
            const hydratedIngest = this.options.memory.ingestLarkPayload(hydrated, {
              source: "lark-sync",
              resource: "chat.message",
            })
            windowRawRecords += mergeIngest(aggregate, hydratedIngest)
            windowCreated += hydratedIngest.created
            windowUpdated += hydratedIngest.updated
          } catch {
            hydrationFailed = true
            errors += 1
          }
        }
        const truncated = payloadMayHaveMore(payload)
        const split = truncated
          ? splitWindow(window, this.options.config.memoryPrepareMinWindowMs)
          : null
        const complete = !truncated && !hydrationFailed
        this.options.memory.recordSyncRun({
          source: "lark-sync",
          start: window.start,
          end: window.end,
          query,
          ...(input.chatType ? { chatType: input.chatType } : {}),
          coverageComplete: complete,
          status: "success",
          startedAt,
          rawRecords: windowRawRecords,
          messagesCreated: windowCreated,
          messagesUpdated: windowUpdated,
        })
        if (truncated && split !== null && windowsRead < this.options.config.memoryPrepareMaxWindows) {
          await syncWindow(split[0])
          await syncWindow(split[1])
        }
      } catch (error) {
        errors += 1
        this.options.memory.recordSyncRun({
          source: "lark-sync",
          start: window.start,
          end: window.end,
          query,
          ...(input.chatType ? { chatType: input.chatType } : {}),
          coverageComplete: false,
          status: "failed",
          startedAt,
          rawRecords: windowRawRecords,
          messagesCreated: windowCreated,
          messagesUpdated: windowUpdated,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    for (const window of queue) await syncWindow(window)
    await this.backfillDisplayNames(chatIds, senderIds)
    const finalCoverage = this.options.memory.coverageFor(input.start, input.end, query, input.chatType)
    let failedChunks = 0
    let factsCreated = 0
    let factsUpdated = 0
    if (input.semantic === "facts" && this.options.semantic.pendingMessageCount() > 0) {
      const ownsSemanticUpdate = this.semanticUpdate === null
      if (this.semanticUpdate === null) {
        const rangeStart = Date.parse(input.start)
        const rangeEnd = Date.parse(input.end)
        this.semanticUpdate = this.options.semantic.enrich(
          this.options.maxChunks ?? this.options.config.memoryExtractionMaxChunks,
          signal,
          this.options.onUsage,
          this.options.prioritizeRequestWindow === true && Number.isFinite(rangeStart) && Number.isFinite(rangeEnd)
            ? { start: rangeStart, end: rangeEnd }
            : undefined,
        )
      }
      const enrichment = await this.semanticUpdate
      failedChunks = enrichment.failedChunks
      if (ownsSemanticUpdate) {
        factsCreated = enrichment.factsCreated
        factsUpdated = enrichment.factsMerged + enrichment.factsSuperseded
        errors += enrichment.failedChunks
      }
    }
    const pendingMessages = this.options.semantic.pendingMessageCount()
    const status = this.options.memory.status()
    const semanticStatus = input.semantic === "messages"
      ? "not_requested" as const
      : pendingMessages === 0 && failedChunks === 0
        ? "ready" as const
        : "partial" as const
    const overall = finalCoverage.complete && semanticStatus !== "partial" ? "ready" : "partial"
    return {
      status: overall,
      coverage: {
        status: finalCoverage.complete ? "complete" : "partial",
        source: windowsRead === 0 ? "cache" : "feishu",
        requestedStart: input.start,
        requestedEnd: input.end,
      },
      semantic: {
        status: semanticStatus,
        currentFacts: status.currentFacts,
        factsChanged: factsCreated + factsUpdated,
      },
      evidence: {
        observedMessages: aggregate.eligible,
        changedMessages: aggregate.created + aggregate.updated,
        rejectedMessages: Object.values(aggregate.rejected).reduce((sum, count) => sum + (count ?? 0), 0),
      },
      errors,
    }
  }

  /**
   * Resolves chat titles and sender display names for freshly synced rows
   * (the message search/list APIs return ids only) and backfills them into
   * memory. Best effort: failures are logged and skipped, never fatal.
   */
  private async backfillDisplayNames(chatIds: ReadonlySet<string>, senderIds: ReadonlySet<string>): Promise<void> {
    if (chatIds.size === 0 && senderIds.size === 0) return
    const resolver = this.options.gateway as LarkGateway & {
      resolveDisplayNames?: (input: {
        chatIds: readonly string[]
        senderIds: readonly string[]
        ownerOpenId?: string
      }) => Promise<{ chatTitles: Map<string, string>; senderNames: Map<string, string> }>
    }
    if (typeof resolver.resolveDisplayNames !== "function") return
    try {
      const names = await resolver.resolveDisplayNames({
        chatIds: [...chatIds],
        senderIds: [...senderIds],
        ...(this.options.ownerOpenId ? { ownerOpenId: this.options.ownerOpenId } : {}),
      })
      const backfilled = this.options.memory.backfillDisplayNames({
        chatTitles: names.chatTitles,
        senderNames: names.senderNames,
      })
      if (backfilled.conversations > 0 || backfilled.messages > 0) {
        logger.info("memory_display_names_backfilled", {
          conversations: backfilled.conversations,
          messages: backfilled.messages,
        })
      }
    } catch (error) {
      logger.warn("memory_display_names_backfill_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

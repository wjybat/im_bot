import type { AgentTool } from "@earendil-works/pi-agent-core"
import { Type } from "@earendil-works/pi-ai"
import { logger } from "../infra/logger.js"
import { truncateText } from "../infra/safety.js"
import type { OfficeMemory } from "../memory/index.js"
import type { MemoryIngestResult } from "../memory/types.js"
import type { LarkGateway, RuntimeConfig } from "../types.js"

function textResult(value: unknown, maxChars: number, details: Record<string, unknown> = {}) {
  const text = truncateText(JSON.stringify(value, null, 2), maxChars, "\n\n[memory output truncated]")
  return {
    content: [{ type: "text" as const, text }],
    details,
  }
}

function validateRange(start: string, end: string): void {
  const startAt = Date.parse(start)
  const endAt = Date.parse(end)
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) {
    throw new Error("start and end must be ISO-8601 date-times")
  }
  if (startAt > endAt) throw new Error("start must not be after end")
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

function aggregateIngest(target: MemoryIngestResult, value: MemoryIngestResult): number {
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

function newAggregate(): MemoryIngestResult {
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

export async function ingestMessageToolOutput(
  memory: OfficeMemory,
  args: readonly string[],
  stdout: string,
): Promise<MemoryIngestResult | null> {
  const command = `${args[0] ?? ""} ${args[1] ?? ""}`
  const supported = new Set([
    "im +messages-search",
    "im +messages-mget",
    "im +chat-messages-list",
    "im +threads-messages-list",
  ])
  if (!supported.has(command)) return null
  const fallbackIndex = args.findIndex((arg) => arg === "--chat-id")
  const fallback = fallbackIndex >= 0 ? args[fallbackIndex + 1] : undefined
  try {
    const payload = JSON.parse(stdout) as unknown
    return memory.ingestLarkPayload(payload, {
      source: "lark-cli",
      resource: "chat.message",
      ...(fallback ? { fallbackConversationExternalId: fallback } : {}),
    })
  } catch (error) {
    logger.error("office_memory_tool_ingest_failed", error, { command })
    return null
  }
}

export function createMemoryTools(
  config: RuntimeConfig,
  gateway: LarkGateway,
  memory: OfficeMemory,
): AgentTool[] {
  const searchParameters = Type.Object({
    query: Type.Optional(Type.String({
      maxLength: 2_000,
      description: "Optional keyword or natural-language topic. Omit for a chronological time-range scan.",
    })),
    start: Type.Optional(Type.String({ description: "Optional ISO-8601 inclusive lower time bound." })),
    end: Type.Optional(Type.String({ description: "Optional ISO-8601 inclusive upper time bound." })),
    chatType: Type.Optional(Type.Union([Type.Literal("p2p"), Type.Literal("group")])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  })
  const searchTool: AgentTool<typeof searchParameters> = {
    name: "search_office_memory",
    label: "Search office memory",
    description:
      "Search the owner's locally indexed, evidence-backed Feishu office messages. This is a cache, not the source of truth: sync or use live Lark reads when freshness matters. Results never include the assistant-control conversation or agent-generated content.",
    parameters: searchParameters,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const hits = memory.search(params)
      return textResult(
        { count: hits.length, hits },
        config.maxToolOutputChars,
        { count: hits.length, source: "office-memory" },
      )
    },
  }

  const evidenceParameters = Type.Object({
    memoryRefs: Type.Array(Type.String({ pattern: "^mem_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 20,
      description: "Opaque memory references returned by search_office_memory.",
    }),
  })
  const evidenceTool: AgentTool<typeof evidenceParameters> = {
    name: "get_memory_evidence",
    label: "Read office memory evidence",
    description:
      "Expand locally stored source evidence selected from search_office_memory. Only eligible human-office corpus rows can be returned.",
    parameters: evidenceParameters,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const evidence = memory.getEvidence(params.memoryRefs)
      return textResult(
        { count: evidence.length, evidence },
        config.maxToolOutputChars,
        { count: evidence.length, source: "office-memory" },
      )
    },
  }

  const syncParameters = Type.Object({
    start: Type.String({ description: "ISO-8601 inclusive lower time bound chosen for this task." }),
    end: Type.String({ description: "ISO-8601 inclusive upper time bound chosen for this task." }),
    query: Type.Optional(Type.String({ maxLength: 2_000, description: "Optional Feishu message search query." })),
    chatType: Type.Optional(Type.Union([Type.Literal("p2p"), Type.Literal("group")])),
  })
  const syncTool: AgentTool<typeof syncParameters> = {
    name: "sync_office_context",
    label: "Sync Feishu office context",
    description:
      "Incrementally fetch a bounded owner-authorized Feishu message range into local office memory, hydrate message bodies when needed, and update FTS. Use before memory search when current information is required. The assistant-control chat is retained only as rejected audit data and never becomes office corpus.",
    parameters: syncParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      validateRange(params.start, params.end)
      const startedAt = Date.now()
      const aggregate = newAggregate()
      let rawRecordsInserted = 0
      try {
        const payload = await gateway.searchMessages(
          {
            query: params.query ?? "",
            start: params.start,
            end: params.end,
            ...(params.chatType ? { chatType: params.chatType } : {}),
            pageLimit: config.maxMessagePages,
          },
          signal,
        )
        const mayHaveMore = payloadMayHaveMore(payload)
        rawRecordsInserted += aggregateIngest(
          aggregate,
          memory.ingestLarkPayload(payload, { source: "lark-sync", resource: "chat.message" }),
        )

        const inspected = memory.inspectLarkPayload(payload)
        const withBodies = new Set(
          inspected.messages.filter((message) => message.contentText.trim() !== "").map((message) => message.externalId),
        )
        const unresolved = inspected.messageIds.filter((id) => !withBodies.has(id))
        for (let offset = 0; offset < unresolved.length; offset += 50) {
          const hydrated = await gateway.getMessagesByIds(unresolved.slice(offset, offset + 50), signal)
          rawRecordsInserted += aggregateIngest(
            aggregate,
            memory.ingestLarkPayload(hydrated, { source: "lark-sync", resource: "chat.message" }),
          )
        }

        memory.recordSyncRun({
          source: "lark-sync",
          start: params.start,
          end: params.end,
          query: params.query ?? "",
          ...(params.chatType ? { chatType: params.chatType } : {}),
          coverageComplete: (params.query ?? "").trim() === "" && params.chatType === undefined && !mayHaveMore,
          status: "success",
          startedAt,
          rawRecords: rawRecordsInserted,
          messagesCreated: aggregate.created,
          messagesUpdated: aggregate.updated,
        })
        const status = memory.status()
        return textResult(
          {
            synced: true,
            range: { start: params.start, end: params.end },
            rangeComplete: !mayHaveMore,
            created: aggregate.created,
            updated: aggregate.updated,
            unchanged: aggregate.unchanged,
            eligible: aggregate.eligible,
            rejected: aggregate.rejected,
            memory: {
              eligibleMessages: status.eligibleMessages,
              latestMessageAt: status.latestMessageAt,
              fullSyncFrom: status.fullSyncFrom,
              fullSyncThrough: status.fullSyncThrough,
              ftsLag: status.ftsLag,
            },
          },
          config.maxToolOutputChars,
          { created: aggregate.created, updated: aggregate.updated, rejected: aggregate.rejected },
        )
      } catch (error) {
        memory.recordSyncRun({
          source: "lark-sync",
          start: params.start,
          end: params.end,
          query: params.query ?? "",
          ...(params.chatType ? { chatType: params.chatType } : {}),
          coverageComplete: false,
          status: "failed",
          startedAt,
          rawRecords: rawRecordsInserted,
          messagesCreated: aggregate.created,
          messagesUpdated: aggregate.updated,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },
  }

  const statusParameters = Type.Object({})
  const statusTool: AgentTool<typeof statusParameters> = {
    name: "get_memory_status",
    label: "Inspect office memory freshness",
    description:
      "Inspect local office-memory coverage and FTS lag without exposing source identifiers. Use it to decide whether a live sync is needed.",
    parameters: statusParameters,
    executionMode: "parallel",
    async execute() {
      return textResult(memory.status(), config.maxToolOutputChars, { source: "office-memory" })
    },
  }

  return [searchTool, evidenceTool, syncTool, statusTool]
}

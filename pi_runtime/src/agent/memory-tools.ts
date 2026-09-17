import type { AgentTool } from "@earendil-works/pi-agent-core"
import { Type } from "@earendil-works/pi-ai"
import { logger } from "../infra/logger.js"
import { truncateText } from "../infra/safety.js"
import {
  OFFICE_FACT_STATUSES,
  OFFICE_FACT_TYPES,
  type OfficeMemory,
  type SemanticMemory,
} from "../memory/index.js"
import type { LarkGateway, RuntimeConfig, RuntimeUsage } from "../types.js"
import { ContextPreparer } from "./context-preparer.js"

function textResult(value: unknown, maxChars: number, details: Record<string, unknown> = {}) {
  const text = truncateText(JSON.stringify(value, null, 2), maxChars, "\n\n[memory output truncated]")
  return { content: [{ type: "text" as const, text }], details }
}

export async function ingestMessageToolOutput(
  memory: OfficeMemory,
  args: readonly string[],
  stdout: string,
) {
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
    return memory.ingestLarkPayload(JSON.parse(stdout) as unknown, {
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
  semantic: SemanticMemory,
  onUsage?: (usage: RuntimeUsage) => void,
  ownerOpenId?: string | null,
): AgentTool[] {
  const preparer = new ContextPreparer({
    config,
    gateway,
    memory,
    semantic,
    prioritizeRequestWindow: true,
    ...(ownerOpenId ? { ownerOpenId } : {}),
    ...(onUsage ? { onUsage } : {}),
  })

  /**
   * Per-run budget across both search tools. Broad tasks that fan out into
   * dozens of narrow searches waste minutes of model reasoning; past the
   * budget the tools force the model to work with gathered evidence.
   */
  let searchBudget = Math.max(1, config.memorySearchCallsPerRun)
  const consumeSearchBudget = (toolName: string): string | null => {
    if (searchBudget <= 0) {
      return [
        `本任务的检索配额已用尽（${toolName} 已被限制）。`,
        "请停止继续检索，直接基于已获得的证据完成回答；如确有关键缺口，在回答中说明该部分无法核实。",
      ].join("\n")
    }
    searchBudget -= 1
    return null
  }

  const searchParameters = Type.Object({
    query: Type.Optional(Type.String({ maxLength: 2_000 })),
    start: Type.Optional(Type.String({ description: "Optional ISO-8601 inclusive lower time bound." })),
    end: Type.Optional(Type.String({ description: "Optional ISO-8601 inclusive upper bound." })),
    chatType: Type.Optional(Type.Union([Type.Literal("p2p"), Type.Literal("group")], {
      description: "Restrict only when the task explicitly needs one chat type; omit to cover both private and group chats.",
    })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  })
  const searchTool: AgentTool<typeof searchParameters> = {
    name: "search_office_memory",
    label: "Search source office messages",
    description:
      "Search locally indexed, evidence-backed Feishu messages. Use prepare_office_context first when the requested range must be current. Assistant-control and agent-generated content is excluded. Prefer a few broad searches (wide time range, per-domain keywords) over many narrow ones; the total number of search calls per task is bounded.",
    parameters: searchParameters,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const blocked = consumeSearchBudget("search_office_memory")
      if (blocked !== null) return { content: [{ type: "text" as const, text: blocked }], details: { blocked: true } }
      const hits = memory.search(params)
      return textResult({ count: hits.length, hits }, config.maxToolOutputChars, {
        count: hits.length,
        source: "office-memory",
      })
    },
  }

  const factTypeSchema = Type.Union(OFFICE_FACT_TYPES.map((value) => Type.Literal(value)))
  const factStatusSchema = Type.Union(OFFICE_FACT_STATUSES.map((value) => Type.Literal(value)))
  const hybridParameters = Type.Object({
    query: Type.Optional(Type.String({ maxLength: 2_000 })),
    start: Type.Optional(Type.String({ description: "Optional ISO-8601 fact/evidence lower bound." })),
    end: Type.Optional(Type.String({ description: "Optional ISO-8601 fact/evidence upper bound." })),
    dueStart: Type.Optional(Type.String({ description: "Optional ISO-8601 due-time lower bound." })),
    dueEnd: Type.Optional(Type.String({ description: "Optional ISO-8601 due-time upper bound." })),
    chatType: Type.Optional(Type.Union([Type.Literal("p2p"), Type.Literal("group")], {
      description: "Restrict only when explicitly requested; omit to search private and group chats together.",
    })),
    factTypes: Type.Optional(Type.Array(factTypeSchema, { maxItems: OFFICE_FACT_TYPES.length })),
    statuses: Type.Optional(Type.Array(factStatusSchema, { maxItems: OFFICE_FACT_STATUSES.length })),
    currentOnly: Type.Optional(Type.Boolean({ description: "Defaults to true." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    tokenBudget: Type.Optional(Type.Integer({ minimum: 500, maximum: 64_000 })),
  })
  const hybridTool: AgentTool<typeof hybridParameters> = {
    name: "search_office_context",
    label: "Search prepared office context",
    description:
      "Search prepared facts and source messages through lexical, structured, recency, and graph routes. Results are RRF-fused, deduplicated, evidence-linked, and token-budgeted. Prefer a few broad searches over many narrow ones; the total number of search calls per task is bounded.",
    parameters: hybridParameters,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const blocked = consumeSearchBudget("search_office_context")
      if (blocked !== null) return { content: [{ type: "text" as const, text: blocked }], details: { blocked: true } }
      const result = semantic.search({
        ...params,
        tokenBudget: params.tokenBudget ?? config.memoryHybridTokenBudget,
      })
      return textResult(result, config.maxToolOutputChars, {
        hits: result.hits.length,
        estimatedTokens: result.estimatedTokens,
        truncated: result.truncated,
      })
    },
  }

  const evidenceParameters = Type.Object({
    memoryRefs: Type.Array(Type.String({ pattern: "^(?:mem|fact)_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 20,
    }),
  })
  const evidenceTool: AgentTool<typeof evidenceParameters> = {
    name: "get_memory_evidence",
    label: "Expand office evidence",
    description: "Expand selected fact or message evidence. Only eligible source messages can be returned.",
    parameters: evidenceParameters,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const messages = memory.getEvidence(params.memoryRefs.filter((ref) => ref.startsWith("mem_")))
      const facts = semantic.getFactEvidence(params.memoryRefs.filter((ref) => ref.startsWith("fact_")))
      return textResult(
        { count: messages.length + facts.length, facts, messages },
        config.maxToolOutputChars,
        { count: messages.length + facts.length, source: "office-memory" },
      )
    },
  }

  const prepareParameters = Type.Object({
    start: Type.String({ description: "ISO-8601 inclusive lower bound required by the task." }),
    end: Type.String({ description: "ISO-8601 inclusive upper bound required by the task." }),
    query: Type.Optional(Type.String({
      maxLength: 2_000,
      description: "Optional source-message filter. Omit for complete time-range coverage.",
    })),
    chatType: Type.Optional(Type.Union([Type.Literal("p2p"), Type.Literal("group")], {
      description: "Restrict only when explicitly requested; omit to prepare private and group chats together.",
    })),
    freshness: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("cached_ok")])),
    semantic: Type.Optional(Type.Union([Type.Literal("messages"), Type.Literal("facts")], {
      description: "facts includes both durable facts/graph and their source messages; do not prepare messages separately.",
    })),
  })
  const prepareTool: AgentTool<typeof prepareParameters> = {
    name: "prepare_office_context",
    label: "Prepare current office context",
    description:
      "Prepare one bounded Feishu message range for reliable reasoning. For broad tasks, use one continuous range, omit chatType to cover private and group chats together, and use semantic=facts because it already includes source messages. Internally handles coverage, pagination, hydration, idempotent ingestion, and at most one fact/graph update per Agent run. ready and partial are both usable; after one broad preparation continue to search instead of preparing alternate variants.",
    parameters: prepareParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const result = await preparer.prepare(params, signal)
      return textResult(result, config.maxToolOutputChars, {
        status: result.status,
        coverage: result.coverage.status,
        semantic: result.semantic.status,
      })
    },
  }

  const statusParameters = Type.Object({})
  const statusTool: AgentTool<typeof statusParameters> = {
    name: "get_memory_status",
    label: "Inspect office-memory readiness",
    description: "Inspect business-level message coverage and semantic readiness without internal cursors.",
    parameters: statusParameters,
    executionMode: "parallel",
    async execute() {
      const status = memory.status()
      const pendingMessages = semantic.pendingMessageCount()
      return textResult(
        {
          messageMemory: {
            status: status.eligibleMessages > 0 ? "available" : "empty",
            eligibleMessages: status.eligibleMessages,
            rejectedMessages: status.rejectedMessages,
            latestMessageAt: status.latestMessageAt,
            lastCompleteWindow:
              status.fullSyncFrom && status.fullSyncThrough
                ? { start: status.fullSyncFrom, end: status.fullSyncThrough }
                : null,
            lastSuccessfulSyncAt: status.lastSuccessfulSyncAt,
          },
          semanticMemory: {
            status: pendingMessages === 0 ? "ready" : status.currentFacts > 0 ? "partial" : "stale",
            currentFacts: status.currentFacts,
            failedExtractions: status.failedExtractions,
          },
        },
        config.maxToolOutputChars,
        { source: "office-memory" },
      )
    },
  }

  return [searchTool, hybridTool, evidenceTool, prepareTool, statusTool]
}

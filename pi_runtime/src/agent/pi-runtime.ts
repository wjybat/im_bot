import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type StreamFn,
} from "@earendil-works/pi-agent-core"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Api,
  type Model,
  type Models,
} from "@earendil-works/pi-ai"
import { redactInternalIdentifiers, truncateText } from "../infra/safety.js"
import { logger } from "../infra/logger.js"
import { OfficeMemory, PiFactExtractor, SemanticMemory } from "../memory/index.js"
import { addRuntimeUsage, emptyRuntimeUsage } from "../memory/usage.js"
import type {
  AgentRuntime,
  LarkGateway,
  MemoryBackedRuntime,
  OwnerMemorySession,
  OwnerMemorySessionProvider,
  RuntimeConfig,
  RuntimeRequest,
  RuntimeResult,
  RuntimeTelemetry,
  RuntimeUsage,
} from "../types.js"
import { createModelRuntime } from "./model.js"
import { buildSystemPrompt } from "./prompt.js"
import { loadRuntimeSkills, type RuntimeSkills } from "./skills.js"
import { shanghaiTimeContext } from "./time.js"
import { createRuntimeTools } from "./tools.js"

interface PiRuntimeOptions {
  config: RuntimeConfig
  gateway: LarkGateway
  models: Models
  model: Model<Api>
  streamFn: StreamFn
  skills: RuntimeSkills
  memory: OfficeMemory
  semantic: SemanticMemory
  /** Optional per-owner memory routing for multi-user deployments. */
  sessionProvider?: OwnerMemorySessionProvider
}

function emptyUsage(): RuntimeUsage {
  return emptyRuntimeUsage()
}

function aggregateUsage(messages: readonly AgentMessage[], auxiliary?: RuntimeUsage): RuntimeUsage {
  const result = emptyUsage()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    result.inputTokens += message.usage.input
    result.outputTokens += message.usage.output
    result.cacheReadTokens += message.usage.cacheRead
    result.cacheWriteTokens += message.usage.cacheWrite
    result.reasoningTokens += message.usage.reasoning ?? 0
    result.totalTokens += message.usage.totalTokens
    result.inputCostUsd += message.usage.cost.input
    result.outputCostUsd += message.usage.cost.output
    result.cacheReadCostUsd += message.usage.cost.cacheRead
    result.cacheWriteCostUsd += message.usage.cost.cacheWrite
    result.estimatedCostUsd += message.usage.cost.total
  }
  if (auxiliary) addRuntimeUsage(result, auxiliary)
  return result
}

export class PiRuntimeExecutionError extends Error {
  constructor(message: string, readonly telemetry: RuntimeTelemetry, options?: ErrorOptions) {
    super(message, options)
    this.name = "PiRuntimeExecutionError"
  }
}

/**
 * Extracts a retryable upstream HTTP status from a provider error message
 * (e.g. "OpenAI API error (503): ..." or "Mistral API error (529): ...").
 * Returns null for absent or non-retryable statuses.
 */
export function upstreamHttpStatusOf(message: string): number | null {
  const match = /API error \((\d{3})\)/.exec(message)
  if (match === null) return null
  const status = Number.parseInt(match[1]!, 10)
  if (status === 408 || status === 409 || status === 429 || status >= 500) return status
  return null
}

/**
 * Known transient overload phrases that arrive without an HTTP status
 * (stream-level errors surfaced as plain text, e.g. "Our servers are
 * currently overloaded. Please try again later."). Matching is
 * case-insensitive substring containment.
 */
const TRANSIENT_OVERLOAD_PHRASES: readonly string[] = [
  "servers are currently overloaded",
  "currently overloaded",
  "please try again later",
  "overloaded_error",
  "server_error",
  "capacity",
  "temporarily unavailable",
  "model service unavailable",
  "upstream_error",
  "try your request again",
]

/** True when an error message carries a transient-overload phrase without a status code. */
export function isTransientOverloadMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return TRANSIENT_OVERLOAD_PHRASES.some((phrase) => normalized.includes(phrase))
}

function finalReply(messages: readonly AgentMessage[]): string {
  const final = [...messages].reverse().find((message) => message.role === "assistant")
  if (!final || final.role !== "assistant") throw new Error("Pi runtime returned no assistant message")
  if (final.stopReason === "error" || final.stopReason === "aborted" || final.stopReason === "deferred") {
    throw new Error(final.errorMessage || `Pi runtime stopped with ${final.stopReason}`)
  }
  const text = final.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim()
  if (text === "") throw new Error("Pi runtime returned no final text")
  return text
}

export class PiAgentRuntime implements MemoryBackedRuntime {
  readonly memory: OfficeMemory
  readonly semantic: SemanticMemory

  private readonly config: RuntimeConfig
  private readonly gateway: LarkGateway
  private readonly models: Models
  private readonly model: Model<Api>
  private readonly streamFn: StreamFn
  private readonly skills: RuntimeSkills
  private readonly sessionProvider: OwnerMemorySessionProvider

  constructor(options: PiRuntimeOptions) {
    this.config = options.config
    this.gateway = options.gateway
    this.models = options.models
    this.model = options.model
    this.streamFn = options.streamFn
    this.skills = options.skills
    this.memory = options.memory
    this.semantic = options.semantic
    const defaultSession: OwnerMemorySession = {
      ownerOpenId: "runtime-owner",
      ownerName: null,
      memory: options.memory,
      semantic: options.semantic,
    }
    this.sessionProvider = options.sessionProvider ?? { sessionFor: () => defaultSession }
  }

  private resolveSession(ownerOpenId: string | null): OwnerMemorySession {
    return this.sessionProvider.sessionFor(ownerOpenId)
  }

  async check(): Promise<{ provider: string; model: string; auth: string | null }> {
    const auth = await this.models.checkAuth(this.model.provider)
    return {
      provider: this.model.provider,
      model: this.model.id,
      auth: auth?.type ?? null,
    }
  }

  async run(request: RuntimeRequest): Promise<RuntimeResult> {
    const startedAt = Date.now()
    const session = this.resolveSession(request.ownerOpenId ?? null)
    session.memory.markAssistantControlConversation(request.assistantControlChatId)
    const systemPrompt = await buildSystemPrompt(this.config, this.skills, request)
    const auxiliaryUsage = emptyRuntimeUsage()
    const tools = createRuntimeTools(
      this.config,
      this.gateway,
      this.skills,
      session.memory,
      session.semantic,
      (usage) => addRuntimeUsage(auxiliaryUsage, usage),
      request.ownerOpenId ?? null,
    )
    const allowedTools = new Set(tools.map((tool) => tool.name))
    let turns = 0
    const invokedTools: string[] = []
    let timedOut = false
    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: this.model,
        thinkingLevel: this.config.thinkingLevel,
        tools,
        messages: [],
      },
      streamFn: this.streamFn,
      sessionId: request.sessionId,
      toolExecution: "parallel",
      maxRetryDelayMs: 30_000,
      beforeToolCall: async ({ toolCall }) => {
        if (!allowedTools.has(toolCall.name)) {
          return { block: true, reason: "Tool is not part of the dedicated read-only runtime", terminate: true }
        }
        return undefined
      },
      shouldStopAfterTurn: async () => turns >= this.config.maxTurns,
    })
    agent.subscribe((event: AgentEvent) => {
      if (event.type === "turn_end") turns += 1
      if (event.type === "tool_execution_start") {
        invokedTools.push(event.toolName)
        logger.info("agent_tool_started", { tool: event.toolName })
      }
    })

    const telemetry = (): RuntimeTelemetry => ({
      usage: aggregateUsage(agent.state.messages, auxiliaryUsage),
      durationMs: Date.now() - startedAt,
      turns,
      tools: [...invokedTools],
      provider: this.model.provider,
      model: this.model.id,
    })

    const executeAgent = async (): Promise<RuntimeResult> => {
      const timer = setTimeout(() => {
        timedOut = true
        agent.abort()
      }, this.config.runtimeTimeoutMs)
      timer.unref()
      try {
        await agent.prompt(`USER_MESSAGE_JSON:\n${JSON.stringify({ text: request.text })}`)
        await agent.waitForIdle()
        if (timedOut) throw new Error(`Pi runtime exceeded ${this.config.runtimeTimeoutMs} ms`)
        if (turns >= this.config.maxTurns) {
          const last = [...agent.state.messages].reverse().find((message) => message.role === "assistant")
          if (last?.role === "assistant" && last.stopReason === "toolUse") {
            throw new Error(`Pi runtime exceeded ${this.config.maxTurns} turns without a final answer`)
          }
        }
        return {
          ...telemetry(),
          reply: truncateText(redactInternalIdentifiers(finalReply(agent.state.messages)), this.config.maxReplyChars),
        }
      } finally {
        clearTimeout(timer)
      }
    }

    try {
      let streamAttempts = 0
      let upstreamAttempts = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          return await executeAgent()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const isUpstream =
            error instanceof Error &&
            (upstreamHttpStatusOf(message) !== null || isTransientOverloadMessage(message))
          if (isUpstream) {
            upstreamAttempts += 1
            if (upstreamAttempts > this.config.runtimeUpstreamRetries) throw error
          } else {
            streamAttempts += 1
            if (!this.isRetryableStreamError(error) || streamAttempts > this.config.runtimeStreamRetries) {
              throw error
            }
          }
          const attempt = isUpstream ? upstreamAttempts : streamAttempts
          const retries = isUpstream ? this.config.runtimeUpstreamRetries : this.config.runtimeStreamRetries
          logger.warn(isUpstream ? "runtime_upstream_retry_scheduled" : "runtime_stream_retry_scheduled", {
            attempt,
            retries,
            delayMs: this.config.runtimeStreamRetryDelayMs,
            error: message,
          })
          await new Promise((resolve) => setTimeout(resolve, this.config.runtimeStreamRetryDelayMs * attempt))
        }
      }
    } catch (error) {
      const message = timedOut
        ? `Pi runtime exceeded ${this.config.runtimeTimeoutMs} ms`
        : error instanceof Error
          ? error.message
          : String(error)
      throw new PiRuntimeExecutionError(message, telemetry(), {
        cause: error,
      })
    }
  }

  /**
   * Transient upstream stream failures worth a full retry: the provider cut
   * the stream before a terminal event, the connection dropped mid-turn, or
   * the upstream model service returned a retryable HTTP status (5xx/408/429).
   * Prompt-cache reuse keeps the retry cost close to the failed attempt.
   */
  private isRetryableStreamError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    const message = error.message
    if (
      message.includes("stream ended before a terminal response event") ||
      message.includes("connection closed before response") ||
      message.includes("aborted by peer") ||
      message.includes("ECONNRESET") ||
      message.includes("socket hang up")
    ) {
      return true
    }
    return upstreamHttpStatusOf(message) !== null
  }
}

export async function createLivePiRuntime(config: RuntimeConfig, gateway: LarkGateway): Promise<PiAgentRuntime> {
  const owner = await gateway.ensureUserIdentity(config.allowedUserOpenId)
  const memory = new OfficeMemory({
    path: config.memoryFile,
    ownerExternalId: owner.ownerOpenId,
    assistantBotExternalId: owner.botAppId,
    assistantBotName: owner.botName,
  })
  const skills = await loadRuntimeSkills(config.projectRoot, config.skillsDir)
  if (skills.skills.length === 0) throw new Error("no dedicated runtime skills were loaded")
  const modelRuntime = createModelRuntime(config)
  const semantic = new SemanticMemory({
    memory,
    extractor: new PiFactExtractor({
      models: modelRuntime.models,
      model: modelRuntime.model,
      ownerName: owner.ownerName,
      thinkingLevel: config.memoryExtractionThinking,
      timeoutMs: config.memoryExtractionTimeoutMs,
      maxOutputTokens: config.memoryExtractionMaxOutputTokens,
    }),
    ownerName: owner.ownerName,
    sessionizer: {
      idleGapMs: config.memoryChunkIdleGapMs,
      maxChunkTokens: config.memoryChunkMaxTokens,
      maxPrimaryMessages: config.memoryChunkMaxMessages,
      contextMessages: config.memoryContextMessages,
    },
    maxAttempts: config.memoryExtractionMaxAttempts,
  })
  return new PiAgentRuntime({
    config,
    gateway,
    models: modelRuntime.models,
    model: modelRuntime.model,
    streamFn: modelRuntime.models.streamSimple.bind(modelRuntime.models),
    skills,
    memory,
    semantic,
  })
}

export async function createDemoPiRuntime(
  config: RuntimeConfig,
  gateway: LarkGateway,
  now: Date,
): Promise<PiAgentRuntime> {
  const owner = await gateway.ensureUserIdentity(config.allowedUserOpenId)
  const memory = new OfficeMemory({
    path: ":memory:",
    ownerExternalId: owner.ownerOpenId,
    assistantBotExternalId: owner.botAppId,
    assistantBotName: owner.botName,
  })
  const skills = await loadRuntimeSkills(config.projectRoot, config.skillsDir)
  const faux = fauxProvider({ provider: "faux-feishu-demo" })
  const models = createModels()
  models.setProvider(faux.provider)
  const model = faux.getModel()
  if (!model) throw new Error("faux model is unavailable")
  const semantic = new SemanticMemory({
    memory,
    extractor: new PiFactExtractor({
      models,
      model,
      ownerName: owner.ownerName,
      thinkingLevel: config.memoryExtractionThinking,
      timeoutMs: config.memoryExtractionTimeoutMs,
      maxOutputTokens: config.memoryExtractionMaxOutputTokens,
    }),
    ownerName: owner.ownerName,
    sessionizer: {
      idleGapMs: config.memoryChunkIdleGapMs,
      maxChunkTokens: config.memoryChunkMaxTokens,
      maxPrimaryMessages: config.memoryChunkMaxMessages,
      contextMessages: config.memoryContextMessages,
    },
    maxAttempts: config.memoryExtractionMaxAttempts,
  })
  const time = shanghaiTimeContext(now)
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("load_skill", { name: "lark-im" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      [
        fauxToolCall("load_skill", { name: "lark-shared" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        fauxToolCall("run_lark_cli", {
          args: [
            "im",
            "+messages-search",
            "--query",
            "",
            "--start",
            time.todayStart,
            "--end",
            time.now,
            "--page-limit",
            "2",
            "--no-reactions",
            "--format",
            "json",
            "--as",
            "user",
          ],
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([
      fauxText(
        "### 需要你处理\n\n1. **确认飞书消息检索接口方案**：项目群中，林同事 09:15 请你今天确认分页与去重方案。\n\n### 可能需要跟进\n\n- 产品讨论群中，周同事 10:05 询问 Demo 演示时间，目前没有看到你的明确回复。",
      ),
    ]),
  ])
  return new PiAgentRuntime({
    config,
    gateway,
    models,
    model,
    streamFn: models.streamSimple.bind(models),
    skills,
    memory,
    semantic,
  })
}

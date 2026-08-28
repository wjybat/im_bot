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
import { OfficeMemory } from "../memory/index.js"
import type {
  AgentRuntime,
  LarkGateway,
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
}

function emptyUsage(): RuntimeUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    inputCostUsd: 0,
    outputCostUsd: 0,
    cacheReadCostUsd: 0,
    cacheWriteCostUsd: 0,
    estimatedCostUsd: 0,
  }
}

function aggregateUsage(messages: readonly AgentMessage[]): RuntimeUsage {
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
  return result
}

export class PiRuntimeExecutionError extends Error {
  constructor(message: string, readonly telemetry: RuntimeTelemetry, options?: ErrorOptions) {
    super(message, options)
    this.name = "PiRuntimeExecutionError"
  }
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

export class PiAgentRuntime implements AgentRuntime {
  private readonly config: RuntimeConfig
  private readonly gateway: LarkGateway
  private readonly models: Models
  private readonly model: Model<Api>
  private readonly streamFn: StreamFn
  private readonly skills: RuntimeSkills
  private readonly memory: OfficeMemory

  constructor(options: PiRuntimeOptions) {
    this.config = options.config
    this.gateway = options.gateway
    this.models = options.models
    this.model = options.model
    this.streamFn = options.streamFn
    this.skills = options.skills
    this.memory = options.memory
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
    this.memory.markAssistantControlConversation(request.assistantControlChatId)
    const systemPrompt = await buildSystemPrompt(this.config, this.skills, request)
    const tools = createRuntimeTools(this.config, this.gateway, this.skills, this.memory)
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
      if (event.type === "tool_execution_start") invokedTools.push(event.toolName)
    })

    const timer = setTimeout(() => {
      timedOut = true
      agent.abort()
    }, this.config.runtimeTimeoutMs)
    timer.unref()
    const telemetry = (): RuntimeTelemetry => ({
      usage: aggregateUsage(agent.state.messages),
      durationMs: Date.now() - startedAt,
      turns,
      tools: [...invokedTools],
      provider: this.model.provider,
      model: this.model.id,
    })
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
    } catch (error) {
      const message = timedOut
        ? `Pi runtime exceeded ${this.config.runtimeTimeoutMs} ms`
        : error instanceof Error
          ? error.message
          : String(error)
      throw new PiRuntimeExecutionError(message, telemetry(), {
        cause: error,
      })
    } finally {
      clearTimeout(timer)
    }
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
  return new PiAgentRuntime({
    config,
    gateway,
    models: modelRuntime.models,
    model: modelRuntime.model,
    streamFn: modelRuntime.models.streamSimple.bind(modelRuntime.models),
    skills,
    memory,
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
  })
}

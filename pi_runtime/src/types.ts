import type { ThinkingLevel } from "@earendil-works/pi-agent-core"
import type { OfficeMemory, SemanticMemory } from "./memory/index.js"

export interface RuntimeConfig {
  projectRoot: string
  skillsDir: string
  systemPromptFile: string
  stateFile: string
  usageLedgerFile: string
  memoryFile: string
  memoryExtractionThinking: ThinkingLevel
  memoryExtractionTimeoutMs: number
  memoryExtractionMaxOutputTokens: number
  memoryChunkIdleGapMs: number
  memoryChunkMaxTokens: number
  memoryChunkMaxMessages: number
  memoryContextMessages: number
  memoryExtractionMaxChunks: number
  memoryExtractionMaxAttempts: number
  memoryHybridTokenBudget: number
  memorySearchCallsPerRun: number
  memoryPrepareMaxWindows: number
  memoryPrepareMinWindowMs: number
  memoryWarmSchedule: string
  memoryWarmInitialDelayMs: number
  memoryWarmLookbackDays: number
  /** Fresh-start initial warm-up lookback (days); regular warm-ups roll forward from the last synced position. */
  memoryWarmInitialLookbackDays: number
  memoryWarmMaxChunks: number
  welcomeCardThrottleMs: number
  welcomeCardStateFile: string
  historyTurns: number
  historyTurnMaxChars: number
  conversationIdleResetMs: number
  authFile: string
  larkCli: string
  provider: "dmall-ai" | "openai" | "anthropic" | "openai-codex"
  baseUrl: string
  model: string | null
  thinkingLevel: ThinkingLevel
  runtimeTimeoutMs: number
  runtimeStreamRetries: number
  runtimeStreamRetryDelayMs: number
  toolTimeoutMs: number
  authVerifyIntervalMs: number
  authVerifyMessageAttempts: number
  authVerifyMessageRetryDelayMs: number
  /** Multi-user mode: comma-separated open_ids allowed to use the bot. Empty = single-owner mode. */
  allowedUserOpenIds: string[]
  /** Multi-user mode: OAuth callback HTTP port; 0 disables the OAuth endpoint. */
  oauthCallbackPort: number
  /** Multi-user mode: public base URL for OAuth redirects. */
  oauthPublicBaseUrl: string
  allowedUserOpenId: string | null
  maxQueue: number
  maxInputChars: number
  maxReplyChars: number
  maxToolOutputChars: number
  maxMessagePages: number
  maxTurns: number
  replyOnError: boolean
  processingReply: string
  pricing: PricingConfig
  allowUserWrites: false
}

export interface PriceRates {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export interface PricingConfig {
  currency: "USD"
  source: string
  asOf: string
  longContextThreshold: number
  standard: PriceRates
  longContext: PriceRates
}

export interface RuntimeRequest {
  text: string
  requestId: string
  sessionId: string
  now?: Date
  assistantControlChatId?: string | null
  recentConversation?: readonly ConversationTurn[]
  /** Per-request owner scope for multi-user deployments; defaults to the runtime owner. */
  ownerOpenId?: string | null
}

export interface OwnerMemorySession {
  ownerOpenId: string
  ownerName: string | null
  memory: OfficeMemory
  semantic: SemanticMemory
}

/** Resolves the owner-scoped memory pair for a request. Single-owner runtimes return one shared pair. */
export interface OwnerMemorySessionProvider {
  sessionFor(ownerOpenId: string | null): OwnerMemorySession
}

export interface ConversationTurn {
  role: "user" | "assistant"
  text: string
  at: string
}

export interface RuntimeUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  inputCostUsd: number
  outputCostUsd: number
  cacheReadCostUsd: number
  cacheWriteCostUsd: number
  estimatedCostUsd: number
}

export interface RuntimeTelemetry {
  usage: RuntimeUsage
  durationMs: number
  turns: number
  tools: string[]
  provider: string
  model: string
}

export interface RuntimeResult extends RuntimeTelemetry {
  reply: string
}

export interface OwnerIdentity {
  ownerOpenId: string
  ownerName: string | null
  botName: string | null
  botAppId: string | null
  tokenStatus: string | null
}

export interface IncomingMessageEvent {
  chat_type?: unknown
  sender_type?: unknown
  sender_id?: unknown
  message_id?: unknown
  message_type?: unknown
  content?: unknown
  create_time?: unknown
  chat_id?: unknown
}

export interface AcceptedMessage {
  messageId: string
  content: string
  messageType: "text" | "post"
  createTime: string | null
  chatId: string
  receivedAt: string
  /** When set, final replies go to this card message instead of the synthetic trigger. */
  replyToMessageId?: string
  /** Per-message owner (multi-tenant); falls back to the service owner. */
  senderOpenId?: string
}

export interface MessageConsumer {
  ready: Promise<void>
  stop(): void
}

export interface MessageConsumerCallbacks {
  onEvent(event: IncomingMessageEvent): void
  onMalformedEvent?(error: unknown): void
  onDiagnostic?(state: "ready" | "connected" | "exited"): void
  onExit?(result: { code: number | null; signal: NodeJS.Signals | null }): void
}

export interface LarkGateway {
  check(expectedOwnerOpenId?: string | null): Promise<OwnerIdentity & { version: string }>
  ensureUserIdentity(expectedOwnerOpenId?: string | null): Promise<OwnerIdentity>
  searchMessages(input: {
    query: string
    start: string
    end: string
    chatType?: "p2p" | "group"
    pageLimit: number
  }, signal?: AbortSignal): Promise<unknown>
  getMessagesByIds(messageIds: string[], signal?: AbortSignal): Promise<unknown>
  listChatMessages(input: {
    chatId: string
    start?: string
    end?: string
    order: "asc" | "desc"
    pageSize: number
  }, signal?: AbortSignal): Promise<unknown>
  listThreadMessages(input: {
    threadId: string
    order: "asc" | "desc"
    pageSize: number
  }, signal?: AbortSignal): Promise<unknown>
  getAgenda(input: { start: string; end: string }, signal?: AbortSignal): Promise<unknown>
  getIncompleteTasks(input: { pageLimit: number }, signal?: AbortSignal): Promise<unknown>
  runReadOnlyCli(args: string[], signal?: AbortSignal): Promise<{ stdout: string }>
  replyToMessage(messageId: string, markdown: string, stage?: "processing" | "final" | "error" | "overloaded"): Promise<void>
  sendCardMessage(input: { userOpenId: string; card: unknown }): Promise<{ messageId: string }>
  startMessageConsumer(callbacks: MessageConsumerCallbacks): MessageConsumer
  startCardActionConsumer(callbacks: CardActionConsumerCallbacks): MessageConsumer
}

export interface CardActionEvent {
  event_id?: unknown
  operator_id?: unknown
  message_id?: unknown
  chat_id?: unknown
  action_tag?: unknown
  action_value?: unknown
}

export interface CardActionConsumerCallbacks {
  onEvent(event: CardActionEvent): void
  onMalformedEvent?(error: unknown): void
  onDiagnostic?(state: "ready" | "connected" | "exited"): void
  onExit?(result: { code: number | null; signal: NodeJS.Signals | null }): void
}

export interface AgentRuntime {
  check(): Promise<{ provider: string; model: string; auth: string | null }>
  run(request: RuntimeRequest): Promise<RuntimeResult>
}

/** Thrown by gateways that cannot back the run_lark_cli tool (e.g. OpenApiGateway). */
export class RunLarkCliUnsupportedError extends Error {
  constructor(message = "run_lark_cli is not available in this deployment") {
    super(message)
    this.name = "RunLarkCliUnsupportedError"
  }
}

export interface MemoryBackedRuntime extends AgentRuntime {
  memory: OfficeMemory
  semantic: SemanticMemory
}

import type { ThinkingLevel } from "@earendil-works/pi-agent-core"

export interface RuntimeConfig {
  projectRoot: string
  skillsDir: string
  systemPromptFile: string
  stateFile: string
  authFile: string
  larkCli: string
  provider: "dmall-ai" | "openai" | "anthropic" | "openai-codex"
  baseUrl: string
  model: string | null
  thinkingLevel: ThinkingLevel
  runtimeTimeoutMs: number
  toolTimeoutMs: number
  authVerifyIntervalMs: number
  allowedUserOpenId: string | null
  maxQueue: number
  maxInputChars: number
  maxReplyChars: number
  maxToolOutputChars: number
  maxMessagePages: number
  maxTurns: number
  replyOnError: boolean
  processingReply: string
  allowUserWrites: false
}

export interface RuntimeRequest {
  text: string
  requestId: string
  sessionId: string
  now?: Date
}

export interface RuntimeUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  estimatedCostUsd: number
}

export interface RuntimeResult {
  reply: string
  usage: RuntimeUsage
  durationMs: number
  turns: number
  tools: string[]
}

export interface OwnerIdentity {
  ownerOpenId: string
  ownerName: string | null
  botName: string | null
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
  startMessageConsumer(callbacks: MessageConsumerCallbacks): MessageConsumer
}

export interface AgentRuntime {
  check(): Promise<{ provider: string; model: string; auth: string | null }>
  run(request: RuntimeRequest): Promise<RuntimeResult>
}

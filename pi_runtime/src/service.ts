import { logger } from "./infra/logger.js"
import { ProcessedMessageStore } from "./infra/state.js"
import { hashIdentifier, sleep, truncateText } from "./infra/safety.js"
import { UsageLedger, type UsageLedgerStatus } from "./infra/usage-ledger.js"
import { PiRuntimeExecutionError } from "./agent/pi-runtime.js"
import type {
  AcceptedMessage,
  AgentRuntime,
  IncomingMessageEvent,
  LarkGateway,
  MessageConsumer,
  OwnerIdentity,
  RuntimeConfig,
  RuntimeTelemetry,
  RuntimeUsage,
} from "./types.js"

const genericErrorReply = "处理这条请求时遇到错误，请稍后再试。"
const overloadedReply = "当前正在处理的请求较多，请稍后再发一次。"

export function validateIncomingEvent(
  event: IncomingMessageEvent,
  ownerOpenId: string,
  maxInputChars: number,
): AcceptedMessage | null {
  if (event.chat_type !== "p2p" || event.sender_type !== "user") return null
  if (event.sender_id !== ownerOpenId) return null
  if (typeof event.message_id !== "string" || !event.message_id.startsWith("om_")) return null
  if (typeof event.content !== "string") return null
  if (event.message_type !== "text" && event.message_type !== "post") return null
  const content = truncateText(event.content, maxInputChars)
  if (content === "") return null
  return {
    messageId: event.message_id,
    content,
    messageType: event.message_type,
    createTime: typeof event.create_time === "string" ? event.create_time : null,
    receivedAt: new Date().toISOString(),
  }
}

function zeroUsage(): RuntimeUsage {
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

export class PiBotService {
  private readonly store: ProcessedMessageStore
  private readonly usageLedger: UsageLedger
  private owner: OwnerIdentity | null = null
  private readonly pending: AcceptedMessage[] = []
  private readonly inFlight = new Set<string>()
  private draining = false
  private stopping = false
  private consumer: MessageConsumer | null = null
  private restartAttempt = 0
  private authTimer: NodeJS.Timeout | null = null
  private authVerification: Promise<OwnerIdentity> | null = null

  constructor(
    private readonly config: RuntimeConfig,
    private readonly gateway: LarkGateway,
    private readonly runtime: AgentRuntime,
  ) {
    this.store = new ProcessedMessageStore(config.stateFile)
    this.usageLedger = new UsageLedger(config.usageLedgerFile)
  }

  async check(): Promise<Record<string, unknown>> {
    const [lark, runtime] = await Promise.all([
      this.gateway.check(this.config.allowedUserOpenId),
      this.runtime.check(),
    ])
    return {
      larkVersion: lark.version,
      ownerConfigured: true,
      botReady: true,
      userReady: true,
      runtime: "pi-agent-core",
      provider: runtime.provider,
      model: runtime.model,
      modelAuth: runtime.auth,
    }
  }

  async start(): Promise<void> {
    await this.store.load()
    const lark = await this.gateway.check(this.config.allowedUserOpenId)
    await this.runtime.check()
    this.owner = lark
    this.scheduleAuthVerification()
    logger.info("pi_service_starting", {
      owner: hashIdentifier(lark.ownerOpenId),
      botNameConfigured: lark.botName !== null,
    })
    await this.startConsumer()
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    if (this.authTimer) clearInterval(this.authTimer)
    logger.info("pi_service_stopping", { queued: this.pending.length, inFlight: this.inFlight.size })
    this.consumer?.stop()
  }

  private async startConsumer(): Promise<void> {
    if (this.stopping || !this.owner) return
    const consumer = this.gateway.startMessageConsumer({
      onEvent: (event) => this.acceptEvent(event),
      onMalformedEvent: (error) => logger.error("malformed_event", error),
      onDiagnostic: (state) => logger.info("event_consumer_state", { state }),
      onExit: ({ code, signal }) => void this.onConsumerExit(code, signal),
    })
    this.consumer = consumer
    await consumer.ready
    this.restartAttempt = 0
    logger.info("pi_service_ready", { owner: hashIdentifier(this.owner.ownerOpenId) })
  }

  private acceptEvent(event: IncomingMessageEvent): void {
    if (!this.owner) return
    const accepted = validateIncomingEvent(event, this.owner.ownerOpenId, this.config.maxInputChars)
    if (!accepted) return
    const hash = hashIdentifier(accepted.messageId)
    if (this.store.has(accepted.messageId) || this.inFlight.has(accepted.messageId)) {
      logger.info("message_duplicate_ignored", { message: hash })
      return
    }
    if (this.pending.length >= this.config.maxQueue) {
      logger.warn("message_queue_full", { message: hash, queued: this.pending.length })
      void this.replyAndMark(accepted.messageId, overloadedReply, "overloaded")
      return
    }
    this.inFlight.add(accepted.messageId)
    this.pending.push(accepted)
    logger.info("message_queued", {
      message: hash,
      queued: this.pending.length,
      sourceCreateTimePresent: accepted.createTime !== null,
    })
    void this.gateway
      .replyToMessage(accepted.messageId, this.config.processingReply, "processing")
      .then(() => logger.info("processing_reply_sent", { message: hash }))
      .catch((error) => logger.error("processing_reply_failed", error, { message: hash }))
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.pending.length > 0 && !this.stopping) {
        const message = this.pending.shift()
        if (message) await this.processMessage(message)
      }
    } finally {
      this.draining = false
    }
  }

  private async processMessage(message: AcceptedMessage): Promise<void> {
    const hash = hashIdentifier(message.messageId)
    const startedAt = Date.now()
    let runtimeCompleted = false
    let finalReplyDelivered = false
    let status: UsageLedgerStatus = "host_failed"
    let errorType: string | undefined
    let telemetry: RuntimeTelemetry = {
      usage: zeroUsage(),
      durationMs: 0,
      turns: 0,
      tools: [],
      provider: this.config.provider,
      model: this.config.model ?? "unknown",
    }
    try {
      await this.verifyUserAuth()
      const result = await this.runtime.run({
        text: message.content,
        requestId: hash,
        sessionId: `feishu-owner-${hashIdentifier(this.owner?.ownerOpenId ?? "owner")}`,
      })
      telemetry = result
      runtimeCompleted = true
      await this.gateway.replyToMessage(message.messageId, result.reply, "final")
      finalReplyDelivered = true
      await this.store.mark(message.messageId)
      status = "success"
      logger.info("message_processed", {
        message: hash,
        durationMs: Date.now() - startedAt,
        runtimeDurationMs: result.durationMs,
        turns: result.turns,
        tools: result.tools,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
        reasoningTokens: result.usage.reasoningTokens,
        estimatedCostUsd: result.usage.estimatedCostUsd,
      })
    } catch (error) {
      errorType = error instanceof Error ? error.name : "unknown"
      if (error instanceof PiRuntimeExecutionError) {
        telemetry = error.telemetry
        status = "runtime_failed"
      } else if (runtimeCompleted) {
        status = "delivery_failed"
      }
      logger.error("message_processing_failed", error, { message: hash, durationMs: Date.now() - startedAt })
      if (this.config.replyOnError) {
        try {
          await this.replyAndMark(message.messageId, genericErrorReply, "error")
        } catch (replyError) {
          logger.error("error_reply_failed", replyError, { message: hash })
        }
      }
    } finally {
      try {
        await this.usageLedger.append({
          message: hash,
          status,
          receivedAt: message.receivedAt,
          completedAt: new Date().toISOString(),
          totalDurationMs: Date.now() - startedAt,
          telemetry,
          pricing: this.config.pricing,
          finalReplyDelivered,
          ...(errorType ? { errorType } : {}),
        })
        logger.info("usage_ledger_recorded", {
          message: hash,
          status,
          totalTokens: telemetry.usage.totalTokens,
          estimatedCostUsd: telemetry.usage.estimatedCostUsd,
        })
      } catch (ledgerError) {
        logger.error("usage_ledger_write_failed", ledgerError, { message: hash })
      }
      this.inFlight.delete(message.messageId)
    }
  }

  private scheduleAuthVerification(): void {
    this.authTimer = setInterval(() => {
      void this.verifyUserAuth().catch((error) => logger.error("user_auth_refresh_failed", error))
    }, this.config.authVerifyIntervalMs)
    this.authTimer.unref()
  }

  private async verifyUserAuth(): Promise<OwnerIdentity> {
    if (this.authVerification) return this.authVerification
    this.authVerification = this.gateway
      .ensureUserIdentity(this.owner?.ownerOpenId ?? this.config.allowedUserOpenId)
      .then((identity) => {
        logger.info("user_auth_verified", { tokenStatus: identity.tokenStatus })
        return identity
      })
      .finally(() => {
        this.authVerification = null
      })
    return this.authVerification
  }

  private async replyAndMark(
    messageId: string,
    reply: string,
    stage: "error" | "overloaded",
  ): Promise<void> {
    await this.gateway.replyToMessage(messageId, reply, stage)
    await this.store.mark(messageId)
  }

  private async onConsumerExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    logger.warn("event_consumer_exited", { code, signal, stopping: this.stopping })
    if (this.stopping) return
    this.restartAttempt += 1
    const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(this.restartAttempt - 1, 5))
    logger.warn("event_consumer_restart_scheduled", { attempt: this.restartAttempt, delayMs })
    await sleep(delayMs)
    try {
      await this.startConsumer()
    } catch (error) {
      logger.error("event_consumer_restart_failed", error, { attempt: this.restartAttempt })
      await this.onConsumerExit(null, null)
    }
  }
}

import { logger } from "./infra/logger.js"
import { ProcessedMessageStore } from "./infra/state.js"
import { hashIdentifier, sleep, truncateText } from "./infra/safety.js"
import { UsageLedger, type UsageLedgerStatus } from "./infra/usage-ledger.js"
import { PiRuntimeExecutionError } from "./agent/pi-runtime.js"
import {
  buildWelcomeCard,
  quickTaskPromptFromCardAction,
  quickTasksFromConfig,
} from "./agent/welcome-card.js"
import { readFile, writeFile, rename, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type {
  AcceptedMessage,
  AgentRuntime,
  CardActionEvent,
  ConversationTurn,
  IncomingMessageEvent,
  LarkGateway,
  MessageConsumer,
  MessageConsumerCallbacks,
  OwnerIdentity,
  RuntimeConfig,
  RuntimeTelemetry,
  RuntimeUsage,
} from "./types.js"

const genericErrorReply = "处理这条请求时遇到错误，请稍后再试。"
const overloadedReply = "当前正在处理的请求较多，请稍后再发一次。"

export function validateIncomingEvent(
  event: IncomingMessageEvent,
  ownerCheck: string | ((openId: unknown) => boolean),
  maxInputChars: number,
): AcceptedMessage | null {
  if (event.chat_type !== "p2p" || event.sender_type !== "user") return null
  const allowed =
    typeof ownerCheck === "string" ? event.sender_id === ownerCheck : ownerCheck(event.sender_id)
  if (!allowed) return null
  if (typeof event.message_id !== "string" || !event.message_id.startsWith("om_")) return null
  if (typeof event.chat_id !== "string" || event.chat_id.trim() === "") return null
  if (typeof event.content !== "string") return null
  if (event.message_type !== "text" && event.message_type !== "post") return null
  const content = truncateText(event.content, maxInputChars)
  if (content === "") return null
  return {
    messageId: event.message_id,
    content,
    messageType: event.message_type,
    createTime: typeof event.create_time === "string" ? event.create_time : null,
    chatId: event.chat_id,
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
  protected readonly store: ProcessedMessageStore
  protected readonly usageLedger: UsageLedger
  protected readonly config: RuntimeConfig
  protected readonly gateway: LarkGateway
  protected readonly runtime: AgentRuntime
  private readonly pending: AcceptedMessage[] = []
  private readonly inFlight = new Set<string>()
  private draining = false
  private stopping = false
  private consumer: MessageConsumer | null = null
  private cardConsumer: MessageConsumer | null = null
  private cardConsumerRestartAttempt = 0
  protected cardConsumerDisabled = false
  private welcomeCardSendInFlight: Promise<void> | null = null
  private restartAttempt = 0
  private authTimer: NodeJS.Timeout | null = null
  private authVerification: Promise<OwnerIdentity> | null = null
  private readonly conversationHistories = new Map<string, ConversationTurn[]>()
  /** Single-owner mode retains this field; multi-tenant subclasses override resolveOwner. */
  private owner: OwnerIdentity | null = null

  constructor(
    config: RuntimeConfig,
    gateway: LarkGateway,
    runtime: AgentRuntime,
  ) {
    this.config = config
    this.gateway = gateway
    this.runtime = runtime
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
    try {
      await this.startCardActionConsumer()
    } catch (error) {
      // The card callback event must be subscribed in the Feishu developer
      // console first. A missing subscription must not take down messaging.
      this.cardConsumerDisabled = true
      logger.error("card_action_consumer_unavailable", error, {
        hint: "subscribe card.action.trigger in the developer console and restart",
      })
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    if (this.authTimer) clearInterval(this.authTimer)
    logger.info("pi_service_stopping", { queued: this.pending.length, inFlight: this.inFlight.size })
    this.consumer?.stop()
    this.cardConsumer?.stop()
  }

  /**
   * Decides whether a user may talk to this bot. Single-owner deployments
   * compare against the configured owner; multi-user deployments override
   * this with their own allowlist and authorization state.
   */
  protected isAllowedUser(senderOpenId: string | null): boolean {
    if (senderOpenId === null || this.owner === null) return false
    return senderOpenId === this.owner.ownerOpenId
  }

  /**
   * Resolves the owner identity that a message belongs to. Single-owner
   * deployments return the startup identity; multi-user deployments resolve
   * per sender. Returning null rejects the message.
   */
  protected resolveOwner(senderOpenId: string | null): OwnerIdentity | null {
    if (!this.owner) return null
    if (senderOpenId !== null && senderOpenId !== this.owner.ownerOpenId) return null
    return this.owner
  }

  protected async startConsumer(): Promise<void> {
    if (this.stopping) return
    const consumer = this.gateway.startMessageConsumer({
      onEvent: (event) => this.acceptEvent(event),
      onMalformedEvent: (error) => logger.error("malformed_event", error),
      onDiagnostic: (state) => logger.info("event_consumer_state", { state }),
      onExit: ({ code, signal }) => void this.onConsumerExit(code, signal),
    })
    this.consumer = consumer
    await consumer.ready
    this.restartAttempt = 0
    logger.info("pi_service_ready", { owner: this.owner ? hashIdentifier(this.owner.ownerOpenId) : "multi" })
  }

  private acceptEvent(event: IncomingMessageEvent): void {
    const senderOpenId = typeof event.sender_id === "string" ? event.sender_id : null
    if (!this.isAllowedUser(senderOpenId)) return
    const accepted = validateIncomingEvent(event, () => true, this.config.maxInputChars)
    if (!accepted) return
    if (senderOpenId !== null) accepted.senderOpenId = senderOpenId
    this.enqueueAccepted(accepted)
  }

  /** Shared queueing path for message events and card actions. */
  protected enqueueAccepted(accepted: AcceptedMessage): void {
    const hash = hashIdentifier(accepted.messageId)
    if (this.store.has(accepted.messageId) || this.inFlight.has(accepted.messageId)) {
      logger.info("message_duplicate_ignored", { message: hash })
      return
    }
    const replyTarget = accepted.replyToMessageId ?? accepted.messageId
    if (this.pending.length >= this.config.maxQueue) {
      logger.warn("message_queue_full", { message: hash, queued: this.pending.length })
      void this.replyAndMark(replyTarget, overloadedReply, "overloaded")
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
      .replyToMessage(replyTarget, this.config.processingReply, "processing")
      .then(() => logger.info("processing_reply_sent", { message: hash }))
      .catch((error) => logger.error("processing_reply_failed", error, { message: hash }))
    void this.drain()
  }

  protected async startCardActionConsumer(): Promise<void> {
    if (this.stopping) return
    const consumer = this.gateway.startCardActionConsumer({
      onEvent: (event) => this.acceptCardAction(event),
      onMalformedEvent: (error) => logger.error("card_action_malformed_event", error),
      onDiagnostic: (state) => logger.info("card_action_consumer_state", { state }),
      onExit: ({ code, signal }) => void this.onCardConsumerExit(code, signal),
    })
    this.cardConsumer = consumer
    await consumer.ready
    this.cardConsumerRestartAttempt = 0
    logger.info("card_action_consumer_ready", {})
  }

  /**
   * Sends the welcome card after the first completed warm-up, throttled by
   * a persisted last-sent timestamp: a restart within the throttle window
   * stays silent, a fresh start delivers a card. The Feishu idempotency key
   * is unique per process start, so the server never swallows a legitimate
   * re-send; crash loops are contained by this local throttle instead.
   */
  async sendWelcomeCardAfterWarmUp(): Promise<void> {
    if (this.welcomeCardSendInFlight !== null) {
      await this.welcomeCardSendInFlight
      return
    }
    const operation = (async () => {
      if (this.stopping || !this.owner) return
      const lastSentAt = await this.readWelcomeCardSentAt()
      if (lastSentAt !== null && Date.now() - lastSentAt < this.config.welcomeCardThrottleMs) {
        logger.info("welcome_card_throttled", {
          lastSentAt: new Date(lastSentAt).toISOString(),
          throttleMs: this.config.welcomeCardThrottleMs,
        })
        return
      }
      const tasks = quickTasksFromConfig(this.config)
      const result = await this.gateway.sendCardMessage({
        userOpenId: this.owner.ownerOpenId,
        card: buildWelcomeCard(tasks),
      })
      await this.writeWelcomeCardSentAt(Date.now())
      logger.info("welcome_card_sent", { message: hashIdentifier(result.messageId) })
    })().catch((error) => {
      logger.error("welcome_card_send_failed", error)
    }).finally(() => {
      this.welcomeCardSendInFlight = null
    })
    this.welcomeCardSendInFlight = operation
    await operation
  }

  private async readWelcomeCardSentAt(): Promise<number | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.config.welcomeCardStateFile, "utf8"))
      if (typeof parsed !== "object" || parsed === null) return null
      const value = (parsed as { lastSentAt?: unknown }).lastSentAt
      return typeof value === "number" && Number.isFinite(value) ? value : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      logger.error("welcome_card_state_read_failed", error)
      return null
    }
  }

  private async writeWelcomeCardSentAt(at: number): Promise<void> {
    const path = this.config.welcomeCardStateFile
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify({ lastSentAt: at }, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      })
      await rename(temp, path)
    } catch (error) {
      logger.error("welcome_card_state_write_failed", error)
    }
  }

  private acceptCardAction(event: CardActionEvent): void {
    const operatorId = typeof event.operator_id === "string" ? event.operator_id : null
    if (!this.isAllowedUser(operatorId)) return
    const eventId = typeof event.event_id === "string" ? event.event_id : null
    if (eventId === null) return
    const dedupKey = `card_${eventId}`
    if (this.store.has(dedupKey) || this.inFlight.has(dedupKey)) {
      logger.info("card_action_duplicate_ignored", { event: hashIdentifier(eventId) })
      return
    }
    const chatId = typeof event.chat_id === "string" ? event.chat_id : ""
    const messageId = typeof event.message_id === "string" ? event.message_id : ""
    if (chatId === "" || !messageId.startsWith("om_")) return
    const prompt = quickTaskPromptFromCardAction(event, quickTasksFromConfig(this.config))
    if (prompt === null) {
      logger.info("card_action_ignored", { event: hashIdentifier(eventId) })
      return
    }
    logger.info("card_action_task_queued", { event: hashIdentifier(eventId), queued: this.pending.length })
    // Route through enqueueAccepted so multi-tenant authorization gates and
    // queue-pressure handling apply to card actions too.
    this.enqueueAccepted({
      messageId: dedupKey,
      content: prompt,
      messageType: "text",
      createTime: null,
      chatId,
      receivedAt: new Date().toISOString(),
      replyToMessageId: messageId,
      ...(operatorId !== null ? { senderOpenId: operatorId } : {}),
    })
  }

  private async onCardConsumerExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    logger.warn("card_action_consumer_exited", { code, signal, stopping: this.stopping })
    if (this.stopping || this.cardConsumerDisabled) return
    this.cardConsumerRestartAttempt += 1
    if (this.cardConsumerRestartAttempt > 5) {
      this.cardConsumerDisabled = true
      logger.error("card_action_consumer_disabled_after_retries", null, {
        attempts: this.cardConsumerRestartAttempt - 1,
      })
      return
    }
    const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(this.cardConsumerRestartAttempt - 1, 5))
    logger.warn("card_action_consumer_restart_scheduled", {
      attempt: this.cardConsumerRestartAttempt,
      delayMs,
    })
    await sleep(delayMs)
    try {
      await this.startCardActionConsumer()
    } catch (error) {
      logger.error("card_action_consumer_restart_failed", error, { attempt: this.cardConsumerRestartAttempt })
      await this.onCardConsumerExit(null, null)
    }
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

  private conversationHistoryFor(userKey: string): ConversationTurn[] {
    let history = this.conversationHistories.get(userKey)
    if (history === undefined) {
      history = []
      this.conversationHistories.set(userKey, history)
    }
    return history
  }

  private recordConversationTurn(userKey: string, turn: ConversationTurn): void {
    const maxTurns = this.config.historyTurns * 2
    if (maxTurns === 0) return
    const history = this.conversationHistoryFor(userKey)
    const previous = history[history.length - 1]
    if (previous !== undefined) {
      const previousAt = Date.parse(previous.at)
      if (Number.isFinite(previousAt) && Date.parse(turn.at) - previousAt > this.config.conversationIdleResetMs) {
        history.length = 0
      }
    }
    history.push(turn)
    while (history.length > maxTurns) history.shift()
  }

  private recentConversationFor(userKey: string): ConversationTurn[] {
    const maxTurns = this.config.historyTurns * 2
    return this.conversationHistoryFor(userKey).slice(-maxTurns)
  }

  /**
   * Serial per-message pipeline: auth (with retry) → agent run → final reply →
   * conversation history → dedup mark → usage ledger. Any failure maps to a
   * ledger status (runtime_failed / delivery_failed / host_failed) and an
   * optional generic error reply.
   */
  private async processMessage(message: AcceptedMessage): Promise<void> {
    const hash = hashIdentifier(message.messageId)
    const owner = this.resolveOwner(message.senderOpenId ?? null)
    if (owner === null) {
      logger.warn("message_owner_unresolved", { message: hash })
      this.inFlight.delete(message.messageId)
      return
    }
    const userKey = owner.ownerOpenId
    await this.beforeProcessMessage(owner, message)
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
      await this.verifyUserAuthWithRetry(
        this.config.authVerifyMessageAttempts,
        this.config.authVerifyMessageRetryDelayMs,
        owner.ownerOpenId,
      )
      const recentConversation = this.recentConversationFor(userKey)
      const result = await this.runtime.run({
        text: message.content,
        requestId: hash,
        sessionId: `feishu-owner-${hashIdentifier(userKey)}`,
        assistantControlChatId: message.chatId,
        ownerOpenId: owner.ownerOpenId,
        ...(recentConversation.length > 0 ? { recentConversation } : {}),
      })
      telemetry = result
      runtimeCompleted = true
      const replyTarget = message.replyToMessageId ?? message.messageId
      await this.gateway.replyToMessage(replyTarget, result.reply, "final")
      finalReplyDelivered = true
      const nowIso = new Date().toISOString()
      this.recordConversationTurn(userKey, { role: "user", text: message.content, at: message.receivedAt })
      this.recordConversationTurn(userKey, { role: "assistant", text: result.reply, at: nowIso })
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
      const handled = await this.onProcessingError(message, error)
      if (handled) {
        await this.store.mark(message.messageId)
      } else if (this.config.replyOnError) {
        try {
          await this.replyAndMark(message.replyToMessageId ?? message.messageId, genericErrorReply, "error")
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

  /**
   * Per-message hook fired before processing. Multi-tenant subclasses use it
   * to bind the active owner on the gateway (owner-scoped reads).
   */
  protected async beforeProcessMessage(owner: OwnerIdentity, message: AcceptedMessage): Promise<void> {
    void owner
    void message
  }

  /**
   * Failure hook: lets subclasses take over a failed message (e.g. replace the
   * generic error reply with a targeted card). Return true when the failure
   * was handled; the generic error reply is then skipped.
   */
  protected async onProcessingError(message: AcceptedMessage, error: unknown): Promise<boolean> {
    void message
    void error
    return false
  }

  protected scheduleAuthVerification(): void {
    this.authTimer = setInterval(() => {
      void this.verifyUserAuth().catch((error) => logger.error("user_auth_refresh_failed", error))
    }, this.config.authVerifyIntervalMs)
    this.authTimer.unref()
  }

  private async verifyUserAuth(ownerOpenId?: string): Promise<OwnerIdentity> {
    if (this.authVerification) return this.authVerification
    this.authVerification = this.gateway
      .ensureUserIdentity(ownerOpenId ?? this.owner?.ownerOpenId ?? this.config.allowedUserOpenId)
      .then((identity) => {
        logger.info("user_auth_verified", { tokenStatus: identity.tokenStatus })
        return identity
      })
      .finally(() => {
        this.authVerification = null
      })
    return this.authVerification
  }

  private async verifyUserAuthWithRetry(attempts: number, delayMs: number, ownerOpenId?: string): Promise<OwnerIdentity> {
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.verifyUserAuth(ownerOpenId)
      } catch (error) {
        lastError = error
        if (attempt === attempts) break
        logger.warn("user_auth_verify_retry_scheduled", {
          attempt,
          attempts,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        })
        await sleep(delayMs * attempt)
      }
    }
    throw lastError
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

import { checkCodexRuntime, runCodex } from "./codex.mjs"
import {
  checkLarkRuntime,
  ensureUserIdentity,
  replyToMessage,
  startMessageConsumer,
} from "./lark.mjs"
import { logger } from "./logger.mjs"
import { ProcessedMessageStore } from "./state.mjs"
import { hashIdentifier, sleep, truncateText } from "./util.mjs"

const GENERIC_ERROR_REPLY = "处理这条请求时遇到错误，请稍后再试。"
const OVERLOADED_REPLY = "当前正在处理的请求较多，请稍后再发一次。"

export function validateIncomingEvent(event, ownerOpenId, maxInputChars) {
  if (event?.chat_type !== "p2p" || event?.sender_type !== "user") return null
  if (event?.sender_id !== ownerOpenId) return null
  if (typeof event?.message_id !== "string" || !event.message_id.startsWith("om_")) return null
  if (typeof event?.content !== "string") return null
  if (!new Set(["text", "post"]).has(event.message_type)) return null
  const content = truncateText(event.content, maxInputChars)
  if (content === "") return null
  return { messageId: event.message_id, content, messageType: event.message_type }
}

export class ImBotService {
  constructor(config) {
    this.config = config
    this.store = new ProcessedMessageStore(config.stateFile, config.stateMaxRecords)
    this.ownerOpenId = null
    this.pending = []
    this.inFlight = new Set()
    this.draining = false
    this.stopping = false
    this.consumer = null
    this.restartAttempt = 0
    this.authTimer = null
    this.authVerification = null
  }

  async check() {
    const [lark, codexVersion] = await Promise.all([
      checkLarkRuntime(this.config),
      checkCodexRuntime(this.config),
    ])
    return {
      larkVersion: lark.version,
      codexVersion,
      ownerConfigured: true,
      botReady: true,
      userReady: true,
      eventScopeCount: lark.eventScope.length,
    }
  }

  async start() {
    await this.store.load()
    const runtime = await checkLarkRuntime(this.config)
    await checkCodexRuntime(this.config)
    this.ownerOpenId = runtime.ownerOpenId
    this.#scheduleAuthVerification()
    logger.info("service_starting", {
      owner: hashIdentifier(this.ownerOpenId),
      botNameConfigured: runtime.botName !== null,
      codexSandbox: this.config.codexSandbox,
    })
    await this.#startConsumer()
  }

  async stop() {
    if (this.stopping) return
    this.stopping = true
    if (this.authTimer !== null) clearInterval(this.authTimer)
    logger.info("service_stopping", { queued: this.pending.length, inFlight: this.inFlight.size })
    this.consumer?.stop()
  }

  async #startConsumer() {
    if (this.stopping) return
    const consumer = startMessageConsumer(this.config, {
      onEvent: (event) => this.#acceptEvent(event),
      onMalformedEvent: (error) => logger.error("malformed_event", error),
      onDiagnostic: (state) => logger.info("event_consumer_state", { state }),
      onExit: ({ code, signal }) => this.#onConsumerExit(code, signal),
    })
    this.consumer = consumer
    await consumer.ready
    this.restartAttempt = 0
    logger.info("service_ready", { owner: hashIdentifier(this.ownerOpenId) })
  }

  #acceptEvent(event) {
    const accepted = validateIncomingEvent(event, this.ownerOpenId, this.config.maxInputChars)
    if (accepted === null) return
    const hash = hashIdentifier(accepted.messageId)
    if (this.store.has(accepted.messageId) || this.inFlight.has(accepted.messageId)) {
      logger.info("message_duplicate_ignored", { message: hash })
      return
    }
    if (this.pending.length >= this.config.maxQueue) {
      logger.warn("message_queue_full", { message: hash, queued: this.pending.length })
      void this.#replyAndMark(accepted.messageId, OVERLOADED_REPLY)
      return
    }
    this.inFlight.add(accepted.messageId)
    this.pending.push(accepted)
    logger.info("message_queued", { message: hash, queued: this.pending.length })
    void this.#drain()
  }

  async #drain() {
    if (this.draining) return
    this.draining = true
    try {
      while (this.pending.length > 0 && !this.stopping) {
        const message = this.pending.shift()
        await this.#processMessage(message)
      }
    } finally {
      this.draining = false
    }
  }

  async #processMessage(message) {
    const hash = hashIdentifier(message.messageId)
    const startedAt = Date.now()
    try {
      await this.#verifyUserAuth()
      const result = await runCodex(this.config, message.content)
      await replyToMessage(this.config, message.messageId, result.reply)
      await this.store.mark(message.messageId)
      logger.info("message_processed", {
        message: hash,
        durationMs: Date.now() - startedAt,
        inputTokens: result.usage?.input_tokens ?? null,
        cachedInputTokens: result.usage?.cached_input_tokens ?? null,
        outputTokens: result.usage?.output_tokens ?? null,
        transientCodexErrors: result.transientErrors,
      })
    } catch (error) {
      logger.error("message_processing_failed", error, {
        message: hash,
        durationMs: Date.now() - startedAt,
      })
      if (this.config.replyOnError) {
        try {
          await this.#replyAndMark(message.messageId, GENERIC_ERROR_REPLY)
        } catch (replyError) {
          logger.error("error_reply_failed", replyError, { message: hash })
        }
      }
    } finally {
      this.inFlight.delete(message.messageId)
    }
  }

  #scheduleAuthVerification() {
    this.authTimer = setInterval(() => {
      void this.#verifyUserAuth().catch((error) => logger.error("user_auth_refresh_failed", error))
    }, this.config.authVerifyIntervalMs)
    this.authTimer.unref()
  }

  async #verifyUserAuth() {
    if (this.authVerification !== null) return this.authVerification
    this.authVerification = ensureUserIdentity(this.config, this.ownerOpenId)
      .then((identity) => {
        logger.info("user_auth_verified", { tokenStatus: identity.tokenStatus })
        return identity
      })
      .finally(() => {
        this.authVerification = null
      })
    return this.authVerification
  }

  async #replyAndMark(messageId, reply) {
    await replyToMessage(this.config, messageId, reply)
    await this.store.mark(messageId)
  }

  async #onConsumerExit(code, signal) {
    logger.warn("event_consumer_exited", { code, signal, stopping: this.stopping })
    if (this.stopping) return
    this.restartAttempt += 1
    const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(this.restartAttempt - 1, 5))
    logger.warn("event_consumer_restart_scheduled", { attempt: this.restartAttempt, delayMs })
    await sleep(delayMs)
    try {
      await this.#startConsumer()
    } catch (error) {
      logger.error("event_consumer_restart_failed", error, { attempt: this.restartAttempt })
      await this.#onConsumerExit(null, "restart_failed")
    }
  }
}

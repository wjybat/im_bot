import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PiBotService } from "../src/service.js"
import type {
  AcceptedMessage,
  AgentRuntime,
  CardActionConsumerCallbacks,
  LarkGateway,
  MessageConsumer,
  MessageConsumerCallbacks,
  OwnerIdentity,
  RuntimeConfig,
} from "../src/types.js"

function acceptedMessage(messageId: string): AcceptedMessage {
  return {
    messageId,
    content: "hello",
    messageType: "text",
    createTime: null,
    chatId: "oc_assistant",
    receivedAt: new Date().toISOString(),
  }
}

function makeConfig(stateDir: string, overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const base = {
    stateFile: join(stateDir, "processed-messages.json"),
    usageLedgerFile: join(stateDir, "usage-ledger.jsonl"),
    welcomeCardStateFile: join(stateDir, "welcome-card.json"),
  }
  const defaults: Record<string, unknown> = {
    replyOnError: false,
    maxQueue: 5,
    authVerifyIntervalMs: 600_000,
    authVerifyMessageAttempts: 3,
    authVerifyMessageRetryDelayMs: 1,
    welcomeCardThrottleMs: 600_000,
    provider: "dmall-ai",
    model: null,
    pricing: {
      currency: "USD",
      source: "test",
      asOf: "2026-09-11",
      longContextThreshold: 272_000,
      standard: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      longContext: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    },
  }
  return { ...defaults, ...base, ...overrides } as unknown as RuntimeConfig
}

class FlakyAuthGateway implements LarkGateway {
  authCalls = 0
  authFailuresRemaining: number
  runtimeRuns = 0
  lastRunText: string | null = null
  replies: Array<{ messageId: string; stage: string }> = []
  consumers: MessageConsumerCallbacks[] = []
  cardConsumers: CardActionConsumerCallbacks[] = []
  cardSends: Array<{ userOpenId: string; card: unknown }> = []

  constructor(failures: number) {
    this.authFailuresRemaining = failures
  }

  async check(): Promise<OwnerIdentity & { version: string }> {
    return { ...this.identity(), version: "test" }
  }

  async ensureUserIdentity(): Promise<OwnerIdentity> {
    this.authCalls += 1
    if (this.authFailuresRemaining > 0) {
      this.authFailuresRemaining -= 1
      throw new Error("Lark bot identity is not ready")
    }
    return this.identity()
  }

  private identity(): OwnerIdentity {
    return {
      ownerOpenId: "owner",
      ownerName: "owner",
      botName: "bot",
      botAppId: "app",
      tokenStatus: "valid",
    }
  }

  startMessageConsumer(callbacks: MessageConsumerCallbacks): MessageConsumer {
    this.consumers.push(callbacks)
    return { ready: Promise.resolve(), stop: () => undefined }
  }

  async sendCardMessage(input: { userOpenId: string; card: unknown }): Promise<{ messageId: string }> {
    this.cardSends.push(input)
    return { messageId: "om_card_test" }
  }

  startCardActionConsumer(callbacks: CardActionConsumerCallbacks): MessageConsumer {
    this.cardConsumers.push(callbacks)
    return { ready: Promise.resolve(), stop: () => undefined }
  }

  async replyToMessage(
    messageId: string,
    _markdown: string,
    stage: "processing" | "final" | "error" | "overloaded" = "final",
  ): Promise<void> {
    this.replies.push({ messageId, stage })
  }

  async runReadOnlyCli(): Promise<{ stdout: string }> {
    return { stdout: "{}" }
  }

  async searchMessages(): Promise<unknown> {
    return {}
  }

  async getMessagesByIds(): Promise<unknown> {
    return {}
  }

  async listChatMessages(): Promise<unknown> {
    return {}
  }

  async listThreadMessages(): Promise<unknown> {
    return {}
  }

  async getAgenda(): Promise<unknown> {
    return {}
  }

  async getIncompleteTasks(): Promise<unknown> {
    return {}
  }
}

function makeRuntime(): AgentRuntime {
  return {
    async check() {
      return { provider: "test", model: "test", auth: null }
    },
    async run(request) {
      return {
        usage: {
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
        },
        durationMs: 1,
        turns: 1,
        tools: [],
        provider: "test",
        model: "test",
        reply: `echo:${request.text}`,
      }
    },
  }
}

test("message processing retries transient auth verification failures and still succeeds", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-service-auth-"))
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })
  const gateway = new FlakyAuthGateway(2)
  const service = new PiBotService(makeConfig(stateDir), gateway, makeRuntime())
  await service.start()
  const processed = new Promise<void>((resolve) => {
    const timer = setInterval(async () => {
      const ledger = await readFile(join(stateDir, "usage-ledger.jsonl"), "utf8").catch(() => "")
      if (ledger.includes('"status":"success"')) {
        clearInterval(timer)
        resolve()
      }
    }, 10)
  })
  gateway.consumers[0]?.onEvent({
    chat_type: "p2p",
    sender_type: "user",
    sender_id: "owner",
    message_id: "om_retry_1",
    message_type: "text",
    content: "hello",
    chat_id: "oc_assistant",
  })
  await processed
  await service.stop()
  assert.equal(gateway.authCalls, 3)
  assert.equal(gateway.replies.some((reply) => reply.stage === "final" && reply.messageId === "om_retry_1"), true)
  assert.equal(gateway.replies.some((reply) => reply.stage === "error"), false)
})

test("message processing fails after exhausting auth retries", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-service-auth-"))
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })
  const gateway = new FlakyAuthGateway(99)
  const config = makeConfig(stateDir)
  const service = new PiBotService(config, gateway, makeRuntime())
  await service.start()
  const failed = new Promise<void>((resolve) => {
    const timer = setInterval(async () => {
      const ledger = await readFile(join(stateDir, "usage-ledger.jsonl"), "utf8").catch(() => "")
      if (ledger.includes('"status":"host_failed"')) {
        clearInterval(timer)
        resolve()
      }
    }, 10)
  })
  gateway.consumers[0]?.onEvent({
    chat_type: "p2p",
    sender_type: "user",
    sender_id: "owner",
    message_id: "om_retry_2",
    message_type: "text",
    content: "hello",
    chat_id: "oc_assistant",
  })
  await failed
  await service.stop()
  assert.equal(gateway.authCalls, 3)
})

test("welcome card respects the persisted throttle window", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-service-card-"))
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })
  const gateway = new FlakyAuthGateway(0)
  const config = makeConfig(stateDir)
  const service = new PiBotService(config, gateway, makeRuntime())
  await service.start()

  await service.sendWelcomeCardAfterWarmUp()
  assert.equal(gateway.cardSends.length, 1)
  assert.equal(gateway.cardSends[0]?.userOpenId, "owner")

  // Same process, still inside the throttle window: no re-send.
  await service.sendWelcomeCardAfterWarmUp()
  assert.equal(gateway.cardSends.length, 1)

  await service.stop()

  // Fresh service instance after the throttle window elapsed: sends again.
  const elapsed = { ...config, welcomeCardThrottleMs: 0 }
  const second = new PiBotService(elapsed, gateway, makeRuntime())
  await second.start()
  await second.sendWelcomeCardAfterWarmUp()
  assert.equal(gateway.cardSends.length, 2)
  await second.stop()
})

test("card quick-task action runs the agent with the preset prompt and replies to the card", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-service-card-"))
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })
  const gateway = new FlakyAuthGateway(0)
  const runtime = makeRuntime()
  const seenTexts: string[] = []
  const spyRuntime: AgentRuntime = {
    async check() {
      return runtime.check()
    },
    async run(request) {
      seenTexts.push(request.text)
      return runtime.run(request)
    },
  }
  const service = new PiBotService(makeConfig(stateDir), gateway, spyRuntime)
  await service.start()

  const done = new Promise<void>((resolve) => {
    const timer = setInterval(async () => {
      const ledger = await readFile(join(stateDir, "usage-ledger.jsonl"), "utf8").catch(() => "")
      if (ledger.includes('"status":"success"')) {
        clearInterval(timer)
        resolve()
      }
    }, 10)
  })
  gateway.cardConsumers[0]?.onEvent({
    event_id: "card-event-1",
    operator_id: "owner",
    message_id: "om_card_test",
    chat_id: "oc_assistant",
    action_tag: "button",
    action_value: { action: "quick_task", task: "生成今天的工作简报" },
  })
  await done
  await service.stop()

  assert.deepEqual(seenTexts, ["生成今天的工作简报"])
  const finalReply = gateway.replies.find((reply) => reply.stage === "final")
  assert.ok(finalReply)
  assert.equal(finalReply.messageId, "om_card_test")
})

test("card action from a non-owner operator is ignored", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-service-card-"))
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })
  const gateway = new FlakyAuthGateway(0)
  const service = new PiBotService(makeConfig(stateDir), gateway, makeRuntime())
  await service.start()

  gateway.cardConsumers[0]?.onEvent({
    event_id: "card-event-2",
    operator_id: "someone-else",
    message_id: "om_card_test",
    chat_id: "oc_assistant",
    action_tag: "button",
    action_value: { action: "quick_task", task: "生成今天的工作简报" },
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  await service.stop()
  assert.deepEqual(gateway.replies.filter((reply) => reply.stage === "final"), [])
})

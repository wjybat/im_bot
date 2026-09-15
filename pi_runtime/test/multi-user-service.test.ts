import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.js"
import { MultiUserService } from "../src/tenant/multi-user-service.js"
import { TenantTokenStore, type UserTokenRecord } from "../src/tenant/token-store.js"
import { UserTokenManager } from "../src/tenant/token-manager.js"
import { OwnerMemoryRouter } from "../src/tenant/memory-router.js"
import { createModelRuntime } from "../src/agent/model.js"
import type {
  AgentRuntime,
  CardActionConsumerCallbacks,
  CardActionEvent,
  LarkGateway,
  MessageConsumer,
  MessageConsumerCallbacks,
  OwnerMemorySessionProvider,
  RuntimeConfig,
  RuntimeRequest,
} from "../src/types.js"

function tokenRecord(ownerOpenId: string, name: string): UserTokenRecord {
  return {
    ownerOpenId,
    ownerName: name,
    userAccessToken: `u-${ownerOpenId}`,
    refreshToken: `r-${ownerOpenId}`,
    expiresAt: Date.now() + 3_600_000,
    refreshExpiresAt: Date.now() + 86_400_000,
    grantedScopes: "",
    updatedAt: Date.now(),
  }
}

class RecordingGateway implements LarkGateway {
  replies: Array<{ messageId: string; stage: string; markdown: string }> = []
  cardSends: Array<{ userOpenId: string; card: unknown }> = []
  messageConsumers: MessageConsumerCallbacks[] = []
  cardConsumers: CardActionConsumerCallbacks[] = []
  activeOwner = ""
  identityByOwner: Record<string, { openId: string; name: string } | undefined> = {}

  async check(expectedOwnerOpenId?: string | null): Promise<{ version: string; ownerOpenId: string; ownerName: string | null; botName: string | null; botAppId: string | null; tokenStatus: string | null }> {
    return {
      version: "test",
      ownerOpenId: expectedOwnerOpenId ?? "",
      ownerName: this.identityByOwner[expectedOwnerOpenId ?? ""]?.name ?? null,
      botName: null,
      botAppId: "cli_test",
      tokenStatus: expectedOwnerOpenId ? "valid" : "no_owner_configured",
    }
  }

  async ensureUserIdentity(expectedOwnerOpenId?: string | null): Promise<{ ownerOpenId: string; ownerName: string | null; botName: string | null; botAppId: string | null; tokenStatus: string | null }> {
    return this.check(expectedOwnerOpenId)
  }

  setActiveOwner(ownerOpenId: string): void {
    this.activeOwner = ownerOpenId
  }

  async searchMessages(): Promise<unknown> {
    return { has_more: false, messages: [] }
  }

  async getMessagesByIds(): Promise<unknown> {
    return { messages: [] }
  }

  async listChatMessages(): Promise<unknown> {
    return { has_more: false, messages: [] }
  }

  async listThreadMessages(): Promise<unknown> {
    return { has_more: false, messages: [] }
  }

  async getAgenda(): Promise<unknown> {
    return { events: [] }
  }

  async getIncompleteTasks(): Promise<unknown> {
    return { items: [] }
  }

  async runReadOnlyCli(): Promise<{ stdout: string }> {
    return { stdout: "{}" }
  }

  async replyToMessage(messageId: string, markdown: string, stage = "final"): Promise<void> {
    this.replies.push({ messageId, stage, markdown })
  }

  async sendCardMessage(input: { userOpenId: string; card: unknown }): Promise<{ messageId: string }> {
    this.cardSends.push(input)
    return { messageId: `om_card_${this.cardSends.length}` }
  }

  startMessageConsumer(callbacks: MessageConsumerCallbacks): MessageConsumer {
    this.messageConsumers.push(callbacks)
    return { ready: Promise.resolve(), stop: () => undefined }
  }

  startCardActionConsumer(callbacks: CardActionConsumerCallbacks): MessageConsumer {
    this.cardConsumers.push(callbacks)
    return { ready: Promise.resolve(), stop: () => undefined }
  }
}

function multiUserConfig(stateDir: string, overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const base = {
    stateFile: join(stateDir, "processed-messages.json"),
    usageLedgerFile: join(stateDir, "usage-ledger.jsonl"),
    welcomeCardStateFile: join(stateDir, "welcome-card.json"),
    memoryFile: join(stateDir, "office-memory.db"),
  }
  const defaults: Record<string, unknown> = {
    replyOnError: false,
    maxQueue: 5,
    maxInputChars: 20_000,
    authVerifyIntervalMs: 600_000,
    authVerifyMessageAttempts: 1,
    authVerifyMessageRetryDelayMs: 1,
    welcomeCardThrottleMs: 600_000,
    allowedUserOpenIds: ["ou_alice", "ou_bob"],
    oauthCallbackPort: 0,
    oauthPublicBaseUrl: "http://localhost:0",
    provider: "dmall-ai",
    model: loadConfig().model,
    pricing: {
      currency: "USD",
      source: "test",
      asOf: "2026-09-14",
      longContextThreshold: 272_000,
      standard: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      longContext: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    },
  }
  return { ...defaults, ...base, ...overrides } as unknown as RuntimeConfig
}

function historySpyRuntime(seen: Array<{ owner: string | null; text: string }>): AgentRuntime {
  return {
    async check() {
      return { provider: "test", model: "test", auth: null }
    },
    async run(request: RuntimeRequest) {
      seen.push({ owner: request.ownerOpenId ?? null, text: request.text })
      return {
        usage: {
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          reasoningTokens: 0, totalTokens: 0, inputCostUsd: 0, outputCostUsd: 0,
          cacheReadCostUsd: 0, cacheWriteCostUsd: 0, estimatedCostUsd: 0,
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

test("unauthorized-but-allowed user receives an OAuth card instead of processing", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "multi-user-svc-"))
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })
  const config = multiUserConfig(stateDir)
  const gateway = new RecordingGateway()
  const tokenStore = new TenantTokenStore(join(stateDir, "tokens.json"), { appId: "cli_test", appSecret: "s" })
  await tokenStore.load()
  await tokenStore.upsert(tokenRecord("ou_alice", "甲"))
  const tokenManager = new UserTokenManager({
    app: { appId: "cli_test", appSecret: "s" },
    store: { get: (id) => tokenStore.get(id), upsert: (r) => tokenStore.upsert(r) },
  })
  const seen: Array<{ owner: string | null; text: string }> = []
  const runtime = historySpyRuntime(seen)
  const service = new MultiUserService({
    config,
    gateway: gateway as never,
    tokenStore,
    tokenManager,
    runtime: runtime as never,
    sessionProvider: { sessionFor: () => null as never } as OwnerMemorySessionProvider,
    buildAuthorizeUrl: (owner, redirect, state) => `https://accounts.feishu.cn/authorize?state=${state}&for=${owner}&redirect=${encodeURIComponent(redirect)}`,
    setActiveOwner: (owner) => gateway.setActiveOwner(owner),
  })
  await service.start()

  gateway.messageConsumers[0]?.onEvent({
    chat_type: "p2p",
    sender_type: "user",
    sender_id: "ou_bob",
    message_id: "om_bob_1",
    message_type: "text",
    content: "你好",
    chat_id: "oc_bob",
  })
  await new Promise((resolve) => setTimeout(resolve, 30))

  // Bob is on the allowlist but has no token: he gets the OAuth card, agent is not invoked.
  assert.equal(seen.length, 0)
  assert.equal(gateway.cardSends.length, 1)
  assert.equal(gateway.cardSends[0]?.userOpenId, "ou_bob")
  const card = JSON.stringify(gateway.cardSends[0]?.card)
  assert.match(card, /需要授权/)
  await service.stop()
})

test("authorized users are processed with per-owner isolation", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "multi-user-svc-"))
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })
  const config = multiUserConfig(stateDir)
  const gateway = new RecordingGateway()
  const tokenStore = new TenantTokenStore(join(stateDir, "tokens.json"), { appId: "cli_test", appSecret: "s" })
  await tokenStore.load()
  await tokenStore.upsert(tokenRecord("ou_alice", "甲"))
  const tokenManager = new UserTokenManager({
    app: { appId: "cli_test", appSecret: "s" },
    store: { get: (id) => tokenStore.get(id), upsert: (r) => tokenStore.upsert(r) },
  })
  const seen: Array<{ owner: string | null; text: string }> = []
  const runtime = historySpyRuntime(seen)
  const modelRuntime = createModelRuntime(config)
  const router = new OwnerMemoryRouter({ config, modelRuntime, assistantBotExternalId: "cli_test", assistantBotName: null })
  const service = new MultiUserService({
    config,
    gateway: gateway as never,
    tokenStore,
    tokenManager,
    runtime: runtime as never,
    sessionProvider: router,
    buildAuthorizeUrl: (owner, redirect, state) => `https://accounts.feishu.cn/authorize?state=${state}&for=${owner}&redirect=${encodeURIComponent(redirect)}`,
    setActiveOwner: (owner) => gateway.setActiveOwner(owner),
  })
  await service.start()

  const done = new Promise<void>((resolve) => {
    const timer = setInterval(async () => {
      const ledger = await readFile(join(stateDir, "usage-ledger.jsonl"), "utf8").catch(() => "")
      if (ledger.includes('"status":"success"') && seen.length >= 1) {
        clearInterval(timer)
        resolve()
      }
    }, 10)
  })
  gateway.messageConsumers[0]?.onEvent({
    chat_type: "p2p",
    sender_type: "user",
    sender_id: "ou_alice",
    message_id: "om_alice_1",
    message_type: "text",
    content: "今天有什么要处理的",
    chat_id: "oc_alice",
  })
  await done
  await service.stop()
  router.close()

  assert.deepEqual(seen, [{ owner: "ou_alice", text: "今天有什么要处理的" }])
  assert.equal(gateway.activeOwner, "ou_alice")
  const final = gateway.replies.find((reply) => reply.stage === "final")
  assert.ok(final)
  assert.equal(final.messageId, "om_alice_1")
  assert.equal(final.markdown, "echo:今天有什么要处理的")
})

test("user outside the allowlist is silently ignored", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "multi-user-svc-"))
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })
  const config = multiUserConfig(stateDir)
  const gateway = new RecordingGateway()
  const tokenStore = new TenantTokenStore(join(stateDir, "tokens.json"), { appId: "cli_test", appSecret: "s" })
  await tokenStore.load()
  await tokenStore.upsert(tokenRecord("ou_alice", "甲"))
  const tokenManager = new UserTokenManager({
    app: { appId: "cli_test", appSecret: "s" },
    store: { get: (id) => tokenStore.get(id), upsert: (r) => tokenStore.upsert(r) },
  })
  const seen: Array<{ owner: string | null; text: string }> = []
  const service = new MultiUserService({
    config,
    gateway: gateway as never,
    tokenStore,
    tokenManager,
    runtime: historySpyRuntime(seen) as never,
    sessionProvider: { sessionFor: () => null as never } as OwnerMemorySessionProvider,
    buildAuthorizeUrl: (owner, redirect, state) => `https://accounts.feishu.cn/authorize?state=${state}&for=${owner}&redirect=${encodeURIComponent(redirect)}`,
    setActiveOwner: (owner) => gateway.setActiveOwner(owner),
  })
  await service.start()
  gateway.messageConsumers[0]?.onEvent({
    chat_type: "p2p",
    sender_type: "user",
    sender_id: "ou_stranger",
    message_id: "om_stranger_1",
    message_type: "text",
    content: "你好",
    chat_id: "oc_stranger",
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await service.stop()
  assert.equal(seen.length, 0)
  assert.equal(gateway.cardSends.length, 0)
  assert.equal(gateway.replies.filter((reply) => reply.stage === "final").length, 0)
})

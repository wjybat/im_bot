import assert from "node:assert/strict"
import test from "node:test"
import { OfficeMemory } from "../src/memory/index.js"
import { createTestSemantic } from "./fakes.js"
import { ContextPreparer } from "../src/agent/context-preparer.js"
import { loadConfig } from "../src/config.js"
import type { LarkGateway, RuntimeConfig } from "../src/types.js"

/**
 * Records every owner-scoped read call together with the owner it was made
 * for, and can stall selected calls to force interleaving.
 */
class OwnerTrackingGateway implements LarkGateway {
  reads: Array<{ method: string; ownerOpenId: string | undefined }> = []

  async check() {
    return { version: "t", ownerOpenId: "", ownerName: null, botName: null, botAppId: "cli_t", tokenStatus: null }
  }
  async ensureUserIdentity() {
    return { ownerOpenId: "", ownerName: null, botName: null, botAppId: "cli_t", tokenStatus: "no_owner_configured" }
  }
  setActiveOwner(): void {}

  private async track(method: string, ownerOpenId: string | undefined, produce: () => Promise<unknown>): Promise<unknown> {
    this.reads.push({ method, ownerOpenId })
    return produce()
  }

  async searchMessages(
    input: { query: string; start: string; end: string; chatType?: "p2p" | "group"; pageLimit: number; ownerOpenId?: string },
  ): Promise<unknown> {
    return this.track("searchMessages", input.ownerOpenId, async () => ({ has_more: false, messages: [] }))
  }

  async getMessagesByIds(messageIds: string[], _signal?: AbortSignal, ownerOpenId?: string): Promise<unknown> {
    return this.track("getMessagesByIds", ownerOpenId, async () => ({ messages: [] }))
  }

  async listChatMessages(input: { chatId: string; ownerOpenId?: string }): Promise<unknown> {
    return this.track("listChatMessages", input.ownerOpenId, async () => ({ has_more: false, messages: [] }))
  }

  async listThreadMessages(input: { threadId: string; ownerOpenId?: string }): Promise<unknown> {
    return this.track("listThreadMessages", input.ownerOpenId, async () => ({ has_more: false, messages: [] }))
  }

  async getAgenda(input: { start: string; end: string; ownerOpenId?: string }): Promise<unknown> {
    return this.track("getAgenda", input.ownerOpenId, async () => ({ events: [] }))
  }

  async getIncompleteTasks(input: { pageLimit: number; ownerOpenId?: string }): Promise<unknown> {
    return this.track("getIncompleteTasks", input.ownerOpenId, async () => ({ items: [] }))
  }

  async runReadOnlyCli(): Promise<{ stdout: string }> {
    return { stdout: "{}" }
  }
  async replyToMessage(): Promise<void> {}
  async sendCardMessage(): Promise<{ messageId: string }> {
    return { messageId: "om_x" }
  }
  startMessageConsumer(): { ready: Promise<void>; stop(): void } {
    return { ready: Promise.resolve(), stop: () => undefined }
  }
  startCardActionConsumer(): { ready: Promise<void>; stop(): void } {
    return { ready: Promise.resolve(), stop: () => undefined }
  }
}

function preparerConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const base = loadConfig()
  return {
    ...base,
    memoryPrepareMaxWindows: 4,
    memoryPrepareMinWindowMs: 60_000,
    maxMessagePages: 2,
    memoryExtractionMaxChunks: 1,
    ...overrides,
  } as RuntimeConfig
}

test("context preparer passes its explicit owner to every gateway read", async (t) => {
  const config = preparerConfig()
  const gateway = new OwnerTrackingGateway()
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "ou_alice" })
  t.after(() => memory.close())
  const semantic = createTestSemantic(memory, config)
  const preparer = new ContextPreparer({
    config,
    gateway,
    memory,
    semantic,
    ownerOpenId: "ou_alice",
  })
  const result = await preparer.prepare({
    start: "2026-09-15T00:00:00Z",
    end: "2026-09-16T00:00:00Z",
    freshness: "current",
    semantic: "messages",
  })
  assert.ok(["ready", "partial"].includes(result.status))
  assert.ok(gateway.reads.length > 0)
  for (const read of gateway.reads) {
    assert.equal(read.ownerOpenId, "ou_alice", `read ${read.method} must carry the explicit owner`)
  }
})

test("interleaved preparers keep their owners isolated under concurrent reads", async (t) => {
  const config = preparerConfig()
  const gateway = new OwnerTrackingGateway()

  // Alice's first search blocks until released; Bob's preparer runs on
  // concurrently and must never see Alice's owner (nor vice versa).
  let releaseAlice!: () => void
  const release = new Promise<void>((resolve) => {
    releaseAlice = resolve
  })
  const held = gateway.searchMessages.bind(gateway)
  let aliceSearches = 0
  gateway.searchMessages = async (input: { ownerOpenId?: string }) => {
    if (input.ownerOpenId === "ou_alice" && aliceSearches++ === 0) await release
    return held(input as never)
  }

  const aliceMemory = new OfficeMemory({ path: ":memory:", ownerExternalId: "ou_alice" })
  const bobMemory = new OfficeMemory({ path: ":memory:", ownerExternalId: "ou_bob" })
  t.after(() => {
    aliceMemory.close()
    bobMemory.close()
  })
  const alicePreparer = new ContextPreparer({
    config, gateway, memory: aliceMemory, semantic: createTestSemantic(aliceMemory, config), ownerOpenId: "ou_alice",
  })
  const bobPreparer = new ContextPreparer({
    config, gateway, memory: bobMemory, semantic: createTestSemantic(bobMemory, config), ownerOpenId: "ou_bob",
  })

  const aliceRun = alicePreparer.prepare({
    start: "2026-09-15T00:00:00Z", end: "2026-09-15T06:00:00Z", freshness: "current", semantic: "messages",
  })
  // Let Alice's search start and block, then run Bob concurrently.
  await new Promise((resolve) => setTimeout(resolve, 30))
  const bobRun = bobPreparer.prepare({
    start: "2026-09-15T00:00:00Z", end: "2026-09-15T06:00:00Z", freshness: "current", semantic: "messages",
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  releaseAlice()
  await Promise.all([aliceRun, bobRun])

  const aliceReads = gateway.reads.filter((read) => read.ownerOpenId === "ou_alice")
  const bobReads = gateway.reads.filter((read) => read.ownerOpenId === "ou_bob")
  assert.ok(aliceReads.length > 0, "alice reads recorded")
  assert.ok(bobReads.length > 0, "bob reads recorded")
  assert.ok(gateway.reads.every((read) => read.ownerOpenId === "ou_alice" || read.ownerOpenId === "ou_bob"))
})

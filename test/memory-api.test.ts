import assert from "node:assert/strict"
import test from "node:test"
import { loadConfig } from "../src/config.js"
import { OfficeMemory } from "../src/memory/index.js"
import { startMemoryApiServer } from "../src/memory-api/server.js"
import type { LarkGateway, RuntimeConfig } from "../src/types.js"
import { createTestSemantic, FakeFactExtractor } from "./fakes.js"

class FakeGateway implements LarkGateway {
  async check(): Promise<never> {
    throw new Error("unused")
  }
  async ensureUserIdentity(): Promise<never> {
    throw new Error("unused")
  }
  async searchMessages(): Promise<unknown> {
    return {
      messages: [
        {
          message_id: "om_refresh_1",
          chat_id: "oc_refresh",
          chat_type: "group",
          chat_name: "刷新测试群",
          create_time: "2026-08-29T10:00:00+08:00",
          sender: { open_id: "ou_lead", name: "负责人", sender_type: "user" },
          content: "ou_abcdef123456 请周会前同步数据 oc_abcdef123456",
        },
      ],
    }
  }
  async getMessagesByIds(): Promise<unknown> {
    return { messages: [] }
  }
  async listChatMessages(): Promise<unknown> {
    return { messages: [] }
  }
  async listThreadMessages(): Promise<unknown> {
    return { messages: [] }
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

function messageFixture(): unknown {
  return {
    messages: [
      {
        message_id: "om_api_1",
        chat_id: "oc_api_project",
        chat_type: "group",
        chat_name: "52MD 项目群",
        create_time: "2026-08-28T09:00:00+08:00",
        sender: { open_id: "ou_lead", name: "负责人", sender_type: "user" },
        content: "请你周五前确认 52MD 选品方案",
      },
      {
        message_id: "om_api_2",
        chat_id: "oc_api_project",
        chat_type: "group",
        chat_name: "52MD 项目群",
        create_time: "2026-08-28T09:20:00+08:00",
        sender: { open_id: "ou_owner", name: "测试用户", sender_type: "user" },
        content: "52MD 选品方案已经确认，无需继续修改",
      },
    ],
  }
}

function apiConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const base = loadConfig()
  return {
    ...base,
    memoryApiPort: 0,
    memoryApiHost: "127.0.0.1",
    memoryApiKeys: ["test-service-key"],
    memoryApiRatePerMinute: 1_000,
    memoryApiDailyQuota: 100_000,
    memoryApiRefreshCooldownMs: 60_000,
    maxMessagePages: 2,
    memoryExtractionMaxChunks: 2,
    ...overrides,
  } as RuntimeConfig
}

async function startServer(
  config: RuntimeConfig,
  gateway: LarkGateway,
  memory: OfficeMemory,
  semantic: ReturnType<typeof createTestSemantic>,
) {
  const server = startMemoryApiServer({
    config,
    gateway,
    owners: () => ["ou_owner"],
    sessionFor: () => ({ ownerOpenId: "ou_owner", memory, semantic }),
    resolveOwnerByUnionId: (unionId) => (unionId === "union_owner" ? "ou_owner" : null),
  })
  await new Promise<void>((resolvePromise) => {
    if (server.listening) resolvePromise()
    else server.once("listening", () => resolvePromise())
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("expected TCP address")
  const port = address.port
  const call = (
    fn: string,
    body: unknown,
    token: string | null = "test-service-key",
  ): Promise<{ status: number; json: Record<string, unknown> }> =>
    fetch(`http://127.0.0.1:${port}/v1/${fn}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, json: (await res.json()) as Record<string, unknown> }))
  return { server, call }
}

test("memory api serves auth, query, and refresh functions", async (t) => {
  const config = apiConfig()
  const gateway = new FakeGateway()
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "ou_owner" })
  t.after(() => memory.close())
  memory.ingestLarkPayload(messageFixture(), { source: "test", resource: "chat.message" })
  const semantic = createTestSemantic(
    memory,
    config,
    new FakeFactExtractor({
      entities: [
        { name: "52MD", type: "Project", aliases: ["52MD 选品"] },
        { name: "测试用户", type: "Person", aliases: [] },
      ],
      facts: [
        {
          type: "ACTION_ITEM",
          key: "52MD:确认选品方案",
          text: "测试用户需要在周五前确认 52MD 选品方案",
          status: "done",
          subject: "52MD",
          object: "选品方案",
          assignee: "测试用户",
          dueAt: null,
          occurredAt: "2026-08-28T09:00:00+08:00",
          confidence: 0.96,
          evidenceOrdinals: [1, 2],
        },
      ],
    }),
  )
  const enrichment = await semantic.enrich(5)
  assert.ok(enrichment.completedChunks >= 1)
  const { server, call } = await startServer(config, gateway, memory, semantic)
  t.after(() => server.close())

  const health = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/health`)
  assert.equal(health.status, 200)
  assert.equal(((await health.json()) as { ok: boolean }).ok, true)

  const unauthorized = await call("search_facts", { ownerOpenId: "ou_owner", query: "52MD" }, "wrong-token")
  assert.equal(unauthorized.status, 401)
  assert.equal((unauthorized.json.error as { code: string }).code, "unauthorized")

  const noToken = await call("search_facts", { ownerOpenId: "ou_owner" }, null)
  assert.equal(noToken.status, 401)

  const badOwner = await call("search_facts", { ownerOpenId: "ou_stranger", query: "52MD" })
  assert.equal(badOwner.status, 403)
  assert.equal((badOwner.json.error as { code: string }).code, "owner_not_authorized")

  const missingOwner = await call("search_facts", { query: "52MD" })
  assert.equal(missingOwner.status, 400)

  const unionOwner = await call("search_entities", { ownerUnionId: "union_owner", query: "52MD" })
  assert.equal(unionOwner.status, 200)
  assert.ok(
    ((unionOwner.json.data as { entities: Array<{ name: string }> }).entities ?? []).some((e) => e.name === "52MD"),
  )
  const badUnion = await call("search_entities", { ownerUnionId: "union_stranger", query: "52MD" })
  assert.equal(badUnion.status, 403)
  assert.equal((badUnion.json.error as { code: string }).code, "owner_not_authorized")

  const toolsUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/tools`
  const toolsNoAuth = await fetch(toolsUrl)
  assert.equal(toolsNoAuth.status, 401)
  const tools = await fetch(toolsUrl, { headers: { authorization: "Bearer test-service-key" } })
  assert.equal(tools.status, 200)
  const manifest = (await tools.json()) as {
    ok: boolean
    data: { tools: Array<{ function: { name: string; parameters: Record<string, unknown> } }> }
  }
  assert.equal(manifest.ok, true)
  assert.equal(manifest.data.tools.length, 8)
  const toolNames = manifest.data.tools.map((tool) => tool.function.name)
  assert.ok(toolNames.includes("search_facts") && toolNames.includes("refresh_context"))
  for (const tool of manifest.data.tools) {
    assert.equal(tool.function.parameters.type, "object")
    assert.ok(
      typeof (tool.function.parameters.properties as Record<string, unknown>).ownerOpenId === "object" ||
        typeof (tool.function.parameters.properties as Record<string, unknown>).ownerUnionId === "object",
    )
  }

  const badParams = await call("search_facts", { ownerOpenId: "ou_owner", limit: 999 })
  assert.equal(badParams.status, 400)
  assert.equal((badParams.json.error as { code: string }).code, "invalid_params")

  const entities = await call("search_entities", { ownerOpenId: "ou_owner", query: "52MD" })
  assert.equal(entities.status, 200)
  assert.equal(entities.json.ok, true)
  const entityList = ((entities.json.data as { entities: Array<{ id: string; name: string }> }).entities)
  assert.ok(entityList.length >= 1)
  assert.equal(entityList[0]?.name, "52MD")

  const entityDetail = await call("get_entity", { ownerOpenId: "ou_owner", id: entityList[0]?.id })
  assert.equal(entityDetail.status, 200)
  const entity = (entityDetail.json.data as { entity: { name: string; facts: unknown[]; relatedEntities: unknown[] } })
    .entity
  assert.equal(entity.name, "52MD")
  assert.ok(entity.facts.length >= 1)

  const facts = await call("search_facts", { ownerOpenId: "ou_owner", query: "52MD 选品方案" })
  assert.equal(facts.status, 200)
  const factHits = (facts.json.data as { hits: Array<{ ref: string; kind: string; text: string }> }).hits
  assert.ok(factHits.some((hit) => hit.kind === "fact"))

  const messages = await call("search_messages", { ownerOpenId: "ou_owner", query: "选品方案" })
  assert.equal(messages.status, 200)
  const messageHits = (messages.json.data as {
    hits: Array<{ ref: string; content: string; chat: string }>
  }).hits
  assert.ok(messageHits.length >= 1)

  const evidence = await call("get_evidence", { ownerOpenId: "ou_owner", refs: [messageHits[0]?.ref] })
  assert.equal(evidence.status, 200)
  const evidenceMessages = (evidence.json.data as { messages: Array<{ content: string }> }).messages
  assert.ok(evidenceMessages.length >= 1)
  assert.ok(evidenceMessages[0]?.content.includes("选品方案"))

  const status = await call("get_status", { ownerOpenId: "ou_owner" })
  assert.equal(status.status, 200)
  const statusData = status.json.data as {
    messageMemory: { status: string }
    semanticMemory: { currentFacts: number }
    lastRefreshJob: unknown
  }
  assert.equal(statusData.messageMemory.status, "available")
  assert.ok(statusData.semanticMemory.currentFacts >= 1)
  assert.equal(statusData.lastRefreshJob, null)

  const refresh = await call("refresh_messages", {
    ownerOpenId: "ou_owner",
    start: "2026-08-29T00:00:00+08:00",
    end: "2026-08-29T23:59:59+08:00",
  })
  assert.equal(refresh.status, 200)
  const refreshData = refresh.json.data as {
    prepare: { status: string }
    messages: Array<{ content: string }>
  }
  assert.ok(["ready", "partial"].includes(refreshData.prepare.status))
  assert.ok(refreshData.messages.length >= 1)
  assert.ok(refreshData.messages[0]?.content.includes("[内部标识已隐藏]"))

  const cooled = await call("refresh_messages", {
    ownerOpenId: "ou_owner",
    start: "2026-08-29T00:00:00+08:00",
    end: "2026-08-29T23:59:59+08:00",
  })
  assert.equal(cooled.status, 429)
  assert.equal((cooled.json.error as { code: string }).code, "refresh_cooldown")

  const refreshContext = await call("refresh_context", {
    ownerOpenId: "ou_owner",
    start: "2026-08-29T00:00:00+08:00",
    end: "2026-08-29T23:59:59+08:00",
  })
  assert.equal(refreshContext.status, 200)
  const job = (refreshContext.json.data as { job: { id: string; status: string } }).job
  assert.ok(["queued", "running", "done"].includes(job.status))

  let lastJob: { status: string; result: unknown } | null = null
  for (let i = 0; i < 40; i++) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    const poll = await call("get_status", { ownerOpenId: "ou_owner" })
    lastJob = ((poll.json.data as { lastRefreshJob: { status: string; result: unknown } | null }).lastRefreshJob)
    if (lastJob !== null && (lastJob.status === "done" || lastJob.status === "error")) break
  }
  assert.notEqual(lastJob, null)
  assert.equal(lastJob?.status, "done")
  assert.ok(lastJob?.result !== null)
})

test("memory api enforces per-token rate limits", async (t) => {
  const config = apiConfig({ memoryApiRatePerMinute: 1, memoryApiDailyQuota: 100_000 })
  const gateway = new FakeGateway()
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "ou_owner" })
  t.after(() => memory.close())
  const { server, call } = await startServer(config, gateway, memory, createTestSemantic(memory, config))
  t.after(() => server.close())

  const first = await call("get_status", { ownerOpenId: "ou_owner" })
  assert.equal(first.status, 200)
  const second = await call("get_status", { ownerOpenId: "ou_owner" })
  assert.equal(second.status, 429)
  assert.equal((second.json.error as { code: string }).code, "rate_limited")
})

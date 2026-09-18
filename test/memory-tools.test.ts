import assert from "node:assert/strict"
import test from "node:test"
import { createMemoryTools } from "../src/agent/memory-tools.js"
import { loadConfig } from "../src/config.js"
import { MockLarkGateway } from "../src/demo/mock-lark.js"
import { OfficeMemory } from "../src/memory/index.js"
import { FakeFactExtractor, createTestSemantic } from "./fakes.js"

test("memory tools sync owner-visible messages and make them searchable", async () => {
  const config = { ...loadConfig(), memoryExtractionMaxChunks: 1 }
  const gateway = new MockLarkGateway()
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "redacted-demo-owner" })
  try {
    const extractor = new FakeFactExtractor({
      entities: [{ name: "消息检索", type: "Project", aliases: [] }],
      facts: [{
        type: "ACTION_ITEM",
        key: "消息检索:确认分页去重",
        text: "需要确认消息分页和去重方案",
        status: "open",
        subject: "消息检索",
        object: null,
        assignee: "测试用户",
        dueAt: null,
        occurredAt: "2026-08-25T09:15:00+08:00",
        confidence: 0.9,
        evidenceOrdinals: [1],
      }],
    }).withUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 120, estimatedCostUsd: 0.001 })
    const semantic = createTestSemantic(
      memory,
      config,
      extractor,
    )
    let auxiliaryInputTokens = 0
    const tools = createMemoryTools(config, gateway, memory, semantic, (usage) => {
      auxiliaryInputTokens += usage.inputTokens
    })
    const prepare = tools.find((tool) => tool.name === "prepare_office_context")
    const search = tools.find((tool) => tool.name === "search_office_memory")
    const hybrid = tools.find((tool) => tool.name === "search_office_context")
    const evidenceTool = tools.find((tool) => tool.name === "get_memory_evidence")
    assert.ok(prepare)
    assert.ok(search)
    assert.ok(hybrid)
    assert.ok(evidenceTool)

    const prepareResult = await prepare.execute(
      "prepare-1",
      {
        start: "2026-08-25T00:00:00+08:00",
        end: "2026-08-25T12:00:00+08:00",
        freshness: "current",
        semantic: "facts",
      },
      new AbortController().signal,
    )
    assert.equal(prepareResult.content[0]?.type, "text")
    assert.deepEqual(gateway.calls.map((call) => call.method), ["searchMessages"])
    const status = memory.status()
    assert.equal(status.eligibleMessages, 3)
    assert.equal(status.fullSyncFrom, "2026-08-25T00:00:00+08:00")
    assert.equal(status.fullSyncThrough, "2026-08-25T12:00:00+08:00")
    assert.equal(status.facts, 1)
    assert.equal(status.factExtractionTokens, 120)
    assert.equal(status.factExtractionCostUsd, 0.001)
    assert.equal(auxiliaryInputTokens, 100)

    const duplicate = await prepare.execute(
      "prepare-duplicate",
      {
        start: "2026-08-25T00:00:00+08:00",
        end: "2026-08-25T12:00:00+08:00",
        freshness: "current",
        semantic: "facts",
      },
      new AbortController().signal,
    )
    const duplicateBlock = duplicate.content[0]
    assert.equal(duplicateBlock?.type, "text")
    if (duplicateBlock?.type !== "text") throw new Error("expected cached preparation text result")
    assert.equal((JSON.parse(duplicateBlock.text) as { coverage: { status: string } }).coverage.status, "complete")
    assert.deepEqual(gateway.calls.map((call) => call.method), ["searchMessages"])

    const searchResult = await search.execute(
      "search-1",
      { query: "分页去重", limit: 10 },
      new AbortController().signal,
    )
    const block = searchResult.content[0]
    assert.equal(block?.type, "text")
    if (block?.type !== "text") throw new Error("expected text tool result")
    const parsed = JSON.parse(block.text) as { count: number; hits: Array<{ chat: string }> }
    assert.equal(parsed.count, 1)
    assert.equal(parsed.hits[0]?.chat, "项目群")

    const hybridResult = await hybrid.execute(
      "hybrid-1",
      { query: "分页去重", limit: 10 },
      new AbortController().signal,
    )
    const hybridBlock = hybridResult.content[0]
    assert.equal(hybridBlock?.type, "text")
    if (hybridBlock?.type !== "text") throw new Error("expected text hybrid result")
    const hybridParsed = JSON.parse(hybridBlock.text) as {
      hits: Array<{ ref: string; kind: string; factType?: string; evidence: unknown[] }>
    }
    const fact = hybridParsed.hits.find((hit) => hit.kind === "fact")
    assert.ok(fact)
    assert.equal(fact.factType, "ACTION_ITEM")
    assert.ok(fact.evidence.length >= 1)

    const expanded = await evidenceTool.execute(
      "evidence-1",
      { memoryRefs: [fact.ref] },
      new AbortController().signal,
    )
    const expandedBlock = expanded.content[0]
    assert.equal(expandedBlock?.type, "text")
    if (expandedBlock?.type !== "text") throw new Error("expected text evidence result")
    const expandedParsed = JSON.parse(expandedBlock.text) as { facts: unknown[] }
    assert.equal(expandedParsed.facts.length, 1)
  } finally {
    memory.close()
  }
})

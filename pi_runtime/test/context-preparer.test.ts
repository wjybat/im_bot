import assert from "node:assert/strict"
import test from "node:test"
import { ContextPreparer } from "../src/agent/context-preparer.js"
import { loadConfig } from "../src/config.js"
import { MockLarkGateway } from "../src/demo/mock-lark.js"
import { OfficeMemory } from "../src/memory/index.js"
import { FakeFactExtractor, createTestSemantic } from "./fakes.js"

class TruncatingGateway extends MockLarkGateway {
  readonly ranges: Array<{ start: string; end: string }> = []

  override async searchMessages(input: {
    query: string
    start: string
    end: string
    chatType?: "p2p" | "group"
    pageLimit: number
  }): Promise<unknown> {
    this.ranges.push({ start: input.start, end: input.end })
    const startAt = Date.parse(input.start)
    const endAt = Date.parse(input.end)
    return {
      has_more: endAt - startAt > 2 * 60 * 60 * 1000,
      messages: [{
        message_id: `om_${startAt}_${endAt}`,
        chat_id: "oc_prepare",
        chat_type: "group",
        chat_name: "准备上下文群",
        create_time: new Date(startAt).toISOString(),
        sender: { open_id: "ou_colleague", name: "同事", type: "user" },
        content: `窗口 ${startAt} 到 ${endAt}`,
      }],
    }
  }
}

test("context preparation owns recursive coverage, one enrichment pass, and request caching", async () => {
  const config = {
    ...loadConfig(),
    maxMessagePages: 1,
    memoryPrepareMaxWindows: 8,
    memoryPrepareMinWindowMs: 60_000,
    memoryExtractionMaxChunks: 1,
  }
  const gateway = new TruncatingGateway()
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "redacted-demo-owner" })
  const extractor = new FakeFactExtractor({ entities: [], facts: [] })
  const semantic = createTestSemantic(memory, config, extractor)
  const preparer = new ContextPreparer({ config, gateway, memory, semantic })
  const input = {
    start: "2026-08-29T00:00:00+08:00",
    end: "2026-08-29T04:00:00+08:00",
    freshness: "current" as const,
    semantic: "facts" as const,
  }
  try {
    const first = await preparer.prepare(input)
    assert.equal(first.coverage.status, "complete")
    assert.equal(gateway.ranges.length, 3)
    assert.equal(extractor.calls.length, 1)
    assert.equal(first.semantic.status, "partial")

    const repeated = await preparer.prepare(input)
    assert.deepEqual(repeated, first)
    assert.equal(gateway.ranges.length, 3)
    assert.equal(extractor.calls.length, 1)

    const secondRange = await preparer.prepare({
      ...input,
      start: "2026-08-29T04:00:00.001+08:00",
      end: "2026-08-29T08:00:00+08:00",
    })
    assert.equal(secondRange.coverage.status, "complete")
    assert.equal(extractor.calls.length, 1)

    const cachedPreparer = new ContextPreparer({ config, gateway, memory, semantic })
    const cached = await cachedPreparer.prepare({ ...input, freshness: "cached_ok", semantic: "messages" })
    assert.equal(cached.coverage.source, "cache")
    assert.equal(cached.coverage.status, "complete")
    assert.equal(gateway.ranges.length, 6)
  } finally {
    memory.close()
  }
})

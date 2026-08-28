import assert from "node:assert/strict"
import test from "node:test"
import { createMemoryTools } from "../src/agent/memory-tools.js"
import { loadConfig } from "../src/config.js"
import { MockLarkGateway } from "../src/demo/mock-lark.js"
import { OfficeMemory } from "../src/memory/index.js"

test("memory tools sync owner-visible messages and make them searchable", async () => {
  const config = loadConfig()
  const gateway = new MockLarkGateway()
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "redacted-demo-owner" })
  try {
    const tools = createMemoryTools(config, gateway, memory)
    const sync = tools.find((tool) => tool.name === "sync_office_context")
    const search = tools.find((tool) => tool.name === "search_office_memory")
    assert.ok(sync)
    assert.ok(search)

    const syncResult = await sync.execute(
      "sync-1",
      {
        start: "2026-08-25T00:00:00+08:00",
        end: "2026-08-25T12:00:00+08:00",
      },
      new AbortController().signal,
    )
    assert.equal(syncResult.content[0]?.type, "text")
    assert.deepEqual(gateway.calls.map((call) => call.method), ["searchMessages"])
    const status = memory.status()
    assert.equal(status.eligibleMessages, 3)
    assert.equal(status.fullSyncFrom, "2026-08-25T00:00:00+08:00")
    assert.equal(status.fullSyncThrough, "2026-08-25T12:00:00+08:00")

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
  } finally {
    memory.close()
  }
})

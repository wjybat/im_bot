import assert from "node:assert/strict"
import test from "node:test"
import { createMemoryTools } from "../src/agent/memory-tools.js"
import { loadConfig } from "../src/config.js"
import { OfficeMemory } from "../src/memory/index.js"
import { createTestSemantic } from "./fakes.js"
import { LarkCliGateway } from "../src/adapters/lark-cli.js"

class NoopGateway extends LarkCliGateway {
  override async searchMessages() {
    return { has_more: false, messages: [] }
  }
}

test("search tools enforce the per-run call budget", async (t) => {
  const config = { ...loadConfig(), memorySearchCallsPerRun: 3 }
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "ou_owner" })
  t.after(() => memory.close())
  memory.ingestLarkPayload(
    {
      messages: [
        {
          message_id: "om_budget_1",
          chat_id: "oc_budget",
          chat_type: "group",
          chat_name: "预算测试群",
          create_time: "2026-09-14T09:00:00+08:00",
          sender: { open_id: "ou_peer", name: "同事" },
          content: "请确认预算测试任务",
        },
      ],
    },
    { source: "test", resource: "chat.message" },
  )
  const semantic = createTestSemantic(memory, config)
  const gateway = new NoopGateway(config)
  const tools = createMemoryTools(config, gateway, memory, semantic)
  const search = tools.find((tool) => tool.name === "search_office_memory")
  const hybrid = tools.find((tool) => tool.name === "search_office_context")
  assert.ok(search)
  assert.ok(hybrid)

  const run = async (tool: typeof search) =>
    (await tool.execute("c", { query: "预算测试" }, new AbortController().signal)) as {
      content: Array<{ type: string; text: string }>
      details: Record<string, unknown>
    }

  // Budget 3 shared across both tools.
  const first = await run(search)
  assert.equal(first.details.blocked, undefined)
  const second = await run(hybrid)
  assert.equal(second.details.blocked, undefined)
  const third = await run(search)
  assert.equal(third.details.blocked, undefined)
  // 4th call is blocked with guidance text.
  const fourth = await run(hybrid)
  assert.equal(fourth.details.blocked, true)
  assert.match(fourth.content.find((block) => block.type === "text")?.text ?? "", /配额已用尽/)
})

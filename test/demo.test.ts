import assert from "node:assert/strict"
import test from "node:test"
import { createDemoPiRuntime } from "../src/agent/pi-runtime.js"
import { loadRuntimeSkills } from "../src/agent/skills.js"
import { createRuntimeTools } from "../src/agent/tools.js"
import { loadConfig } from "../src/config.js"
import { MockLarkGateway } from "../src/demo/mock-lark.js"
import { OfficeMemory } from "../src/memory/index.js"
import { createTestSemantic } from "./fakes.js"

test("offline Pi demo loads a dedicated skill, calls a read-only Lark tool, and returns evidence", async () => {
  const config = loadConfig()
  const gateway = new MockLarkGateway()
  const now = new Date("2026-08-25T02:30:00Z")
  const runtime = await createDemoPiRuntime(config, gateway, now)
  const result = await runtime.run({
    text: "整理一下今天有什么需要我处理",
    requestId: "test-demo",
    sessionId: "test-demo-session",
    now,
  })
  assert.deepEqual(result.tools, ["load_skill", "load_skill", "run_lark_cli"])
  assert.deepEqual(gateway.calls.map((call) => call.method), ["runReadOnlyCli"])
  assert.match(result.reply, /需要你处理/)
  assert.match(result.reply, /项目群/)
  assert.doesNotMatch(result.reply, /internal-demo|internal-chat/)
})

test("skill discovery is confined to the Pi runtime catalog", async () => {
  const config = loadConfig()
  const loaded = await loadRuntimeSkills(config.projectRoot, config.skillsDir)
  assert.equal(loaded.skills.length, 28)
  assert.ok(loaded.skills.some((skill) => skill.name === "lark-im"))
  assert.ok(loaded.skills.some((skill) => skill.name === "lark-calendar"))
  assert.ok(loaded.skills.some((skill) => skill.name === "lark-mail"))
  assert.ok(loaded.skills.some((skill) => skill.name === "lark-shared"))
  assert.ok(loaded.skills.some((skill) => skill.name === "daily-work-brief"))
  assert.equal(loaded.diagnostics.length, 0)
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "redacted-demo-owner" })
  const semantic = createTestSemantic(memory, config)
  const gateway = new MockLarkGateway()
  const tools = createRuntimeTools(config, gateway, loaded, memory, semantic)
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "get_memory_evidence",
    "get_memory_status",
    "load_skill",
    "prepare_office_context",
    "read_skill_file",
    "run_lark_cli",
    "search_office_context",
    "search_office_memory",
  ])
  assert.equal(tools.some((tool) => /bash|shell|send|reply|auth|write/u.test(tool.name)), false)
  const runLark = tools.find((tool) => tool.name === "run_lark_cli")
  assert.ok(runLark)
  const args = ["im", "+messages-search", "--query", "分页", "--as", "user", "--format", "json"]
  await runLark.execute("cached-read-1", { args }, new AbortController().signal)
  await runLark.execute("cached-read-2", { args }, new AbortController().signal)
  assert.equal(gateway.calls.filter((call) => call.method === "runReadOnlyCli").length, 1)
  memory.close()
})

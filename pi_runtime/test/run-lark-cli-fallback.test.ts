import assert from "node:assert/strict"
import test from "node:test"
import { createRuntimeTools } from "../src/agent/tools.js"
import { RunLarkCliUnsupportedError } from "../src/types.js"
import { OfficeMemory } from "../src/memory/index.js"
import { createTestSemantic } from "./fakes.js"
import { loadConfig } from "../src/config.js"
import { loadRuntimeSkills } from "../src/agent/skills.js"
import type { LarkGateway } from "../src/types.js"

class UnsupportedCliGateway implements LarkGateway {
  async check() {
    return { version: "t", ownerOpenId: "ou_t", ownerName: null, botName: null, botAppId: null, tokenStatus: null }
  }
  async ensureUserIdentity() {
    return { ownerOpenId: "ou_t", ownerName: null, botName: null, botAppId: null, tokenStatus: null }
  }
  async searchMessages() {
    return { has_more: false, messages: [] }
  }
  async getMessagesByIds() {
    return { messages: [] }
  }
  async listChatMessages() {
    return { has_more: false, messages: [] }
  }
  async listThreadMessages() {
    return { has_more: false, messages: [] }
  }
  async getAgenda() {
    return { events: [] }
  }
  async getIncompleteTasks() {
    return { items: [] }
  }
  async runReadOnlyCli(): Promise<{ stdout: string }> {
    throw new RunLarkCliUnsupportedError()
  }
  async replyToMessage() {}
  async sendCardMessage() {
    return { messageId: "om_t" }
  }
  startMessageConsumer() {
    return { ready: Promise.resolve(), stop: () => undefined }
  }
  startCardActionConsumer() {
    return { ready: Promise.resolve(), stop: () => undefined }
  }
}

test("run_lark_cli degrades to guidance text when the gateway cannot back it", async (t) => {
  const config = loadConfig()
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "ou_t" })
  t.after(() => memory.close())
  const semantic = createTestSemantic(memory, config)
  const gateway = new UnsupportedCliGateway()
  const skills = await loadRuntimeSkills(config.projectRoot, config.skillsDir)
  const tools = createRuntimeTools(config, gateway, skills, memory, semantic)
  const runLarkCli = tools.find((tool) => tool.name === "run_lark_cli")
  assert.ok(runLarkCli)
  const result = (await runLarkCli.execute(
    "call-1",
    { args: ["im", "+messages-search", "--query", "测试"] },
    new AbortController().signal,
  )) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> }
  const text = result.content.find((block) => block.type === "text")?.text ?? ""
  assert.match(text, /不支持 run_lark_cli/)
  assert.match(text, /prepare_office_context/)
  assert.equal(result.details.unsupported, true)
})

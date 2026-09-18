import assert from "node:assert/strict"
import test from "node:test"
import { buildSystemPrompt } from "../src/agent/prompt.js"
import { loadConfig } from "../src/config.js"
import type { AgentTool } from "@earendil-works/pi-agent-core"
import type { RuntimeSkills } from "../src/agent/skills.js"
import type { ConversationTurn, RuntimeRequest } from "../src/types.js"

const config = loadConfig()
const skills = {
  skills: [],
  catalogPrompt: "",
  loadTool: null as unknown as AgentTool,
  readFileTool: null as unknown as AgentTool,
  diagnostics: [],
} satisfies RuntimeSkills

async function buildPromptWith(recentConversation?: readonly ConversationTurn[]): Promise<string> {
  const request: RuntimeRequest = {
    text: "第二条展开说说",
    requestId: "history-test",
    sessionId: "history-test-session",
    now: new Date("2026-09-10T04:00:00Z"),
    ...(recentConversation === undefined ? {} : { recentConversation }),
  }
  return buildSystemPrompt(config, skills, request)
}

test("system prompt omits history block when no prior turns exist", async () => {
  const prompt = await buildPromptWith()
  assert.doesNotMatch(prompt, /<RECENT_CONVERSATION_JSON>/)
})

test("recent conversation turns are injected as ordered JSON with truncation", async () => {
  const longText = "长".repeat(config.historyTurnMaxChars + 500)
  const turns: ConversationTurn[] = [
    { role: "user", text: "今天有什么要处理的", at: "2026-09-10T03:50:00.000Z" },
    { role: "assistant", text: "有两条待办", at: "2026-09-10T03:51:00.000Z" },
    { role: "user", text: longText, at: "2026-09-10T03:55:00.000Z" },
    { role: "assistant", text: "已收到", at: "2026-09-10T03:56:00.000Z" },
  ]
  const prompt = await buildPromptWith(turns)
  const block = prompt.match(/<RECENT_CONVERSATION_JSON>\n([\s\S]*?)\n<\/RECENT_CONVERSATION_JSON>/)
  assert.ok(block)
  const parsed = JSON.parse(block[1] ?? "null") as Array<{ role: string; text: string }>
  assert.equal(parsed.length, 4)
  assert.equal(parsed[0]?.role, "user")
  assert.ok((parsed[2]?.text.length ?? 0) < longText.length)
  assert.match(parsed[2]?.text ?? "", /内容已截断/)
})

test("history injection stays bounded to the configured turn count", async () => {
  const turns: ConversationTurn[] = Array.from({ length: config.historyTurns * 4 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `turn-${index}`,
    at: new Date(Date.parse("2026-09-10T00:00:00Z") + index * 60_000).toISOString(),
  }))
  const prompt = await buildPromptWith(turns)
  const block = prompt.match(/<RECENT_CONVERSATION_JSON>\n([\s\S]*?)\n<\/RECENT_CONVERSATION_JSON>/)
  assert.ok(block)
  const parsed = JSON.parse(block[1] ?? "null") as unknown[]
  assert.equal(parsed.length, config.historyTurns * 2)
  assert.ok(prompt.includes(`turn-${turns.length - 1}`))
  assert.doesNotMatch(prompt, /turn-0\b/)
})

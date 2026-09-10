import { readFile } from "node:fs/promises"
import { truncateText } from "../infra/safety.js"
import type { ConversationTurn, RuntimeConfig, RuntimeRequest } from "../types.js"
import type { RuntimeSkills } from "./skills.js"
import { shanghaiTimeContext } from "./time.js"

export async function buildSystemPrompt(
  config: RuntimeConfig,
  skills: RuntimeSkills,
  request: RuntimeRequest,
): Promise<string> {
  const base = await readFile(config.systemPromptFile, "utf8")
  const context = {
    ...shanghaiTimeContext(request.now),
    requestId: request.requestId,
    runtime: "pi-agent-core",
    toolPolicy: "dedicated-read-only",
  }
  const recent = (request.recentConversation ?? [])
    .slice(-config.historyTurns * 2)
    .map((turn) => ({
      role: turn.role,
      at: turn.at,
      text: truncateText(turn.text, config.historyTurnMaxChars),
    }))
  const historyBlock = recent.length
    ? `\n\n<RECENT_CONVERSATION_JSON>\n${JSON.stringify(recent)}\n</RECENT_CONVERSATION_JSON>`
    : ""
  return `${base.trim()}\n\n${skills.catalogPrompt}\n\n<RUNTIME_CONTEXT_JSON>\n${JSON.stringify(context)}\n</RUNTIME_CONTEXT_JSON>${historyBlock}`
}

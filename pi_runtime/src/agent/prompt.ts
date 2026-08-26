import { readFile } from "node:fs/promises"
import type { RuntimeConfig, RuntimeRequest } from "../types.js"
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
  return `${base.trim()}\n\n${skills.catalogPrompt}\n\n<RUNTIME_CONTEXT_JSON>\n${JSON.stringify(context)}\n</RUNTIME_CONTEXT_JSON>`
}

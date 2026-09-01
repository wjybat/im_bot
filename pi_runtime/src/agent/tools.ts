import type { AgentTool } from "@earendil-works/pi-agent-core"
import { Type } from "@earendil-works/pi-ai"
import { truncateText } from "../infra/safety.js"
import { logger } from "../infra/logger.js"
import type { OfficeMemory, SemanticMemory } from "../memory/index.js"
import type { LarkGateway, RuntimeConfig, RuntimeUsage } from "../types.js"
import { createMemoryTools, ingestMessageToolOutput } from "./memory-tools.js"
import type { RuntimeSkills } from "./skills.js"

export function createRuntimeTools(
  config: RuntimeConfig,
  gateway: LarkGateway,
  skills: RuntimeSkills,
  memory: OfficeMemory,
  semantic: SemanticMemory,
  onUsage?: (usage: RuntimeUsage) => void,
): AgentTool[] {
  const larkReadCache = new Map<
    string,
    Promise<{
      output: { stdout: string }
      memoryIngest: Awaited<ReturnType<typeof ingestMessageToolOutput>>
    }>
  >()
  const parameters = Type.Object({
    args: Type.Array(Type.String(), {
      minItems: 1,
      maxItems: 64,
      description:
        "lark-cli argv without the executable name, exactly as specified by a loaded Lark integration skill; for example [\"im\",\"+messages-search\",\"--query\",\"\",\"--as\",\"user\",\"--format\",\"json\"]",
    }),
  })
  const runLarkCli: AgentTool<typeof parameters> = {
    name: "run_lark_cli",
    label: "Run Lark CLI command",
    description:
      "Execute a command selected from a loaded Lark integration skill. Pass argv only, without the lark-cli executable. The host dynamically permits declared Risk: read commands, schema inspection, event metadata inspection, and generic GET requests; writes, auth changes, event consumers, and --yes are blocked.",
    parameters,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal) {
      const cacheKey = JSON.stringify(params.args)
      const cached = larkReadCache.has(cacheKey)
      let operation = larkReadCache.get(cacheKey)
      if (!operation) {
        operation = gateway.runReadOnlyCli(params.args, signal).then(async (output) => {
          const memoryIngest = await ingestMessageToolOutput(memory, params.args, output.stdout).catch((error) => {
            logger.error("office_memory_ingest_failed", error)
            return null
          })
          return { output, memoryIngest }
        })
        larkReadCache.set(cacheKey, operation)
        operation.catch(() => larkReadCache.delete(cacheKey))
      }
      const { output, memoryIngest } = await operation
      return {
        content: [
          {
            type: "text",
            text: truncateText(output.stdout, config.maxToolOutputChars, "\n\n[tool output truncated]"),
          },
        ],
        details: {
          command: params.args.slice(0, params.args[1]?.startsWith("+") ? 2 : 3),
          outputBytes: Buffer.byteLength(output.stdout),
          cached,
          ...(memoryIngest
            ? {
                memoryCreated: memoryIngest.created,
                memoryUpdated: memoryIngest.updated,
                memoryRejected: memoryIngest.rejected,
              }
            : {}),
        },
      }
    },
  }
  return [
    skills.loadTool,
    skills.readFileTool,
    ...createMemoryTools(config, gateway, memory, semantic, onUsage),
    runLarkCli,
  ]
}

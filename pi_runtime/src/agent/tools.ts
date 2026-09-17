import type { AgentTool } from "@earendil-works/pi-agent-core"
import { Type } from "@earendil-works/pi-ai"
import { truncateText } from "../infra/safety.js"
import { logger } from "../infra/logger.js"
import type { OfficeMemory, SemanticMemory } from "../memory/index.js"
import { RunLarkCliUnsupportedError } from "../types.js"
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
  ownerOpenId?: string | null,
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
      let resolved: Awaited<typeof operation>
      try {
        resolved = await operation
      } catch (error) {
        if (error instanceof RunLarkCliUnsupportedError) {
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  "此部署不支持 run_lark_cli（无本地 lark-cli 通道）。",
                  "请改用结构化记忆与上下文工具完成同一目标：",
                  "- 消息检索/同步：prepare_office_context、search_office_memory、search_office_context",
                  "- 证据展开：get_memory_evidence；状态检查：get_memory_status",
                  "- 日程与任务已由上下文准备器覆盖；其余来源（邮件/审批等）在当前部署不可用，请基于可用证据继续作答并说明缺口的来源。",
                ].join("\n"),
              },
            ],
            details: { unsupported: true, command: params.args.slice(0, 3) },
          }
        }
        throw error
      }
      const { output, memoryIngest } = resolved
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
    ...createMemoryTools(config, gateway, memory, semantic, onUsage, ownerOpenId),
    runLarkCli,
  ]
}

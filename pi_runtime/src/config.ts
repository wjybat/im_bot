import { accessSync, constants, existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ThinkingLevel } from "@earendil-works/pi-agent-core"
import type { RuntimeConfig } from "./types.js"

const moduleParent = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const projectRoot = basename(moduleParent) === "dist" ? resolve(moduleParent, "..") : moduleParent
const envFile = resolve(projectRoot, ".env")

if (existsSync(envFile)) {
  const inheritedEnvironment = { ...process.env }
  process.loadEnvFile(envFile)
  Object.assign(process.env, inheritedEnvironment)
}

function firstExecutable(fallback: string, candidates: string[]): string {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue to PATH fallback.
    }
  }
  return fallback
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function decimal(name: string, fallback: number, min = 0, max = 1_000_000): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`)
  }
  return value
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false
  throw new Error(`${name} must be true or false`)
}

function provider(): RuntimeConfig["provider"] {
  const value = process.env.IM_BOT_PI_PROVIDER || "dmall-ai"
  if (!new Set(["dmall-ai", "openai", "anthropic", "openai-codex"]).has(value)) {
    throw new Error("IM_BOT_PI_PROVIDER must be dmall-ai, openai, anthropic, or openai-codex")
  }
  return value as RuntimeConfig["provider"]
}

function thinkingLevel(name = "IM_BOT_PI_THINKING", fallback = "high"): ThinkingLevel {
  const value = process.env[name] || fallback
  if (!new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).has(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value as ThinkingLevel
}

export function loadConfig(): RuntimeConfig {
  if (boolean("IM_BOT_PI_ALLOW_USER_WRITES", false)) {
    throw new Error("IM_BOT_PI_ALLOW_USER_WRITES=true is not supported")
  }
  return Object.freeze({
    projectRoot,
    skillsDir: resolve(projectRoot, "runtime", "skills"),
    systemPromptFile: resolve(projectRoot, "runtime", "system.md"),
    stateFile: resolve(projectRoot, "var", "processed-messages.json"),
    usageLedgerFile: resolve(projectRoot, "var", "usage-ledger.jsonl"),
    memoryFile: resolve(projectRoot, process.env.IM_BOT_PI_MEMORY_FILE || "var/office-memory.db"),
    memoryExtractionThinking: thinkingLevel("IM_BOT_PI_MEMORY_THINKING", "low"),
    memoryExtractionTimeoutMs: integer("IM_BOT_PI_MEMORY_EXTRACTION_TIMEOUT_MS", 120_000, 10_000, 300_000),
    memoryExtractionMaxOutputTokens: integer("IM_BOT_PI_MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS", 4096, 256, 16_384),
    memoryChunkIdleGapMs: integer("IM_BOT_PI_MEMORY_IDLE_GAP_MINUTES", 90, 5, 1440) * 60_000,
    memoryChunkMaxTokens: integer("IM_BOT_PI_MEMORY_CHUNK_TOKENS", 1400, 200, 8000),
    memoryChunkMaxMessages: integer("IM_BOT_PI_MEMORY_CHUNK_MESSAGES", 20, 1, 100),
    memoryContextMessages: integer("IM_BOT_PI_MEMORY_CONTEXT_MESSAGES", 5, 0, 30),
    memoryExtractionMaxChunks: integer("IM_BOT_PI_MEMORY_MAX_CHUNKS", 3, 1, 30),
    memoryExtractionMaxAttempts: integer("IM_BOT_PI_MEMORY_MAX_ATTEMPTS", 3, 1, 10),
    memoryHybridTokenBudget: integer("IM_BOT_PI_MEMORY_CONTEXT_TOKENS", 12000, 500, 64000),
    memorySearchCallsPerRun: integer("IM_BOT_PI_MEMORY_SEARCH_CALLS_PER_RUN", 8, 1, 100),
    memoryPrepareMaxWindows: integer("IM_BOT_PI_MEMORY_PREPARE_MAX_WINDOWS", 16, 1, 64),
    memoryPrepareMinWindowMs:
      integer("IM_BOT_PI_MEMORY_PREPARE_MIN_WINDOW_SECONDS", 60, 1, 3600) * 1000,
    memoryWarmSchedule:
      process.env.IM_BOT_PI_MEMORY_WARM_SCHEDULE || "07:30,12:30,23:00",
    memoryWarmInitialDelayMs:
      integer("IM_BOT_PI_MEMORY_WARM_INITIAL_DELAY_SECONDS", 30, 0, 3600) * 1000,
    memoryWarmLookbackDays: integer("IM_BOT_PI_MEMORY_WARM_LOOKBACK_DAYS", 14, 1, 90),
    memoryWarmInitialLookbackDays: integer("IM_BOT_PI_MEMORY_WARM_INITIAL_LOOKBACK_DAYS", 7, 1, 90),
    memoryWarmMaxChunks: integer("IM_BOT_PI_MEMORY_WARM_MAX_CHUNKS", 10, 1, 30),
    welcomeCardThrottleMs:
      integer("IM_BOT_PI_WELCOME_CARD_THROTTLE_MINUTES", 15, 0, 10_080) * 60_000,
    welcomeCardStateFile: resolve(projectRoot, "var", "welcome-card.json"),
    historyTurns: integer("IM_BOT_PI_HISTORY_TURNS", 8, 0, 40),
    historyTurnMaxChars: integer("IM_BOT_PI_HISTORY_TURN_CHARS", 4000, 100, 12_000),
    conversationIdleResetMs:
      integer("IM_BOT_PI_CONVERSATION_IDLE_RESET_MINUTES", 60, 1, 10_080) * 60_000,
    authFile: resolve(projectRoot, process.env.IM_BOT_PI_AUTH_FILE || "var/pi-auth/auth.json"),
    larkCli:
      process.env.IM_BOT_LARK_CLI ||
      firstExecutable("lark-cli", [join(homedir(), ".npm-global", "bin", "lark-cli")]),
    provider: provider(),
    baseUrl: process.env.IM_BOT_PI_BASE_URL || "https://ai-router.dmall.com/v1",
    model: process.env.IM_BOT_PI_MODEL || "gpt-5.6-luna",
    thinkingLevel: thinkingLevel(),
    runtimeTimeoutMs: integer("IM_BOT_PI_TIMEOUT_MS", 600_000, 10_000, 1_800_000),
    runtimeStreamRetries: integer("IM_BOT_PI_STREAM_RETRIES", 2, 0, 5),
    runtimeStreamRetryDelayMs: integer("IM_BOT_PI_STREAM_RETRY_DELAY_MS", 2_000, 250, 60_000),
    toolTimeoutMs: integer("IM_BOT_PI_TOOL_TIMEOUT_MS", 120_000, 5_000, 600_000),
    authVerifyIntervalMs: integer("IM_BOT_PI_AUTH_VERIFY_INTERVAL_MS", 600_000, 60_000, 3_600_000),
    authVerifyMessageAttempts: integer("IM_BOT_PI_AUTH_VERIFY_MESSAGE_ATTEMPTS", 3, 1, 10),
    authVerifyMessageRetryDelayMs:
      integer("IM_BOT_PI_AUTH_VERIFY_MESSAGE_RETRY_DELAY_MS", 2_000, 500, 60_000),
    allowedUserOpenIds: (process.env.IM_BOT_PI_ALLOWED_USER_OPEN_IDS || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
    oauthCallbackPort: integer("IM_BOT_PI_OAUTH_CALLBACK_PORT", 37_731, 0, 65_535),
    oauthPublicBaseUrl: process.env.IM_BOT_PI_OAUTH_PUBLIC_BASE_URL || "http://localhost:37731",
    allowedUserOpenId: process.env.IM_BOT_ALLOWED_USER_OPEN_ID || null,
    maxQueue: integer("IM_BOT_PI_MAX_QUEUE", 20, 1, 1000),
    maxInputChars: integer("IM_BOT_PI_MAX_INPUT_CHARS", 20_000, 100, 100_000),
    maxReplyChars: integer("IM_BOT_PI_MAX_REPLY_CHARS", 12_000, 100, 50_000),
    maxToolOutputChars: integer("IM_BOT_PI_MAX_TOOL_OUTPUT_CHARS", 100_000, 1_000, 500_000),
    maxMessagePages: integer("IM_BOT_PI_MAX_MESSAGE_PAGES", 5, 1, 40),
    maxTurns: integer("IM_BOT_PI_MAX_TURNS", 50, 1, 100),
    replyOnError: boolean("IM_BOT_PI_REPLY_ON_ERROR", true),
    processingReply:
      process.env.IM_BOT_PI_PROCESSING_REPLY || "已收到，正在读取办公上下文并整理，请稍候。",
    pricing: {
      currency: "USD" as const,
      source:
        process.env.IM_BOT_PI_PRICE_SOURCE ||
        "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
      asOf: process.env.IM_BOT_PI_PRICE_AS_OF || "2026-08-26",
      longContextThreshold: integer("IM_BOT_PI_PRICE_LONG_CONTEXT_THRESHOLD", 272_000, 1, 10_000_000),
      standard: {
        input: decimal("IM_BOT_PI_PRICE_INPUT_PER_MILLION", 0.2),
        cacheRead: decimal("IM_BOT_PI_PRICE_CACHE_READ_PER_MILLION", 0.02),
        cacheWrite: decimal("IM_BOT_PI_PRICE_CACHE_WRITE_PER_MILLION", 0.25),
        output: decimal("IM_BOT_PI_PRICE_OUTPUT_PER_MILLION", 1.2),
      },
      longContext: {
        input: decimal("IM_BOT_PI_PRICE_LONG_INPUT_PER_MILLION", 0.4),
        cacheRead: decimal("IM_BOT_PI_PRICE_LONG_CACHE_READ_PER_MILLION", 0.04),
        cacheWrite: decimal("IM_BOT_PI_PRICE_LONG_CACHE_WRITE_PER_MILLION", 0.5),
        output: decimal("IM_BOT_PI_PRICE_LONG_OUTPUT_PER_MILLION", 1.8),
      },
    },
    allowUserWrites: false,
  })
}

export { projectRoot }

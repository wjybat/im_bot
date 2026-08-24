import { accessSync, constants } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function firstExecutable(fallback, candidates) {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue to the next well-known location; PATH lookup remains the final fallback.
    }
  }
  return fallback
}

function integer(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function boolean(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false
  throw new Error(`${name} must be true or false`)
}

export function loadConfig() {
  const sandbox = process.env.IM_BOT_CODEX_SANDBOX || "workspace-write"
  if (!new Set(["read-only", "workspace-write"]).has(sandbox)) {
    throw new Error("IM_BOT_CODEX_SANDBOX must be read-only or workspace-write")
  }

  const allowUserWrites = boolean("IM_BOT_ALLOW_USER_WRITES", false)
  if (allowUserWrites) {
    throw new Error(
      "IM_BOT_ALLOW_USER_WRITES=true is not supported until a reviewed confirmation protocol exists",
    )
  }

  return Object.freeze({
    projectRoot,
    runtimeDir: resolve(projectRoot, "runtime"),
    stateFile: resolve(projectRoot, "var", "state.json"),
    larkCli:
      process.env.IM_BOT_LARK_CLI ||
      firstExecutable("lark-cli", [join(homedir(), ".npm-global", "bin", "lark-cli")]),
    codexCli:
      process.env.IM_BOT_CODEX_CLI ||
      firstExecutable("codex", ["/Applications/ChatGPT.app/Contents/Resources/codex"]),
    codexSandbox: sandbox,
    codexModel: process.env.IM_BOT_CODEX_MODEL || null,
    codexTimeoutMs: integer("IM_BOT_CODEX_TIMEOUT_MS", 600_000, {
      min: 10_000,
      max: 900_000,
    }),
    authVerifyIntervalMs: integer("IM_BOT_AUTH_VERIFY_INTERVAL_MS", 600_000, {
      min: 60_000,
      max: 3_600_000,
    }),
    allowedUserOpenId: process.env.IM_BOT_ALLOWED_USER_OPEN_ID || null,
    maxQueue: integer("IM_BOT_MAX_QUEUE", 20, { min: 1, max: 1000 }),
    maxInputChars: integer("IM_BOT_MAX_INPUT_CHARS", 20_000, { min: 100, max: 100_000 }),
    maxReplyChars: integer("IM_BOT_MAX_REPLY_CHARS", 12_000, { min: 100, max: 50_000 }),
    replyOnError: boolean("IM_BOT_REPLY_ON_ERROR", true),
    allowUserWrites,
    stateMaxRecords: integer("IM_BOT_STATE_MAX_RECORDS", 5000, { min: 100, max: 100_000 }),
  })
}

export { projectRoot }

import { createHash } from "node:crypto"
import { spawn } from "node:child_process"

export class CommandError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = "CommandError"
    this.details = details
  }
}

function appendBounded(current, chunk, maxBytes) {
  const next = current + chunk
  if (Buffer.byteLength(next) <= maxBytes) return next
  return next.slice(-maxBytes)
}

export function runCommand(
  command,
  args,
  { cwd, env, input = null, timeoutMs = 60_000, maxOutputBytes = 2_000_000 } = {},
) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let forceTimer = null

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk, maxOutputBytes)
    })
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk, maxOutputBytes)
    })

    child.once("error", (error) => {
      rejectPromise(new CommandError(`failed to start ${command}: ${error.message}`, { command }))
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 5000)
      forceTimer.unref()
    }, timeoutMs)
    timer.unref()

    child.once("close", (code, signal) => {
      clearTimeout(timer)
      if (forceTimer !== null) clearTimeout(forceTimer)
      resolvePromise({ code, signal, stdout, stderr, timedOut })
    })

    if (input === null) child.stdin.end()
    else child.stdin.end(input)
  })
}

export function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new CommandError(`${label} returned invalid JSON`, {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}

export function hashIdentifier(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12)
}

export function replyIdempotencyKey(messageId) {
  return `imbot-${createHash("sha256").update(messageId).digest("hex").slice(0, 32)}`
}

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

export function safeError(error) {
  if (!(error instanceof Error)) return { type: "unknown", message: "unknown error" }
  return { type: error.name, message: error.message.slice(0, 500) }
}

export function truncateText(text, maxChars) {
  const normalized = String(text).replaceAll("\u0000", "").trim()
  const chars = Array.from(normalized)
  if (chars.length <= maxChars) return normalized
  return `${chars.slice(0, Math.max(0, maxChars - 18)).join("")}\n\n（回复已截断）`
}

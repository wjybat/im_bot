import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { CommandError, parseJson, replyIdempotencyKey, runCommand } from "./util.mjs"

const quietEnv = Object.freeze({
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
})

async function runLark(config, args, options = {}) {
  const result = await runCommand(config.larkCli, args, {
    cwd: config.projectRoot,
    env: quietEnv,
    timeoutMs: options.timeoutMs ?? 60_000,
    input: options.input ?? null,
  })
  if (result.code !== 0) {
    throw new CommandError(`lark-cli ${args.slice(0, 3).join(" ")} failed`, {
      code: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      stderr: result.stderr.slice(-1000),
    })
  }
  return result
}

export async function checkLarkRuntime(config) {
  const version = await runLark(config, ["--version"], { timeoutMs: 15_000 })
  const identity = await ensureUserIdentity(config, config.allowedUserOpenId)

  const eventsResult = await runLark(config, ["event", "list", "--json"])
  const events = parseJson(eventsResult.stdout, "lark-cli event list")
  const receive = Array.isArray(events)
    ? events.find((item) => (item.key ?? item.event_key) === "im.message.receive_v1")
    : null
  if (receive === null || receive === undefined) {
    throw new Error("im.message.receive_v1 is not available in the installed lark-cli")
  }

  return {
    ownerOpenId: identity.ownerOpenId,
    ownerName: identity.ownerName,
    botName: identity.botName,
    version: version.stdout.trim(),
    eventScope: Array.isArray(receive.scopes) ? receive.scopes : [],
  }
}

/**
 * The only code path allowed to verify/refresh the UAT.
 *
 * This function runs in the unsandboxed host process so a rotated refresh token can be
 * persisted atomically by lark-cli. Codex children must never call auth status --verify.
 */
export async function ensureUserIdentity(config, expectedOwnerOpenId = null) {
  const authResult = await runLark(config, ["auth", "status", "--json", "--verify"])
  const auth = parseJson(authResult.stdout, "lark-cli auth status")
  const bot = auth.identities?.bot
  const user = auth.identities?.user

  if (auth.verified !== true || bot?.available !== true || bot?.verified !== true) {
    throw new Error("Lark bot identity is not ready")
  }
  if (user?.available !== true || user?.verified !== true || typeof user?.openId !== "string") {
    throw new Error("Lark user identity is not ready; host-side token refresh failed")
  }
  if (expectedOwnerOpenId !== null && expectedOwnerOpenId !== user.openId) {
    throw new Error("authorized Lark user changed; refusing to cross the owner boundary")
  }
  return {
    ownerOpenId: user.openId,
    ownerName: user.userName || null,
    botName: bot.appName || null,
    tokenStatus: user.tokenStatus || null,
  }
}

export async function replyToMessage(config, messageId, markdown) {
  const result = await runLark(
    config,
    [
      "im",
      "+messages-reply",
      "--as",
      "bot",
      "--message-id",
      messageId,
      "--markdown",
      markdown,
      "--idempotency-key",
      replyIdempotencyKey(messageId),
      "--format",
      "json",
    ],
    { timeoutMs: 90_000 },
  )
  return parseJson(result.stdout, "lark-cli message reply")
}

export function startMessageConsumer(config, callbacks) {
  const child = spawn(
    config.larkCli,
    [
      "event",
      "consume",
      "im.message.receive_v1",
      "--as",
      "bot",
      "--jq",
      'select(.chat_type=="p2p" and .sender_type=="user")',
    ],
    {
      cwd: config.projectRoot,
      env: { ...process.env, ...quietEnv },
      stdio: ["pipe", "pipe", "pipe"],
    },
  )

  let readySettled = false
  let readyResolve
  let readyReject
  const ready = new Promise((resolvePromise, rejectPromise) => {
    readyResolve = resolvePromise
    readyReject = rejectPromise
  })

  const stdoutLines = createInterface({ input: child.stdout })
  const stderrLines = createInterface({ input: child.stderr })

  stdoutLines.on("line", (line) => {
    if (line.trim() === "") return
    try {
      callbacks.onEvent(JSON.parse(line))
    } catch (error) {
      callbacks.onMalformedEvent?.(error)
    }
  })

  stderrLines.on("line", (line) => {
    if (line.includes("[event] ready")) {
      readySettled = true
      readyResolve()
      callbacks.onDiagnostic?.("ready")
      return
    }
    if (line.includes("[source] feishu-websocket: connected")) {
      callbacks.onDiagnostic?.("connected")
      return
    }
    if (line.includes("[event] exited")) callbacks.onDiagnostic?.("exited")
  })

  child.once("error", (error) => {
    if (!readySettled) {
      readySettled = true
      readyReject(error)
    }
  })

  child.once("close", (code, signal) => {
    if (!readySettled) {
      readySettled = true
      readyReject(new Error(`event consumer exited before ready (code=${code}, signal=${signal})`))
    }
    callbacks.onExit?.({ code, signal })
  })

  return {
    child,
    ready,
    stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    },
  }
}

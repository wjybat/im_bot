import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { CommandError, parseJson, runCommand } from "../infra/command.js"
import { replyIdempotencyKey, truncateText } from "../infra/safety.js"
import type {
  IncomingMessageEvent,
  LarkGateway,
  MessageConsumer,
  MessageConsumerCallbacks,
  OwnerIdentity,
  RuntimeConfig,
} from "../types.js"

const quietEnv = Object.freeze({
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
})

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null
}

function dataFromEnvelope(value: unknown): unknown {
  const envelope = asRecord(value)
  if (envelope?.ok !== true) throw new CommandError("lark-cli returned an unsuccessful envelope")
  return envelope.data
}

function safeLarkFailure(stderr: string): Record<string, unknown> {
  const trimmed = stderr.trim()
  const candidates = [trimmed]
  const objectStart = trimmed.indexOf("{")
  const objectEnd = trimmed.lastIndexOf("}")
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(trimmed.slice(objectStart, objectEnd + 1))
  candidates.push(...trimmed.split(/\r?\n/).reverse())
  for (const candidate of candidates) {
    try {
      const envelope = asRecord(JSON.parse(candidate))
      const error = asRecord(envelope?.error)
      if (!error) continue
      return {
        type: error.type ?? "unknown",
        subtype: error.subtype ?? null,
        message: typeof error.message === "string" ? error.message.slice(0, 500) : "lark-cli failed",
        missingScopes: Array.isArray(error.missing_scopes) ? error.missing_scopes : [],
      }
    } catch {
      // Try the next JSON candidate.
    }
  }
  return { type: "unknown", message: "lark-cli failed" }
}

export class LarkCliGateway implements LarkGateway {
  private readonly riskCache = new Map<string, string>()

  constructor(private readonly config: RuntimeConfig) {}

  private async runRaw(
    args: string[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await runCommand(this.config.larkCli, args, {
      cwd: this.config.projectRoot,
      env: quietEnv,
      timeoutMs: options.timeoutMs ?? this.config.toolTimeoutMs,
      maxOutputBytes: 5_000_000,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (result.code !== 0 || result.timedOut) {
      const failure = safeLarkFailure(result.stderr)
      throw new CommandError(
        `lark-cli ${args.slice(0, 2).join(" ")} failed: ${String(failure.message ?? "unknown error")}`,
        {
        code: result.code,
        timedOut: result.timedOut,
        failure,
        },
      )
    }
    return { stdout: result.stdout, stderr: result.stderr }
  }

  private async run(args: string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    const result = await this.runRaw(args, options)
    return parseJson(result.stdout, "lark-cli")
  }

  async runReadOnlyCli(args: string[], signal?: AbortSignal): Promise<{ stdout: string }> {
    if (args.length === 0 || args.length > 64) throw new Error("lark-cli args must contain 1 to 64 items")
    if (args.some((arg) => typeof arg !== "string" || arg.includes("\u0000") || arg.length > 20_000)) {
      throw new Error("invalid lark-cli argument")
    }
    if (args.includes("--yes")) throw new Error("--yes is forbidden in the read-only runtime")
    const first = args[0]?.toLowerCase()
    if (!first || ["auth", "config", "update"].includes(first)) {
      throw new Error(`${first || "unknown"} is host-managed and unavailable to the agent`)
    }
    if (first === "event") {
      const action = args[1]?.toLowerCase()
      if (!action || !["list", "schema", "status"].includes(action)) {
        throw new Error("the agent may inspect event metadata but may not consume or stop event streams")
      }
      const output = await this.runRaw(args, { ...(signal ? { signal } : {}) })
      return { stdout: output.stdout }
    }
    if (first === "schema" || first === "whoami") {
      const output = await this.runRaw(args, { ...(signal ? { signal } : {}) })
      return { stdout: output.stdout }
    }
    if (first === "api") {
      if (args[1]?.toUpperCase() !== "GET") throw new Error("generic lark-cli api is restricted to GET")
      const output = await this.runRaw(args, { ...(signal ? { signal } : {}) })
      return { stdout: output.stdout }
    }

    const prefix = args[1]?.startsWith("+") ? args.slice(0, 2) : args.slice(0, 3)
    if (prefix.length < 2) throw new Error("unable to identify lark-cli command path")
    const cacheKey = prefix.join("\u0000")
    let risk = this.riskCache.get(cacheKey)
    if (!risk) {
      const help = await runCommand(this.config.larkCli, [...prefix, "--help"], {
        cwd: this.config.projectRoot,
        env: quietEnv,
        timeoutMs: 15_000,
        maxOutputBytes: 200_000,
        ...(signal ? { signal } : {}),
      })
      if (help.code !== 0 || help.timedOut) throw new Error("unable to inspect lark-cli command risk")
      const matched = /^Risk:\s*([^\s]+)\s*$/imu.exec(help.stdout)
      if (!matched?.[1]) throw new Error("lark-cli command does not declare a risk level")
      risk = matched[1].toLowerCase()
      this.riskCache.set(cacheKey, risk)
    }
    if (risk !== "read" && !args.includes("--dry-run")) {
      throw new Error(`lark-cli command is blocked by read-only policy (risk=${risk})`)
    }
    const output = await this.runRaw(args, { ...(signal ? { signal } : {}) })
    return { stdout: output.stdout }
  }

  async ensureUserIdentity(expectedOwnerOpenId: string | null = null): Promise<OwnerIdentity> {
    const value = await this.run(["auth", "status", "--json", "--verify"])
    const auth = asRecord(value)
    const identities = asRecord(auth?.identities)
    const bot = asRecord(identities?.bot)
    const user = asRecord(identities?.user)
    if (auth?.verified !== true || bot?.available !== true || bot?.verified !== true) {
      throw new Error("Lark bot identity is not ready")
    }
    if (user?.available !== true || user?.verified !== true || typeof user?.openId !== "string") {
      throw new Error("Lark user identity is not ready")
    }
    if (expectedOwnerOpenId !== null && expectedOwnerOpenId !== user.openId) {
      throw new Error("authorized Lark user changed; refusing to cross the owner boundary")
    }
    return {
      ownerOpenId: user.openId,
      ownerName: typeof user.userName === "string" ? user.userName : null,
      botName: typeof bot.appName === "string" ? bot.appName : null,
      tokenStatus: typeof user.tokenStatus === "string" ? user.tokenStatus : null,
    }
  }

  async check(expectedOwnerOpenId: string | null = null): Promise<OwnerIdentity & { version: string }> {
    const versionResult = await runCommand(this.config.larkCli, ["--version"], {
      cwd: this.config.projectRoot,
      env: quietEnv,
      timeoutMs: 15_000,
    })
    if (versionResult.code !== 0) throw new Error("lark-cli version check failed")
    const identity = await this.ensureUserIdentity(expectedOwnerOpenId)
    const events = await this.run(["event", "list", "--json"])
    if (
      !Array.isArray(events) ||
      !events.some((item) => {
        const record = asRecord(item)
        return (record?.key ?? record?.event_key) === "im.message.receive_v1"
      })
    ) {
      throw new Error("im.message.receive_v1 is unavailable")
    }
    return { ...identity, version: versionResult.stdout.trim() }
  }

  async searchMessages(
    input: { query: string; start: string; end: string; chatType?: "p2p" | "group"; pageLimit: number },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const args = [
      "im",
      "+messages-search",
      "--as",
      "user",
      "--query",
      input.query,
      "--start",
      input.start,
      "--end",
      input.end,
      "--page-size",
      "50",
      "--page-limit",
      String(input.pageLimit),
      "--no-reactions",
      "--format",
      "json",
    ]
    if (input.chatType) args.push("--chat-type", input.chatType)
    return dataFromEnvelope(await this.run(args, { ...(signal ? { signal } : {}) }))
  }

  async listChatMessages(
    input: { chatId: string; start?: string; end?: string; order: "asc" | "desc"; pageSize: number },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const args = [
      "im",
      "+chat-messages-list",
      "--as",
      "user",
      "--chat-id",
      input.chatId,
      "--order",
      input.order,
      "--page-size",
      String(input.pageSize),
      "--no-reactions",
      "--format",
      "json",
    ]
    if (input.start) args.push("--start", input.start)
    if (input.end) args.push("--end", input.end)
    return dataFromEnvelope(await this.run(args, { ...(signal ? { signal } : {}) }))
  }

  async listThreadMessages(
    input: { threadId: string; order: "asc" | "desc"; pageSize: number },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return dataFromEnvelope(
      await this.run(
        [
          "im",
          "+threads-messages-list",
          "--as",
          "user",
          "--thread",
          input.threadId,
          "--order",
          input.order,
          "--page-size",
          String(input.pageSize),
          "--no-reactions",
          "--format",
          "json",
        ],
        { ...(signal ? { signal } : {}) },
      ),
    )
  }

  async getAgenda(input: { start: string; end: string }, signal?: AbortSignal): Promise<unknown> {
    return dataFromEnvelope(
      await this.run(
        ["calendar", "+agenda", "--as", "user", "--start", input.start, "--end", input.end, "--format", "json"],
        { ...(signal ? { signal } : {}) },
      ),
    )
  }

  async getIncompleteTasks(input: { pageLimit: number }, signal?: AbortSignal): Promise<unknown> {
    return dataFromEnvelope(
      await this.run(
        [
          "task",
          "+get-my-tasks",
          "--as",
          "user",
          "--complete=false",
          "--page-limit",
          String(input.pageLimit),
          "--format",
          "json",
        ],
        { ...(signal ? { signal } : {}) },
      ),
    )
  }

  async replyToMessage(
    messageId: string,
    markdown: string,
    stage: "processing" | "final" | "error" | "overloaded" = "final",
  ): Promise<void> {
    const key = replyIdempotencyKey(messageId, stage)
    const common = [
        "im",
        "+messages-reply",
        "--as",
        "bot",
        "--message-id",
        messageId,
        "--idempotency-key",
        key,
        "--format",
        "json",
    ]
    try {
      await this.run([...common, "--markdown", markdown], { timeoutMs: 90_000 })
    } catch (markdownError) {
      try {
        await this.run([...common, "--text", truncateText(markdown, 6_000)], { timeoutMs: 90_000 })
      } catch (textError) {
        throw new CommandError("both markdown and text bot replies failed", {
          markdown: markdownError instanceof Error ? markdownError.message : String(markdownError),
          text: textError instanceof Error ? textError.message : String(textError),
        })
      }
    }
  }

  startMessageConsumer(callbacks: MessageConsumerCallbacks): MessageConsumer {
    const child = spawn(
      this.config.larkCli,
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
        cwd: this.config.projectRoot,
        env: { ...process.env, ...quietEnv },
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
    let settled = false
    let readyResolve: () => void = () => undefined
    let readyReject: (error: unknown) => void = () => undefined
    const ready = new Promise<void>((resolvePromise, rejectPromise) => {
      readyResolve = resolvePromise
      readyReject = rejectPromise
    })
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.trim() === "") return
      try {
        callbacks.onEvent(JSON.parse(line) as IncomingMessageEvent)
      } catch (error) {
        callbacks.onMalformedEvent?.(error)
      }
    })
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.includes("[event] ready")) {
        if (!settled) {
          settled = true
          readyResolve()
        }
        callbacks.onDiagnostic?.("ready")
      } else if (line.includes("[source] feishu-websocket: connected")) {
        callbacks.onDiagnostic?.("connected")
      } else if (line.includes("[event] exited")) {
        callbacks.onDiagnostic?.("exited")
      }
    })
    child.once("error", (error) => {
      if (!settled) {
        settled = true
        readyReject(error)
      }
    })
    child.once("close", (code, signal) => {
      if (!settled) {
        settled = true
        readyReject(new Error(`event consumer exited before ready (code=${code}, signal=${signal})`))
      }
      callbacks.onExit?.({ code, signal })
    })
    return {
      ready,
      stop(): void {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
      },
    }
  }
}

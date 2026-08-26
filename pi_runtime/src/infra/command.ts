import { spawn } from "node:child_process"

export interface CommandResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export class CommandError extends Error {
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message)
    this.name = "CommandError"
  }
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
  const next = current + chunk
  if (Buffer.byteLength(next) <= maxBytes) return next
  return next.slice(-maxBytes)
}

export function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
    input?: string | null
    timeoutMs?: number
    maxOutputBytes?: number
    signal?: AbortSignal
  },
): Promise<CommandResult> {
  options.signal?.throwIfAborted()
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const maxOutputBytes = options.maxOutputBytes ?? 2_000_000
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk, maxOutputBytes)
    })
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk, maxOutputBytes)
    })

    const terminate = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    }
    const onAbort = (): void => terminate()
    options.signal?.addEventListener("abort", onAbort, { once: true })

    const timeout = setTimeout(() => {
      timedOut = true
      terminate()
    }, options.timeoutMs ?? 60_000)
    timeout.unref()

    child.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener("abort", onAbort)
      rejectPromise(new CommandError(`failed to start command: ${error.message}`))
    })

    child.once("close", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener("abort", onAbort)
      resolvePromise({ code, signal, stdout, stderr, timedOut })
    })

    if (options.input === undefined || options.input === null) child.stdin.end()
    else child.stdin.end(options.input)
  })
}

export function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new CommandError(`${label} returned invalid JSON`, {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { ContextPreparer } from "../agent/context-preparer.js"
import { logger } from "../infra/logger.js"
import { safeError } from "../infra/safety.js"
import type { LarkGateway, RuntimeConfig } from "../types.js"
import {
  getEntityHandler,
  getEvidenceHandler,
  InvalidParamsError,
  refreshContextHandler,
  refreshMessagesHandler,
  RefreshCooldownError,
  searchEntitiesHandler,
  searchFactsHandler,
  searchMessagesHandler,
  getStatusHandler,
  type MemoryApiCallContext,
  type MemoryApiDeps,
  type MemoryApiSession,
} from "./handlers.js"
import { MemoryApiRateLimiter } from "./rate-limit.js"
import { RefreshJobManager } from "./refresh-jobs.js"
import { TOOL_MANIFEST } from "./tools.js"

export interface MemoryApiOptions {
  config: RuntimeConfig
  gateway: LarkGateway
  owners: () => string[]
  sessionFor: (ownerOpenId: string) => MemoryApiSession
  /** Resolves a Feishu union_id to this app's ownerOpenId; null when unknown. */
  resolveOwnerByUnionId?: (unionId: string) => string | null
}

const MAX_BODY_BYTES = 256 * 1024
const API_VERSION = 1

interface ApiError extends Error {
  code?: string
  retryAfterMs?: number
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) })
  res.end(body)
}

function sendError(res: ServerResponse, code: string, message: string, status: number): void {
  sendJson(res, status, { version: API_VERSION, ok: false, error: { code, message } })
}

function sendOk(res: ServerResponse, data: unknown): void {
  sendJson(res, 200, { version: API_VERSION, ok: true, data })
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new Error("request body too large")
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (typeof header !== "string") return null
  const match = /^Bearer\s+(.+)$/u.exec(header.trim())
  return match === null ? null : match[1] ?? null
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export function startMemoryApiServer(options: MemoryApiOptions): ReturnType<typeof createServer> {
  const { config, gateway } = options
  const keys = new Set(config.memoryApiKeys)
  const limiter = new MemoryApiRateLimiter({
    perMinute: config.memoryApiRatePerMinute,
    dailyQuota: config.memoryApiDailyQuota,
  })
  const cooldowns = new Map<string, number>()
  const preparers = new Map<string, ContextPreparer>()

  function preparerFor(ownerOpenId: string): ContextPreparer {
    const existing = preparers.get(ownerOpenId)
    if (existing !== undefined) return existing
    const session = options.sessionFor(ownerOpenId)
    const preparer = new ContextPreparer({
      config,
      gateway,
      memory: session.memory,
      semantic: session.semantic,
      prioritizeRequestWindow: true,
      ownerOpenId,
    })
    preparers.set(ownerOpenId, preparer)
    return preparer
  }

  const jobs = new RefreshJobManager(
    (job) =>
      preparerFor(job.ownerOpenId).prepare({
        start: job.start,
        end: job.end,
        ...(job.query !== null ? { query: job.query } : {}),
        ...(job.chatType !== null ? { chatType: job.chatType } : {}),
        freshness: "current",
        semantic: "facts",
      }),
  )
  const deps: MemoryApiDeps = { config, gateway, sessionFor: options.sessionFor, preparerFor }
  const validOwners = (): Set<string> => new Set(options.owners())

  const server = createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost")
      if (req.method === "GET" && url.pathname === "/v1/health") {
        sendJson(res, 200, { version: API_VERSION, ok: true })
        return
      }
      if (req.method === "GET" && url.pathname === "/v1/tools") {
        const token = bearerToken(req)
        if (token === null || ![...keys].some((key) => timingSafeEqual(key, token))) {
          sendError(res, "unauthorized", "missing or invalid bearer token", 401)
          return
        }
        sendOk(res, TOOL_MANIFEST)
        return
      }
      if (req.method !== "POST") {
        sendError(res, "method_not_allowed", "POST only (GET /v1/health, /v1/tools)", 405)
        return
      }
      const match = /^\/v1\/([a-z_]+)$/u.exec(url.pathname)
      if (match === null) {
        sendError(res, "not_found", "unknown path; expected /v1/<function>", 404)
        return
      }
      const fn = match[1]
      if (fn === undefined) {
        sendError(res, "not_found", "unknown path", 404)
        return
      }

      const token = bearerToken(req)
      if (token === null || ![...keys].some((key) => timingSafeEqual(key, token))) {
        sendError(res, "unauthorized", "missing or invalid bearer token", 401)
        return
      }
      const decision = limiter.check(token)
      if (!decision.allowed) {
        if (decision.reason === "per_minute") {
          res.setHeader("retry-after", Math.ceil((decision.retryAfterMs ?? 60_000) / 1000))
        }
        sendError(res, "rate_limited", `rate limit exceeded (${decision.reason})`, 429)
        return
      }

      const parsedBody = await readBody(req)
      if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
        sendError(res, "invalid_params", "request body must be a JSON object", 400)
        return
      }
      const body = parsedBody as Record<string, unknown>
      const ownerOpenIdRaw = typeof body.ownerOpenId === "string" ? body.ownerOpenId : null
      const ownerUnionIdRaw = typeof body.ownerUnionId === "string" && body.ownerUnionId !== "" ? body.ownerUnionId : null
      let ownerOpenId: string | null = null
      if (ownerOpenIdRaw !== null && ownerOpenIdRaw !== "") {
        ownerOpenId = ownerOpenIdRaw
      } else if (ownerUnionIdRaw !== null) {
        ownerOpenId = options.resolveOwnerByUnionId?.(ownerUnionIdRaw) ?? null
        if (ownerOpenId === null) {
          sendError(res, "owner_not_authorized", "ownerUnionId does not map to a registered owner of this bot", 403)
          return
        }
      } else {
        sendError(res, "invalid_params", "ownerOpenId or ownerUnionId is required", 400)
        return
      }
      if (!validOwners().has(ownerOpenId)) {
        sendError(res, "owner_not_authorized", "ownerOpenId is not a registered owner of this bot", 403)
        return
      }

      const ctx: MemoryApiCallContext = {
        ...deps,
        ownerOpenId,
        session: options.sessionFor(ownerOpenId),
      }

      let data: unknown
      switch (fn) {
        case "search_facts":
          data = searchFactsHandler(ctx, body)
          break
        case "search_messages":
          data = searchMessagesHandler(ctx, body)
          break
        case "get_evidence":
          data = getEvidenceHandler(ctx, body)
          break
        case "search_entities":
          data = searchEntitiesHandler(ctx, body)
          break
        case "get_entity":
          data = getEntityHandler(ctx, body)
          break
        case "get_status":
          data = getStatusHandler(ctx, jobs)
          break
        case "refresh_messages":
          data = await refreshMessagesHandler(ctx, body, cooldowns, config.memoryApiRefreshCooldownMs)
          break
        case "refresh_context":
          data = refreshContextHandler(ctx, body, jobs, cooldowns, config.memoryApiRefreshCooldownMs)
          break
        default:
          sendError(res, "not_found", `unknown function ${fn}`, 404)
          return
      }
      sendOk(res, data)
    } catch (error) {
      const apiError = error as ApiError
      if (error instanceof InvalidParamsError || error instanceof RefreshCooldownError) {
        const status = error instanceof RefreshCooldownError ? 429 : 400
        const headers: Record<string, string | number> = {}
        if (error instanceof RefreshCooldownError) {
          headers["retry-after"] = Math.ceil(error.retryAfterMs / 1000)
        }
        const body = JSON.stringify({
          version: API_VERSION,
          ok: false,
          error: { code: error.code ?? "invalid_params", message: error.message.slice(0, 300) },
        })
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers })
        res.end(body)
        return
      }
      const safe = safeError(error)
      const message = /invalid_access_token|user_access_token|auth(?:orize|ization)?[_ ]?(failed|expired|required)/iu.test(
        safe.message,
      )
        ? "owner token requires re-authorization"
        : safe.message
      const code = message === "owner token requires re-authorization" ? "owner_reauth_required" : "internal_error"
      logger.error("memory_api_request_failed", error, { code })
      sendError(res, code, message, message === "owner token requires re-authorization" ? 403 : 500)
    }
  }

  server.listen(config.memoryApiPort, config.memoryApiHost, () => {
    logger.info("memory_api_started", {
      host: config.memoryApiHost,
      port: config.memoryApiPort,
      functions: 8,
    })
  })

  return server
}

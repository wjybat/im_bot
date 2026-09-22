import type { ContextPreparer, PrepareOfficeContextResult } from "../agent/context-preparer.js"
import { redactInternalIdentifiers } from "../infra/safety.js"
import { OFFICE_FACT_STATUSES, OFFICE_FACT_TYPES } from "../memory/index.js"
import type { OfficeMemory, SemanticMemory } from "../memory/index.js"
import type { LarkGateway, RuntimeConfig } from "../types.js"
import { getEntity, searchEntities } from "./entity-queries.js"
import { RefreshJobManager, type RefreshJob } from "./refresh-jobs.js"

export class InvalidParamsError extends Error {
  readonly code = "invalid_params"
}

export interface MemoryApiSession {
  ownerOpenId: string
  memory: OfficeMemory
  semantic: SemanticMemory
}

export interface MemoryApiDeps {
  config: RuntimeConfig
  gateway: LarkGateway
  sessionFor: (ownerOpenId: string) => MemoryApiSession
  preparerFor: (ownerOpenId: string) => ContextPreparer
}

export interface MemoryApiCallContext extends MemoryApiDeps {
  ownerOpenId: string
  session: MemoryApiSession
}

type Body = Record<string, unknown>

function stringParam(body: Body, name: string, options: { min?: number; max?: number; optional?: boolean } = {}): string | undefined {
  const value = body[name]
  if (value === undefined || value === null) {
    if (options.optional !== true) throw new InvalidParamsError(`${name} is required`)
    return undefined
  }
  if (typeof value !== "string") throw new InvalidParamsError(`${name} must be a string`)
  const trimmed = value.trim()
  const min = options.min ?? 1
  if (trimmed.length < min) throw new InvalidParamsError(`${name} must be at least ${min} characters`)
  const max = options.max ?? 2_000
  if (trimmed.length > max) throw new InvalidParamsError(`${name} must be at most ${max} characters`)
  return trimmed
}

function numberParam(body: Body, name: string, min: number, max: number, fallback: number): number {
  const value = body[name]
  if (value === undefined || value === null) return fallback
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new InvalidParamsError(`${name} must be an integer`)
  }
  if (value < min || value > max) throw new InvalidParamsError(`${name} must be between ${min} and ${max}`)
  return value
}

function isoParam(body: Body, name: string): string | undefined {
  const value = stringParam(body, name, { optional: true })
  if (value === undefined) return undefined
  if (!Number.isFinite(Date.parse(value))) throw new InvalidParamsError(`${name} must be an ISO-8601 date-time`)
  return value
}

function chatTypeParam(body: Body): "p2p" | "group" | undefined {
  const value = body.chatType
  if (value === undefined || value === null) return undefined
  if (value !== "p2p" && value !== "group") throw new InvalidParamsError("chatType must be p2p or group")
  return value
}

function enumArrayParam(
  body: Body,
  name: string,
  allowed: readonly string[],
): string[] | undefined {
  const value = body[name]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new InvalidParamsError(`${name} must be an array`)
  if (value.length === 0) return undefined
  if (value.length > allowed.length) throw new InvalidParamsError(`${name} has too many entries`)
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.includes(entry)) {
      throw new InvalidParamsError(`${name} contains an invalid value`)
    }
    seen.add(entry)
  }
  return [...seen]
}

function refArrayParam(body: Body, name: string): string[] {
  const value = body[name]
  if (value === undefined || !Array.isArray(value)) throw new InvalidParamsError(`${name} must be an array`)
  if (value.length < 1 || value.length > 20) throw new InvalidParamsError(`${name} must contain 1-20 refs`)
  for (const entry of value) {
    if (typeof entry !== "string" || !/^(?:mem|fact)_[a-f0-9]{64}$/u.test(entry)) {
      throw new InvalidParamsError(`${name} entries must be mem_/fact_ refs`)
    }
  }
  return value as string[]
}

function requireRange(body: Body): { start: string; end: string } {
  const start = isoParam(body, "start")
  const end = isoParam(body, "end")
  if (start === undefined) throw new InvalidParamsError("start is required")
  if (end === undefined) throw new InvalidParamsError("end is required")
  if (Date.parse(start) > Date.parse(end)) throw new InvalidParamsError("start must not be after end")
  return { start, end }
}

export function searchFactsHandler(ctx: MemoryApiCallContext, body: Body): Record<string, unknown> {
  const query = stringParam(body, "query", { max: 2_000, optional: true })
  const start = isoParam(body, "start")
  const end = isoParam(body, "end")
  const dueStart = isoParam(body, "dueStart")
  const dueEnd = isoParam(body, "dueEnd")
  const chatType = chatTypeParam(body)
  const factTypes = enumArrayParam(body, "factTypes", OFFICE_FACT_TYPES)
  const statuses = enumArrayParam(body, "statuses", OFFICE_FACT_STATUSES)
  const currentOnlyValue = body.currentOnly
  if (
    currentOnlyValue !== undefined &&
    currentOnlyValue !== null &&
    typeof currentOnlyValue !== "boolean"
  ) {
    throw new InvalidParamsError("currentOnly must be a boolean")
  }
  const result = ctx.session.semantic.search({
    ...(query !== undefined ? { query } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    ...(dueStart !== undefined ? { dueStart } : {}),
    ...(dueEnd !== undefined ? { dueEnd } : {}),
    ...(chatType !== undefined ? { chatType } : {}),
    ...(factTypes !== undefined ? { factTypes: factTypes as never } : {}),
    ...(statuses !== undefined ? { statuses: statuses as never } : {}),
    currentOnly: currentOnlyValue !== false,
    limit: numberParam(body, "limit", 1, 50, 20),
    tokenBudget: numberParam(body, "tokenBudget", 500, 64_000, ctx.config.memoryHybridTokenBudget),
  })
  return {
    hits: result.hits.map((hit) => ({
      ref: hit.ref,
      kind: hit.kind,
      score: hit.score,
      text: redactInternalIdentifiers(hit.text),
      factType: hit.factType ?? null,
      status: hit.status ?? null,
      dueAt: hit.dueAt ?? null,
      occurredAt: hit.occurredAt ?? null,
      entities: hit.entities ?? [],
      evidence: hit.evidence.map((item) => ({
        memoryRef: item.memoryRef,
        chat: redactInternalIdentifiers(item.chat),
        sender: redactInternalIdentifiers(item.sender),
        sentAt: item.sentAt,
        content: redactInternalIdentifiers(item.content),
      })),
    })),
    estimatedTokens: result.estimatedTokens,
    truncated: result.truncated,
  }
}

export function searchMessagesHandler(ctx: MemoryApiCallContext, body: Body): Record<string, unknown> {
  const query = stringParam(body, "query", { max: 2_000, optional: true })
  const start = isoParam(body, "start")
  const end = isoParam(body, "end")
  const chatType = chatTypeParam(body)
  const hits = ctx.session.memory.search({
    ...(query !== undefined ? { query } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    ...(chatType !== undefined ? { chatType } : {}),
    limit: numberParam(body, "limit", 1, 50, 20),
  })
  return {
    hits: hits.map((hit) => ({
      ref: hit.memoryRef,
      chatType: hit.chatType,
      chat: redactInternalIdentifiers(hit.chat),
      sender: redactInternalIdentifiers(hit.sender),
      sentAt: hit.sentAt,
      content: redactInternalIdentifiers(hit.content),
      isSelf: hit.isSelf,
    })),
  }
}

export function getEvidenceHandler(ctx: MemoryApiCallContext, body: Body): Record<string, unknown> {
  const refs = refArrayParam(body, "refs")
  const messages = ctx.session.memory.getEvidence(refs.filter((ref) => ref.startsWith("mem_")))
  const facts = ctx.session.semantic.getFactEvidence(refs.filter((ref) => ref.startsWith("fact_")))
  return {
    facts: facts.map((fact) => ({
      ref: fact.ref,
      factType: fact.factType ?? null,
      status: fact.status ?? null,
      dueAt: fact.dueAt ?? null,
      occurredAt: fact.occurredAt ?? null,
      text: redactInternalIdentifiers(fact.text),
      evidence: fact.evidence.map((item) => ({
        memoryRef: item.memoryRef,
        chat: redactInternalIdentifiers(item.chat),
        sender: redactInternalIdentifiers(item.sender),
        sentAt: item.sentAt,
        content: redactInternalIdentifiers(item.content),
      })),
    })),
    messages: messages.map((message) => ({
      ref: message.memoryRef,
      chatType: message.chatType,
      chat: redactInternalIdentifiers(message.chat),
      sender: redactInternalIdentifiers(message.sender),
      sentAt: message.sentAt,
      content: redactInternalIdentifiers(message.content),
      isSelf: message.isSelf,
    })),
  }
}

export function searchEntitiesHandler(ctx: MemoryApiCallContext, body: Body): Record<string, unknown> {
  const query = stringParam(body, "query", { max: 200 })
  if (query === undefined) throw new InvalidParamsError("query is required")
  const limit = numberParam(body, "limit", 1, 20, 10)
  const entities = searchEntities(
    ctx.session.memory.semanticDatabase(),
    ctx.session.memory.semanticOwnerKey(),
    query,
    limit,
  )
  return {
    entities: entities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      entityType: entity.entityType,
      mentionCount: entity.mentionCount,
      aliases: entity.aliases,
      firstSeenAt: entity.firstSeenAt,
      lastSeenAt: entity.lastSeenAt,
    })),
  }
}

export function getEntityHandler(ctx: MemoryApiCallContext, body: Body): Record<string, unknown> {
  const id = stringParam(body, "id", { max: 128 })
  if (id === undefined) throw new InvalidParamsError("id is required")
  const detail = getEntity(ctx.session.memory.semanticDatabase(), ctx.session.memory.semanticOwnerKey(), id)
  if (detail === null) return { entity: null }
  return {
    entity: {
      id: detail.id,
      name: detail.name,
      entityType: detail.entityType,
      mentionCount: detail.mentionCount,
      aliases: detail.aliases,
      firstSeenAt: detail.firstSeenAt,
      lastSeenAt: detail.lastSeenAt,
      relatedEntities: detail.relatedEntities,
      facts: detail.facts.map((fact) => ({
        factType: fact.factType,
        text: redactInternalIdentifiers(fact.text),
        status: fact.status,
        dueAt: fact.dueAt,
        occurredAt: fact.occurredAt,
        ownerRelevance: fact.ownerRelevance,
      })),
    },
  }
}

export function getStatusHandler(
  ctx: MemoryApiCallContext,
  jobs: RefreshJobManager,
): Record<string, unknown> {
  const status = ctx.session.memory.status()
  const pendingMessages = ctx.session.semantic.pendingMessageCount()
  const job = jobs.latestFor(ctx.ownerOpenId)
  return {
    messageMemory: {
      status: status.eligibleMessages > 0 ? "available" : "empty",
      eligibleMessages: status.eligibleMessages,
      rejectedMessages: status.rejectedMessages,
      latestMessageAt: status.latestMessageAt,
      lastCompleteWindow:
        status.fullSyncFrom !== null && status.fullSyncThrough !== null
          ? { start: status.fullSyncFrom, end: status.fullSyncThrough }
          : null,
      lastSuccessfulSyncAt: status.lastSuccessfulSyncAt,
    },
    semanticMemory: {
      status: pendingMessages === 0 ? "ready" : status.currentFacts > 0 ? "partial" : "stale",
      currentFacts: status.currentFacts,
      entities: status.entities,
      edges: status.edges,
      failedExtractions: status.failedExtractions,
      pendingExtractions: pendingMessages,
    },
    lastRefreshJob: job === null ? null : { ...job, result: job.result },
  }
}

export class RefreshCooldownError extends Error {
  readonly code = "refresh_cooldown"
  constructor(readonly retryAfterMs: number) {
    super(`refresh cooldown active; retry after ${Math.ceil(retryAfterMs / 1000)}s`)
  }
}

export async function refreshMessagesHandler(
  ctx: MemoryApiCallContext,
  body: Body,
  cooldowns: Map<string, number>,
  cooldownMs: number,
): Promise<Record<string, unknown>> {
  const { start, end } = requireRange(body)
  const query = stringParam(body, "query", { max: 2_000, optional: true })
  const chatType = chatTypeParam(body)
  const cooldownKey = [ctx.ownerOpenId, start, end].join("|")
  const until = cooldowns.get(cooldownKey)
  if (until !== undefined && until > Date.now()) {
    throw new RefreshCooldownError(until - Date.now())
  }
  cooldowns.set(cooldownKey, Date.now() + cooldownMs)

  const prepare = await ctx.preparerFor(ctx.ownerOpenId).prepare({
    start,
    end,
    ...(query !== undefined ? { query } : {}),
    ...(chatType !== undefined ? { chatType } : {}),
    freshness: "current",
    semantic: "messages",
  })
  const messages = ctx.session.memory.search({
    start,
    end,
    ...(query !== undefined ? { query } : {}),
    ...(chatType !== undefined ? { chatType } : {}),
    limit: 50,
  })
  return {
    prepare,
    messages: messages.map((message) => ({
      ref: message.memoryRef,
      chatType: message.chatType,
      chat: redactInternalIdentifiers(message.chat),
      sender: redactInternalIdentifiers(message.sender),
      sentAt: message.sentAt,
      content: redactInternalIdentifiers(message.content),
      isSelf: message.isSelf,
    })),
  }
}

export function refreshContextHandler(
  ctx: MemoryApiCallContext,
  body: Body,
  jobs: RefreshJobManager,
  cooldowns: Map<string, number>,
  cooldownMs: number,
): Record<string, unknown> {
  const { start, end } = requireRange(body)
  const query = stringParam(body, "query", { max: 2_000, optional: true }) ?? null
  const chatType = chatTypeParam(body) ?? null
  const cooldownKey = ["ctx", ctx.ownerOpenId, start, end].join("|")
  const until = cooldowns.get(cooldownKey)
  if (until !== undefined && until > Date.now()) {
    throw new RefreshCooldownError(until - Date.now())
  }
  cooldowns.set(cooldownKey, Date.now() + cooldownMs)

  const job = jobs.enqueue({ ownerOpenId: ctx.ownerOpenId, start, end, query, chatType })
  return { job }
}

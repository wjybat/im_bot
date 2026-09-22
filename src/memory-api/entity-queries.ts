import type { DatabaseSync } from "node:sqlite"
import { toSearchTokens } from "../memory/normalize.js"

type SqlRow = Record<string, unknown>

function row<T extends SqlRow>(value: unknown): T | null {
  return typeof value === "object" && value !== null ? (value as T) : null
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return value
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export interface EntitySummary {
  id: string
  name: string
  entityType: string
  mentionCount: number
  aliases: string[]
  firstSeenAt: number
  lastSeenAt: number
}

export interface EntityFact {
  factType: string
  text: string
  status: string
  dueAt: number
  occurredAt: number
  ownerRelevance: string
}

export interface EntityDetail extends EntitySummary {
  relatedEntities: Array<{ name: string; entityType: string }>
  facts: EntityFact[]
}

function parseAliases(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === "string").slice(0, 12)
    }
  } catch {
    return []
  }
  return []
}

function toEntitySummary(value: unknown): EntitySummary | null {
  const item = row<{
    id: unknown
    name: unknown
    entity_type: unknown
    aliases_json: unknown
    mention_count: unknown
    first_seen_at: unknown
    last_seen_at: unknown
  }>(value)
  if (item === null || typeof item.id !== "string") return null
  return {
    id: item.id,
    name: text(item.name),
    entityType: text(item.entity_type),
    mentionCount: numberValue(item.mention_count),
    aliases: parseAliases(text(item.aliases_json)),
    firstSeenAt: numberValue(item.first_seen_at),
    lastSeenAt: numberValue(item.last_seen_at),
  }
}

export function searchEntities(
  db: DatabaseSync,
  ownerKey: string,
  query: string,
  limit: number,
): EntitySummary[] {
  const tokens = toSearchTokens(query)
    .split(/\s+/u)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2)
    .slice(0, 6)
  if (tokens.length === 0) return []
  const conditions: string[] = []
  const parameters: string[] = [ownerKey]
  for (const token of tokens) {
    conditions.push("normalized_key LIKE ?")
    parameters.push(`%${token}%`)
  }
  for (const token of tokens) {
    conditions.push("lower(aliases_json) LIKE ?")
    parameters.push(`%${token}%`)
  }
  const rows = db
    .prepare(
      `SELECT id, name, entity_type, aliases_json, mention_count, first_seen_at, last_seen_at
       FROM memory_entities
       WHERE owner_key = ? AND (${conditions.join(" OR ")})
       ORDER BY mention_count DESC, last_seen_at DESC
       LIMIT ?`,
    )
    .all(...parameters, limit)
  return rows.flatMap((value) => {
    const summary = toEntitySummary(value)
    return summary === null ? [] : [summary]
  })
}

export function getEntity(db: DatabaseSync, ownerKey: string, id: string): EntityDetail | null {
  const entity = db
    .prepare(
      `SELECT id, name, entity_type, aliases_json, mention_count, first_seen_at, last_seen_at
       FROM memory_entities WHERE id = ? AND owner_key = ?`,
    )
    .get(id, ownerKey)
  const summary = toEntitySummary(entity)
  if (summary === null) return null

  const facts = db
    .prepare(
      `SELECT fact_type, text, status, due_at, occurred_at, owner_relevance
       FROM memory_facts
       WHERE is_current = 1 AND owner_key = ?
         AND (subject_entity_id = ? OR object_entity_id = ? OR assignee_entity_id = ?)
       ORDER BY occurred_at DESC LIMIT 100`,
    )
    .all(ownerKey, id, id, id)
    .map((value) => {
      const fact = row<SqlRow>(value) ?? {}
      return {
        factType: text(fact.fact_type),
        text: text(fact.text),
        status: text(fact.status),
        dueAt: numberValue(fact.due_at),
        occurredAt: numberValue(fact.occurred_at),
        ownerRelevance: text(fact.owner_relevance),
      }
    })

  const factFilter = "is_current = 1 AND owner_key = ?"
  const subquery = (column: string, target: string): string =>
    `SELECT ${column} FROM memory_facts WHERE ${factFilter} AND ${target} = ?`
  const related = db
    .prepare(
      `SELECT DISTINCT e.id, e.name, e.entity_type FROM memory_entities e WHERE e.id IN (
        ${[
          subquery("object_entity_id", "subject_entity_id"),
          subquery("assignee_entity_id", "subject_entity_id"),
          subquery("subject_entity_id", "object_entity_id"),
          subquery("assignee_entity_id", "object_entity_id"),
          subquery("subject_entity_id", "assignee_entity_id"),
          subquery("object_entity_id", "assignee_entity_id"),
        ].join(" UNION ")}
      ) LIMIT 100`,
    )
    .all(
      ownerKey, id,
      ownerKey, id,
      ownerKey, id,
      ownerKey, id,
      ownerKey, id,
      ownerKey, id,
    )
    .map((value) => {
      const relatedRow = row<SqlRow>(value) ?? {}
      return { name: text(relatedRow.name), entityType: text(relatedRow.entity_type) }
    })

  return { ...summary, relatedEntities: related, facts }
}

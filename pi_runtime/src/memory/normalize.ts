import { createHash } from "node:crypto"
import type {
  LarkPayloadInspection,
  NormalizedOfficeMessage,
  OfficeMemoryOrigin,
} from "./types.js"

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {}
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  return null
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function unwrapPayload(value: unknown): unknown {
  const outer = record(value)
  if (outer.ok === true && outer.data !== undefined) return outer.data
  return value
}

function candidateItems(value: unknown): unknown[] {
  const payload = unwrapPayload(value)
  if (Array.isArray(payload)) return payload
  const outer = record(payload)
  for (const key of ["messages", "items", "results", "message_list", "messageList"]) {
    if (Array.isArray(outer[key])) return outer[key] as unknown[]
  }
  const data = record(outer.data)
  for (const key of ["messages", "items", "results", "message_list", "messageList"]) {
    if (Array.isArray(data[key])) return data[key] as unknown[]
  }
  return []
}

function collectMessageIds(value: unknown): string[] {
  const ids = new Set<string>()
  const visit = (current: unknown, depth: number): void => {
    if (depth > 5) return
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1)
      return
    }
    const row = record(current)
    for (const key of ["message_id", "messageId"]) {
      const id = row[key]
      if (typeof id === "string" && id.trim() !== "") ids.add(id.trim())
    }
    for (const key of ["message_ids", "messageIds"]) {
      const values = row[key]
      if (Array.isArray(values)) {
        for (const id of values) if (typeof id === "string" && id.trim() !== "") ids.add(id.trim())
      }
    }
    for (const key of ["data", "messages", "items", "results", "message_list", "messageList"]) {
      if (row[key] !== undefined) visit(row[key], depth + 1)
    }
  }
  visit(value, 0)
  return [...ids]
}

function epochMs(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value)
  }
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 10_000_000_000 ? Math.trunc(numeric * 1000) : Math.trunc(numeric)
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function optionalEpochMs(value: unknown): number | null {
  const parsed = epochMs(value, 0)
  return parsed > 0 ? parsed : null
}

function collectVisibleText(value: unknown, output: string[], depth = 0): void {
  if (depth > 12 || value === null || value === undefined) return
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed === "") return
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        collectVisibleText(JSON.parse(trimmed) as unknown, output, depth + 1)
        return
      } catch {
        // Plain text that happens to start with a bracket remains visible text.
      }
    }
    output.push(trimmed)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectVisibleText(item, output, depth + 1)
    return
  }
  const row = record(value)
  const directKeys = ["title", "text", "user_name", "display_name", "file_name"]
  for (const key of directKeys) {
    const direct = row[key]
    if (typeof direct === "string" && direct.trim() !== "") output.push(direct.trim())
  }
  for (const key of ["content", "body", "elements", "children", "paragraphs", "post"]) {
    if (row[key] !== undefined) collectVisibleText(row[key], output, depth + 1)
  }
}

function renderContent(value: unknown): string {
  const pieces: string[] = []
  collectVisibleText(value, pieces)
  const deduped: string[] = []
  for (const piece of pieces) {
    if (deduped.at(-1) !== piece) deduped.push(piece)
  }
  return deduped.join("\n").trim()
}

function conversationType(value: string | null): "p2p" | "group" | "unknown" {
  const normalized = value?.toLowerCase()
  if (normalized === "p2p" || normalized === "direct") return "p2p"
  if (normalized === "group" || normalized === "topic_group") return "group"
  return "unknown"
}

function originOf(item: JsonRecord, sender: JsonRecord): OfficeMemoryOrigin {
  const raw = firstString(
    item.origin,
    item.sender_type,
    item.senderType,
    sender.sender_type,
    sender.senderType,
    sender.type,
  )?.toLowerCase()
  if (raw === "agent" || raw === "assistant") return "agent"
  if (raw === "bot" || raw === "app" || raw === "application") return "bot"
  if (raw === "system") return "system"
  return "human"
}

function mentionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  for (const mention of value) {
    const row = record(mention)
    const id = firstString(row.open_id, row.openId, row.id, record(row.id).open_id)
    if (id !== null) ids.add(id)
  }
  return [...ids]
}

export interface NormalizeLarkOptions {
  ownerExternalId: string
  fetchedAt?: number
  fallbackConversationExternalId?: string
}

export function inspectLarkMessagePayload(
  payload: unknown,
  options: NormalizeLarkOptions,
): LarkPayloadInspection {
  const fetchedAt = options.fetchedAt ?? Date.now()
  const messages: NormalizedOfficeMessage[] = []
  for (const raw of candidateItems(payload)) {
    const item = record(raw)
    const externalId = firstString(item.message_id, item.messageId, item.id)
    if (externalId === null) continue
    const chat = record(item.chat)
    const conversationExternalId = firstString(
      item.chat_id,
      item.chatId,
      chat.chat_id,
      chat.id,
      options.fallbackConversationExternalId,
    )
    if (conversationExternalId === null) continue
    const sender = record(item.sender)
    const origin = originOf(item, sender)
    // Bot message `sender.id` is normally the application id (`cli_...`), while
    // `open_id` may be an optional open-bot id. The authenticated app identity is
    // keyed by app id, so keep that as the primary bot identifier.
    const senderExternalId = origin === "bot" || origin === "agent"
      ? firstString(sender.id, item.sender_id, sender.open_id, sender.openId)
      : firstString(sender.open_id, sender.openId, sender.id, item.sender_id)
    const isSelf = senderExternalId === null ? null : senderExternalId === options.ownerExternalId
    const contentValue = item.content ?? item.body ?? item.message
    const contentText = renderContent(contentValue)
    const rawChatType = firstString(item.chat_type, item.chatType, chat.chat_type, chat.type)
    const sentAt = epochMs(item.create_time_iso ?? item.create_time ?? item.createTime, fetchedAt)
    const normalized = {
      externalId,
      conversationExternalId,
      conversationType: conversationType(rawChatType),
      conversationTitle: firstString(item.chat_name, item.chatName, chat.name, record(item.chat_partner).name),
      senderExternalId,
      senderDisplayName: firstString(sender.name, sender.display_name, item.sender_name),
      messageType: firstString(item.message_type, item.messageType, item.msg_type),
      contentText,
      contentJson: JSON.stringify(contentValue ?? null),
      sentAt,
      updatedAt: optionalEpochMs(item.update_time_iso ?? item.update_time ?? item.updateTime),
      parentExternalId: firstString(item.parent_id, item.parentId),
      rootExternalId: firstString(item.root_id, item.rootId),
      threadExternalId: firstString(item.thread_id, item.threadId),
      mentions: mentionIds(item.mentions),
      direction: isSelf === true ? "outbound" as const : isSelf === false ? "inbound" as const : "unknown" as const,
      isSelf,
      origin,
    }
    messages.push({
      ...normalized,
      digest: stableHash(JSON.stringify(normalized)),
    })
  }
  return { messages, messageIds: collectMessageIds(payload) }
}

export function memoryLocalId(ownerKey: string, kind: string, externalId: string): string {
  return stableHash(`${ownerKey}\u0000feishu\u0000${kind}\u0000${externalId}`)
}

export function sha256Text(value: string): string {
  return stableHash(value)
}

export function toSearchTokens(value: string): string {
  const normalized = value.normalize("NFKC").toLowerCase()
  const tokens: string[] = []
  const seen = new Set<string>()
  const add = (token: string): void => {
    const trimmed = token.trim()
    if (trimmed === "" || seen.has(trimmed)) return
    seen.add(trimmed)
    tokens.push(trimmed)
  }
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9._-]*|[\p{Script=Han}]+/gu)) {
    const token = match[0]
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      const chars = [...token]
      if (chars.length === 1) add(chars[0] ?? "")
      for (let index = 0; index < chars.length - 1; index += 1) {
        add(`${chars[index] ?? ""}${chars[index + 1] ?? ""}`)
      }
    } else {
      add(token)
    }
  }
  return tokens.join(" ")
}

export function toFtsMatch(value: string): string | null {
  const tokens = toSearchTokens(value).split(/\s+/u).filter(Boolean)
  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ")
}

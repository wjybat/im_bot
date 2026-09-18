import { sha256Text } from "./normalize.js"
import type { SemanticEvidenceItem } from "./semantic-types.js"

export interface SemanticSourceMessage extends SemanticEvidenceItem {
  conversationId: string
  sourceSeq: number
  pending: boolean
}

export interface SemanticChunkPlan {
  conversationId: string
  sessionKey: string
  content: string
  contentHash: string
  startAt: number
  endAt: number
  sourceSeq: number
  evidence: SemanticEvidenceItem[]
}

export interface SessionizerOptions {
  idleGapMs: number
  maxChunkTokens: number
  maxPrimaryMessages: number
  contextMessages: number
}

function estimateTokens(text: string): number {
  if (text === "") return 0
  const cjk = [...text.matchAll(/[\p{Script=Han}]/gu)].length
  const other = Math.max(0, text.length - cjk)
  return Math.ceil(cjk / 1.5 + other / 4)
}

function shanghaiTime(timestamp: number): string {
  return `${new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ")} +08:00`
}

function renderEvidence(item: SemanticEvidenceItem): string {
  const role = item.primary ? "primary" : "context"
  const self = item.isSelf === true ? "我" : item.sender
  const mentioned = item.mentionsSelf ? " @我" : ""
  return `[E${item.ordinal}|${role}] ${shanghaiTime(item.sentAt)} ${self}${mentioned}：${item.content}`
}

function buildEvidence(
  all: readonly SemanticSourceMessage[],
  primary: readonly SemanticSourceMessage[],
  options: SessionizerOptions,
): SemanticEvidenceItem[] {
  const first = primary[0]
  if (first === undefined) return []
  let context = all
    .filter(
      (item) =>
        item.sentAt < first.sentAt &&
        first.sentAt - item.sentAt <= options.idleGapMs &&
        !primary.some((candidate) => candidate.messageId === item.messageId && candidate.revision === item.revision),
    )
    .slice(-options.contextMessages)
  const primaryKeys = new Set(primary.map((item) => `${item.messageId}:${item.revision}`))
  const assemble = (): SemanticEvidenceItem[] =>
    [...context, ...primary]
      .sort((a, b) => a.sentAt - b.sentAt || a.messageId.localeCompare(b.messageId))
      .map((item, index) => ({
        ordinal: index + 1,
        messageId: item.messageId,
        revision: item.revision,
        primary: primaryKeys.has(`${item.messageId}:${item.revision}`),
        sentAt: item.sentAt,
        sender: item.sender,
        isSelf: item.isSelf,
        mentionsSelf: item.mentionsSelf,
        conversationType: item.conversationType,
        conversationTitle: item.conversationTitle,
        content: item.content,
      }))
  let evidence = assemble()
  while (context.length > 0 && estimateTokens(evidence.map(renderEvidence).join("\n")) > options.maxChunkTokens) {
    context = context.slice(1)
    evidence = assemble()
  }
  return evidence
}

export function buildSemanticChunkPlans(
  messages: readonly SemanticSourceMessage[],
  options: SessionizerOptions,
): SemanticChunkPlan[] {
  const byConversation = new Map<string, SemanticSourceMessage[]>()
  for (const message of messages) {
    const current = byConversation.get(message.conversationId) ?? []
    current.push(message)
    byConversation.set(message.conversationId, current)
  }

  const plans: SemanticChunkPlan[] = []
  for (const [conversationId, unsorted] of byConversation) {
    const all = [...unsorted].sort((a, b) => a.sentAt - b.sentAt || a.messageId.localeCompare(b.messageId))
    const pending = all.filter((item) => item.pending)
    let group: SemanticSourceMessage[] = []
    let tokens = 0
    const flush = (): void => {
      if (group.length === 0) return
      const evidence = buildEvidence(all, group, options)
      const content = evidence.map(renderEvidence).join("\n\n")
      const first = group[0]
      const last = group.at(-1)
      if (first === undefined || last === undefined) return
      const signature = evidence
        .map((item) => `${item.messageId}:${item.revision}:${item.primary ? "p" : "c"}`)
        .join("|")
      plans.push({
        conversationId,
        sessionKey: `${conversationId}:${first.messageId}:${first.revision}`,
        content,
        contentHash: sha256Text(`${signature}\n${content}`),
        startAt: first.sentAt,
        endAt: last.sentAt,
        sourceSeq: Math.max(...group.map((item) => item.sourceSeq)),
        evidence,
      })
      group = []
      tokens = 0
    }

    for (const message of pending) {
      const cost = estimateTokens(message.content) + 24
      const previous = group.at(-1)
      const startsNew =
        previous !== undefined &&
        (message.sentAt - previous.sentAt > options.idleGapMs ||
          group.length >= options.maxPrimaryMessages ||
          tokens + cost > options.maxChunkTokens)
      if (startsNew) flush()
      group.push(message)
      tokens += cost
    }
    flush()
  }
  return plans.sort((a, b) => a.startAt - b.startAt || a.conversationId.localeCompare(b.conversationId))
}

export { estimateTokens as estimateMemoryTokens }

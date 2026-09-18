import type { RuntimeUsage } from "../types.js"

export const OFFICE_FACT_TYPES = [
  "ACTION_ITEM",
  "REQUEST",
  "DELEGATION",
  "COMMITMENT",
  "DECISION",
  "STATUS",
  "DEADLINE",
  "RISK",
] as const

export type OfficeFactType = (typeof OFFICE_FACT_TYPES)[number]

export const OFFICE_FACT_STATUSES = [
  "open",
  "done",
  "cancelled",
  "active",
  "resolved",
  "uncertain",
  "superseded",
] as const

export type OfficeFactStatus = (typeof OFFICE_FACT_STATUSES)[number]

export const OFFICE_ENTITY_TYPES = [
  "Person",
  "Project",
  "System",
  "Organization",
  "Document",
  "Event",
  "Unknown",
] as const

export type OfficeEntityType = (typeof OFFICE_ENTITY_TYPES)[number]

export interface SemanticEvidenceItem {
  ordinal: number
  messageId: string
  revision: number
  primary: boolean
  sentAt: number
  sender: string
  isSelf: boolean | null
  mentionsSelf: boolean
  conversationType: "p2p" | "group" | "unknown"
  conversationTitle: string
  content: string
}

export interface SemanticChunk {
  id: string
  conversationId: string
  sessionKey: string
  content: string
  contentHash: string
  startAt: number
  endAt: number
  sourceSeq: number
  strategyVersion: string
  evidence: SemanticEvidenceItem[]
}

export interface ExtractedEntity {
  name: string
  type: OfficeEntityType
  aliases: string[]
}

export interface ExtractedFact {
  type: OfficeFactType
  key: string
  text: string
  status: OfficeFactStatus
  subject: string | null
  object: string | null
  assignee: string | null
  dueAt: string | null
  occurredAt: string | null
  confidence: number
  evidenceOrdinals: number[]
}

export interface FactExtractionData {
  entities: ExtractedEntity[]
  facts: ExtractedFact[]
}

export interface FactExtractionResult {
  data: FactExtractionData
  model: string
  promptVersion: string
  usage: RuntimeUsage
  rawOutput: string
}

export interface FactExtractor {
  extract(chunk: SemanticChunk, signal?: AbortSignal): Promise<FactExtractionResult>
}

export interface SemanticEnrichmentResult {
  queuedChunks: number
  completedChunks: number
  failedChunks: number
  factsCreated: number
  factsMerged: number
  factsSuperseded: number
  factsRejected: number
  entitiesUpserted: number
  usage: RuntimeUsage
  failures: string[]
}

export interface PersistExtractionResult {
  factsCreated: number
  factsMerged: number
  factsSuperseded: number
  factsRejected: number
  entitiesUpserted: number
}

export interface HybridSearchInput {
  query?: string
  start?: string
  end?: string
  dueStart?: string
  dueEnd?: string
  chatType?: "p2p" | "group"
  factTypes?: OfficeFactType[]
  statuses?: OfficeFactStatus[]
  currentOnly?: boolean
  limit?: number
  tokenBudget?: number
}

export interface HybridSearchEvidence {
  memoryRef: string
  chat: string
  sender: string
  sentAt: string
  content: string
}

export interface HybridSearchHit {
  ref: string
  kind: "fact" | "message"
  score: number
  routes: Array<{ source: string; rank: number }>
  text: string
  factType?: OfficeFactType
  status?: OfficeFactStatus
  dueAt?: string | null
  occurredAt?: string | null
  entities?: string[]
  evidence: HybridSearchEvidence[]
}

export interface HybridSearchResult {
  query: string
  hits: HybridSearchHit[]
  contextText: string
  estimatedTokens: number
  truncated: boolean
  debug: {
    routes: Array<{ source: string; count: number }>
    fusedCount: number
    packedCount: number
  }
}

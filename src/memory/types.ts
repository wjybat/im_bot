export type OfficeMemoryOrigin = "human" | "agent" | "bot" | "system"

export type OfficeMemoryRejectionReason =
  | "assistant_control"
  | "self_generated"
  | "bot_channel"
  | "empty_content"
  | "learning_disabled"

export interface NormalizedOfficeMessage {
  externalId: string
  conversationExternalId: string
  conversationType: "p2p" | "group" | "unknown"
  conversationTitle: string | null
  senderExternalId: string | null
  senderDisplayName: string | null
  messageType: string | null
  contentText: string
  contentJson: string
  sentAt: number
  updatedAt: number | null
  parentExternalId: string | null
  rootExternalId: string | null
  threadExternalId: string | null
  mentions: string[]
  direction: "inbound" | "outbound" | "unknown"
  isSelf: boolean | null
  origin: OfficeMemoryOrigin
  digest: string
}

export interface LarkPayloadInspection {
  messages: NormalizedOfficeMessage[]
  messageIds: string[]
}

export interface MemoryIngestContext {
  source: "lark-cli" | "lark-sync" | "test"
  resource: "chat.message"
  fallbackConversationExternalId?: string
}

export interface MemoryIngestResult {
  rawInserted: boolean
  created: number
  updated: number
  unchanged: number
  eligible: number
  rejected: Partial<Record<OfficeMemoryRejectionReason, number>>
  indexed: number
  discoveredMessageIds: string[]
}

export interface MemorySearchInput {
  query?: string
  start?: string
  end?: string
  chatType?: "p2p" | "group"
  limit?: number
}

export interface MemorySearchHit {
  memoryRef: string
  source: "feishu"
  chatType: "p2p" | "group" | "unknown"
  chat: string
  sender: string
  sentAt: string
  content: string
  isSelf: boolean | null
  revision: number
  relevance: number | null
}

export interface MemoryEvidence {
  memoryRef: string
  source: "feishu"
  chatType: "p2p" | "group" | "unknown"
  chat: string
  sender: string
  sentAt: string
  content: string
  isSelf: boolean | null
  revision: number
}

export interface MemoryStatus {
  schemaVersion: number
  rawRecords: number
  conversations: number
  assistantControlConversations: number
  messages: number
  eligibleMessages: number
  rejectedMessages: number
  chunks: number
  pendingChunks: number
  facts: number
  currentFacts: number
  entities: number
  edges: number
  factExtractionTokens: number
  factExtractionCostUsd: number
  failedExtractions: number
  latestMessageAt: string | null
  fullSyncFrom: string | null
  fullSyncThrough: string | null
  lastSuccessfulSyncAt: string | null
  changelogHead: number
  ftsAckedSeq: number
  ftsLag: number
  semanticMessageHead: number
  semanticAckedSeq: number
  semanticLag: number
}

export interface MemoryCoverage {
  complete: boolean
  coveredThrough: string | null
  missingRanges: Array<{ start: string; end: string }>
}

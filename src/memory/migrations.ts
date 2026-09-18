import type { DatabaseSync } from "node:sqlite"

export const OFFICE_MEMORY_SCHEMA_VERSION = 3

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS memory_raw_records (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  platform TEXT NOT NULL,
  source TEXT NOT NULL,
  resource TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  UNIQUE(owner_key, platform, source, resource, payload_hash)
);
CREATE INDEX IF NOT EXISTS idx_memory_raw_fetched
  ON memory_raw_records(owner_key, fetched_at DESC);

CREATE TABLE IF NOT EXISTS memory_conversations (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'unknown',
  title TEXT,
  is_assistant_control INTEGER NOT NULL DEFAULT 0,
  is_bot_channel INTEGER NOT NULL DEFAULT 0,
  learning_enabled INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_key, platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_conversations_owner
  ON memory_conversations(owner_key, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS memory_messages (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES memory_conversations(id) ON DELETE CASCADE,
  sender_external_id TEXT,
  sender_display_name TEXT,
  message_type TEXT,
  content_text TEXT NOT NULL,
  content_json TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  updated_at INTEGER,
  parent_external_id TEXT,
  root_external_id TEXT,
  thread_external_id TEXT,
  direction TEXT NOT NULL,
  is_self INTEGER,
  origin TEXT NOT NULL,
  learning_eligible INTEGER NOT NULL,
  rejection_reason TEXT,
  raw_record_id TEXT NOT NULL REFERENCES memory_raw_records(id),
  source_digest TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_local_at INTEGER NOT NULL,
  UNIQUE(owner_key, platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_messages_owner_time
  ON memory_messages(owner_key, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_messages_conversation_time
  ON memory_messages(conversation_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_messages_eligible_time
  ON memory_messages(owner_key, learning_eligible, sent_at DESC);

CREATE TABLE IF NOT EXISTS memory_message_mentions (
  message_id TEXT NOT NULL REFERENCES memory_messages(id) ON DELETE CASCADE,
  actor_external_id TEXT NOT NULL,
  is_self INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(message_id, actor_external_id)
);

CREATE TABLE IF NOT EXISTS memory_knowledge_changelog (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  emitted_at INTEGER NOT NULL,
  payload_ref TEXT,
  digest TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_changelog_owner_seq
  ON memory_knowledge_changelog(owner_key, seq);

CREATE TABLE IF NOT EXISTS memory_consumer_cursors (
  consumer_id TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  acked_seq INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_success_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(consumer_id, owner_key)
);

CREATE TABLE IF NOT EXISTS memory_sync_runs (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  source TEXT NOT NULL,
  range_start INTEGER,
  range_end INTEGER,
  query TEXT,
  status TEXT NOT NULL,
  raw_records INTEGER NOT NULL DEFAULT 0,
  messages_created INTEGER NOT NULL DEFAULT 0,
  messages_updated INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_sync_runs_owner
  ON memory_sync_runs(owner_key, completed_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_messages_fts USING fts5(
  message_id UNINDEXED,
  owner_key UNINDEXED,
  conversation_id UNINDEXED,
  content_tokens,
  sender_tokens,
  conversation_tokens,
  tokenize='unicode61 remove_diacritics 2'
);
`

const MIGRATION_2 = `
ALTER TABLE memory_sync_runs ADD COLUMN chat_type TEXT;
ALTER TABLE memory_sync_runs ADD COLUMN coverage_complete INTEGER NOT NULL DEFAULT 0;
`

const MIGRATION_3 = `
CREATE TABLE memory_chunks (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES memory_conversations(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  source_seq INTEGER NOT NULL DEFAULT 0,
  strategy_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  extraction_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(owner_key, content_hash, strategy_version)
);
CREATE INDEX idx_memory_chunks_status
  ON memory_chunks(owner_key, status, start_at);
CREATE INDEX idx_memory_chunks_session
  ON memory_chunks(owner_key, conversation_id, session_key, end_at DESC);

CREATE TABLE memory_chunk_messages (
  chunk_id TEXT NOT NULL REFERENCES memory_chunks(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES memory_messages(id) ON DELETE CASCADE,
  message_revision INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY(chunk_id, message_id, message_revision)
);
CREATE INDEX idx_memory_chunk_messages_message
  ON memory_chunk_messages(message_id, message_revision, role);

CREATE TABLE memory_entities (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  mention_count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_key, entity_type, normalized_key)
);
CREATE INDEX idx_memory_entities_name
  ON memory_entities(owner_key, normalized_key, entity_type);

CREATE TABLE memory_facts (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  topic_key TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  subject_entity_id TEXT REFERENCES memory_entities(id),
  object_entity_id TEXT REFERENCES memory_entities(id),
  assignee_entity_id TEXT REFERENCES memory_entities(id),
  due_at INTEGER,
  occurred_at INTEGER NOT NULL,
  confidence REAL NOT NULL,
  owner_relevance TEXT NOT NULL DEFAULT 'contextual',
  source_chunk_id TEXT NOT NULL REFERENCES memory_chunks(id),
  extraction_model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1,
  supersedes_fact_id TEXT REFERENCES memory_facts(id),
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_facts_current_time
  ON memory_facts(owner_key, is_current, occurred_at DESC);
CREATE INDEX idx_memory_facts_type_status
  ON memory_facts(owner_key, fact_type, status, is_current);
CREATE INDEX idx_memory_facts_topic
  ON memory_facts(owner_key, fact_type, topic_key, occurred_at DESC);
CREATE INDEX idx_memory_facts_due
  ON memory_facts(owner_key, due_at, status) WHERE is_current = 1;

CREATE TABLE memory_fact_evidence (
  fact_id TEXT NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES memory_messages(id) ON DELETE CASCADE,
  message_revision INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(fact_id, message_id, message_revision)
);
CREATE INDEX idx_memory_fact_evidence_message
  ON memory_fact_evidence(message_id, message_revision, fact_id);

CREATE TABLE memory_edges (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source_fact_id TEXT NOT NULL DEFAULT '',
  properties_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_key, source_type, source_id, target_type, target_id, edge_type, source_fact_id)
);
CREATE INDEX idx_memory_edges_source
  ON memory_edges(owner_key, source_type, source_id, edge_type);
CREATE INDEX idx_memory_edges_target
  ON memory_edges(owner_key, target_type, target_id, edge_type);

CREATE TABLE memory_extraction_runs (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  chunk_id TEXT NOT NULL REFERENCES memory_chunks(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  raw_output TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_extraction_runs_chunk
  ON memory_extraction_runs(owner_key, chunk_id, completed_at DESC);

CREATE VIRTUAL TABLE memory_facts_fts USING fts5(
  fact_id UNINDEXED,
  owner_key UNINDEXED,
  text_tokens,
  key_tokens,
  entity_tokens,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE memory_retrieval_runs (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  query TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  route_debug_json TEXT NOT NULL,
  selected_refs_json TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_retrieval_runs_owner
  ON memory_retrieval_runs(owner_key, created_at DESC);
`

export function migrateOfficeMemory(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE")
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`)
    const applied = new Set(
      db.prepare("SELECT version FROM memory_schema_migrations").all().map((value) => {
        const record = value as Record<string, unknown>
        return Number(record.version)
      }),
    )
    if (!applied.has(1)) {
      db.exec(MIGRATION_1)
      db.prepare("INSERT INTO memory_schema_migrations(version, applied_at) VALUES (1, ?)").run(Date.now())
    }
    if (!applied.has(2)) {
      db.exec(MIGRATION_2)
      db.prepare("INSERT INTO memory_schema_migrations(version, applied_at) VALUES (2, ?)").run(Date.now())
    }
    if (!applied.has(3)) {
      db.exec(MIGRATION_3)
      db.prepare("INSERT INTO memory_schema_migrations(version, applied_at) VALUES (3, ?)").run(Date.now())
    }
    db.exec(`PRAGMA user_version = ${OFFICE_MEMORY_SCHEMA_VERSION}`)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

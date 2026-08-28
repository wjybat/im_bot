import type { DatabaseSync } from "node:sqlite"

export const OFFICE_MEMORY_SCHEMA_VERSION = 2

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
    db.exec(`PRAGMA user_version = ${OFFICE_MEMORY_SCHEMA_VERSION}`)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

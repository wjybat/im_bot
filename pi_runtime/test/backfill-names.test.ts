import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OfficeMemory } from "../src/memory/index.js"

function larkPayload(messageId: string, chatId: string, senderId: string, text: string): unknown {
  return {
    has_more: false,
    messages: [
      {
        message_id: messageId,
        root_id: null,
        parent_id: null,
        thread_id: null,
        chat_id: chatId,
        chat_type: "group",
        chat_name: null,
        create_time: "2026-09-15T10:00:00Z",
        update_time: null,
        sender: { open_id: senderId, name: null, type: null },
        message_type: "text",
        content: { text },
      },
    ],
  }
}

test("backfillDisplayNames fills chat titles and sender names and refreshes search", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "backfill-"))
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })
  const memory = new OfficeMemory({
    path: join(stateDir, "mem.db"),
    ownerExternalId: "ou_owner",
  })
  t.after(() => memory.close())

  memory.ingestLarkPayload(larkPayload("om_1", "oc_group", "ou_alice", "项目评审改到周三"), {
    source: "test",
    resource: "chat.message",
  })
  const before = memory.search({ query: "项目评审" })
  assert.equal(before.length, 1)
  assert.equal(before[0]?.chat, "未命名群聊")
  assert.equal(before[0]?.sender, "未知发送人")

  const result = memory.backfillDisplayNames({
    chatTitles: new Map([["oc_group", "ARI中心-原子智能部"]]),
    senderNames: new Map([["ou_alice", "张三"]]),
  })
  assert.equal(result.conversations, 1)
  assert.equal(result.messages, 1)

  const after = memory.search({ query: "项目评审" })
  assert.equal(after.length, 1)
  assert.equal(after[0]?.chat, "ARI中心-原子智能部")
  assert.equal(after[0]?.sender, "张三")

  // FTS sender/conversation tokens now match the backfilled names.
  const bySender = memory.search({ query: "张三" })
  assert.equal(bySender.length, 1)
  const byChat = memory.search({ query: "原子智能部" })
  assert.equal(byChat.length, 1)

  // Idempotent: nothing left to backfill.
  const second = memory.backfillDisplayNames({
    chatTitles: new Map([["oc_group", "ARI中心-原子智能部"]]),
    senderNames: new Map([["ou_alice", "张三"]]),
  })
  assert.equal(second.conversations, 0)
  assert.equal(second.messages, 0)
})

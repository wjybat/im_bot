import assert from "node:assert/strict"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { evaluateOfficeMemoryEligibility, OfficeMemory } from "../src/memory/index.js"

function fixture(normalContent = "请确认一下选品方案"): unknown {
  return {
    messages: [
      {
        message_id: "om_normal",
        chat_id: "oc_project",
        chat_type: "group",
        chat_name: "选品项目群",
        create_time: "2026-08-28T09:00:00+08:00",
        sender: { open_id: "ou_colleague", name: "林同事", sender_type: "user" },
        content: JSON.stringify({ text: normalContent }),
      },
      {
        message_id: "om_control_user",
        chat_id: "oc_assistant",
        chat_type: "p2p",
        chat_name: "办公助手",
        create_time: "2026-08-28T09:10:00+08:00",
        sender: { open_id: "ou_owner", name: "我", sender_type: "user" },
        content: "帮我生成每日简报",
      },
      {
        message_id: "om_control_agent",
        chat_id: "oc_assistant",
        chat_type: "p2p",
        chat_name: "办公助手",
        create_time: "2026-08-28T09:11:00+08:00",
        sender: { open_id: "ou_bot", name: "办公助手", sender_type: "app" },
        origin: "agent",
        content: "这是根据聊天生成的每日简报",
      },
      {
        message_id: "om_empty",
        chat_id: "oc_misc",
        chat_type: "group",
        chat_name: "杂项群",
        create_time: "2026-08-28T09:20:00+08:00",
        sender: { open_id: "ou_colleague", name: "林同事", sender_type: "user" },
        content: "   ",
      },
      {
        message_id: "om_agent_elsewhere",
        chat_id: "oc_misc",
        chat_type: "group",
        chat_name: "杂项群",
        create_time: "2026-08-28T09:21:00+08:00",
        sender: { open_id: "ou_bot", name: "自动助手", sender_type: "app" },
        origin: "agent",
        content: "模型自己生成的结论",
      },
    ],
  }
}

test("office memory persists evidence, indexes eligible messages, and rejects assistant feedback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-office-memory-"))
  const path = join(directory, "memory.db")
  const memory = new OfficeMemory({ path, ownerExternalId: "ou_owner" })
  try {
    memory.markAssistantControlConversation("oc_assistant")
    const first = memory.ingestLarkPayload(fixture(), {
      source: "test",
      resource: "chat.message",
    })
    assert.equal(first.rawInserted, true)
    assert.equal(first.created, 5)
    assert.equal(first.eligible, 1)
    assert.deepEqual(first.rejected, {
      assistant_control: 2,
      empty_content: 1,
      self_generated: 1,
    })

    const status = memory.status()
    assert.equal(status.rawRecords, 1)
    assert.equal(status.conversations, 3)
    assert.equal(status.assistantControlConversations, 1)
    assert.equal(status.messages, 5)
    assert.equal(status.eligibleMessages, 1)
    assert.equal(status.rejectedMessages, 4)
    assert.equal(status.ftsLag, 0)
    assert.equal(status.fullSyncFrom, null)
    assert.equal((await stat(path)).mode & 0o777, 0o600)

    memory.recordSyncRun({
      source: "lark-sync",
      start: "2026-08-28T00:00:00+08:00",
      end: "2026-08-28T10:00:00+08:00",
      query: "",
      coverageComplete: true,
      status: "success",
      startedAt: Date.now() - 100,
      rawRecords: 1,
      messagesCreated: 5,
      messagesUpdated: 0,
    })
    const covered = memory.status()
    assert.equal(covered.fullSyncFrom, "2026-08-28T00:00:00+08:00")
    assert.equal(covered.fullSyncThrough, "2026-08-28T10:00:00+08:00")

    const hits = memory.search({ query: "选品方案" })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.chat, "选品项目群")
    assert.equal(hits[0]?.sender, "林同事")
    assert.match(hits[0]?.memoryRef ?? "", /^mem_[a-f0-9]{64}$/u)
    assert.equal(memory.search({ query: "每日简报" }).length, 0)
    assert.equal(memory.search({ query: "模型自己生成" }).length, 0)

    const evidence = memory.getEvidence([hits[0]?.memoryRef ?? ""])
    assert.equal(evidence.length, 1)
    assert.equal(evidence[0]?.content, "请确认一下选品方案")

    const head = status.changelogHead
    const repeated = memory.ingestLarkPayload(fixture(), {
      source: "test",
      resource: "chat.message",
    })
    assert.equal(repeated.rawInserted, false)
    assert.equal(repeated.created, 0)
    assert.equal(repeated.updated, 0)
    assert.equal(repeated.unchanged, 5)
    assert.equal(memory.status().changelogHead, head)

    const edited = memory.ingestLarkPayload(fixture("已完成模型评审"), {
      source: "test",
      resource: "chat.message",
    })
    assert.equal(edited.updated, 1)
    assert.equal(memory.search({ query: "请确认" }).length, 0)
    const revised = memory.search({ query: "完成模型评审" })
    assert.equal(revised.length, 1)
    assert.equal(revised[0]?.revision, 2)

    assert.equal(memory.markAssistantControlConversation("oc_project"), 1)
    assert.equal(memory.search({ query: "完成模型评审" }).length, 0)
    assert.equal(memory.status().eligibleMessages, 0)
  } finally {
    memory.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("eligibility guard is deterministic and prompt-independent", () => {
  const base = {
    contentText: "有内容",
    origin: "human" as const,
    assistantControl: false,
    botChannel: false,
    learningEnabled: true,
  }
  assert.deepEqual(evaluateOfficeMemoryEligibility(base), { eligible: true, reason: null })
  assert.deepEqual(evaluateOfficeMemoryEligibility({ ...base, assistantControl: true }), {
    eligible: false,
    reason: "assistant_control",
  })
  assert.deepEqual(evaluateOfficeMemoryEligibility({ ...base, origin: "agent" }), {
    eligible: false,
    reason: "self_generated",
  })
  assert.deepEqual(evaluateOfficeMemoryEligibility({ ...base, contentText: "\n\t " }), {
    eligible: false,
    reason: "empty_content",
  })
})

test("the authenticated bot app id can backfill the assistant-control chat", () => {
  const memory = new OfficeMemory({
    path: ":memory:",
    ownerExternalId: "ou_owner",
    assistantBotExternalId: "cli_office_bot",
    assistantBotName: "名称并不相同",
  })
  try {
    memory.ingestLarkPayload(
      {
        messages: [
          {
            message_id: "om_bot_reply",
            chat_id: "oc_control",
            chat_type: "p2p",
            chat_name: "办公助手",
            create_time: "2026-08-28T10:00:00+08:00",
            sender: { id: "cli_office_bot", open_id: "ou_bot", name: "办公助手", type: "app" },
            content: "昨日简报内容",
          },
          {
            message_id: "om_owner_prompt",
            chat_id: "oc_control",
            chat_type: "p2p",
            chat_name: "办公助手",
            create_time: "2026-08-28T09:59:00+08:00",
            sender: { open_id: "ou_owner", name: "我", type: "user" },
            content: "整理一下待办",
          },
          {
            message_id: "om_work",
            chat_id: "oc_work",
            chat_type: "group",
            chat_name: "工作群",
            create_time: "2026-08-28T10:01:00+08:00",
            sender: { open_id: "ou_colleague", name: "同事", type: "user" },
            content: "请确认今天的方案",
          },
        ],
      },
      { source: "test", resource: "chat.message" },
    )
    const status = memory.status()
    assert.equal(status.assistantControlConversations, 1)
    assert.equal(status.eligibleMessages, 1)
    assert.equal(status.rejectedMessages, 2)
    assert.equal(memory.search({ query: "昨日简报" }).length, 0)
    assert.equal(memory.search({ query: "今天方案" }).length, 1)
  } finally {
    memory.close()
  }
})

import assert from "node:assert/strict"
import test from "node:test"
import { validateIncomingEvent } from "../src/service.mjs"

const base = {
  chat_type: "p2p",
  sender_type: "user",
  sender_id: "owner",
  message_id: "om_123",
  message_type: "text",
  content: "整理一下我有什么待办事件",
}

test("accepts owner P2P text", () => {
  assert.deepEqual(validateIncomingEvent(base, "owner", 1000), {
    messageId: "om_123",
    messageType: "text",
    content: "整理一下我有什么待办事件",
  })
})

test("rejects other users, groups, bots, and unsupported message types", () => {
  assert.equal(validateIncomingEvent({ ...base, sender_id: "other" }, "owner", 1000), null)
  assert.equal(validateIncomingEvent({ ...base, chat_type: "group" }, "owner", 1000), null)
  assert.equal(validateIncomingEvent({ ...base, sender_type: "bot" }, "owner", 1000), null)
  assert.equal(validateIncomingEvent({ ...base, message_type: "file" }, "owner", 1000), null)
})

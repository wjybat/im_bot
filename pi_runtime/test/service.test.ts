import assert from "node:assert/strict"
import test from "node:test"
import { validateIncomingEvent } from "../src/service.js"
import { redactInternalIdentifiers, replyIdempotencyKey } from "../src/infra/safety.js"

test("owner P2P text is accepted and source create time is retained", () => {
  assert.deepEqual(
    validateIncomingEvent(
      {
        chat_type: "p2p",
        sender_type: "user",
        sender_id: "owner",
        message_id: "om_valid",
        message_type: "text",
        content: "hello",
        create_time: "1787620000000",
      },
      "owner",
      100,
    ),
    {
      messageId: "om_valid",
      content: "hello",
      messageType: "text",
      createTime: "1787620000000",
    },
  )
})

test("other users, groups, bots, and unsupported content are rejected", () => {
  const base = {
    chat_type: "p2p",
    sender_type: "user",
    sender_id: "owner",
    message_id: "om_valid",
    message_type: "text",
    content: "hello",
  }
  assert.equal(validateIncomingEvent({ ...base, sender_id: "other" }, "owner", 100), null)
  assert.equal(validateIncomingEvent({ ...base, chat_type: "group" }, "owner", 100), null)
  assert.equal(validateIncomingEvent({ ...base, sender_type: "bot" }, "owner", 100), null)
  assert.equal(validateIncomingEvent({ ...base, message_type: "file" }, "owner", 100), null)
})

test("host redacts Feishu internal identifiers from final text", () => {
  assert.equal(
    redactInternalIdentifiers("chat oc_12345678 message om_abcdefgh sender ou_abcdefgh"),
    "chat [内部标识已隐藏] message [内部标识已隐藏] sender [内部标识已隐藏]",
  )
})

test("processing, final, and error replies use distinct stable idempotency keys", () => {
  const processing = replyIdempotencyKey("om_example", "processing")
  const final = replyIdempotencyKey("om_example", "final")
  const error = replyIdempotencyKey("om_example", "error")
  assert.notEqual(processing, final)
  assert.notEqual(final, error)
  assert.equal(processing, replyIdempotencyKey("om_example", "processing"))
})

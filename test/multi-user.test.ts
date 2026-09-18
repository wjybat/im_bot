import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OfficeMemory } from "../src/memory/index.js"
import { loadConfig } from "../src/config.js"
import { createModelRuntime } from "../src/agent/model.js"
import { OwnerMemoryRouter } from "../src/tenant/memory-router.js"
import { TenantTokenStore, buildOAuthAuthorizeUrl } from "../src/tenant/token-store.js"
import { quickTaskPromptFromCardAction } from "../src/agent/welcome-card.js"
import { adaptCardActionEvent } from "../src/tenant/openapi-gateway.js"

test("tenant token store persists per-user records atomically", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "token-store-"))
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })
  const store = new TenantTokenStore(join(stateDir, "tokens.json"), { appId: "cli_test", appSecret: "s" })
  await store.load()
  assert.equal(store.get("ou_a"), null)
  await store.upsert({
    ownerOpenId: "ou_a",
    ownerName: "甲",
    userAccessToken: "u-a",
    refreshToken: "r-a",
    expiresAt: Date.now() + 3_600_000,
    refreshExpiresAt: Date.now() + 86_400_000,
    grantedScopes: "search:message",
    updatedAt: Date.now(),
  })
  await store.upsert({
    ownerOpenId: "ou_b",
    ownerName: "乙",
    userAccessToken: "u-b",
    refreshToken: "r-b",
    expiresAt: Date.now() + 3_600_000,
    refreshExpiresAt: Date.now() + 86_400_000,
    grantedScopes: "search:message",
    updatedAt: Date.now(),
  })
  assert.equal(store.get("ou_a")?.ownerName, "甲")
  assert.equal(store.list().length, 2)
  // Reload from disk in a fresh instance.
  const reloaded = new TenantTokenStore(join(stateDir, "tokens.json"), { appId: "cli_test", appSecret: "s" })
  await reloaded.load()
  assert.equal(reloaded.get("ou_b")?.userAccessToken, "u-b")
  await reloaded.remove("ou_b")
  assert.equal(reloaded.get("ou_b"), null)
})

test("oauth authorize url carries app id, redirect, scopes, offline_access and state", () => {
  const url = buildOAuthAuthorizeUrl(
    { redirectUri: "https://bots.example.com/oauth/callback", scopes: ["search:message"], state: "st:ou_x" },
    { appId: "cli_test", appSecret: "s" },
  )
  const parsed = new URL(url)
  assert.equal(parsed.hostname, "accounts.feishu.cn")
  assert.equal(parsed.pathname, "/open-apis/authen/v1/authorize")
  assert.equal(parsed.searchParams.get("client_id"), "cli_test")
  assert.equal(parsed.searchParams.get("response_type"), "code")
  assert.equal(parsed.searchParams.get("redirect_uri"), "https://bots.example.com/oauth/callback")
  assert.equal(parsed.searchParams.get("state"), "st:ou_x")
  const scopes = (parsed.searchParams.get("scope") ?? "").split(" ")
  assert.ok(scopes.includes("search:message"))
  assert.ok(scopes.includes("offline_access"))
})

test("owner memory router isolates rows by owner_key in one shared database", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "memory-router-"))
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })
  const config = { ...loadConfig(), memoryFile: join(stateDir, "office-memory.db") }
  const modelRuntime = createModelRuntime(config)
  const router = new OwnerMemoryRouter({
    config,
    modelRuntime,
    assistantBotExternalId: "cli_test",
    assistantBotName: null,
  })
  try {
    const alice = router.sessionFor("ou_alice")
    const bob = router.sessionFor("ou_bob")
    assert.notEqual(alice.memory, bob.memory)
    // Same owner resolves to the same cached session.
    assert.equal(router.sessionFor("ou_alice"), alice)
    const payload = (id: string, chat: string, text: string) => ({
      messages: [
        {
          message_id: id,
          chat_id: chat,
          chat_type: "p2p",
          chat_name: "对话",
          create_time: "2026-09-12T10:00:00+08:00",
          sender: { open_id: "ou_peer", name: "同事" },
          content: text,
        },
      ],
    })
    alice.memory.ingestLarkPayload(payload("om_a1", "oc_a", "alice 的消息"), { source: "test", resource: "chat.message" })
    bob.memory.ingestLarkPayload(payload("om_b1", "oc_b", "bob 的消息"), { source: "test", resource: "chat.message" })
    const aliceStatus = alice.memory.status()
    const bobStatus = bob.memory.status()
    assert.equal(aliceStatus.messages, 1)
    assert.equal(bobStatus.messages, 1)
    assert.equal(alice.memory.search({ query: "bob" }).length, 0)
    assert.equal(bob.memory.search({ query: "alice" }).length, 0)
    assert.equal(alice.memory.search({ query: "alice 的消息" }).length, 1)
    assert.equal(bob.memory.search({ query: "bob 的消息" }).length, 1)
  } finally {
    router.close()
  }
})

test("card quick-task prompt whitelist still applies in multi-user mode", () => {
  const tasks = [{ label: "今天的工作简报", prompt: "生成今天的工作简报" }]
  assert.equal(
    quickTaskPromptFromCardAction(
      { action_tag: "button", action_value: { action: "quick_task", task: "生成今天的工作简报" } },
      tasks,
    ),
    "生成今天的工作简报",
  )
  assert.equal(
    quickTaskPromptFromCardAction(
      { action_tag: "button", action_value: { action: "quick_task", task: "伪造的提示词" } },
      tasks,
    ),
    null,
  )
})

test("card action adapter resolves v2 card.action.trigger payloads", () => {
  // v2 schema delivered by the SDK WS event dispatcher: ids under context,
  // operator object, action object with the callback value.
  const v2 = adaptCardActionEvent({
    event_id: "evt_1",
    operator: { open_id: "ou_alice" },
    context: { open_message_id: "om_card", open_chat_id: "oc_alice" },
    action: { tag: "button", value: { action: "quick_task", task: "生成今天的工作简报" } },
  })
  assert.ok(v2)
  assert.equal(v2.operator_id, "ou_alice")
  assert.equal(v2.message_id, "om_card")
  assert.equal(v2.chat_id, "oc_alice")
  assert.equal(v2.action_tag, "button")
  assert.deepEqual(v2.action_value, { action: "quick_task", task: "生成今天的工作简报" })
  assert.equal(
    quickTaskPromptFromCardAction(v2, [{ label: "今天的工作简报", prompt: "生成今天的工作简报" }]),
    "生成今天的工作简报",
  )

  // Flat legacy shape still resolves.
  const flat = adaptCardActionEvent({
    event_id: "evt_2",
    operator_id: "ou_bob",
    message_id: "om_card",
    chat_id: "oc_bob",
    action_tag: "button",
    action_value: { action: "quick_task", task: "生成今天的工作简报" },
  })
  assert.ok(flat)
  assert.equal(flat.operator_id, "ou_bob")
  assert.equal(flat.message_id, "om_card")

  // Missing ids or operator yield null (event dropped, not misrouted).
  assert.equal(adaptCardActionEvent({ operator: { open_id: "ou_x" }, action: { tag: "button" } }), null)
  assert.equal(
    adaptCardActionEvent({ context: { open_message_id: "om_c", open_chat_id: "oc_c" }, action: {} }),
    null,
  )
})

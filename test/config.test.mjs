import assert from "node:assert/strict"
import test from "node:test"
import { loadConfig } from "../src/config.mjs"

test("loadConfig defaults to a network-capable workspace-confined Codex runtime", () => {
  const previous = process.env.IM_BOT_CODEX_SANDBOX
  const previousTimeout = process.env.IM_BOT_CODEX_TIMEOUT_MS
  delete process.env.IM_BOT_CODEX_SANDBOX
  delete process.env.IM_BOT_CODEX_TIMEOUT_MS
  try {
    const config = loadConfig()
    assert.equal(config.codexSandbox, "workspace-write")
    assert.equal(config.codexTimeoutMs, 600_000)
  } finally {
    if (previous !== undefined) process.env.IM_BOT_CODEX_SANDBOX = previous
    if (previousTimeout !== undefined) process.env.IM_BOT_CODEX_TIMEOUT_MS = previousTimeout
  }
})

test("loadConfig rejects enabling user-scoped writes", () => {
  const previous = process.env.IM_BOT_ALLOW_USER_WRITES
  process.env.IM_BOT_ALLOW_USER_WRITES = "true"
  try {
    assert.throws(() => loadConfig(), /not supported/)
  } finally {
    if (previous === undefined) delete process.env.IM_BOT_ALLOW_USER_WRITES
    else process.env.IM_BOT_ALLOW_USER_WRITES = previous
  }
})

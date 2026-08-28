import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createConfiguredModels } from "../src/agent/model.js"
import { loadConfig } from "../src/config.js"
import { UsageLedger } from "../src/infra/usage-ledger.js"

test("configured DMall model carries official reference pricing and long-context tier", () => {
  const config = loadConfig()
  const model = createConfiguredModels(config).getModel("dmall-ai", "gpt-5.6-luna")
  assert.ok(model)
  assert.deepEqual(model.cost, {
    input: 0.2,
    output: 1.2,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    tiers: [
      {
        inputTokensAbove: 272_000,
        input: 0.4,
        output: 1.8,
        cacheRead: 0.04,
        cacheWrite: 0.5,
      },
    ],
  })
})

test("usage ledger writes one private aggregate record per Feishu message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-usage-ledger-"))
  const path = join(directory, "usage.jsonl")
  try {
    const config = loadConfig()
    const ledger = new UsageLedger(path)
    await ledger.append({
      message: "hashed-message",
      status: "success",
      receivedAt: "2026-08-26T08:00:00.000Z",
      completedAt: "2026-08-26T08:01:00.000Z",
      totalDurationMs: 60_000,
      telemetry: {
        provider: "dmall-ai",
        model: "gpt-5.6-luna",
        durationMs: 58_000,
        turns: 4,
        tools: ["load_skill", "run_lark_cli"],
        usage: {
          inputTokens: 10_000,
          outputTokens: 1_000,
          cacheReadTokens: 5_000,
          cacheWriteTokens: 0,
          reasoningTokens: 300,
          totalTokens: 16_000,
          inputCostUsd: 0.002,
          outputCostUsd: 0.0012,
          cacheReadCostUsd: 0.0001,
          cacheWriteCostUsd: 0,
          estimatedCostUsd: 0.0033,
        },
      },
      pricing: config.pricing,
      finalReplyDelivered: true,
    })
    const lines = (await readFile(path, "utf8")).trim().split("\n")
    assert.equal(lines.length, 1)
    const record = JSON.parse(lines[0] ?? "{}")
    assert.equal(record.message, "hashed-message")
    assert.equal(record.usage.totalTokens, 16_000)
    assert.equal(record.estimatedCost.amount, 0.0033)
    assert.equal(record.pricing.source, config.pricing.source)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

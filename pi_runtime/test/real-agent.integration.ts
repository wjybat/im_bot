import assert from "node:assert/strict"
import test from "node:test"
import { LarkCliGateway } from "../src/adapters/lark-cli.js"
import { createLivePiRuntime } from "../src/agent/pi-runtime.js"
import { loadConfig } from "../src/config.js"

test(
  "real gpt-5.6-luna autonomously reads today's Feishu context and produces a safe office-assistant answer",
  { timeout: 300_000 },
  async () => {
    const base = loadConfig()
    const config = {
      ...base,
      maxMessagePages: Math.min(base.maxMessagePages, 2),
      maxToolOutputChars: Math.min(base.maxToolOutputChars, 60_000),
      maxTurns: Math.min(base.maxTurns, 6),
    }
    const gateway = new LarkCliGateway(config)
    const identity = await gateway.check(config.allowedUserOpenId)
    const runtime = await createLivePiRuntime(config, gateway)
    const model = await runtime.check()
    assert.equal(model.provider, "dmall-ai")
    assert.equal(model.model, "gpt-5.6-luna")
    assert.equal(model.auth, "api_key")

    const result = await runtime.run({
      text: "请自主浏览我今天截至目前的私聊和群聊消息，列出最需要我处理或回复的1到3件事，并给出会话、发送人和时间依据。不要把飞书原生任务当作唯一来源。",
      requestId: "real-integration-test",
      sessionId: `real-integration-${identity.ownerOpenId.slice(-8)}`,
    })

    assert.ok(result.turns >= 2, `expected a multi-turn tool-using run, got ${result.turns}`)
    assert.ok(result.tools.filter((tool) => tool === "load_skill").length >= 1, `skill was not loaded: ${result.tools.join(",")}`)
    assert.ok(
      result.tools.includes("run_lark_cli"),
      `Lark CLI integration tool was not selected: ${result.tools.join(",")}`,
    )
    assert.ok(result.usage.inputTokens > 0)
    assert.ok(result.reply.length >= 80)
    assert.match(result.reply, /发送人|会话|私聊|群聊|时间/u)
    assert.doesNotMatch(result.reply, /\b(?:cli|ou|oc|om|omt)_[A-Za-z0-9_-]{6,}\b/u)
  },
)

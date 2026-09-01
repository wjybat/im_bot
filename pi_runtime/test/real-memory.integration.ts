import assert from "node:assert/strict"
import test from "node:test"
import { LarkCliGateway } from "../src/adapters/lark-cli.js"
import { createLivePiRuntime } from "../src/agent/pi-runtime.js"
import { loadConfig } from "../src/config.js"

test(
  "real daily brief uses high-level context preparation and hybrid retrieval",
  { timeout: 420_000 },
  async () => {
    const base = loadConfig()
    const config = {
      ...base,
      memoryFile: ":memory:",
      memoryExtractionMaxChunks: 1,
      maxMessagePages: 10,
      maxToolOutputChars: Math.min(base.maxToolOutputChars, 80_000),
      maxTurns: Math.min(base.maxTurns, 14),
      runtimeTimeoutMs: Math.min(base.runtimeTimeoutMs, 360_000),
    }
    const gateway = new LarkCliGateway(config)
    const identity = await gateway.check(config.allowedUserOpenId)
    const runtime = await createLivePiRuntime(config, gateway)
    const result = await runtime.run({
      text: "请按每日工作简报工作流生成一个消息记忆链路验收版简报。本次明确只使用飞书聊天和办公记忆，不查询日历、任务、邮件或其他来源。确保昨日零点至当前的消息上下文已经准备完整，然后调查仍有效的事项并输出昨日小结、今日规划、本周关注、备注四个模块；在备注说明本次只覆盖消息。",
      requestId: "real-memory-daily-brief",
      sessionId: `real-memory-${identity.ownerOpenId.slice(-8)}`,
    })

    assert.ok(result.tools.includes("prepare_office_context"), result.tools.join(","))
    assert.ok(result.tools.includes("search_office_context"), result.tools.join(","))
    assert.ok(result.usage.inputTokens > 0)
    assert.match(result.reply, /昨日小结/u)
    assert.match(result.reply, /今日规划/u)
    assert.match(result.reply, /本周关注/u)
    assert.match(result.reply, /备注/u)
    assert.doesNotMatch(result.reply, /\b(?:mem|fact)_[a-f0-9]{32,}\b/u)
  },
)

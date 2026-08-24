import assert from "node:assert/strict"
import test from "node:test"
import { buildCodexPrompt, parseCodexJsonl, shanghaiTimeContext } from "../src/codex.mjs"

test("prompt pins personal Lark calls to user identity and blocks writes", () => {
  const prompt = buildCodexPrompt("整理一下我的待办")
  assert.match(prompt, /--as user/)
  assert.match(prompt, /只允许读取/)
  assert.match(prompt, /不要发送飞书消息/)
  assert.match(prompt, /禁止运行 lark-cli auth login/)
  assert.match(prompt, /auth status --verify/)
  assert.match(prompt, /USER_MESSAGE_JSON/)
})

test("todo defaults to action items inferred from today's messages", () => {
  const prompt = buildCodexPrompt("整理一下我有什么待办事件", new Date("2026-08-24T10:15:30Z"))
  assert.match(prompt, /宿主没有关键词路由/)
  assert.match(prompt, /自主决定要读取哪些信息/)
  assert.match(prompt, /今天 00:00 至当前时刻用户可见的私聊和群聊消息/)
  assert.match(prompt, /而不是只查询飞书原生任务/)
  assert.match(prompt, /飞书原生任务、日历、邮件、文档等可以由你判断/)
  assert.doesNotMatch(prompt, /task_only|calendar_only|calendar_and_task|确定性路由/)
})

test("prompt provides an exact Asia/Shanghai time boundary", () => {
  const context = shanghaiTimeContext(new Date("2026-08-24T10:15:30Z"))
  assert.deepEqual(context, {
    timezone: "Asia/Shanghai",
    now: "2026-08-24T18:15:30+08:00",
    todayStart: "2026-08-24T00:00:00+08:00",
  })
  const prompt = buildCodexPrompt("今天有什么需要我处理", new Date("2026-08-24T10:15:30Z"))
  assert.match(prompt, /2026-08-24T18:15:30\+08:00/)
  assert.match(prompt, /2026-08-24T00:00:00\+08:00/)
})

test("transient Codex error events do not override a completed final answer", () => {
  const parsed = parseCodexJsonl(
    [
      JSON.stringify({ type: "error", error: "Reconnecting..." }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "有效" },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }),
    ].join("\n"),
  )
  assert.equal(parsed.finalText, "有效")
  assert.equal(parsed.failure, null)
  assert.equal(parsed.transientErrors, 1)
})

test("Codex command diagnostics redact output while classifying failures", () => {
  const parsed = parseCodexJsonl(
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "lark-cli auth status --json --verify",
        status: "failed",
        exit_code: 1,
        aggregated_output: "permission denied by sandbox",
      },
    }),
  )
  assert.deepEqual(parsed.commandDiagnostics, [
    {
      usesLarkCli: true,
      status: "failed",
      exitCode: 1,
      verifiedTrue: false,
      commandNotFound: false,
      permissionDenied: true,
      networkError: false,
      authorizationError: false,
    },
  ])
})

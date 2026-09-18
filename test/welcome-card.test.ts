import assert from "node:assert/strict"
import test from "node:test"
import {
  DEFAULT_QUICK_TASKS,
  buildWelcomeCard,
  quickTaskPromptFromCardAction,
} from "../src/agent/welcome-card.js"
import type { CardActionEvent } from "../src/types.js"

test("welcome card follows card 2.0 structure with a single primary quick-task button", () => {
  const card = buildWelcomeCard(DEFAULT_QUICK_TASKS) as {
    schema: string
    header: { template: string; title: { content: string }; icon: { token: string } }
    body: { elements: Array<Record<string, unknown>> }
  }
  assert.equal(card.schema, "2.0")
  assert.equal(card.header.template, "blue")
  assert.equal(card.header.title.content, "飞书办公助理")
  assert.equal(card.header.icon.token, "myai_colorful")
  const buttons = card.body.elements.filter((element) => element.tag === "button") as Array<{
    type: string
    width: string
    behaviors: Array<{ type: string; value: { action: string; task: string } }>
  }>
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0]?.type, "primary_filled")
  assert.equal(buttons[0]?.width, "fill")
  assert.deepEqual(buttons[0]?.behaviors, [
    { type: "callback", value: { action: "quick_task", task: "生成今天的工作简报" } },
  ])
})

test("quick task resolution accepts object and JSON-string action values", () => {
  const base = { action_tag: "button" }
  const fromObject = quickTaskPromptFromCardAction(
    { ...base, action_value: { action: "quick_task", task: "生成今天的工作简报" } },
    DEFAULT_QUICK_TASKS,
  )
  assert.equal(fromObject, "生成今天的工作简报")
  const fromString = quickTaskPromptFromCardAction(
    { ...base, action_value: JSON.stringify({ action: "quick_task", task: "生成今天的工作简报" }) },
    DEFAULT_QUICK_TASKS,
  )
  assert.equal(fromString, "生成今天的工作简报")
})

test("quick task resolution rejects unknown prompts, non-button actions, and malformed values", () => {
  const tasks = DEFAULT_QUICK_TASKS
  assert.equal(
    quickTaskPromptFromCardAction(
      { action_tag: "button", action_value: { action: "quick_task", task: "删除所有数据" } },
      tasks,
    ),
    null,
  )
  assert.equal(
    quickTaskPromptFromCardAction(
      { action_tag: "select_static", action_value: { action: "quick_task", task: "生成今天的工作简报" } },
      tasks,
    ),
    null,
  )
  assert.equal(
    quickTaskPromptFromCardAction({ action_tag: "button", action_value: "not-json" }, tasks),
    null,
  )
  assert.equal(
    quickTaskPromptFromCardAction({ action_tag: "button", action_value: { action: "other" } }, tasks),
    null,
  )
  assert.equal(quickTaskPromptFromCardAction({ action_tag: "button" }, tasks), null)
})

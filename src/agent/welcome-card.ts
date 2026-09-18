import type { CardActionEvent, RuntimeConfig } from "../types.js"

/**
 * Card 2.0 payloads produced here follow the lark-im card workflow
 * (card-2.0-schema / components / style P0-P7). Keep changes aligned with
 * those references: header carries the context, one focal point in body,
 * grouped containers, single button as primary_filled + fill width.
 */

export interface QuickTask {
  label: string
  prompt: string
}

/** Default preset quick tasks shown as buttons on the welcome card. */
export const DEFAULT_QUICK_TASKS: readonly QuickTask[] = [
  { label: "今天的工作简报", prompt: "生成今天的工作简报" },
]

export function quickTasksFromConfig(config: RuntimeConfig): readonly QuickTask[] {
  return DEFAULT_QUICK_TASKS
}

/** Builds the welcome card sent after the first successful memory warm-up. */
export function buildWelcomeCard(tasks: readonly QuickTask[]): Record<string, unknown> {
  const buttons = tasks.map((task, index) => ({
    tag: "button",
    element_id: `quick_task_${index + 1}`,
    text: { tag: "plain_text", content: task.label },
    type: index === 0 ? "primary_filled" : "default",
    width: "fill",
    size: "medium",
    behaviors: [
      { type: "callback", value: { action: "quick_task", task: task.prompt } },
    ],
  }))
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      enable_forward: false,
      summary: { content: "飞书办公助理已就绪" },
    },
    header: {
      title: { tag: "plain_text", content: "飞书办公助理" },
      subtitle: { tag: "plain_text", content: "办公上下文已就绪，随时可以开始" },
      template: "blue",
      icon: { tag: "standard_icon", token: "myai_colorful" },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 20px 12px",
      elements: [
        {
          tag: "column_set",
          flex_mode: "none",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              background_style: "blue-50",
              padding: "12px",
              vertical_spacing: "4px",
              elements: [
                {
                  tag: "markdown",
                  content: "**你好，我是你的飞书办公助理，欢迎询问我问题**",
                  text_align: "center",
                  margin: "0px",
                },
                {
                  tag: "markdown",
                  content: "<font color='grey'>可以直接提问，也可以点击下方按钮快速开始</font>",
                  text_align: "center",
                  text_size: "notation",
                  margin: "0px",
                },
              ],
            },
          ],
          margin: "0px 0px 12px 0px",
        },
        ...buttons.map((button) => ({ ...button, margin: "0px 0px 8px 0px" })),
      ],
    },
  }
}

/**
 * Resolves a card action event into the task prompt it carries. Returns null
 * for events that are not quick-task button clicks (form submits, pickers,
 * other components) or that carry no usable prompt.
 */
export function quickTaskPromptFromCardAction(
  event: CardActionEvent,
  tasks: readonly QuickTask[],
): string | null {
  if (event.action_tag !== "button") return null
  let value: unknown = event.action_value
  if (typeof value === "string" && value.trim() !== "") {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (typeof value !== "object" || value === null) return null
  const record = value as { action?: unknown; task?: unknown }
  if (record.action !== "quick_task") return null
  if (typeof record.task !== "string" || record.task.trim() === "") return null
  const task = record.task.trim()
  const known = tasks.some((candidate) => candidate.prompt === task)
  if (!known) return null
  return task
}

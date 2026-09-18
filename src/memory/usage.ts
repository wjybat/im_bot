import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { RuntimeUsage } from "../types.js"

export function emptyRuntimeUsage(): RuntimeUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    inputCostUsd: 0,
    outputCostUsd: 0,
    cacheReadCostUsd: 0,
    cacheWriteCostUsd: 0,
    estimatedCostUsd: 0,
  }
}

export function addRuntimeUsage(target: RuntimeUsage, value: RuntimeUsage): RuntimeUsage {
  target.inputTokens += value.inputTokens
  target.outputTokens += value.outputTokens
  target.cacheReadTokens += value.cacheReadTokens
  target.cacheWriteTokens += value.cacheWriteTokens
  target.reasoningTokens += value.reasoningTokens
  target.totalTokens += value.totalTokens
  target.inputCostUsd += value.inputCostUsd
  target.outputCostUsd += value.outputCostUsd
  target.cacheReadCostUsd += value.cacheReadCostUsd
  target.cacheWriteCostUsd += value.cacheWriteCostUsd
  target.estimatedCostUsd += value.estimatedCostUsd
  return target
}

export function runtimeUsageFromAssistant(message: AssistantMessage): RuntimeUsage {
  return {
    inputTokens: message.usage.input,
    outputTokens: message.usage.output,
    cacheReadTokens: message.usage.cacheRead,
    cacheWriteTokens: message.usage.cacheWrite,
    reasoningTokens: message.usage.reasoning ?? 0,
    totalTokens: message.usage.totalTokens,
    inputCostUsd: message.usage.cost.input,
    outputCostUsd: message.usage.cost.output,
    cacheReadCostUsd: message.usage.cost.cacheRead,
    cacheWriteCostUsd: message.usage.cost.cacheWrite,
    estimatedCostUsd: message.usage.cost.total,
  }
}

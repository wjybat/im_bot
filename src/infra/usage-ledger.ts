import { appendFile, chmod, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { PricingConfig, RuntimeTelemetry } from "../types.js"

export type UsageLedgerStatus = "success" | "runtime_failed" | "delivery_failed" | "host_failed" | "overloaded"

export interface UsageLedgerInput {
  message: string
  status: UsageLedgerStatus
  receivedAt: string
  completedAt: string
  totalDurationMs: number
  telemetry: RuntimeTelemetry
  pricing: PricingConfig
  finalReplyDelivered: boolean
  errorType?: string
}

export class UsageLedger {
  constructor(private readonly path: string) {}

  async append(input: UsageLedgerInput): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const record = {
      version: 1,
      source: "feishu_message",
      message: input.message,
      status: input.status,
      receivedAt: input.receivedAt,
      completedAt: input.completedAt,
      totalDurationMs: input.totalDurationMs,
      runtimeDurationMs: input.telemetry.durationMs,
      provider: input.telemetry.provider,
      model: input.telemetry.model,
      turns: input.telemetry.turns,
      toolCalls: input.telemetry.tools.length,
      usage: input.telemetry.usage,
      estimatedCost: {
        currency: input.pricing.currency,
        amount: input.telemetry.usage.estimatedCostUsd,
        basis: "reference_estimate",
      },
      pricing: input.pricing,
      finalReplyDelivered: input.finalReplyDelivered,
      ...(input.errorType ? { errorType: input.errorType } : {}),
    }
    await appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 })
    await chmod(this.path, 0o600)
  }
}

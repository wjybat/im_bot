import { logger } from "../infra/logger.js"
import { ContextPreparer } from "./context-preparer.js"
import type { LarkGateway, RuntimeConfig, RuntimeUsage } from "../types.js"
import type { OfficeMemory, SemanticMemory } from "../memory/index.js"

export interface MemoryWarmerOptions {
  config: RuntimeConfig
  gateway: LarkGateway
  memory: OfficeMemory
  semantic: SemanticMemory
  onUsage?: (usage: RuntimeUsage) => void
  /** Invoked once after the first completed warm-up run of this process. */
  onWarmedOnce?: () => void
}

export interface MemoryWarmerStatus {
  running: boolean
  schedule: string[]
  nextRunAt: string | null
  lastRunAt: string | null
  lastResult: "ok" | "partial" | "failed" | null
  lastError: string | null
  runs: number
  failures: number
}

/** Parses "HH:MM" (Asia/Shanghai) entries; returns null entries as errors to skip. */
export function parseSchedule(raw: string): Array<{ hour: number; minute: number } | null> {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const matched = /^(\d{1,2}):(\d{2})$/.exec(entry)
      if (!matched) return null
      const hour = Number(matched[1])
      const minute = Number(matched[2])
      if (hour > 23 || minute > 59) return null
      return { hour, minute }
    })
}

interface ShanghaiParts {
  day: string
  hour: number
  minute: number
  second: number
}

function shanghaiNow(now = new Date()): ShanghaiParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  )
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  }
}

/** Milliseconds from now until the next scheduled Shanghai local time. */
export function msUntilNextSlot(
  slots: Array<{ hour: number; minute: number }>,
  now = new Date(),
): number | null {
  if (slots.length === 0) return null
  const current = shanghaiNow(now)
  const today = slots
    .map((slot) => slot.hour * 60 + slot.minute)
    .sort((a, b) => a - b)
  const nowMinutes = current.hour * 60 + current.minute
  const nextToday = today.find((minutes) => minutes > nowMinutes)
  if (nextToday !== undefined) {
    return (nextToday - nowMinutes) * 60_000 - current.second * 1000
  }
  const firstTomorrow = today[0] ?? 0
  const minutesLeft = (24 * 60 - nowMinutes + firstTomorrow)
  return minutesLeft * 60_000 - current.second * 1000
}

/**
 * Offline memory maintenance on fixed daily Shanghai times. Keeps message
 * ingestion and fact extraction ahead of interactive requests so the online
 * path only pays for cache reads and small gap fills, never a cold sync.
 */
export class MemoryWarmer {
  private readonly preparer: ContextPreparer
  private readonly schedule: Array<{ hour: number; minute: number }>
  private timer: NodeJS.Timeout | null = null
  private initialRun: Promise<void> | null = null
  private runInFlight: Promise<void> | null = null
  private runs = 0
  private failures = 0
  private lastRunAt: number | null = null
  private lastResult: "ok" | "partial" | "failed" | null = null
  private lastError: string | null = null
  private warmedOnceNotified = false

  constructor(private readonly options: MemoryWarmerOptions) {
    this.preparer = new ContextPreparer({
      config: options.config,
      gateway: options.gateway,
      memory: options.memory,
      semantic: options.semantic,
      maxChunks: options.config.memoryWarmMaxChunks,
      ...(options.onUsage ? { onUsage: options.onUsage } : {}),
    })
    const parsed = parseSchedule(options.config.memoryWarmSchedule)
    const invalid = options.config.memoryWarmSchedule
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "").length !== parsed.filter((slot) => slot !== null).length
    if (invalid) throw new Error("memory warm schedule contains invalid HH:MM entries")
    this.schedule = parsed.flatMap((slot) => (slot === null ? [] : [slot]))
  }

  status(): MemoryWarmerStatus {
    return {
      running: this.timer !== null,
      schedule: this.schedule.map((slot) => `${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")}`),
      nextRunAt:
        this.timer === null || this.schedule.length === 0
          ? null
          : new Date(Date.now() + (msUntilNextSlot(this.schedule) ?? 0)).toISOString(),
      lastRunAt: this.lastRunAt === null ? null : new Date(this.lastRunAt).toISOString(),
      lastResult: this.lastResult,
      lastError: this.lastError,
      runs: this.runs,
      failures: this.failures,
    }
  }

  start(): void {
    if (this.schedule.length === 0) return
    if (this.timer !== null) return
    logger.info("memory_warmer_scheduled", {
      schedule: this.schedule.map((slot) => `${slot.hour}:${slot.minute}`),
      lookbackDays: this.options.config.memoryWarmLookbackDays,
    })
    if (this.options.config.memoryWarmInitialDelayMs <= 0) {
      this.initialRun = this.trigger(true).then(() => {
        this.scheduleNext()
      })
    } else {
      const initial = setTimeout(() => {
        this.initialRun = this.trigger(true).then(() => {
          this.scheduleNext()
        })
      }, this.options.config.memoryWarmInitialDelayMs)
      initial.unref()
    }
  }

  /** Resolves once the initial run (if started) has settled. */
  async waitForInitialRun(): Promise<void> {
    if (this.schedule.length === 0) return
    if (this.initialRun !== null) await this.initialRun
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.runInFlight !== null) await this.runInFlight
  }

  private scheduleNext(): void {
    if (this.timer !== null) return
    const delayMs = msUntilNextSlot(this.schedule)
    if (delayMs === null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.trigger()
        .catch(() => undefined)
        .finally(() => this.scheduleNext())
    }, delayMs)
    this.timer.unref()
  }

  private trigger(initial = false): Promise<void> {
    this.runInFlight = this.warmOnce(initial)
      .catch((error) => {
        this.failures += 1
        this.lastResult = "failed"
        this.lastError = error instanceof Error ? error.message : String(error)
        logger.error("memory_warmer_failed", error)
      })
      .finally(() => {
        this.runInFlight = null
      })
    return this.runInFlight
  }

  async warmOnce(initial = false): Promise<void> {
    const now = new Date()
    const lookback = initial
      ? this.options.config.memoryWarmInitialLookbackDays
      : this.options.config.memoryWarmLookbackDays
    const start = new Date(now.getTime() - lookback * 24 * 60 * 60 * 1000)
    this.runs += 1
    this.lastRunAt = Date.now()
    const pendingBefore = this.options.semantic.pendingMessageCount()
    const toSecondPrecision = (value: number): string =>
      new Date(Math.floor(value / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
    const result = await this.preparer.prepare(
      {
        start: toSecondPrecision(start.getTime()),
        end: toSecondPrecision(now.getTime()),
        freshness: "current",
        semantic: "facts",
      },
    )
    this.lastError = null
    this.lastResult = result.status === "ready" ? "ok" : "partial"
    if (!this.warmedOnceNotified) {
      this.warmedOnceNotified = true
      this.options.onWarmedOnce?.()
    }
    logger.info("memory_warmer_run_completed", {
      initial,
      lookbackDays: lookback,
      status: result.status,
      coverage: result.coverage.status,
      observedMessages: result.evidence.observedMessages,
      changedMessages: result.evidence.changedMessages,
      factsChanged: result.semantic.factsChanged,
      pendingBefore,
      errors: result.errors,
    })
  }
}

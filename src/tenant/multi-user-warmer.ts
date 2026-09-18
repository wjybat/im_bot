import { logger } from "../infra/logger.js"
import { ContextPreparer } from "../agent/context-preparer.js"
import { msUntilNextSlot, parseSchedule } from "../agent/memory-warmer.js"
import type { LarkGateway, RuntimeConfig, RuntimeUsage } from "../types.js"
import type { OfficeMemory, SemanticMemory } from "../memory/index.js"
import type { OwnerMemoryRouter } from "./memory-router.js"

export interface MultiUserWarmerOptions {
  config: RuntimeConfig
  gateway: LarkGateway
  router: OwnerMemoryRouter
  /** Resolves which owners currently hold valid user tokens (the warm set). */
  warmOwners: () => Array<{ ownerOpenId: string; ownerName: string | null }>
  onUsage?: (usage: RuntimeUsage) => void
  /** Invoked once after the first completed warm run of this process. */
  onWarmedOnce?: () => void
}

/**
 * Fixed-schedule memory warmer that fans out to every authorized owner,
 * reusing the single-user MemoryWarmer semantics (lookback window, chunk
 * quota, second-precision ranges) per owner.
 */
export class MultiUserWarmer {
  private readonly preparers = new Map<string, ContextPreparer>()
  private timer: NodeJS.Timeout | null = null
  private initialRun: Promise<void> | null = null
  private runInFlight: Promise<void> | null = null
  private runs = 0
  private failures = 0
  private lastRunAt: number | null = null
  private warmedOnceNotified = false

  constructor(private readonly options: MultiUserWarmerOptions) {}

  private preparerFor(ownerOpenId: string, memory: OfficeMemory, semantic: SemanticMemory): ContextPreparer {
    let preparer = this.preparers.get(ownerOpenId)
    if (preparer === undefined) {
      preparer = new ContextPreparer({
        config: this.options.config,
        gateway: this.options.gateway,
        memory,
        semantic,
        ownerOpenId,
        maxChunks: this.options.config.memoryWarmMaxChunks,
        ...(this.options.onUsage ? { onUsage: this.options.onUsage } : {}),
      })
      this.preparers.set(ownerOpenId, preparer)
    }
    return preparer
  }

  start(): void {
    const slots = parseSchedule(this.options.config.memoryWarmSchedule).flatMap((slot) =>
      slot === null ? [] : [slot],
    )
    if (slots.length === 0) return
    if (this.timer !== null) return
    logger.info("multi_user_warmer_scheduled", {
      schedule: slots.map((slot) => `${slot.hour}:${slot.minute}`),
      lookbackDays: this.options.config.memoryWarmLookbackDays,
    })
    if (this.options.config.memoryWarmInitialDelayMs <= 0) {
      this.initialRun = this.trigger(true).then(() => this.scheduleNext(slots))
    } else {
      const initial = setTimeout(() => {
        this.initialRun = this.trigger(true).then(() => this.scheduleNext(slots))
      }, this.options.config.memoryWarmInitialDelayMs)
      initial.unref()
    }
  }

  async waitForInitialRun(): Promise<void> {
    if (this.initialRun !== null) await this.initialRun
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.runInFlight !== null) await this.runInFlight
  }

  private scheduleNext(slots: Array<{ hour: number; minute: number }>): void {
    if (this.timer !== null) return
    const delayMs = msUntilNextSlot(slots)
    if (delayMs === null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.trigger()
        .catch(() => undefined)
        .finally(() => this.scheduleNext(slots))
    }, delayMs)
    this.timer.unref()
  }

  private trigger(initial = false): Promise<void> {
    this.runInFlight = this.warmOnce(initial)
      .catch((error) => {
        this.failures += 1
        logger.error("multi_user_warmer_failed", error)
      })
      .finally(() => {
        this.runInFlight = null
      })
    return this.runInFlight
  }

  async warmOnce(initial = false): Promise<void> {
    const owners = this.options.warmOwners()
    this.runs += 1
    this.lastRunAt = Date.now()
    const lookback = initial
      ? this.options.config.memoryWarmInitialLookbackDays
      : this.options.config.memoryWarmLookbackDays
    // Each warm pass reads with its owner's token explicitly; no shared
    // mutable gateway state is relied upon, so warm runs and live message
    // processing cannot cross owner scopes.
    for (const owner of owners) {
      const session = this.options.router.sessionFor(owner.ownerOpenId)
      const now = new Date()
      const start = new Date(now.getTime() - lookback * 24 * 60 * 60 * 1000)
      const toSecondPrecision = (value: number): string =>
        new Date(Math.floor(value / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
      try {
        const result = await this.preparerFor(owner.ownerOpenId, session.memory, session.semantic).prepare({
          start: toSecondPrecision(start.getTime()),
          end: toSecondPrecision(now.getTime()),
          freshness: "current",
          semantic: "facts",
        })
        logger.info("multi_user_warmer_owner_completed", {
          owner: owner.ownerOpenId.slice(0, 12),
          initial,
          lookbackDays: lookback,
          status: result.status,
          changedMessages: result.evidence.changedMessages,
          factsChanged: result.semantic.factsChanged,
          errors: result.errors,
        })
      } catch (error) {
        this.failures += 1
        logger.error("multi_user_warmer_owner_failed", error, { owner: owner.ownerOpenId.slice(0, 12) })
      }
    }
    if (!this.warmedOnceNotified) {
      this.warmedOnceNotified = true
      this.options.onWarmedOnce?.()
    }
    logger.info("multi_user_warmer_run_completed", { owners: owners.length, runs: this.runs, failures: this.failures })
  }

}

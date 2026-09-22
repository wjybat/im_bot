export interface RateLimitOptions {
  perMinute: number
  dailyQuota: number
}

export interface RateLimitDecision {
  allowed: boolean
  reason?: "per_minute" | "daily"
  retryAfterMs?: number
}

export class MemoryApiRateLimiter {
  private readonly minuteHits = new Map<string, number[]>()
  private readonly dailyCounts = new Map<string, { day: string; count: number }>()

  constructor(private readonly options: RateLimitOptions) {}

  check(key: string, now = Date.now()): RateLimitDecision {
    const windowStart = now - 60_000
    const hits = (this.minuteHits.get(key) ?? []).filter((value) => value > windowStart)
    if (hits.length >= this.options.perMinute) {
      this.minuteHits.set(key, hits)
      const oldest = hits[0]
      return {
        allowed: false,
        reason: "per_minute",
        retryAfterMs: oldest === undefined ? 60_000 : Math.max(1, oldest + 60_000 - now),
      }
    }
    hits.push(now)
    this.minuteHits.set(key, hits)

    const day = new Date(now).toISOString().slice(0, 10)
    const existing = this.dailyCounts.get(key)
    const count = existing !== undefined && existing.day === day ? existing.count : 0
    if (count >= this.options.dailyQuota) {
      this.dailyCounts.set(key, { day, count })
      return { allowed: false, reason: "daily" }
    }
    this.dailyCounts.set(key, { day, count: count + 1 })
    return { allowed: true }
  }
}

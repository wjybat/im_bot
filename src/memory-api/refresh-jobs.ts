import { randomUUID } from "node:crypto"

export type RefreshJobStatus = "queued" | "running" | "done" | "error"

export interface RefreshJob {
  id: string
  ownerOpenId: string
  start: string
  end: string
  query: string | null
  chatType: "p2p" | "group" | null
  status: RefreshJobStatus
  requestedAt: number
  startedAt: number | null
  completedAt: number | null
  result: unknown
  error: string | null
}

const MAX_TRACKED_JOBS = 200

export class RefreshJobManager {
  private readonly jobs = new Map<string, RefreshJob>()
  private readonly chains = new Map<string, Promise<void>>()
  private readonly latestPerOwner = new Map<string, RefreshJob>()

  constructor(private readonly run: (job: RefreshJob) => Promise<unknown>) {}

  enqueue(input: {
    ownerOpenId: string
    start: string
    end: string
    query: string | null
    chatType: "p2p" | "group" | null
  }): RefreshJob {
    const job: RefreshJob = {
      id: randomUUID(),
      ownerOpenId: input.ownerOpenId,
      start: input.start,
      end: input.end,
      query: input.query,
      chatType: input.chatType,
      status: "queued",
      requestedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
    }
    this.track(job)
    const chain = this.chains.get(job.ownerOpenId) ?? Promise.resolve()
    const next = chain.then(() => this.execute(job)).catch(() => undefined)
    this.chains.set(job.ownerOpenId, next)
    return job
  }

  get(id: string): RefreshJob | null {
    return this.jobs.get(id) ?? null
  }

  latestFor(ownerOpenId: string): RefreshJob | null {
    return this.latestPerOwner.get(ownerOpenId) ?? null
  }

  private async execute(job: RefreshJob): Promise<void> {
    job.status = "running"
    job.startedAt = Date.now()
    try {
      job.result = await this.run(job)
      job.status = "done"
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error)
      job.status = "error"
    } finally {
      job.completedAt = Date.now()
      this.latestPerOwner.set(job.ownerOpenId, job)
    }
  }

  private track(job: RefreshJob): void {
    this.jobs.set(job.id, job)
    this.latestPerOwner.set(job.ownerOpenId, job)
    if (this.jobs.size > MAX_TRACKED_JOBS) {
      const oldest = this.jobs.keys().next()
      const oldestId = oldest.value
      if (oldest.done !== true || oldestId === undefined) return
      const first = this.jobs.get(oldestId)
      if (first !== undefined && (first.status === "queued" || first.status === "running")) return
      this.jobs.delete(oldestId)
    }
  }
}

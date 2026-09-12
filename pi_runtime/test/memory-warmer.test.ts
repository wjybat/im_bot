import assert from "node:assert/strict"
import test from "node:test"
import { MemoryWarmer, msUntilNextSlot, parseSchedule } from "../src/agent/memory-warmer.js"
import { loadConfig } from "../src/config.js"
import { MockLarkGateway } from "../src/demo/mock-lark.js"
import { OfficeMemory } from "../src/memory/index.js"
import { FakeFactExtractor, createTestSemantic } from "./fakes.js"

class CountingGateway extends MockLarkGateway {
  readonly ranges: Array<{ start: string; end: string }> = []

  override async searchMessages(input: {
    query: string
    start: string
    end: string
    chatType?: "p2p" | "group"
    pageLimit: number
  }): Promise<unknown> {
    this.ranges.push({ start: input.start, end: input.end })
    return {
      has_more: false,
      messages: [{
        message_id: `om_warm_${this.ranges.length}`,
        chat_id: "oc_warm",
        chat_type: "group",
        chat_name: "预热测试群",
        create_time: new Date(Date.now() - this.ranges.length * 60_000).toISOString(),
        sender: { open_id: "ou_colleague", name: "同事", type: "user" },
        content: `预热消息 ${this.ranges.length}`,
      }],
    }
  }
}

test("schedule parsing accepts HH:MM entries and rejects invalid ones", () => {
  const slots = parseSchedule("07:30, 12:30,23:00")
  assert.deepEqual(slots, [
    { hour: 7, minute: 30 },
    { hour: 12, minute: 30 },
    { hour: 23, minute: 0 },
  ])
  assert.deepEqual(parseSchedule(""), [])
  assert.equal(parseSchedule("25:00")[0], null)
  assert.equal(parseSchedule("7:3")[0], null)
  assert.equal(parseSchedule("noon")[0], null)
})

test("next-slot computation walks forward within the day and rolls over midnight", () => {
  const slots = [{ hour: 7, minute: 30 }, { hour: 23, minute: 0 }]
  // 2026-09-11T10:00:00+08:00 is 02:00Z; next slot is 23:00 Shanghai same day.
  const beforeEvening = msUntilNextSlot(slots, new Date("2026-09-11T02:00:00Z"))!
  assert.ok(Math.abs(beforeEvening - 13 * 60 * 60_000) < 5_000)
  // 23:30 Shanghai is after both slots; next is tomorrow 07:30.
  const afterLast = msUntilNextSlot(slots, new Date("2026-09-11T15:30:00Z"))!
  assert.ok(Math.abs(afterLast - 8 * 60 * 60_000) < 5_000)
})

test("warmer synchronizes the lookback window and extracts facts in the background", async (t) => {
  const config = {
    ...loadConfig(),
    memoryPrepareMaxWindows: 8,
    memoryPrepareMinWindowMs: 60_000,
    memoryWarmMaxChunks: 5,
  }
  const gateway = new CountingGateway()
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "redacted-demo-owner" })
  t.after(() => memory.close())
  const extractor = new FakeFactExtractor({ entities: [], facts: [] })
  const semantic = createTestSemantic(memory, config, extractor)
  const warmer = new MemoryWarmer({ config, gateway, memory, semantic })

  const statusBefore = warmer.status()
  assert.equal(statusBefore.running, false)
  assert.equal(statusBefore.runs, 0)

  await warmer.warmOnce()

  const statusAfter = warmer.status()
  assert.equal(statusAfter.runs, 1)
  assert.equal(statusAfter.failures, 0)
  assert.ok(statusAfter.lastRunAt !== null)
  assert.ok(gateway.ranges.length >= 1)
  const now = Date.now()
  const first = gateway.ranges[0]
  assert.ok(first)
  const lookbackMs = config.memoryWarmLookbackDays * 24 * 60 * 60 * 1000
  assert.ok(Date.parse(first.start) <= now - lookbackMs + 5_000)
  assert.ok(Date.parse(first.end) <= now + 5_000)
  assert.equal(extractor.calls.length, 1)
  assert.equal(memory.status().messages, 1)
})

test("warmer start runs once immediately then arms the next scheduled slot", async (t) => {
  const config = {
    ...loadConfig(),
    memoryWarmSchedule: "07:30,12:30,23:00",
    memoryWarmInitialDelayMs: 0,
    memoryWarmLookbackDays: 1,
    memoryWarmMaxChunks: 1,
  }
  const gateway = new CountingGateway()
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "redacted-demo-owner" })
  t.after(() => memory.close())
  const semantic = createTestSemantic(memory, config)
  const warmer = new MemoryWarmer({ config, gateway, memory, semantic })

  warmer.start()
  assert.equal(warmer.status().running, false) // timer not armed until initial run settles
  await warmer.waitForInitialRun()
  assert.equal(warmer.status().runs, 1)
  assert.ok(warmer.status().nextRunAt !== null)

  await warmer.stop()
  const runsAfterStop = warmer.status().runs
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(warmer.status().runs, runsAfterStop)
  assert.equal(warmer.status().nextRunAt, null)
})

test("warmer is disabled when the schedule is empty", () => {
  const config = {
    ...loadConfig(),
    memoryWarmSchedule: "",
  }
  const gateway = new CountingGateway()
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "redacted-demo-owner" })
  const semantic = createTestSemantic(memory, config)
  const warmer = new MemoryWarmer({ config, gateway, memory, semantic })
  warmer.start()
  assert.equal(warmer.status().running, false)
  warmer.stop()
  memory.close()
})

test("warmer constructor rejects invalid schedule entries", () => {
  const config = {
    ...loadConfig(),
    memoryWarmSchedule: "07:30,broken",
  }
  const gateway = new CountingGateway()
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "redacted-demo-owner" })
  const semantic = createTestSemantic(memory, config)
  assert.throws(() => new MemoryWarmer({ config, gateway, memory, semantic }), /invalid HH:MM/)
  memory.close()
})

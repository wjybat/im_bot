import assert from "node:assert/strict"
import test from "node:test"
import { shanghaiTimeContext } from "../src/agent/time.js"

test("runtime receives exact Asia/Shanghai boundaries", () => {
  assert.deepEqual(shanghaiTimeContext(new Date("2026-08-25T02:30:00Z")), {
    timezone: "Asia/Shanghai",
    now: "2026-08-25T10:30:00+08:00",
    todayStart: "2026-08-25T00:00:00+08:00",
  })
})

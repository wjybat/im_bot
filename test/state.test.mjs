import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ProcessedMessageStore } from "../src/state.mjs"

test("persists bounded processed message IDs with private permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "im-bot-state-"))
  const path = join(dir, "state.json")
  try {
    const store = new ProcessedMessageStore(path, 2)
    await store.load()
    await store.mark("om_1")
    await store.mark("om_2")
    await store.mark("om_3")
    assert.equal(store.has("om_1"), false)
    assert.equal(store.has("om_3"), true)
    const parsed = JSON.parse(await readFile(path, "utf8"))
    assert.deepEqual(
      parsed.processed.map((item) => item.id),
      ["om_2", "om_3"],
    )
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

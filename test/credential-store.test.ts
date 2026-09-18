import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { JsonCredentialStore } from "../src/agent/credential-store.js"

test("credential store persists atomically with private file permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-runtime-auth-"))
  const path = join(directory, "auth.json")
  try {
    const store = new JsonCredentialStore(path)
    await store.modify("demo", async () => ({ type: "api_key", key: "test-only" }))
    assert.deepEqual(await store.list(), [{ providerId: "demo", type: "api_key" }])
    assert.equal((await store.read("demo"))?.type, "api_key")
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.doesNotMatch(await readFile(path, "utf8"), /undefined/)
    await store.delete("demo")
    assert.equal(await store.read("demo"), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

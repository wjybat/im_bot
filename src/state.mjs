import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export class ProcessedMessageStore {
  constructor(path, maxRecords = 5000) {
    this.path = path
    this.maxRecords = maxRecords
    this.records = []
    this.ids = new Set()
  }

  async load() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    let raw
    try {
      raw = await readFile(this.path, "utf8")
    } catch (error) {
      if (error?.code === "ENOENT") return
      throw error
    }

    const parsed = JSON.parse(raw)
    if (parsed.version !== 1 || !Array.isArray(parsed.processed)) {
      throw new Error("unsupported or corrupt processed-message state")
    }
    this.records = parsed.processed
      .filter((item) => typeof item?.id === "string" && Number.isFinite(item?.at))
      .slice(-this.maxRecords)
    this.ids = new Set(this.records.map((item) => item.id))
    await chmod(this.path, 0o600)
  }

  has(messageId) {
    return this.ids.has(messageId)
  }

  async mark(messageId) {
    if (this.ids.has(messageId)) return
    this.records.push({ id: messageId, at: Date.now() })
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords)
    }
    this.ids = new Set(this.records.map((item) => item.id))
    await this.#flush()
  }

  async #flush() {
    const temp = `${this.path}.${process.pid}.tmp`
    const body = `${JSON.stringify({ version: 1, processed: this.records }, null, 2)}\n`
    await writeFile(temp, body, { encoding: "utf8", mode: 0o600 })
    await rename(temp, this.path)
    await chmod(this.path, 0o600)
  }
}

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

interface RecordEntry {
  id: string
  at: number
}

export class ProcessedMessageStore {
  private records: RecordEntry[] = []
  private ids = new Set<string>()

  constructor(private readonly path: string, private readonly maxRecords = 5000) {}

  async load(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"))
      if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { processed?: unknown }).processed)) {
        throw new Error("unsupported or corrupt processed-message state")
      }
      this.records = (parsed as { processed: unknown[] }).processed
        .filter(
          (item): item is RecordEntry =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as RecordEntry).id === "string" &&
            Number.isFinite((item as RecordEntry).at),
        )
        .slice(-this.maxRecords)
      this.ids = new Set(this.records.map((item) => item.id))
      await chmod(this.path, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }

  has(messageId: string): boolean {
    return this.ids.has(messageId)
  }

  async mark(messageId: string): Promise<void> {
    if (this.ids.has(messageId)) return
    this.records.push({ id: messageId, at: Date.now() })
    this.records = this.records.slice(-this.maxRecords)
    this.ids = new Set(this.records.map((item) => item.id))
    const temp = `${this.path}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify({ version: 1, processed: this.records }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    await rename(temp, this.path)
    await chmod(this.path, 0o600)
  }
}

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai"

function throwIfAborted(options?: AuthOperationOptions): void {
  options?.signal?.throwIfAborted()
}

export class JsonCredentialStore implements CredentialStore {
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(private readonly path: string) {}

  private async load(): Promise<Record<string, Credential>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"))
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("credential file must contain an object")
      }
      return parsed as Record<string, Credential>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw error
    }
  }

  private async save(credentials: Record<string, Credential>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const tempPath = `${this.path}.${process.pid}.tmp`
    await writeFile(tempPath, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    await rename(tempPath, this.path)
    await chmod(this.path, 0o600)
  }

  private enqueue<T>(providerId: string, task: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve()
    const queued = (async () => {
      await previous.catch(() => undefined)
      throwIfAborted(options)
      return task()
    })()
    const tail = queued.catch(() => undefined)
    this.chains.set(providerId, tail)
    void tail.finally(() => {
      if (this.chains.get(providerId) === tail) this.chains.delete(providerId)
    })
    return queued
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    throwIfAborted(options)
    return (await this.load())[providerId]
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    throwIfAborted(options)
    return Object.entries(await this.load()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }))
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.enqueue(
      providerId,
      async () => {
        const credentials = await this.load()
        const current = credentials[providerId]
        const next = await fn(current)
        throwIfAborted(options)
        if (next !== undefined) {
          credentials[providerId] = next
          await this.save(credentials)
        }
        return next ?? current
      },
      options,
    )
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(
      providerId,
      async () => {
        const credentials = await this.load()
        if (credentials[providerId] === undefined) return
        delete credentials[providerId]
        await this.save(credentials)
      },
      options,
    )
  }
}

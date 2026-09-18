import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export interface AppCredentials {
  appId: string
  appSecret: string
}

export interface UserTokenRecord {
  ownerOpenId: string
  ownerName: string | null
  userAccessToken: string
  refreshToken: string
  expiresAt: number
  refreshExpiresAt: number
  grantedScopes: string
  updatedAt: number
}

interface TenantTokenStoreShape {
  version: 1
  users: Record<string, UserTokenRecord>
}

/**
 * Per-tenant persistence for Feishu user OAuth tokens (the multi-user
 * replacement for lark-cli's single-user credential file). Single-process
 * safe: all mutations run through an in-process write chain, and the file is
 * replaced atomically with 0600 permissions.
 */
export class TenantTokenStore {
  private chain: Promise<void> = Promise.resolve()
  private users: Record<string, UserTokenRecord> = {}

  constructor(
    private readonly path: string,
    private readonly app: AppCredentials,
  ) {}

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"))
      if (typeof parsed === "object" && parsed !== null) {
        const shape = parsed as { users?: unknown }
        if (typeof shape.users === "object" && shape.users !== null) {
          this.users = shape.users as Record<string, UserTokenRecord>
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await chmod(this.path, 0o600).catch(() => undefined)
  }

  get(ownerOpenId: string): UserTokenRecord | null {
    return this.users[ownerOpenId] ?? null
  }

  list(): UserTokenRecord[] {
    return Object.values(this.users)
  }

  upsert(record: UserTokenRecord): Promise<void> {
    return this.enqueue(async () => {
      this.users[record.ownerOpenId] = record
      await this.persist()
    })
  }

  remove(ownerOpenId: string): Promise<void> {
    return this.enqueue(async () => {
      delete this.users[ownerOpenId]
      await this.persist()
    })
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const queued = this.chain.then(task)
    this.chain = queued.catch(() => undefined)
    return queued
  }

  private async persist(): Promise<void> {
    const shape: TenantTokenStoreShape = { version: 1, users: this.users }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temp, `${JSON.stringify(shape, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    await rename(temp, this.path)
    await chmod(this.path, 0o600).catch(() => undefined)
  }
}

export interface OAuthAuthorizeUrlInput {
  redirectUri: string
  scopes: string[]
  state: string
}

/** Builds the Feishu end-user OAuth authorize page URL. */
export function buildOAuthAuthorizeUrl(input: OAuthAuthorizeUrlInput, app: AppCredentials): string {
  const url = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize")
  url.searchParams.set("client_id", app.appId)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("scope", [...new Set([...input.scopes, "offline_access"])].join(" "))
  url.searchParams.set("state", input.state)
  return url.toString()
}

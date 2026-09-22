import * as Lark from "@larksuiteoapi/node-sdk"
import type { AppCredentials, UserTokenRecord } from "./token-store.js"

/** Feishu authen error code for an expired (unusable) refresh token. */
export const REFRESH_TOKEN_EXPIRED_CODE = 20026

/** Thrown when the stored refresh token can no longer mint a fresh access token. */
export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RefreshTokenExpiredError"
  }
}

export interface TokenManagerOptions {
  app: AppCredentials
  store: {
    get: (ownerOpenId: string) => UserTokenRecord | null
    upsert: (record: UserTokenRecord) => Promise<void>
  }
}

/**
 * Exchanges OAuth codes for user tokens and refreshes them via the Feishu
 * authen API. All tokens are persisted through the injected store. The SDK
 * client used here carries no user credentials; every call passes the
 * app_access_token implicitly (required by the authen endpoints).
 */
export class UserTokenManager {
  private readonly client: Lark.Client

  constructor(private readonly options: TokenManagerOptions) {
    this.client = new Lark.Client({
      appId: options.app.appId,
      appSecret: options.app.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
      domain: Lark.Domain.Feishu,
    })
  }

  /** Exchanges an OAuth authorization code for a user token and persists it. */
  async exchangeCode(code: string): Promise<UserTokenRecord> {
    const response = await this.client.authen.v1.accessToken.create({
      data: { grant_type: "authorization_code", code },
    })
    if (response.code !== 0 || !response.data?.access_token) {
      throw new Error(`oauth code exchange failed: ${response.code} ${response.msg ?? ""}`)
    }
    const record: UserTokenRecord = {
      ownerOpenId: response.data.open_id ?? "",
      ownerName: response.data.name ?? null,
      userAccessToken: response.data.access_token,
      refreshToken: response.data.refresh_token ?? "",
      expiresAt: Date.now() + (response.data.expires_in ?? 7_200) * 1000,
      refreshExpiresAt: Date.now() + (response.data.refresh_expires_in ?? 2_592_000) * 1000,
      grantedScopes: "",
      updatedAt: Date.now(),
    }
    if (record.ownerOpenId === "") throw new Error("oauth code exchange returned no open_id")
    await this.options.store.upsert(record)
    return record
  }

  /** Refreshes the stored token for the owner and persists the rotation. */
  async refresh(ownerOpenId: string): Promise<UserTokenRecord> {
    const current = this.options.store.get(ownerOpenId)
    if (current === null) throw new Error(`no user token to refresh for owner`)
    if (current.refreshToken === "") throw new Error("stored token has no refresh_token; re-authorization required")
    const response = await this.client.authen.v1.refreshAccessToken.create({
      data: {
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
      },
    })
    if (response.code === REFRESH_TOKEN_EXPIRED_CODE) {
      throw new RefreshTokenExpiredError(`token refresh failed: ${response.code} ${response.msg ?? ""}`)
    }
    if (response.code !== 0 || !response.data?.access_token) {
      throw new Error(`token refresh failed: ${response.code} ${response.msg ?? ""}`)
    }
    const record: UserTokenRecord = {
      ownerOpenId,
      ownerName: current.ownerName,
      userAccessToken: response.data.access_token,
      refreshToken: response.data.refresh_token ?? current.refreshToken,
      expiresAt: Date.now() + (response.data.expires_in ?? 7_200) * 1000,
      refreshExpiresAt: Date.now() + (response.data.refresh_expires_in ?? 2_592_000) * 1000,
      grantedScopes: current.grantedScopes,
      updatedAt: Date.now(),
    }
    await this.options.store.upsert(record)
    return record
  }
}

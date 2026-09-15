import { createHash, randomUUID } from "node:crypto"
import { createServer, type Server } from "node:http"
import { logger } from "../infra/logger.js"
import { hashIdentifier } from "../infra/safety.js"
import { PiBotService } from "../service.js"
import { buildWelcomeCard, quickTasksFromConfig } from "../agent/welcome-card.js"
import type {
  AcceptedMessage,
  LarkGateway,
  MemoryBackedRuntime,
  OwnerIdentity,
  OwnerMemorySession,
  OwnerMemorySessionProvider,
  RuntimeConfig,
} from "../types.js"
import { OpenApiGateway } from "./openapi-gateway.js"
import { TenantTokenStore, type UserTokenRecord } from "./token-store.js"
import { UserTokenManager } from "./token-manager.js"
import { TENANT_USER_SCOPES } from "./types.js"

interface MultiUserRuntimeOptions {
  config: RuntimeConfig
  gateway: LarkGateway
  tokenStore: TenantTokenStore
  tokenManager: UserTokenManager
  runtime: MemoryBackedRuntime
  sessionProvider: OwnerMemorySessionProvider
  /** Builds the OAuth authorize URL for an owner; only the OpenApiGateway implements it. */
  buildAuthorizeUrl: (ownerOpenId: string, redirectUri: string, state: string) => string
  /** Pins the gateway's active owner before each message (owner-scoped reads). */
  setActiveOwner: (ownerOpenId: string) => void
}

/**
 * Authorizes users through the multi-user memory router: a user is allowed
 * when they are on the allowlist AND hold a valid stored user token. The
 * bearer of an authorized user identity is derived per message.
 */
export class MultiUserService extends PiBotService {
  private readonly tokenStore: TenantTokenStore
  private readonly tokenManager: UserTokenManager
  private readonly buildAuthorizeUrlFn: (ownerOpenId: string, redirectUri: string, state: string) => string
  private readonly setActiveOwnerFn: (ownerOpenId: string) => void
  private readonly sessionProvider: OwnerMemorySessionProvider
  private readonly pendingStates = new Map<string, string>()
  private oauthServer: Server | null = null

  constructor(options: MultiUserRuntimeOptions) {
    super(options.config, options.gateway, options.runtime)
    this.tokenStore = options.tokenStore
    this.tokenManager = options.tokenManager
    this.buildAuthorizeUrlFn = options.buildAuthorizeUrl
    this.setActiveOwnerFn = options.setActiveOwner
    this.sessionProvider = options.sessionProvider
  }

  override async start(): Promise<void> {
    await this.store.load()
    await this.runtime.check()
    this.scheduleAuthVerification()
    logger.info("pi_multi_user_service_starting", {
      allowlist: this.config.allowedUserOpenIds.map(hashIdentifier),
      authorized: this.tokenStore.list().map((record) => hashIdentifier(record.ownerOpenId)),
    })
    await this.startConsumer()
    try {
      await this.startCardActionConsumer()
    } catch (error) {
      this.cardConsumerDisabled = true
      logger.error("card_action_consumer_unavailable", error, {
        hint: "subscribe card.action.trigger in the developer console and restart",
      })
    }
    this.startOAuthServer()
  }

  override async stop(): Promise<void> {
    if (this.oauthServer !== null) {
      this.oauthServer.close()
      this.oauthServer = null
    }
    await super.stop()
  }

  protected override isAllowedUser(senderOpenId: string | null): boolean {
    if (senderOpenId === null) return false
    if (this.config.allowedUserOpenIds.length > 0 && !this.config.allowedUserOpenIds.includes(senderOpenId)) {
      return false
    }
    return true
  }

  /** A user is processable when allowlisted and holds a stored token. */
  private isAuthorizedUser(senderOpenId: string | null): boolean {
    if (!this.isAllowedUser(senderOpenId)) return false
    return senderOpenId !== null && this.tokenStore.get(senderOpenId) !== null
  }

  protected override resolveOwner(senderOpenId: string | null): OwnerIdentity | null {
    if (senderOpenId === null || !this.isAllowedUser(senderOpenId)) return null
    const record = this.tokenStore.get(senderOpenId)
    return {
      ownerOpenId: senderOpenId,
      ownerName: record?.ownerName ?? null,
      botName: null,
      botAppId: null,
      tokenStatus: record !== null ? "valid" : "user_token_missing",
    }
  }

  protected override async beforeProcessMessage(owner: OwnerIdentity, message: AcceptedMessage): Promise<void> {
    this.setActiveOwnerFn(owner.ownerOpenId)
  }

  /**
   * Gate override: unauthorized-but-allowed users get an OAuth card instead
   * of entering the queue.
   */
  protected override enqueueAccepted(accepted: AcceptedMessage): void {
    const sender = accepted.senderOpenId ?? null
    if (sender !== null && !this.isAuthorizedUser(sender)) {
      void this.sendAuthorizationCard(sender, accepted.messageId)
      return
    }
    super.enqueueAccepted(accepted)
  }

  private async sendAuthorizationCard(userOpenId: string, replyToMessageId: string): Promise<void> {
    try {
      const state = randomUUID()
      this.pendingStates.set(state, userOpenId)
      const redirectUri = `${this.config.oauthPublicBaseUrl.replace(/\/$/, "")}/oauth/callback`
      const authorizeUrl = this.buildAuthorizeUrlFn(userOpenId, redirectUri, state)
      const card = {
        schema: "2.0",
        config: { update_multi: true, width_mode: "default", enable_forward: false },
        header: {
          title: { tag: "plain_text", content: "需要授权" },
          subtitle: { tag: "plain_text", content: "授权后即可使用办公助理" },
          template: "blue",
          icon: { tag: "standard_icon", token: "myai_colorful" },
        },
        body: {
          direction: "vertical",
          padding: "12px 12px 20px 12px",
          elements: [
            {
              tag: "column_set",
              flex_mode: "none",
              columns: [
                {
                  tag: "column",
                  width: "weighted",
                  weight: 1,
                  background_style: "blue-50",
                  padding: "12px",
                  vertical_spacing: "4px",
                  elements: [
                    {
                      tag: "markdown",
                      content:
                        "**首次使用需要授权**\n<font color='grey'>办公助理需要以你的身份读取消息、日程和任务，点击下方按钮完成授权（约 30 秒）</font>",
                    },
                  ],
                },
              ],
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "点击授权" },
              type: "primary_filled",
              width: "fill",
              size: "medium",
              behaviors: [{ type: "open_url", default_url: authorizeUrl }],
              margin: "0px 0px 8px 0px",
            },
          ],
        },
      }
      await this.gateway.sendCardMessage({ userOpenId, card })
      logger.info("authorization_card_sent", { user: hashIdentifier(userOpenId), replyTo: hashIdentifier(replyToMessageId) })
    } catch (error) {
      logger.error("authorization_card_send_failed", error, { user: hashIdentifier(userOpenId) })
    }
  }

  private startOAuthServer(): void {
    if (this.config.oauthCallbackPort <= 0) {
      logger.warn("oauth_server_disabled", { port: 0 })
      return
    }
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost")
      if (request.method === "GET" && url.pathname === "/oauth/callback") {
        void this.handleOAuthCallback(url, response)
        return
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      response.end("not found")
    })
    server.on("error", (error) => logger.error("oauth_server_error", error))
    this.oauthServer = server
    server.listen(this.config.oauthCallbackPort, () => {
      logger.info("oauth_server_listening", { port: this.config.oauthCallbackPort })
    })
  }

  private async handleOAuthCallback(url: URL, response: import("node:http").ServerResponse): Promise<void> {
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state") ?? ""
    const error = url.searchParams.get("error")
    const finish = (title: string, detail: string): void => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>授权结果</title></head>` +
          `<body style="font-family:-apple-system,sans-serif;text-align:center;padding-top:80px">` +
          `<h2>${title}</h2><p style="color:#666">${detail}</p>` +
          `<p style="color:#999;font-size:13px">可以回到飞书继续对话</p></body></html>`,
      )
    }
    if (error !== null) {
      finish("授权未完成", "你取消了授权；如需使用助理，请在飞书里重新发送任意消息")
      return
    }
    if (code === null || code === "") {
      finish("授权失败", "回调缺少授权码，请重试")
      return
    }
    const expectedUser = this.pendingStates.get(state) ?? null
    this.pendingStates.delete(state)
    try {
      const record = await this.tokenManager.exchangeCode(code)
      if (expectedUser !== null && record.ownerOpenId !== expectedUser) {
        logger.warn("oauth_state_user_mismatch", {
          expected: hashIdentifier(expectedUser),
          actual: hashIdentifier(record.ownerOpenId),
        })
      }
      logger.info("oauth_completed", { user: hashIdentifier(record.ownerOpenId) })
      finish("授权成功", "办公助理已可以使用，回到飞书发一条消息试试")
      // Greet the newly authorized user with the welcome card.
      const session = this.sessionProvider.sessionFor(record.ownerOpenId)
      void session
      try {
        await this.gateway.sendCardMessage({
          userOpenId: record.ownerOpenId,
          card: buildWelcomeCard(quickTasksFromConfig(this.config)),
        })
      } catch (welcomeError) {
        logger.error("post_oauth_welcome_failed", welcomeError)
      }
    } catch (exchangeError) {
      logger.error("oauth_exchange_failed", exchangeError)
      finish("授权失败", "授权码交换出错，请重新发起")
    }
  }

  /** Lists authorization status for observability. */
  status(): Record<string, unknown> {
    return {
      allowlist: this.config.allowedUserOpenIds.map(hashIdentifier),
      authorized: this.tokenStore.list().map((record) => ({
        user: hashIdentifier(record.ownerOpenId),
        name: record.ownerName,
        expiresAt: new Date(record.expiresAt).toISOString(),
      })),
    }
  }
}

export function ownerKeyHash(ownerOpenId: string): string {
  return createHash("sha256").update(ownerOpenId).digest("hex").slice(0, 12)
}

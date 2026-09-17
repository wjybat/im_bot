import * as Lark from "@larksuiteoapi/node-sdk"
import { logger } from "../infra/logger.js"
import { replyIdempotencyKey, truncateText } from "../infra/safety.js"
import {
  RunLarkCliUnsupportedError,
  type CardActionConsumerCallbacks,
  type CardActionEvent,
  type IncomingMessageEvent,
  type LarkGateway,
  type MessageConsumer,
  type MessageConsumerCallbacks,
  type OwnerIdentity,
} from "../types.js"
import {
  buildOAuthAuthorizeUrl,
  type AppCredentials,
  type UserTokenRecord,
} from "./token-store.js"

/** Wire format produced by lark-cli that normalize.ts already understands. */
interface WireMessage {
  message_id: string
  root_id: string | null
  parent_id: string | null
  thread_id: string | null
  chat_id: string
  chat_type?: string
  chat_name: string | null
  create_time: string
  update_time: string | null
  sender: { open_id: string | null; name: string | null; type: string | null; sender_type?: string | null }
  message_type: string
  content: unknown
  mentions?: Array<{ open_id: string; name?: string }>
}

interface RawMessageResource {
  message_id?: string
  root_id?: string | null
  parent_id?: string | null
  thread_id?: string | null
  chat_id?: string
  create_time?: string
  update_time?: string
  msg_type?: string
  body?: { content: string } | null
  sender?: { id: string; sender_type: string; sender_name?: string } | null
  mentions?: Array<{ key: string; id: string; name: string }> | null
}

interface OpenApiGatewayOptions {
  app: AppCredentials
  /** Resolves the current user token for a given owner, or null when absent. */
  getUserToken: (ownerOpenId: string) => UserTokenRecord | null
  /** Refreshes and persists the user token; returns the fresh record or throws. */
  refreshUserToken: (ownerOpenId: string) => Promise<UserTokenRecord>
  /** Extra scopes appended to the default OAuth authorize URL scope set. */
  extraScopes?: string[]
}

interface EventRegistration {
  [eventKey: string]: (data: unknown) => Promise<void> | void
}

const EVENT_HANDLER_TIMEOUT_MS = 2_500

export class OpenApiGateway implements LarkGateway {
  private readonly client: Lark.Client
  private readonly options: OpenApiGatewayOptions
  private wsMessage: Lark.WSClient | null = null
  private wsCard: Lark.WSClient | null = null
  private messageConsumerCallbacks: MessageConsumerCallbacks | null = null
  private cardConsumerCallbacks: CardActionConsumerCallbacks | null = null
  private activeOwnerOpenId = ""

  constructor(options: OpenApiGatewayOptions) {
    this.options = options
    this.client = new Lark.Client({
      appId: options.app.appId,
      appSecret: options.app.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
      domain: Lark.Domain.Feishu,
    })
  }

  // ---------------------------------------------------------------- identity

  async check(expectedOwnerOpenId?: string | null): Promise<OwnerIdentity & { version: string }> {
    const identity = await this.ensureUserIdentity(expectedOwnerOpenId)
    return { ...identity, version: "openapi-gateway" }
  }

  /**
   * Verifies the owner's user token via the authen user-info API, refreshing
   * it first when expired. `expectedOwnerOpenId === null` returns the app
   * identity with `no_owner_configured` (the supervisor fills the owner per
   * message).
   */
  async ensureUserIdentity(expectedOwnerOpenId?: string | null): Promise<OwnerIdentity> {
    const owner = expectedOwnerOpenId ?? null
    const appInfo: OwnerIdentity = {
      ownerOpenId: owner ?? "",
      ownerName: null,
      botName: null,
      botAppId: this.options.app.appId,
      tokenStatus: owner === null ? "no_owner_configured" : "user_token_missing",
    }
    if (owner === null || owner === "") return appInfo
    const token = await this.requireUserToken(owner)
    const userInfo = await this.client.authen.v1.userInfo.get(
      {},
      Lark.withUserAccessToken(token),
    )
    if (userInfo.code !== 0 || !userInfo.data) {
      return { ...appInfo, tokenStatus: "user_token_invalid" }
    }
    return {
      ownerOpenId: userInfo.data.open_id ?? owner,
      ownerName: userInfo.data.name ?? null,
      botName: null,
      botAppId: this.options.app.appId,
      tokenStatus: "valid",
    }
  }

  /** Builds the OAuth authorize URL for the given owner. */
  buildAuthorizeUrl(ownerOpenId: string, redirectUri: string, state: string): string {
    return buildOAuthAuthorizeUrl(
      { redirectUri, scopes: this.options.extraScopes ?? [], state: `${state}:${ownerOpenId}` },
      this.options.app,
    )
  }

  // ------------------------------------------------------------ read APIs

  async searchMessages(
    input: { query: string; start: string; end: string; chatType?: "p2p" | "group"; pageLimit: number; ownerOpenId?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const token = await this.requireUserToken(this.resolveReadOwner(input.ownerOpenId))
    const startMs = Date.parse(input.start)
    const endMs = Date.parse(input.end)
    const hits: WireMessage[] = []
    let pageToken: string | undefined
    let hasMore = false
    const pages = Math.max(1, Math.min(input.pageLimit, 40))
    for (let page = 0; page < pages; page += 1) {
      const response = await this.client.im.v1.message.search(
        {
          data: {
            query: input.query,
            ...(input.chatType ? { filter: { chat_type: input.chatType } } : {}),
          },
          params: {
            page_size: 50,
            ...(pageToken ? { page_token: pageToken } : {}),
            user_id_type: "open_id",
          },
        },
        { ...(signal ? { signal } : {}), ...Lark.withUserAccessToken(token) },
      )
      if (response.code !== 0 || !response.data) {
        throw new Error(`im message search failed: ${response.code} ${response.msg ?? ""}`)
      }
      for (const item of response.data.items ?? []) {
        const meta = item.meta_data
        if (!meta?.message_id || !meta.chat_id || meta.create_time === undefined) continue
        const sentMs = this.parseLarkTime(meta.create_time, startMs)
        if (sentMs < startMs || sentMs > endMs) continue
        hits.push({
          message_id: meta.message_id,
          root_id: null,
          parent_id: null,
          thread_id: meta.thread_id ?? null,
          chat_id: meta.chat_id,
          chat_type: meta.is_p2p_chat === true ? "p2p" : "group",
          chat_name: null,
          create_time: String(Math.trunc(sentMs)),
          update_time: null,
          sender: { open_id: meta.from_id ?? null, name: null, type: null },
          message_type: meta.type ?? "text",
          content: { text: "" },
        })
      }
      hasMore = response.data.has_more
      pageToken = response.data.page_token
      if (!hasMore || pageToken === undefined) break
    }
    // Search returns ids only; hydrate bodies in batches of 50.
    const messages: WireMessage[] = []
    for (let offset = 0; offset < hits.length; offset += 50) {
      const batch = hits.slice(offset, offset + 50)
      const hydrated = await this.fetchMessages(
        batch.map((message) => message.message_id),
        token,
        signal,
      )
      const byId = new Map(hydrated.map((message) => [message.message_id, message]))
      for (const hit of batch) {
        const full = byId.get(hit.message_id)
        if (full) {
          full.create_time = hit.create_time
          if (hit.chat_type !== undefined) full.chat_type = hit.chat_type
          messages.push(full)
        }
      }
    }
    return { has_more: hasMore, messages }
  }

  async getMessagesByIds(messageIds: string[], signal?: AbortSignal, ownerOpenId?: string): Promise<unknown> {
    const unique = [...new Set(messageIds)].filter((id) => id.trim() !== "").slice(0, 50)
    if (unique.length === 0) return { messages: [] }
    const token = await this.requireUserToken(this.resolveReadOwner(ownerOpenId))
    const messages = await this.fetchMessages(unique, token, signal)
    return { has_more: false, messages }
  }

  private async fetchMessages(
    messageIds: string[],
    userToken: string,
    signal?: AbortSignal,
  ): Promise<WireMessage[]> {
    const results: WireMessage[] = []
    for (const messageId of messageIds) {
      const response = await this.client.im.v1.message.get(
        { path: { message_id: messageId }, params: { user_id_type: "open_id" } },
        { ...(signal ? { signal } : {}), ...Lark.withUserAccessToken(userToken) },
      ).catch((error) => {
        logger.warn("openapi_message_get_failed", { messageId, error: String(error).slice(0, 200) })
        return null
      })
      if (response === null || response.code !== 0) continue
      const item = (response.data?.items ?? [])[0] as RawMessageResource | undefined
      if (item === undefined) continue
      const wire = this.toWireMessage(item)
      if (wire !== null) results.push(wire)
    }
    return results
  }

  private toWireMessage(item: RawMessageResource): WireMessage | null {
    if (!item.message_id || !item.chat_id) return null
    return {
      message_id: item.message_id,
      root_id: item.root_id ?? null,
      parent_id: item.parent_id ?? null,
      thread_id: item.thread_id ?? null,
      chat_id: item.chat_id,
      chat_name: null,
      create_time: item.create_time ?? String(Date.now()),
      update_time: item.update_time ?? null,
      sender: {
        open_id: item.sender?.id ?? null,
        name: item.sender?.sender_name ?? null,
        type: item.sender?.sender_type ?? null,
        sender_type: item.sender?.sender_type ?? null,
      },
      message_type: item.msg_type ?? "text",
      content: this.parseBodyContent(item.body?.content),
      mentions: (item.mentions ?? []).map((mention) => ({
        open_id: mention.id,
        name: mention.name,
      })),
    }
  }

  private parseBodyContent(content: string | undefined): unknown {
    if (content === undefined || content === "") return { text: "" }
    try {
      return JSON.parse(content)
    } catch {
      return { text: content }
    }
  }

  async listChatMessages(
    input: { chatId: string; start?: string; end?: string; order: "asc" | "desc"; pageSize: number; ownerOpenId?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const token = await this.requireUserToken(this.resolveReadOwner(input.ownerOpenId))
    const response = await this.client.im.v1.message.list(
      {
        params: {
          container_id_type: "chat_id",
          container_id: input.chatId,
          ...(input.start ? { start_time: String(Math.trunc(Date.parse(input.start) / 1000)) } : {}),
          ...(input.end ? { end_time: String(Math.trunc(Date.parse(input.end) / 1000)) } : {}),
          sort_type: input.order === "asc" ? "ByCreateTimeAsc" : "ByCreateTimeDesc",
          page_size: Math.min(input.pageSize, 50),
        },
      },
      { ...(signal ? { signal } : {}), ...Lark.withUserAccessToken(token) },
    )
    if (response.code !== 0) throw new Error(`im message list failed: ${response.code} ${response.msg ?? ""}`)
    const messages = (response.data?.items ?? [])
      .map((item) => this.toWireMessage(item as RawMessageResource))
      .flatMap((item) => (item === null ? [] : [item]))
    return {
      has_more: response.data?.has_more ?? false,
      page_token: response.data?.page_token,
      messages,
    }
  }

  async listThreadMessages(
    input: { threadId: string; order: "asc" | "desc"; pageSize: number; ownerOpenId?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const token = await this.requireUserToken(this.resolveReadOwner(input.ownerOpenId))
    const response = await this.client.im.v1.message.list(
      {
        params: {
          container_id_type: "thread_id",
          container_id: input.threadId,
          sort_type: input.order === "asc" ? "ByCreateTimeAsc" : "ByCreateTimeDesc",
          page_size: Math.min(input.pageSize, 50),
        },
      },
      { ...(signal ? { signal } : {}), ...Lark.withUserAccessToken(token) },
    )
    if (response.code !== 0) throw new Error(`im thread list failed: ${response.code} ${response.msg ?? ""}`)
    const messages = (response.data?.items ?? [])
      .map((item) => this.toWireMessage(item as RawMessageResource))
      .flatMap((item) => (item === null ? [] : [item]))
    return { has_more: response.data?.has_more ?? false, messages }
  }

  async getAgenda(input: { start: string; end: string; ownerOpenId?: string }, signal?: AbortSignal): Promise<unknown> {
    const token = await this.requireUserToken(this.resolveReadOwner(input.ownerOpenId))
    const response = await this.client.calendar.v4.calendarEvent.list(
      {
        params: {
          start_time: String(Date.parse(input.start)),
          end_time: String(Date.parse(input.end)),
          page_size: 50,
          user_id_type: "open_id",
        },
        path: { calendar_id: "primary" },
      },
      { ...(signal ? { signal } : {}), ...Lark.withUserAccessToken(token) },
    ).catch(() => null)
    return { events: response?.data?.items ?? [] }
  }

  async getIncompleteTasks(input: { pageLimit: number; ownerOpenId?: string }, signal?: AbortSignal): Promise<unknown> {
    const token = await this.requireUserToken(this.resolveReadOwner(input.ownerOpenId))
    const tasks: unknown[] = []
    let pageToken: string | undefined
    for (let page = 0; page < Math.min(input.pageLimit, 10); page += 1) {
      const response = await this.client.task.v2.task.list(
        {
          params: {
            page_size: 50,
            user_id_type: "open_id",
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        },
        { ...(signal ? { signal } : {}), ...Lark.withUserAccessToken(token) },
      ).catch(() => null)
      if (response === null || response.code !== 0) break
      tasks.push(...(response.data?.items ?? []))
      if (!response.data?.has_more || response.data?.page_token === undefined) break
      pageToken = response.data.page_token
    }
    return { has_more: false, items: tasks }
  }

  async runReadOnlyCli(): Promise<{ stdout: string }> {
    throw new RunLarkCliUnsupportedError()
  }

  /**
   * Resolves display names for ingestion backfill: chat titles via
   * im.chats.get, sender names via im.chats.members (paged, user token).
   * Missing entries are simply absent from the returned maps.
   */
  async resolveDisplayNames(input: {
    chatIds: readonly string[]
    senderIds: readonly string[]
    ownerOpenId?: string
  }): Promise<{ chatTitles: Map<string, string>; senderNames: Map<string, string> }> {
    const chatTitles = new Map<string, string>()
    const senderNames = new Map<string, string>()
    const owner = this.resolveReadOwner(input.ownerOpenId)
    for (const chatId of [...new Set(input.chatIds)]) {
      if (!chatId.startsWith("oc_")) continue
      const response = await this.client.im.v1.chat.get(
        { path: { chat_id: chatId } },
        Lark.withUserAccessToken(await this.requireUserToken(owner)),
      ).catch(() => null)
      if (response?.code === 0 && response.data?.name) chatTitles.set(chatId, response.data.name)
    }
    const unresolved = new Set(
      [...new Set(input.senderIds)].filter((id) => id.startsWith("ou_") && !senderNames.has(id)),
    )
    if (unresolved.size > 0) {
      for (const chatId of [...new Set(input.chatIds)]) {
        if (!chatId.startsWith("oc_") || unresolved.size === 0) continue
        let pageToken: string | undefined
        for (let page = 0; page < 5; page += 1) {
          const response = await this.client.im.v1.chatMembers.get(
            {
              params: {
                member_id_type: "open_id",
                page_size: 100,
                ...(pageToken ? { page_token: pageToken } : {}),
              },
              path: { chat_id: chatId },
            },
            Lark.withUserAccessToken(await this.requireUserToken(owner)),
          ).catch(() => null)
          if (response?.code !== 0) break
          for (const member of response.data?.items ?? []) {
            const id = member.member_id ?? ""
            const name = member.name ?? ""
            if (id !== "" && name !== "" && unresolved.has(id)) {
              senderNames.set(id, name)
              unresolved.delete(id)
            }
          }
          if (!response.data?.has_more || response.data?.page_token === undefined) break
          pageToken = response.data.page_token
        }
      }
    }
    return { chatTitles, senderNames }
  }

  // ------------------------------------------------------------ write APIs

  async replyToMessage(
    messageId: string,
    markdown: string,
    stage: "processing" | "final" | "error" | "overloaded" = "final",
  ): Promise<void> {
    const key = this.replyKey(messageId, stage)
    try {
      const response = await this.client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ zh_cn: { content: [[{ tag: "md", text: markdown }]] } }),
          msg_type: "post",
          uuid: key,
        },
      })
      if (response.code !== 0) throw new Error(`reply failed: ${response.code} ${response.msg ?? ""}`)
    } catch (postError) {
      const response = await this.client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text: truncateText(markdown, 6_000) }),
          msg_type: "text",
          uuid: `${key}:text`,
        },
      })
      if (response.code !== 0) {
        throw new Error(
          `both post and text replies failed: ${postError instanceof Error ? postError.message : String(postError)}`,
        )
      }
    }
  }

  async sendCardMessage(input: { userOpenId: string; card: unknown }): Promise<{ messageId: string }> {
    const response = await this.client.im.v1.message.create({
      params: { receive_id_type: "open_id" },
      data: {
        receive_id: input.userOpenId,
        msg_type: "interactive",
        content: JSON.stringify(input.card),
      },
    })
    if (response.code !== 0 || !response.data?.message_id) {
      throw new Error(`card send failed: ${response.code} ${response.msg ?? ""}`)
    }
    return { messageId: response.data.message_id }
  }

  private replyKey(messageId: string, stage: string): string {
    return replyIdempotencyKey(messageId, stage)
  }

  // ------------------------------------------------------------ consumers

  startMessageConsumer(callbacks: MessageConsumerCallbacks): MessageConsumer {
    this.messageConsumerCallbacks = callbacks
    return this.startWsConsumer(callbacks)
  }

  startCardActionConsumer(callbacks: CardActionConsumerCallbacks): MessageConsumer {
    this.cardConsumerCallbacks = callbacks
    return this.startWsConsumer(callbacks)
  }

  private startWsConsumer(callbacks: MessageConsumerCallbacks | CardActionConsumerCallbacks): MessageConsumer {
    let settled = false
    let readyResolve: () => void = () => undefined
    let readyReject: (error: unknown) => void = () => undefined
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    const ws = new Lark.WSClient({
      appId: this.options.app.appId,
      appSecret: this.options.app.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
      domain: Lark.Domain.Feishu,
      onReady: () => {
        if (!settled) {
          settled = true
          readyResolve()
        }
        callbacks.onDiagnostic?.("ready")
      },
      onError: (error: unknown) => {
        logger.error(
          "openapi_ws_error",
          error instanceof Error ? error : new Error(String(error)),
        )
        if (!settled) {
          settled = true
          readyReject(error instanceof Error ? error : new Error(String(error)))
        }
      },
      onReconnecting: () => callbacks.onDiagnostic?.("exited"),
      onReconnected: () => callbacks.onDiagnostic?.("connected"),
    })
    const dispatch = (key: "im.message.receive_v1" | "card.action.trigger", data: unknown): Promise<void> => {
      const run = (async () => {
        if (key === "im.message.receive_v1") {
          const event = this.adaptMessageEvent(data)
          if (event !== null && this.messageConsumerCallbacks !== null) this.messageConsumerCallbacks.onEvent(event)
        } else {
          const event = this.adaptCardActionEvent(data)
          if (event !== null && this.cardConsumerCallbacks !== null) this.cardConsumerCallbacks.onEvent(event)
        }
      })()
      return run
    }
    const wrap = (key: "im.message.receive_v1" | "card.action.trigger"): NonNullable<EventRegistration["im.message.receive_v1"]> => {
      return async (data: unknown) => {
        try {
          await Promise.race([
            dispatch(key, data),
            new Promise((resolve) => setTimeout(resolve, EVENT_HANDLER_TIMEOUT_MS)),
          ])
        } catch (error) {
          logger.error(
            "openapi_event_handler_failed",
            error instanceof Error ? error : new Error(String(error)),
            { eventKey: key },
          )
        }
      }
    }
    // Feishu load-balances events across all of an app's live long
    // connections, so every connection registers handlers for both event
    // types; a consumer that has not started yet simply drops its events
    // (callbacks null), same as a dedicated single-type connection would.
    const registration: EventRegistration = {
      "im.message.receive_v1": wrap("im.message.receive_v1"),
      "card.action.trigger": wrap("card.action.trigger"),
    }
    void ws
      .start({ eventDispatcher: new Lark.EventDispatcher({}).register(registration) })
      .catch((error: unknown) => {
        if (!settled) {
          settled = true
          readyReject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    if (callbacks === this.messageConsumerCallbacks) this.wsMessage = ws
    else this.wsCard = ws
    return {
      ready,
      stop: () => ws.close({ force: true }),
    }
  }

  /** Adapts an im.message.receive_v1 (v2.0) event into the flat shape service.ts expects. */
  private adaptMessageEvent(data: unknown): IncomingMessageEvent | null {
    const event = data as {
      message?: {
        message_id?: string
        chat_id?: string
        chat_type?: string
        message_type?: string
        content?: string
        create_time?: string
      }
      sender?: { sender_id?: { open_id?: string }; sender_type?: string; type?: string }
    }
    const message = event.message
    if (!message?.message_id || !message.chat_id) return null
    return {
      chat_type: message.chat_type,
      sender_type: event.sender?.sender_type ?? event.sender?.type ?? "user",
      sender_id: event.sender?.sender_id?.open_id,
      message_id: message.message_id,
      message_type: message.message_type,
      content: message.content,
      create_time: message.create_time,
      chat_id: message.chat_id,
    }
  }

  /** Adapts a card.action.trigger event into the flat shape service.ts expects. */
  private adaptCardActionEvent(data: unknown): CardActionEvent | null {
    return adaptCardActionEvent(data)
  }

  // ------------------------------------------------------------ helpers

  /** Sets the owner whose user token backs owner-scoped read APIs. */
  setActiveOwner(ownerOpenId: string): void {
    this.activeOwnerOpenId = ownerOpenId
  }

  /**
   * Resolves the owner for an owner-scoped read: an explicit per-call owner
   * wins (multi-tenant concurrent safety), the pinned active owner is the
   * single-owner fallback.
   */
  private resolveReadOwner(explicit: string | undefined): string {
    if (explicit !== undefined && explicit !== "") return explicit
    if (this.activeOwnerOpenId !== "") return this.activeOwnerOpenId
    throw new Error("no owner set; pass ownerOpenId or call setActiveOwner before owner-scoped reads")
  }

  private async requireUserToken(ownerOpenId: string): Promise<string> {
    const record = this.options.getUserToken(ownerOpenId)
    if (record === null) throw new Error("user token missing; OAuth authorization required")
    if (record.expiresAt - 60_000 > Date.now()) return record.userAccessToken
    const fresh = await this.options.refreshUserToken(ownerOpenId)
    return fresh.userAccessToken
  }

  /** Feishu create_time can be epoch seconds or milliseconds. */
  private parseLarkTime(value: string, fallback: number): number {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 10_000_000_000 ? numeric * 1000 : numeric
    }
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
}

/**
 * Adapts a raw card.action.trigger event (v2 schema: ids nested under
 * `context`, operator under `operator`, action under `action`) into the flat
 * shape service.ts expects. Falls back to flat fields and returns null when
 * message, chat, or operator cannot be resolved.
 */
export function adaptCardActionEvent(data: unknown): CardActionEvent | null {
  const event = data as {
    event_id?: unknown
    operator_id?: { open_id?: unknown } | unknown
    operator?: { open_id?: unknown } | undefined
    message_id?: unknown
    chat_id?: unknown
    context?: { open_message_id?: unknown; open_chat_id?: unknown }
    open_message_id?: unknown
    open_chat_id?: unknown
    action?: { tag?: unknown; value?: unknown }
    action_tag?: unknown
    action_value?: unknown
  }
  const message =
    typeof event.message_id === "string"
      ? event.message_id
      : typeof event.context?.open_message_id === "string"
        ? event.context.open_message_id
        : typeof event.open_message_id === "string"
          ? event.open_message_id
          : undefined
  const chat =
    typeof event.chat_id === "string"
      ? event.chat_id
      : typeof event.context?.open_chat_id === "string"
        ? event.context.open_chat_id
        : typeof event.open_chat_id === "string"
          ? event.open_chat_id
          : undefined
  const operator =
    typeof event.operator_id === "string"
      ? event.operator_id
      : typeof (event.operator_id as { open_id?: unknown } | null)?.open_id === "string"
        ? (event.operator_id as { open_id: string }).open_id
        : typeof event.operator?.open_id === "string"
          ? event.operator.open_id
          : undefined
  if (message === undefined || chat === undefined || operator === undefined) return null
  return {
    event_id: event.event_id,
    operator_id: operator,
    message_id: message,
    chat_id: chat,
    action_tag:
      event.action_tag !== undefined
        ? event.action_tag
        : event.action?.tag !== undefined
          ? event.action.tag
          : "button",
    action_value: event.action_value !== undefined ? event.action_value : event.action?.value,
  }
}

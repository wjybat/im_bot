import type { RuntimeConfig } from "../types.js"
import type { AppCredentials } from "./token-store.js"

export interface TenantDefinition {
  /** Stable slug used for paths, logs, and the supervisor registry. */
  tenantId: string
  /** Feishu custom-app credentials owned by the merchant's enterprise. */
  app: AppCredentials
  /** Display name for logs and human-facing state. */
  displayName: string
  /** Users allowed to talk to the bot within this tenant. Empty = anyone in the app's availability. */
  allowedUserOpenIds: string[]
  /** Whether new users must complete user OAuth before the bot processes their messages. */
  requireUserOAuth: boolean
  /** Public HTTPS base for OAuth callbacks, e.g. https://bots.example.com */
  publicBaseUrl: string
  /** Enabled tenants run; disabled tenants stay stopped. */
  enabled: boolean
}

export interface TenantRuntimeFiles {
  /** Derived from tenantId; supervisor places all state under this root. */
  stateRoot: string
}

/** Base configuration shared by all tenants (model, budgets, schedules). */
export type TenantBaseConfig = RuntimeConfig

export const TENANT_USER_SCOPES: readonly string[] = [
  "search:message",
  "im:message",
  "im:message:readonly",
  "im:message.p2p_msg:get_as_user",
  "im:message.group_msg:get_as_user",
  "im:chat:read",
  "im:chat.members:read",
  "im:message.reactions:read",
  "calendar:calendar.event:read",
  "task:task:read",
  "task:tasklist:read",
  "mail:user_mailbox.message:readonly",
  "docs:document.content:read",
  "contact:user.basic_profile:readonly",
  "auth:user.id:read",
  "offline_access",
]

export const TENANT_EVENT_SUBSCRIPTIONS: readonly string[] = [
  "im.message.receive_v1",
  "card.action.trigger",
]

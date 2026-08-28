import { createHash } from "node:crypto"

export function hashIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12)
}

export function replyIdempotencyKey(messageId: string, stage: string): string {
  return `piimbot-${createHash("sha256").update(`${messageId}:${stage}`).digest("hex").slice(0, 32)}`
}

export function truncateText(text: string, maxChars: number, suffix = "\n\n（内容已截断）"): string {
  const normalized = String(text).replaceAll("\u0000", "").trim()
  const chars = Array.from(normalized)
  if (chars.length <= maxChars) return normalized
  return `${chars.slice(0, Math.max(0, maxChars - Array.from(suffix).length)).join("")}${suffix}`
}

export function redactInternalIdentifiers(text: string): string {
  return text
    .replace(
      /\b(?:cli|ou|oc|om|omt|on|od|ofg|file|img)_[A-Za-z0-9_-]{6,}\b/gu,
      "[内部标识已隐藏]",
    )
    .replace(/\bmem_[a-f0-9]{64}\b/gu, "[内部证据标识已隐藏]")
}

export function safeError(error: unknown): { type: string; message: string } {
  if (!(error instanceof Error)) return { type: "unknown", message: "unknown error" }
  return { type: error.name, message: error.message.slice(0, 500) }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

import { safeError } from "./safety.js"

function emit(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields })}\n`)
}

export const logger = Object.freeze({
  info(event: string, fields: Record<string, unknown> = {}): void {
    emit("info", event, fields)
  },
  warn(event: string, fields: Record<string, unknown> = {}): void {
    emit("warn", event, fields)
  },
  error(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
    emit("error", event, { ...fields, error: safeError(error) })
  },
})

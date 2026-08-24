import { safeError } from "./util.mjs"

function emit(level, event, fields = {}) {
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields })}\n`,
  )
}

export const logger = Object.freeze({
  info(event, fields) {
    emit("info", event, fields)
  },
  warn(event, fields) {
    emit("warn", event, fields)
  },
  error(event, error, fields = {}) {
    emit("error", event, { ...fields, error: safeError(error) })
  },
})

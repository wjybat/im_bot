#!/usr/bin/env node
import { mkdir } from "node:fs/promises"
import { loadConfig } from "./config.mjs"
import { runCodex } from "./codex.mjs"
import { logger } from "./logger.mjs"
import { ImBotService } from "./service.mjs"

async function main() {
  const config = loadConfig()
  await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 })
  const service = new ImBotService(config)

  if (process.argv.includes("--check")) {
    const result = await service.check()
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
    return
  }

  if (process.argv.includes("--codex-smoke")) {
    await service.check()
    const result = await runCodex(
      config,
      "请使用飞书授权状态的只读命令检查当前用户身份是否有效。只回答“有效”或“无效”，不要展示姓名、ID、scope 或任何凭据。",
    )
    process.stdout.write(
      `${JSON.stringify({ reply: result.reply, commandDiagnostics: result.commandDiagnostics }, null, 2)}\n`,
    )
    return
  }

  const stop = async (signal) => {
    logger.info("signal_received", { signal })
    await service.stop()
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.once("SIGINT", () => void stop("SIGINT"))
  process.once("SIGTERM", () => void stop("SIGTERM"))

  await service.start()
}

main().catch((error) => {
  logger.error("fatal", error)
  process.exitCode = 1
})

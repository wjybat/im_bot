#!/usr/bin/env node
import { loadConfig } from "./config.js"
import { LarkCliGateway } from "./adapters/lark-cli.js"
import { createConfiguredModels } from "./agent/model.js"
import { createDemoPiRuntime, createLivePiRuntime } from "./agent/pi-runtime.js"
import { MockLarkGateway } from "./demo/mock-lark.js"
import { logger } from "./infra/logger.js"
import { hashIdentifier } from "./infra/safety.js"
import { PiBotService } from "./service.js"

function usage(): never {
  throw new Error(
    "usage: tsx src/main.ts <demo [prompt] | smoke-lark | models | check | once <prompt> | listen>",
  )
}

async function runDemo(prompt: string): Promise<void> {
  const config = loadConfig()
  const gateway = new MockLarkGateway()
  const now = new Date("2026-08-25T02:30:00Z")
  const runtime = await createDemoPiRuntime(config, gateway, now)
  const result = await runtime.run({
    text: prompt,
    requestId: "offline-demo",
    sessionId: "offline-demo-session",
    now,
  })
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        mode: "offline-faux-provider",
        reply: result.reply,
        trace: { turns: result.turns, tools: result.tools, larkCalls: gateway.calls.map((call) => call.method) },
        usage: result.usage,
      },
      null,
      2,
    )}\n`,
  )
}

async function runLarkSmoke(): Promise<void> {
  const config = loadConfig()
  const gateway = new LarkCliGateway(config)
  const identity = await gateway.check(config.allowedUserOpenId)
  const now = new Date()
  const runtime = await createDemoPiRuntime(config, gateway, now)
  const result = await runtime.run({
    text: "验证专用 Skill 和当天飞书消息只读工具链",
    requestId: "lark-smoke",
    sessionId: "lark-smoke-session",
    now,
  })
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        mode: "faux-model-with-live-read-only-lark-tools",
        owner: hashIdentifier(identity.ownerOpenId),
        trace: { turns: result.turns, tools: result.tools },
        usage: result.usage,
        externalWrites: 0,
      },
      null,
      2,
    )}\n`,
  )
}

async function runCheck(): Promise<void> {
  const config = loadConfig()
  const gateway = new LarkCliGateway(config)
  const runtime = await createLivePiRuntime(config, gateway)
  const [lark, pi] = await Promise.all([gateway.check(config.allowedUserOpenId), runtime.check()])
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        larkVersion: lark.version,
        owner: hashIdentifier(lark.ownerOpenId),
        provider: pi.provider,
        model: pi.model,
        modelAuth: pi.auth,
      },
      null,
      2,
    )}\n`,
  )
}

function listModels(): void {
  const config = loadConfig()
  const models = createConfiguredModels(config)
  process.stdout.write(
    `${JSON.stringify(
      {
        provider: config.provider,
        models: models.getModels(config.provider).map((model) => ({
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          contextWindow: model.contextWindow,
        })),
      },
      null,
      2,
    )}\n`,
  )
}

async function runOnce(prompt: string): Promise<void> {
  const config = loadConfig()
  const gateway = new LarkCliGateway(config)
  const identity = await gateway.check(config.allowedUserOpenId)
  const runtime = await createLivePiRuntime(config, gateway)
  const result = await runtime.run({
    text: prompt,
    requestId: "local-once",
    sessionId: `local-owner-${hashIdentifier(identity.ownerOpenId)}`,
  })
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
}

async function runListener(): Promise<void> {
  const config = loadConfig()
  const gateway = new LarkCliGateway(config)
  const runtime = await createLivePiRuntime(config, gateway)
  const service = new PiBotService(config, gateway, runtime)
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info("signal_received", { signal })
    await service.stop()
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.once("SIGINT", () => void stop("SIGINT"))
  process.once("SIGTERM", () => void stop("SIGTERM"))
  await service.start()
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === "demo") {
    await runDemo(args.join(" ").trim() || "整理一下今天有什么需要我处理的事情")
  } else if (command === "smoke-lark") {
    await runLarkSmoke()
  } else if (command === "models") {
    listModels()
  } else if (command === "check") {
    await runCheck()
  } else if (command === "once") {
    const prompt = args.join(" ").trim()
    if (!prompt) usage()
    await runOnce(prompt)
  } else if (command === "listen") {
    await runListener()
  } else {
    usage()
  }
}

main().catch((error) => {
  logger.error("fatal", error)
  process.exitCode = 1
})

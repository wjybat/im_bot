#!/usr/bin/env node
import { rm, stat } from "node:fs/promises"
import { loadConfig } from "./config.js"
import { LarkCliGateway } from "./adapters/lark-cli.js"
import { createConfiguredModels, createModelRuntime } from "./agent/model.js"
import { MemoryWarmer } from "./agent/memory-warmer.js"
import { createDemoPiRuntime, createLivePiRuntime } from "./agent/pi-runtime.js"
import { MockLarkGateway } from "./demo/mock-lark.js"
import { logger } from "./infra/logger.js"
import { hashIdentifier } from "./infra/safety.js"
import { PiBotService } from "./service.js"
import { MultiUserService } from "./tenant/multi-user-service.js"
import { MultiUserWarmer } from "./tenant/multi-user-warmer.js"
import { OwnerMemoryRouter } from "./tenant/memory-router.js"
import { TenantTokenStore } from "./tenant/token-store.js"
import { UserTokenManager } from "./tenant/token-manager.js"
import { OpenApiGateway } from "./tenant/openapi-gateway.js"
import { TENANT_USER_SCOPES } from "./tenant/types.js"
import { PiAgentRuntime } from "./agent/pi-runtime.js"
import { loadRuntimeSkills } from "./agent/skills.js"

function usage(): never {
  throw new Error(
    "usage: tsx src/main.ts <demo [prompt] | smoke-lark | models | check | once <prompt> | listen | reset [--yes]>",
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

async function runReset(confirmed: boolean): Promise<void> {
  const config = loadConfig()
  const candidates = [config.memoryFile, `${config.memoryFile}-wal`, `${config.memoryFile}-shm`]
  const targets: { path: string; size: number }[] = []
  for (const path of candidates) {
    try {
      targets.push({ path, size: (await stat(path)).size })
    } catch {
      // Missing sidecar files are expected after a clean shutdown.
    }
  }
  if (targets.length === 0) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, deleted: [], message: "memory database not found; nothing to reset" }, null, 2)}\n`,
    )
    return
  }
  if (!confirmed) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          action: "reset-memory",
          targets,
          warning:
            "this deletes all pulled chat records and extracted graph data; stop the listen service first",
          hint: "re-run with --yes to confirm",
        },
        null,
        2,
      )}\n`,
    )
    process.exitCode = 1
    return
  }
  for (const target of targets) await rm(target.path, { force: true })
  process.stdout.write(
    `${JSON.stringify({ ok: true, deleted: targets.map((target) => target.path) }, null, 2)}\n`,
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
  if (config.allowedUserOpenIds.length > 0 || process.env.IM_BOT_PI_MULTI_USER === "1") {
    await runMultiUserListener(config)
    return
  }
  const gateway = new LarkCliGateway(config)
  const runtime = await createLivePiRuntime(config, gateway)
  const service = new PiBotService(config, gateway, runtime)
  const warmer = new MemoryWarmer({
    config,
    gateway,
    memory: runtime.memory,
    semantic: runtime.semantic,
    onWarmedOnce: () => void service.sendWelcomeCardAfterWarmUp(),
  })
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info("signal_received", { signal })
    await warmer.stop()
    await service.stop()
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.once("SIGINT", () => void stop("SIGINT"))
  process.once("SIGTERM", () => void stop("SIGTERM"))
  await service.start()
  warmer.start()
}

/**
 * Multi-user (single-tenant) mode: one Feishu app, several colleagues each
 * OAuth-authorizing the app, per-owner memory/history isolation, direct
 * OpenAPI access instead of lark-cli.
 */
async function runMultiUserListener(config: ReturnType<typeof loadConfig>): Promise<void> {
  const appId = process.env.IM_BOT_PI_MULTI_APP_ID
  const appSecret = process.env.IM_BOT_PI_MULTI_APP_SECRET
  if (!appId || !appSecret) {
    throw new Error("multi-user mode requires IM_BOT_PI_MULTI_APP_ID and IM_BOT_PI_MULTI_APP_SECRET")
  }
  const stateRoot = config.projectRoot
  const tokenStore = new TenantTokenStore(`${stateRoot}/var/tenant-user-tokens.json`, { appId, appSecret })
  await tokenStore.load()
  const tokenManager = new UserTokenManager({
    app: { appId, appSecret },
    store: { get: (id) => tokenStore.get(id), upsert: (record) => tokenStore.upsert(record) },
  })
  const ownerNames = new Map<string, string | null>()
  for (const record of tokenStore.list()) ownerNames.set(record.ownerOpenId, record.ownerName)
  const modelRuntime = createModelRuntime(config)
  const skills = await loadRuntimeSkills(config.projectRoot, config.skillsDir)
  const router = new OwnerMemoryRouter({
    config,
    modelRuntime,
    assistantBotExternalId: appId,
    assistantBotName: null,
    ownerNames,
  })
  const tokenGet = (ownerOpenId: string) => tokenStore.get(ownerOpenId)
  const tokenRefresh = (ownerOpenId: string) => tokenManager.refresh(ownerOpenId)
  const gateway = new OpenApiGateway({
    app: { appId, appSecret },
    getUserToken: tokenGet,
    refreshUserToken: tokenRefresh,
    extraScopes: [...TENANT_USER_SCOPES],
  })
  const bootstrapOwner = tokenStore.list()[0]?.ownerOpenId ?? "bootstrap"
  const anySession = router.sessionFor(bootstrapOwner)
  const runtime = new PiAgentRuntime({
    config,
    gateway,
    models: modelRuntime.models,
    model: modelRuntime.model,
    streamFn: modelRuntime.models.streamSimple.bind(modelRuntime.models),
    skills,
    memory: anySession.memory,
    semantic: anySession.semantic,
    sessionProvider: router,
  })
  const service = new MultiUserService({
    config,
    gateway,
    tokenStore,
    tokenManager,
    runtime,
    sessionProvider: router,
    buildAuthorizeUrl: (ownerOpenId, redirectUri, state) => gateway.buildAuthorizeUrl(ownerOpenId, redirectUri, state),
    setActiveOwner: (ownerOpenId) => gateway.setActiveOwner(ownerOpenId),
  })
  const warmer = new MultiUserWarmer({
    config,
    gateway,
    router,
    warmOwners: () =>
      tokenStore.list().map((record) => ({ ownerOpenId: record.ownerOpenId, ownerName: record.ownerName })),
    onWarmedOnce: () => undefined,
  })
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info("signal_received", { signal })
    await warmer.stop()
    await service.stop()
    router.close()
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.once("SIGINT", () => void stop("SIGINT"))
  process.once("SIGTERM", () => void stop("SIGTERM"))
  await service.start()
  warmer.start()
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
  } else if (command === "reset") {
    await runReset(args.includes("--yes"))
  } else {
    usage()
  }
}

main().catch((error) => {
  logger.error("fatal", error)
  process.exitCode = 1
})

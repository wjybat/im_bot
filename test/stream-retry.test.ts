import assert from "node:assert/strict"
import test from "node:test"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai"
import { PiAgentRuntime } from "../src/agent/pi-runtime.js"
import { loadConfig } from "../src/config.js"
import { loadRuntimeSkills } from "../src/agent/skills.js"
import { OfficeMemory } from "../src/memory/index.js"
import { createTestSemantic } from "./fakes.js"
import { LarkCliGateway } from "../src/adapters/lark-cli.js"
import type { StreamFn } from "@earendil-works/pi-agent-core"
import type { Api, Context, Model, Models } from "@earendil-works/pi-ai"

/**
 * Wraps the real streamSimple so the first `failures` calls throw a transient
 * stream interruption; later calls delegate to the scripted faux provider.
 */
function flakyStream(models: Models, failures: number): StreamFn {
  let calls = 0
  const fn = (model: Model<Api>, context: Context, options: Parameters<StreamFn>[2]) => {
    calls += 1
    if (calls <= failures) {
      return Promise.reject(
        new Error("OpenAI Responses stream ended before a terminal response event"),
      )
    }
    return models.streamSimple(model, context, options)
  }
  return fn as unknown as StreamFn
}

async function makeRuntime(config: ReturnType<typeof loadConfig>, failures: number, reply: string) {
  const faux = fauxProvider({ provider: `faux-stream-retry-${failures}` })
  const models = createModels()
  models.setProvider(faux.provider)
  const model = faux.getModel()
  if (!model) throw new Error("faux model unavailable")
  faux.setResponses([fauxAssistantMessage([fauxText(reply)])])
  const gateway = new LarkCliGateway(config)
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "ou_owner" })
  const semantic = createTestSemantic(memory, config)
  const skills = await loadRuntimeSkills(config.projectRoot, config.skillsDir)
  const runtime = new PiAgentRuntime({
    config,
    gateway,
    models,
    model,
    streamFn: flakyStream(models, failures) as never,
    skills,
    memory,
    semantic,
  })
  return { runtime, memory }
}

test("runtime retries transient stream interruptions and succeeds", async (t) => {
  const config = { ...loadConfig(), runtimeStreamRetries: 2, runtimeStreamRetryDelayMs: 1, maxTurns: 3 }
  const { runtime, memory } = await makeRuntime(config, 2, "恢复后的正常回答")
  t.after(() => memory.close())
  const result = await runtime.run({
    text: "随便问点什么",
    requestId: "stream-retry-test",
    sessionId: "stream-retry-test",
  })
  assert.match(result.reply, /恢复后的正常回答/)
})

test("runtime gives up after exhausting stream retries", async (t) => {
  const config = { ...loadConfig(), runtimeStreamRetries: 1, runtimeStreamRetryDelayMs: 1, maxTurns: 3 }
  const { runtime, memory } = await makeRuntime(config, 99, "不会被用到")
  t.after(() => memory.close())
  await assert.rejects(
    runtime.run({
      text: "随便问点什么",
      requestId: "stream-retry-exhaust",
      sessionId: "stream-retry-exhaust",
    }),
    /stream ended before a terminal response event/,
  )
})

test("runtime does not retry non-stream failures", async (t) => {
  const config = { ...loadConfig(), runtimeStreamRetries: 3, runtimeStreamRetryDelayMs: 1, maxTurns: 3 }
  const faux = fauxProvider({ provider: "faux-stream-no-retry" })
  const models = createModels()
  models.setProvider(faux.provider)
  const model = faux.getModel()
  if (!model) throw new Error("faux model unavailable")
  let calls = 0
  const streamFn = ((): StreamFn => {
    const fn = () => {
      calls += 1
      return Promise.reject(new Error("some permanent model error"))
    }
    return fn as unknown as StreamFn
  })()
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "ou_owner" })
  t.after(() => memory.close())
  const semantic = createTestSemantic(memory, config)
  const skills = await loadRuntimeSkills(config.projectRoot, config.skillsDir)
  const runtime = new PiAgentRuntime({
    config,
    gateway: null as never,
    models,
    model,
    streamFn: streamFn as never,
    skills,
    memory,
    semantic,
  })
  await assert.rejects(
    runtime.run({
      text: "随便问点什么",
      requestId: "stream-no-retry",
      sessionId: "stream-no-retry",
    }),
    /some permanent model error/,
  )
  assert.equal(calls, 1)
})

function upstreamErrorStream(models: Models, failures: number, status: number): StreamFn {
  let calls = 0
  const fn = (model: Model<Api>, context: Context, options: Parameters<StreamFn>[2]) => {
    calls += 1
    if (calls <= failures) {
      return Promise.reject(
        new Error(
          `OpenAI API error (${status}): 503 data: {"error":{"message":"模型服务异常","type":"upstream_error","code":${status}}}`,
        ),
      )
    }
    return models.streamSimple(model, context, options)
  }
  return fn as unknown as StreamFn
}

test("runtime retries upstream 5xx model service errors and succeeds", async (t) => {
  const config = { ...loadConfig(), runtimeUpstreamRetries: 3, runtimeStreamRetryDelayMs: 1, maxTurns: 3 }
  const faux = fauxProvider({ provider: "faux-upstream-retry" })
  const models = createModels()
  models.setProvider(faux.provider)
  const model = faux.getModel()
  if (!model) throw new Error("faux model unavailable")
  faux.setResponses([fauxAssistantMessage([fauxText("服务恢复后的回答")])])
  const gateway = new LarkCliGateway(config)
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "ou_owner" })
  t.after(() => memory.close())
  const semantic = createTestSemantic(memory, config)
  const skills = await loadRuntimeSkills(config.projectRoot, config.skillsDir)
  const runtime = new PiAgentRuntime({
    config,
    gateway,
    models,
    model,
    streamFn: upstreamErrorStream(models, 3, 503) as never,
    skills,
    memory,
    semantic,
  })
  const result = await runtime.run({
    text: "随便问点什么",
    requestId: "upstream-retry-test",
    sessionId: "upstream-retry-test",
  })
  assert.match(result.reply, /服务恢复后的回答/)
})

test("runtime gives up after exhausting upstream retries", async (t) => {
  const config = { ...loadConfig(), runtimeUpstreamRetries: 2, runtimeStreamRetryDelayMs: 1, maxTurns: 3 }
  const faux = fauxProvider({ provider: "faux-upstream-exhaust" })
  const models = createModels()
  models.setProvider(faux.provider)
  const model = faux.getModel()
  if (!model) throw new Error("faux model unavailable")
  let calls = 0
  const streamFn = ((): StreamFn => {
    const fn = () => {
      calls += 1
      return Promise.reject(new Error("OpenAI API error (503): 503 模型服务异常"))
    }
    return fn as unknown as StreamFn
  })()
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "ou_owner" })
  t.after(() => memory.close())
  const semantic = createTestSemantic(memory, config)
  const skills = await loadRuntimeSkills(config.projectRoot, config.skillsDir)
  const runtime = new PiAgentRuntime({
    config,
    gateway: null as never,
    models,
    model,
    streamFn: streamFn as never,
    skills,
    memory,
    semantic,
  })
  await assert.rejects(
    runtime.run({
      text: "随便问点什么",
      requestId: "upstream-retry-exhaust",
      sessionId: "upstream-retry-exhaust",
    }),
    /OpenAI API error \(503\)/,
  )
  // Initial call + configured retries.
  assert.equal(calls, 3)
})

test("runtime does not retry non-retryable upstream statuses like 401", async (t) => {
  const config = { ...loadConfig(), runtimeUpstreamRetries: 3, runtimeStreamRetryDelayMs: 1, maxTurns: 3 }
  const faux = fauxProvider({ provider: "faux-upstream-401" })
  const models = createModels()
  models.setProvider(faux.provider)
  const model = faux.getModel()
  if (!model) throw new Error("faux model unavailable")
  let calls = 0
  const streamFn = ((): StreamFn => {
    const fn = () => {
      calls += 1
      return Promise.reject(new Error("OpenAI API error (401): Invalid token"))
    }
    return fn as unknown as StreamFn
  })()
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "ou_owner" })
  t.after(() => memory.close())
  const semantic = createTestSemantic(memory, config)
  const skills = await loadRuntimeSkills(config.projectRoot, config.skillsDir)
  const runtime = new PiAgentRuntime({
    config,
    gateway: null as never,
    models,
    model,
    streamFn: streamFn as never,
    skills,
    memory,
    semantic,
  })
  await assert.rejects(
    runtime.run({
      text: "随便问点什么",
      requestId: "upstream-401",
      sessionId: "upstream-401",
    }),
    /Invalid token/,
  )
  assert.equal(calls, 1)
})

test("runtime retries overload errors that arrive without an HTTP status", async (t) => {
  // Regression: "Our servers are currently overloaded. Please try again
  // later." carries no "API error (NNN)" prefix, so it previously slipped
  // past the upstream retry classification and failed immediately.
  const config = { ...loadConfig(), runtimeUpstreamRetries: 3, runtimeStreamRetryDelayMs: 1, maxTurns: 3 }
  const faux = fauxProvider({ provider: "faux-overload-phrase" })
  const models = createModels()
  models.setProvider(faux.provider)
  const model = faux.getModel()
  if (!model) throw new Error("faux model unavailable")
  faux.setResponses([fauxAssistantMessage([fauxText("恢复后的回答")])])
  const gateway = new LarkCliGateway(config)
  const memory = new OfficeMemory({ path: ":memory:", ownerExternalId: "ou_owner" })
  t.after(() => memory.close())
  const semantic = createTestSemantic(memory, config)
  const skills = await loadRuntimeSkills(config.projectRoot, config.skillsDir)
  let failures = 2
  const streamFn = ((): StreamFn => {
    const fn = (model2: Model<Api>, context: Context, options: Parameters<StreamFn>[2]) => {
      if (failures > 0) {
        failures -= 1
        return Promise.reject(new Error("Our servers are currently overloaded. Please try again later."))
      }
      return models.streamSimple(model2, context, options)
    }
    return fn as unknown as StreamFn
  })()
  const runtime = new PiAgentRuntime({
    config,
    gateway,
    models,
    model,
    streamFn: streamFn as never,
    skills,
    memory,
    semantic,
  })
  const result = await runtime.run({
    text: "随便问点什么",
    requestId: "overload-phrase-retry",
    sessionId: "overload-phrase-retry",
  })
  assert.match(result.reply, /恢复后的回答/)
})

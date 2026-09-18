#!/usr/bin/env node
/**
 * One-off backfill: extract facts for ALL pending messages, ignoring the
 * per-run chunk quota. Loops enrich(30) until pending reaches zero or no
 * progress is made (failed chunks). Requires the main service to be stopped.
 */
import { LarkCliGateway } from "../src/adapters/lark-cli.js"
import { loadConfig } from "../src/config.js"
import { createModelRuntime } from "../src/agent/model.js"
import { OfficeMemory, PiFactExtractor, SemanticMemory } from "../src/memory/index.js"
import { emptyRuntimeUsage, addRuntimeUsage } from "../src/memory/usage.js"
import { logger } from "../src/infra/logger.js"

const config = loadConfig()
const gateway = new LarkCliGateway(config)
const owner = await gateway.ensureUserIdentity(config.allowedUserOpenId)

const memory = new OfficeMemory({
  path: config.memoryFile,
  ownerExternalId: owner.ownerOpenId,
  assistantBotExternalId: owner.botAppId,
  assistantBotName: owner.botName,
})

const modelRuntime = createModelRuntime(config)
const semantic = new SemanticMemory({
  memory,
  extractor: new PiFactExtractor({
    models: modelRuntime.models,
    model: modelRuntime.model,
    ownerName: owner.ownerName,
    thinkingLevel: config.memoryExtractionThinking,
    timeoutMs: config.memoryExtractionTimeoutMs,
    maxOutputTokens: config.memoryExtractionMaxOutputTokens,
  }),
  ownerName: owner.ownerName,
  sessionizer: {
    idleGapMs: config.memoryChunkIdleGapMs,
    maxChunkTokens: config.memoryChunkMaxTokens,
    maxPrimaryMessages: config.memoryChunkMaxMessages,
    contextMessages: config.memoryContextMessages,
  },
  maxAttempts: config.memoryExtractionMaxAttempts,
})

const totalUsage = emptyRuntimeUsage()
let round = 0
const startedAt = Date.now()
try {
  while (true) {
    round += 1
    const pendingBefore = semantic.pendingMessageCount()
    if (pendingBefore === 0) {
      console.log(`[round ${round}] no pending messages left`)
      break
    }
    const result = await semantic.enrich(30, undefined, (usage) => addRuntimeUsage(totalUsage, usage))
    addRuntimeUsage(totalUsage, result.usage)
    const pendingAfter = semantic.pendingMessageCount()
    console.log(
      `[round ${round}] pending ${pendingBefore} -> ${pendingAfter} | chunks ok=${result.completedChunks} failed=${result.failedChunks} | facts +${result.factsCreated} merged=${result.factsMerged} superseded=${result.factsSuperseded} rejected=${result.factsRejected} | entities +${result.entitiesUpserted} | estCost=$${totalUsage.estimatedCostUsd.toFixed(4)}`,
    )
    if (result.failures.length > 0) {
      for (const failure of result.failures) console.log(`  failure: ${failure}`)
    }
    if (result.queuedChunks === 0) {
      console.log("no more chunkable work; stopping")
      break
    }
    if (result.completedChunks === 0 && result.failedChunks > 0) {
      console.log("all chunks in this round failed; stopping to avoid burning cost")
      break
    }
  }
} finally {
  const status = memory.status()
  console.log("--- final status ---")
  console.log(`elapsed: ${Math.round((Date.now() - startedAt) / 1000)}s`)
  console.log(
    `messages=${status.messages} eligible=${status.eligibleMessages} chunks=${status.chunks} facts=${status.facts} entities=${status.entities} edges=${status.edges}`,
  )
  console.log(
    `usage: input=${totalUsage.inputTokens} output=${totalUsage.outputTokens} cacheRead=${totalUsage.cacheReadTokens} total=${totalUsage.totalTokens} estCost=$${totalUsage.estimatedCostUsd.toFixed(4)}`,
  )
  memory.close()
}

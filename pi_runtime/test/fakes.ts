import type {
  FactExtractionData,
  FactExtractionResult,
  FactExtractor,
  OfficeMemory,
  SemanticChunk,
} from "../src/memory/index.js"
import { SemanticMemory } from "../src/memory/index.js"
import { emptyRuntimeUsage } from "../src/memory/usage.js"
import type { RuntimeConfig } from "../src/types.js"
import type { RuntimeUsage } from "../src/types.js"

export class FakeFactExtractor implements FactExtractor {
  readonly calls: SemanticChunk[] = []
  private readonly queued: Array<FactExtractionData | Error>
  private usage: RuntimeUsage = emptyRuntimeUsage()

  constructor(...queued: Array<FactExtractionData | Error>) {
    this.queued = [...queued]
  }

  withUsage(usage: Partial<RuntimeUsage>): this {
    this.usage = { ...emptyRuntimeUsage(), ...usage }
    return this
  }

  async extract(chunk: SemanticChunk): Promise<FactExtractionResult> {
    this.calls.push(chunk)
    const next = this.queued.shift() ?? { entities: [], facts: [] }
    if (next instanceof Error) throw next
    return {
      data: next,
      model: "fake/test-model",
      promptVersion: "office-facts-zh-v1-test",
      usage: { ...this.usage },
      rawOutput: JSON.stringify(next),
    }
  }
}

export function createTestSemantic(
  memory: OfficeMemory,
  config: RuntimeConfig,
  extractor: FactExtractor = new FakeFactExtractor(),
): SemanticMemory {
  return new SemanticMemory({
    memory,
    extractor,
    ownerName: "测试用户",
    sessionizer: {
      idleGapMs: config.memoryChunkIdleGapMs,
      maxChunkTokens: config.memoryChunkMaxTokens,
      maxPrimaryMessages: config.memoryChunkMaxMessages,
      contextMessages: config.memoryContextMessages,
    },
    maxAttempts: config.memoryExtractionMaxAttempts,
  })
}

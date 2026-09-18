import { logger } from "../infra/logger.js"
import { OfficeMemory, PiFactExtractor, SemanticMemory } from "../memory/index.js"
import type { ModelRuntime } from "../agent/model.js"
import type {
  OwnerMemorySession,
  OwnerMemorySessionProvider,
  RuntimeConfig,
} from "../types.js"

interface OwnerMemoryRouterOptions {
  config: RuntimeConfig
  modelRuntime: ModelRuntime
  /** Bot identity for the assistant-control pollution guard. */
  assistantBotExternalId: string | null
  assistantBotName: string | null
  /** Owner names resolved lazily from tokens; null is acceptable. */
  ownerNames?: Map<string, string | null>
}

/**
 * Routes memory access per owner. Each owner gets lazily-instantiated
 * OfficeMemory + SemanticMemory bound to their owner_key, all sharing one
 * SQLite file (WAL handles concurrent connections; each owner's rows are
 * partitioned by owner_key).
 */
export class OwnerMemoryRouter implements OwnerMemorySessionProvider {
  private readonly sessions = new Map<string, OwnerMemorySession>()

  constructor(private readonly options: OwnerMemoryRouterOptions) {}

  sessionFor(ownerOpenId: string | null): OwnerMemorySession {
    const key = ownerOpenId ?? "anonymous"
    const existing = this.sessions.get(key)
    if (existing !== undefined) return existing
    const memory = new OfficeMemory({
      path: this.options.config.memoryFile,
      ownerExternalId: key,
      assistantBotExternalId: this.options.assistantBotExternalId,
      assistantBotName: this.options.assistantBotName,
    })
    const semantic = new SemanticMemory({
      memory,
      extractor: new PiFactExtractor({
        models: this.options.modelRuntime.models,
        model: this.options.modelRuntime.model,
        ownerName: this.options.ownerNames?.get(key) ?? null,
        thinkingLevel: this.options.config.memoryExtractionThinking,
        timeoutMs: this.options.config.memoryExtractionTimeoutMs,
        maxOutputTokens: this.options.config.memoryExtractionMaxOutputTokens,
      }),
      ownerName: this.options.ownerNames?.get(key) ?? null,
      sessionizer: {
        idleGapMs: this.options.config.memoryChunkIdleGapMs,
        maxChunkTokens: this.options.config.memoryChunkMaxTokens,
        maxPrimaryMessages: this.options.config.memoryChunkMaxMessages,
        contextMessages: this.options.config.memoryContextMessages,
      },
      maxAttempts: this.options.config.memoryExtractionMaxAttempts,
    })
    const session: OwnerMemorySession = {
      ownerOpenId: key,
      ownerName: this.options.ownerNames?.get(key) ?? null,
      memory,
      semantic,
    }
    this.sessions.set(key, session)
    logger.info("owner_memory_session_created", { owner: key.slice(0, 12) })
    return session
  }

  /** All sessions created so far (for the warmer). */
  allSessions(): OwnerMemorySession[] {
    return [...this.sessions.values()]
  }

  close(): void {
    for (const session of this.sessions.values()) session.memory.close()
    this.sessions.clear()
  }
}

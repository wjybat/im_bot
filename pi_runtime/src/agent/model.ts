import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
  type Models,
} from "@earendil-works/pi-ai"
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy"
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import type { RuntimeConfig } from "../types.js"
import { JsonCredentialStore } from "./credential-store.js"

export interface ModelRuntime {
  models: Models
  model: Model<Api>
}

export function createConfiguredModels(config: RuntimeConfig): Models {
  const models = createModels({ credentials: new JsonCredentialStore(config.authFile) })
  if (config.provider === "dmall-ai") {
    const model: Model<"openai-responses"> = {
      id: config.model ?? "gpt-5.6-luna",
      name: config.model ?? "gpt-5.6-luna",
      api: "openai-responses",
      provider: "dmall-ai",
      baseUrl: config.baseUrl,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 272_000,
      maxTokens: 32_768,
      compat: {
        supportsDeveloperRole: true,
        supportsStrictMode: false,
        supportsLongCacheRetention: false,
      },
    }
    models.setProvider(
      createProvider({
        id: "dmall-ai",
        name: "DMall AI Router",
        baseUrl: config.baseUrl,
        auth: { apiKey: envApiKeyAuth("DMall AI Router key", ["DMALL_AI_API_KEY"]) },
        models: [model],
        api: openAIResponsesApi(),
      }),
    )
  } else if (config.provider === "openai") models.setProvider(openaiProvider())
  else if (config.provider === "anthropic") models.setProvider(anthropicProvider())
  else models.setProvider(openaiCodexProvider())
  return models
}

export function createModelRuntime(config: RuntimeConfig): ModelRuntime {
  if (!config.model) {
    throw new Error("IM_BOT_PI_MODEL is required for check, once, and listen modes")
  }
  const models = createConfiguredModels(config)
  const model = models.getModel(config.provider, config.model)
  if (!model) {
    const available = models.getModels(config.provider).slice(0, 20).map((item) => item.id)
    throw new Error(
      `model ${config.provider}/${config.model} is unavailable; configured catalog sample: ${available.join(", ")}`,
    )
  }
  return { models, model }
}

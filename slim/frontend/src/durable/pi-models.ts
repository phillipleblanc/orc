import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createProvider, type MutableModels } from '@earendil-works/pi-ai/models'
import { piAgentDir } from './credentials.ts'

const APIS: Record<string, () => ReturnType<typeof openAICompletionsApi>> = {
  'openai-completions': openAICompletionsApi,
  'anthropic-messages': anthropicMessagesApi
}

/**
 * Pi's custom providers from its `models.json`, such as models served on the local network, so a
 * durable agent can use them by `provider/id`. A model keeps every field Pi reads, such as its
 * `thinkingLevelMap`. Providers on other APIs are skipped. `apiKey` is used as written.
 */
export function installPiModels(models: MutableModels): string[] {
  let config: { providers?: Record<string, any> }
  try {
    config = JSON.parse(readFileSync(join(piAgentDir(), 'models.json'), 'utf8'))
  } catch {
    return []
  }
  const installed: string[] = []
  for (const [id, provider] of Object.entries(config.providers ?? {})) {
    const api = APIS[provider?.api]
    if (!api || typeof provider.baseUrl !== 'string' || !Array.isArray(provider.models)) continue
    const key = typeof provider.apiKey === 'string' ? provider.apiKey : 'none'
    models.setProvider(createProvider({
      id,
      name: id,
      baseUrl: provider.baseUrl,
      ...(provider.headers ? { headers: provider.headers } : {}),
      auth: { apiKey: { name: `${id} key from Pi's models.json`, resolve: async () => ({ auth: { apiKey: key }, source: 'models.json' }) } },
      models: provider.models.filter((model: any) => typeof model?.id === 'string').map((model: any) => ({
        ...model,
        name: model.name ?? model.id,
        api: provider.api,
        provider: id,
        baseUrl: provider.baseUrl,
        input: model.input ?? ['text'],
        reasoning: Boolean(model.reasoning),
        contextWindow: model.contextWindow ?? 128_000,
        maxTokens: model.maxTokens ?? 16_384,
        cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(provider.compat || model.compat ? { compat: { ...provider.compat, ...model.compat } } : {})
      })),
      api: api()
    }))
    installed.push(id)
  }
  return installed
}

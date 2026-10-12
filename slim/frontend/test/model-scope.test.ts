import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveModelScope } from '../src/durable/model-scope.ts'
import { resolvePiModel } from '../src/durable/pi-models.ts'

const models = [
  { provider: 'openai-codex', id: 'gpt-6-astra', name: 'GPT-6 Astra' },
  { provider: 'openai-codex', id: 'gpt-6-luna', name: 'GPT-6 Luna' },
  { provider: 'openai', id: 'gpt-6-luna', name: 'GPT-6 Luna' },
  { provider: 'anthropic', id: 'claude-sonnet-5-20260101', name: 'Claude Sonnet 5' },
  { provider: 'anthropic', id: 'claude-sonnet-5-latest', name: 'Claude Sonnet 5' },
  { provider: 'cuda-gpu-dev', id: 'qwen-flash-next', name: 'Qwen Flash Next' },
  { provider: 'openrouter', id: 'moonshotai/kimi-k3:exacto', name: 'Kimi K3' }
]
const scope = (patterns: string[]) => resolveModelScope(patterns, models).map(({ model, thinkingLevel }) => `${model.provider}/${model.id}${thinkingLevel ? `:${thinkingLevel}` : ''}`)

test('a model scope resolves like Pi: references, partial names, globs and thinking levels, in order', () => {
  assert.deepEqual(scope(['cuda-gpu-dev/qwen-flash-next', 'openai-codex/gpt-6-astra']), ['cuda-gpu-dev/qwen-flash-next', 'openai-codex/gpt-6-astra'])
  // A bare id must name one provider's model.
  assert.deepEqual(scope(['gpt-6-astra', 'GPT-6-LUNA']), ['openai-codex/gpt-6-astra', 'openai-codex/gpt-6-luna'])
  // Partial matches prefer an undated alias.
  assert.deepEqual(scope(['sonnet']), ['anthropic/claude-sonnet-5-latest'])
  assert.deepEqual(scope(['openai-codex/*', '*luna']), ['openai-codex/gpt-6-astra', 'openai-codex/gpt-6-luna', 'openai/gpt-6-luna'])
  assert.deepEqual(scope(['openai-codex/gpt-6-astra:high', 'openai-codex/*:low']), ['openai-codex/gpt-6-astra:high', 'openai-codex/gpt-6-luna:low'])
  // A colon that is part of the id is not a thinking level.
  assert.deepEqual(scope(['openrouter/moonshotai/kimi-k3:exacto', 'kimi-k3:exacto:medium']), ['openrouter/moonshotai/kimi-k3:exacto'])
  assert.deepEqual(scope(['no-such-model', 'gpt-6-astra:bogus']), ['openai-codex/gpt-6-astra'])
})

test('a bare model id runs on the provider Pi scopes, else one it is signed in to, else any that has it', async () => {
  const catalog = [
    { provider: 'azure-openai-responses', id: 'gpt-6-astra' }, { provider: 'github-copilot', id: 'gpt-6-astra' },
    { provider: 'openai-codex', id: 'gpt-6-astra' }, { provider: 'azure-openai-responses', id: 'gpt-6-luna' },
    { provider: 'openai', id: 'gpt-6-luna' }, { provider: 'azure-openai-responses', id: 'only-on-azure' }
  ]
  const signedIn = ['github-copilot', 'openai', 'openai-codex']
  const registry = {
    getModels: () => catalog,
    getModel: (provider: string, id: string) => catalog.find((model) => model.provider === provider && model.id === id),
    getAvailable: async () => catalog.filter((model) => signedIn.includes(model.provider))
  } as any
  const resolve = async (spec: string | undefined, settings: object) => {
    const found = await resolvePiModel(registry, spec, settings)
    return found && `${found.provider}/${found.modelId}`
  }
  const scoped = { enabledModels: ['openai-codex/gpt-6-astra'] }
  assert.equal(await resolve('gpt-6-astra', scoped), 'openai-codex/gpt-6-astra')
  assert.equal(await resolve('gpt-6-astra', {}), 'github-copilot/gpt-6-astra')
  assert.equal(await resolve('gpt-6-luna', scoped), 'openai/gpt-6-luna')
  assert.equal(await resolve('only-on-azure', scoped), 'azure-openai-responses/only-on-azure')
  assert.equal(await resolve('azure-openai-responses/gpt-6-astra', scoped), 'azure-openai-responses/gpt-6-astra')
  assert.equal(await resolve(undefined, { defaultProvider: 'openai', defaultModel: 'gpt-6-luna' }), 'openai/gpt-6-luna')
  assert.equal(await resolve('no-such-model', scoped), undefined)
})

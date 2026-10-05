import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveModelScope } from '../src/durable/model-scope.ts'

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

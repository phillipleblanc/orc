import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentArgv } from '../src/agent-hooks.ts'

const hooks = { script: '/hooks/orc-agent-hook', claudeSettings: '/hooks/claude-settings.json', piExtension: '/hooks/orc-agent-status.ts' }
const count = (argv: string[], flag: string) => argv.filter((arg) => arg === flag).length

test('Codex and Claude agents start without approval prompts, each flag once', () => {
  const codex = agentArgv('codex', '/bin/codex', hooks, { args: ['--yolo', '--no-daemon', '--dangerously-bypass-approvals-and-sandbox', '-c', 'x=1'] })
  assert.deepEqual(codex.slice(0, 3), ['/bin/codex', '--no-daemon', '--yolo'])
  assert.equal(count(codex, '--yolo'), 1)
  assert.equal(count(codex, '--no-daemon'), 1)
  assert.equal(count(codex, '--dangerously-bypass-approvals-and-sandbox'), 0)
  assert.deepEqual(codex.slice(-2), ['-c', 'x=1'])

  const claude = agentArgv('claude', '/bin/claude', hooks, { model: 'haiku', args: ['--dangerously-skip-permissions'] })
  assert.deepEqual(claude, ['/bin/claude', '--dangerously-skip-permissions', '--settings', hooks.claudeSettings, '--model', 'haiku'])

  assert.deepEqual(agentArgv('pi', '/bin/pi', hooks), ['/bin/pi', '-e', hooks.piExtension])
})

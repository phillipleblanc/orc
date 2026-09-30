import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentArgv, callerArguments } from '../src/agent-hooks.ts'

const hooks = { script: '/p/agent-hooks/1/orc-agent-hook', claudeSettings: '/p/agent-hooks/1/claude-settings.json', piExtension: '/p/agent-hooks/1/orc-agent-status.ts' }
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

test('a resumed agent continues its conversation with the arguments it was started with', () => {
  const resume = { id: 'abc-123', transcriptPath: '/sessions/abc-123.jsonl' }
  const codex = agentArgv('codex', '/bin/codex', hooks, { model: 'gpt', effort: 'low', args: ['-c', 'x=1'], resume })
  assert.deepEqual(codex.slice(0, 5), ['/bin/codex', 'resume', 'abc-123', '--no-daemon', '--yolo'])
  const claude = agentArgv('claude', '/bin/claude', hooks, { model: 'haiku', resume })
  assert.deepEqual(claude.slice(-4), ['--resume', 'abc-123', '--model', 'haiku'])
  const pi = agentArgv('pi', '/bin/pi', hooks, { effort: 'low', resume })
  assert.deepEqual(pi, ['/bin/pi', '-e', hooks.piExtension, '--session', '/sessions/abc-123.jsonl', '--thinking', 'low'])

  // Recovering the caller's arguments from an argv, resumed or not, gives back model, effort and extra arguments.
  for (const kind of ['codex', 'claude', 'pi'] as const) {
    const fresh = agentArgv(kind, `/bin/${kind}`, hooks, { model: 'm', effort: 'e', args: ['--extra', 'value'] })
    const resumed = agentArgv(kind, `/bin/${kind}`, hooks, { model: 'm', effort: 'e', args: ['--extra', 'value'], resume })
    assert.deepEqual(callerArguments(kind, resumed), callerArguments(kind, fresh), kind)
    assert.deepEqual(agentArgv(kind, `/bin/${kind}`, hooks, { args: callerArguments(kind, fresh) }), fresh, kind)
  }
  // Argv from before Orc passed the approval flags, and a caller's own resume request.
  assert.deepEqual(callerArguments('codex', ['/bin/codex', '--no-daemon', '-c', 'hooks={}', '-c', 'hooks.state={}', '-m', 'gpt', 'resume', '--last']), ['-m', 'gpt'])
  assert.deepEqual(callerArguments('claude', ['/bin/claude', '--settings', hooks.claudeSettings, '--settings', '/mine.json']), ['--settings', '/mine.json'])
})

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentMonitor, type AgentState } from '../src/agent-monitor.ts'
import type { TerminalSession } from '../src/terminal-session.ts'
import { until } from './harness.ts'

/** The parts of a session the monitor reads, for a Pi agent (no screen checks). */
class StandInSession extends EventEmitter {
  exit: object | null = null
  title = ''
}

const line = (event: string) => JSON.stringify({ agent: 'pi', event, time: 1, payload: { session_id: 's1' } }) + '\n'

test('a conversation that ends and restarts keeps reporting; only the program exiting is final', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'slim-monitor-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'events.jsonl')
  // Pi switching conversations (/resume, /new) ends one session and starts another in the same program.
  await writeFile(file, ['SessionStart', 'SessionEnd', 'SessionStart'].map(line).join(''))
  const session = new StandInSession()
  const monitor = new AgentMonitor('pi', file, session as unknown as TerminalSession)
  const states: AgentState[] = []
  monitor.on('change', () => states.push(monitor.state))
  await monitor.start()
  t.after(() => monitor.stop())
  assert.deepEqual(states, ['idle', 'ended', 'idle'])

  await appendFile(file, line('UserPromptSubmit'))
  await until(async () => monitor.state === 'working', 2000, 'working after the restarted conversation')
  await appendFile(file, line('Stop'))
  await until(async () => monitor.state === 'idle', 2000, 'idle again')

  session.exit = {}
  session.emit('exit')
  assert.equal(monitor.state, 'ended')
  assert.equal(monitor.exited, true)
  await appendFile(file, line('SessionStart') + line('UserPromptSubmit'))
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(monitor.state, 'ended', 'events after the program exited change nothing')
})

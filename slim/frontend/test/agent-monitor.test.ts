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

test('Claude keeps working after a turn while text queued during it is still to be read', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'slim-monitor-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'events.jsonl')
  const transcript = join(directory, 'transcript.jsonl')
  const event = (name: string, promptId?: string) =>
    JSON.stringify({ agent: 'claude', event: name, time: 1, payload: { session_id: 's1', transcript_path: transcript, ...(promptId ? { prompt_id: promptId } : {}) } }) + '\n'
  const prompt = (promptId: string) => JSON.stringify({ type: 'user', promptId, message: { role: 'user', content: 'text' } }) + '\n'
  const queue = (operation: string) => JSON.stringify({ type: 'queue-operation', operation }) + '\n'
  await writeFile(file, event('SessionStart') + event('UserPromptSubmit', 'p1'))
  await writeFile(transcript, prompt('p1'))
  const session = Object.assign(new StandInSession(), { screenText: async () => [] })
  const monitor = new AgentMonitor('claude', file, session as unknown as TerminalSession)
  await monitor.start()
  t.after(() => monitor.stop())
  assert.equal(monitor.state, 'working')
  const after = async (events: string, lines = '') => {
    await appendFile(transcript, lines)
    await appendFile(file, events)
    await monitor.refresh()
    return monitor.state
  }

  // Text submitted mid-turn and read at the turn's next step ends with the turn.
  assert.equal(await after(event('UserPromptSubmit', 'p1'), queue('enqueue') + queue('remove')), 'working')
  assert.equal(await after(event('Stop', 'p1')), 'idle')

  // Text still queued when the turn stops starts another turn, which no hook announces.
  assert.equal(await after(event('UserPromptSubmit', 'p2'), prompt('p2')), 'working')
  assert.equal(await after(event('UserPromptSubmit', 'p2'), queue('enqueue')), 'working')
  assert.equal(await after(event('Stop', 'p2')), 'working')
  // Claude took the text for that turn before its Stop was read.
  assert.equal(await after(event('UserPromptSubmit', 'p3'), queue('dequeue') + prompt('p3') + queue('enqueue') + queue('dequeue')), 'working')
  assert.equal(await after(event('Stop', 'p3')), 'working')
  assert.equal(await after(event('Stop', 'p4'), prompt('p4')), 'idle')

  // A turn with nothing queued during it ends at its Stop whatever the transcript says.
  assert.equal(await after(event('UserPromptSubmit', 'p5'), prompt('p5') + queue('enqueue')), 'working')
  assert.equal(await after(event('Stop', 'p5')), 'idle')
  // A prompt typed to an idle Claude means nothing was left in its queue.
  assert.equal(await after(event('UserPromptSubmit', 'p6') + event('UserPromptSubmit', 'p6'), prompt('p6') + queue('enqueue') + queue('remove')), 'working')
  assert.equal(await after(event('Stop', 'p6')), 'idle')

  // Text queued just before the turn stopped counts once it reaches the transcript.
  setTimeout(() => void appendFile(transcript, queue('enqueue')), 300)
  assert.equal(await after(event('UserPromptSubmit', 'p7') + event('UserPromptSubmit', 'p7') + event('Stop', 'p7'), prompt('p7')), 'working')
  assert.equal(await after(event('Stop', 'p8'), queue('dequeue') + prompt('p8')), 'idle')
})

test('answering a prompt returns to what it interrupted: an idle agent stays idle without ending a turn', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'slim-monitor-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'events.jsonl')
  const at = (event: string, time: number) => JSON.stringify({ agent: 'pi', event, time, payload: { session_id: 's1' } }) + '\n'
  // A turn ends, then an extension command (Pi's /codex-account) opens a picker while the agent is idle.
  await writeFile(file, at('SessionStart', 10) + at('UserPromptSubmit', 20) + at('Stop', 30) + at('PermissionRequest', 40) + at('PermissionResolved', 41))
  const monitor = new AgentMonitor('pi', file, new StandInSession() as unknown as TerminalSession)
  await monitor.start()
  t.after(() => monitor.stop())
  assert.equal(monitor.state, 'idle')
  assert.equal(monitor.lastIdleAt, 30_000)
  // The state changed last when the prompt was answered.
  assert.equal(monitor.stateSince, 41_000)

  // A prompt during a turn returns to the turn once answered.
  await appendFile(file, line('UserPromptSubmit') + line('PermissionRequest'))
  await until(async () => monitor.state === 'permission', 2000, 'the prompt')
  await appendFile(file, line('PermissionResolved'))
  await until(async () => monitor.state === 'working', 2000, 'back to the turn')

  // A turn that ends while its prompt is open stays ended when the prompt closes.
  await appendFile(file, line('PermissionRequest') + line('Stop') + line('PermissionResolved'))
  await until(async () => monitor.state === 'idle', 2000, 'idle after the turn')
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(monitor.state, 'idle')
})

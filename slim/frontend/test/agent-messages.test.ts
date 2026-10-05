import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentDirectory } from '../src/agents.ts'
import { destroyProfile, makeProfile, until } from './harness.ts'

/** The parts of a Pi agent's session the directory uses; what is typed into it is recorded. */
class StandInSession extends EventEmitter {
  readonly meta: Record<string, unknown>
  readonly dir: string
  readonly handle: string
  readonly typed: string[] = []
  connected = true
  exit: object | null = null
  title = ''

  constructor(name: string, dir: string, events: string) {
    super()
    this.meta = { name, agent: 'pi', events, cwd: dir, createdAt: 0 }
    this.dir = dir
    this.handle = `term_${name}`
  }

  async bracketedPaste(): Promise<boolean> {
    return true
  }

  input(text: string): void {
    this.typed.push(text)
  }

  /** The messages typed so far, each as one bracketed paste followed by Enter. */
  messages(): string[] {
    const text = this.typed.join('')
    return [...text.matchAll(/\x1b\[200~([\s\S]*?)\x1b\[201~\r/g)].map((match) => match[1])
  }
}

const line = (name: string) => JSON.stringify({ agent: 'pi', event: name, time: 1, payload: {} }) + '\n'

/** An agent directory over one stand-in Pi session, whose events file starts with `initial`. */
async function agentRuntime(t: { after: (fn: () => unknown) => void }, initial: string[] = [], saved?: object) {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const dir = join(profile, 'sessions', 'worker')
  await mkdir(dir, { recursive: true })
  if (saved) await writeFile(join(dir, 'queue.json'), JSON.stringify(saved))
  const events = join(profile, 'events.jsonl')
  await writeFile(events, initial.map(line).join(''))
  const session = new StandInSession('worker', dir, events)
  const store = Object.assign(new EventEmitter(), { get: (name: string) => (name === 'worker' ? session : undefined) })
  const agents = new AgentDirectory(store as any, {} as any, profile)
  t.after(() => store.emit('ended', session))
  store.emit('added', session)
  await until(async () => agents.list().length === 1, 2000, 'the agent to be attached')
  const event = async (name: string) => {
    await appendFile(events, line(name))
    await agents.monitor(session as any)!.refresh()
  }
  const status = () => agents.status('worker') as { state: string; queued: number; delivering: boolean }
  return { agents, session, event, status }
}

test('a working agent is typed messages at once, except those held for idle; nothing is typed at a prompt', async (t) => {
  const { agents, session, event, status } = await agentRuntime(t)
  await event('SessionStart')

  // An idle agent starts a turn with the message, and the next waits until that turn starts.
  assert.equal((await agents.send('worker', 'first', { from: 'lead' })).delivered, true)
  assert.equal(status().delivering, true)
  await event('UserPromptSubmit')
  assert.equal(status().delivering, false)

  // While it works, a message held for idle waits and a later message is typed past it.
  assert.equal((await agents.send('worker', 'after the turn', { from: 'lead', whenIdle: true })).delivered, false)
  assert.equal((await agents.send('worker', 'steer', { from: 'lead' })).delivered, true)
  assert.deepEqual(session.messages(), ['[from lead]\nfirst', '[from lead]\nsteer'])

  // At a permission prompt a typed Enter would answer it, so every message waits.
  await event('PermissionRequest')
  assert.equal((await agents.send('worker', 'during the prompt')).delivered, false)
  assert.equal(status().queued, 2)
  await event('PermissionResolved')
  await until(async () => session.messages().length === 3, 2000, 'the held message once the prompt is answered')
  assert.equal(session.messages()[2], 'during the prompt')

  // The message held for idle starts the next turn, and wait covers that turn too.
  const waiting = agents.wait('worker', 5000)
  await event('Stop')
  await until(async () => session.messages().length === 4, 2000, 'the message held for idle')
  assert.equal(session.messages()[3], '[from lead]\nafter the turn')
  await event('UserPromptSubmit')
  await event('Stop')
  assert.equal((await waiting).done, true)
})

test('a queued message saved without whenIdle waits for idle', async (t) => {
  const saved = { queue: [{ id: 'saved', text: 'from before', queuedAt: 1 }], lastDeliveredAt: 0, unconfirmed: 0 }
  const { agents, session, event } = await agentRuntime(t, ['SessionStart', 'UserPromptSubmit'], saved)
  assert.equal((await agents.send('worker', 'steer')).delivered, true)
  assert.deepEqual(session.messages(), ['steer'])
  await event('Stop')
  await until(async () => session.messages().length === 2, 2000, 'the saved message once idle')
  assert.equal(session.messages()[1], 'from before')
})

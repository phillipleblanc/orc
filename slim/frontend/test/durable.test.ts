import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import { ChatServer } from '../src/durable/chat-server.ts'
import { durableRequest } from '../src/durable/connection.ts'
import { viewEvent } from '../src/durable/views.ts'
import { destroyProfile, Frontend, makeProfile, until } from './harness.ts'
import { connectWithGrant } from './runtime-client.ts'

const here = dirname(fileURLToPath(import.meta.url))

// Durable agents with the worker's scripted model (`--faux`): it echoes input and runs `run: COMMAND`
// with bash. No model requests are made.

/** A chat view's connection: the messages it received, and requests by method. */
async function chatSocket(url: string) {
  const socket = new WebSocket(url.replace('http://', 'ws://').replace(/\/chat\/[^?]*\?/, '/chat/socket?'))
  const messages: any[] = []
  const replies = new Map<number, (value: any) => void>()
  let id = 0
  socket.on('message', (data) => {
    const message = JSON.parse(String(data))
    if (typeof message.id === 'number') replies.get(message.id)?.(message)
    else messages.push(message)
  })
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const request = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve) => {
    replies.set(++id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { socket, messages, request }
}

test('a durable agent runs in a session, takes Orc messages, serves its chat view, and keeps its conversation when reopened', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const project = join(profile, 'project')
  await mkdir(project)
  let frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))

  // Spawn delivers the prompt; wait returns the answer; a message runs a tool through bash.
  const spawned = await frontend.rpc('agent.spawn', { agent: 'durable', name: 'dur', cwd: project, prompt: 'hello', args: ['--faux'] })
  assert.equal(spawned.delivered, true)
  assert.equal((await frontend.rpc('agent.wait', { name: 'dur', timeoutMs: 20_000 })).lastAssistantMessage, 'echo: hello')
  assert.equal((await frontend.rpc('agent.send', { to: 'dur', text: 'run: echo via-orc', from: 'lead' })).delivered, true)
  const ran = await frontend.rpc('agent.wait', { name: 'dur', timeoutMs: 20_000 })
  assert.equal(ran.done, true)
  assert.equal(ran.lastAssistantMessage, 'ran: via-orc')
  const screen = (await frontend.rpc('terminal.read', { terminal: 'dur' })).read.lines.join('\n')
  assert.match(screen, /› \[from lead\]/)
  assert.match(screen, /⏺ bash echo via-orc/)

  // The chat view gets a snapshot, then every commit, and its submissions reach the conversation.
  const { url } = await frontend.rpc('durable.chat', { name: 'dur' })
  const page = await fetch(url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<title>Workbench<\/title>/)
  assert.equal((await fetch(new URL('/chat/vendor/marked.js', url))).status, 200)
  assert.equal((await fetch(new URL('/chat/..%2Fdurable%2Fworker.ts', url))).status, 404)
  assert.equal((await fetch(new URL('/chat/vendor/diffs/..%2F..%2Fpackage.json', url))).status, 404)
  const chat = await chatSocket(url)
  t.after(() => chat.socket.close())
  await chat.request('subscribe')
  const snapshot = await until(async () => chat.messages.find((message) => message.type === 'snapshot'), 5000, 'the snapshot')
  assert.equal(snapshot.snapshot.entries.filter((entry: any) => entry.kind === 'pi.user').length, 2)
  assert.equal(snapshot.info.model.provider, 'faux')
  assert.ok(snapshot.context > 0)
  assert.ok((await chat.request('submit', { text: 'from the chat', mode: 'steer' })).result.submissionId)
  await until(async () => chat.messages.some((message) => message.type === 'events' &&
    message.events.some((event: any) => event.type === 'message_end' && event.entry.kind === 'pi.assistant' &&
      JSON.stringify(event.entry.model).includes('echo: from the chat'))), 10_000, 'the answer to the chat message')
  const contextSize = () => chat.messages.findLast((message) => message.type === 'context')?.tokens
  const grown = await until(async () => contextSize() > snapshot.context && contextSize(), 5000, 'the context to grow')

  // After a new context the model sees only what follows, and views still show everything; the
  // context's size is what follows too, before any answer reports it.
  await chat.request('reset', { note: 'we were testing' })
  const shrunk = await until(async () => contextSize() < grown && contextSize(), 5000, 'the context to shrink')
  const later = await chatSocket(url)
  t.after(() => later.socket.close())
  await later.request('subscribe')
  const shown = await until(async () => later.messages.find((message) => message.type === 'snapshot'), 5000, 'the snapshot after a reset')
  assert.deepEqual(shown.snapshot.entries.filter((entry: any) => entry.kind === 'pi.user' || entry.kind === 'pi.reset').map((entry: any) => entry.kind),
    ['pi.user', 'pi.user', 'pi.user', 'pi.reset'])
  assert.equal(shown.context, shrunk)

  // A wrong token gets no socket.
  const refused = new WebSocket(url.replace('http://', 'ws://').replace(/\/chat\/.*$/, '/chat/socket?session=dur&token=wrong'))
  await new Promise((resolve) => { refused.once('error', resolve); refused.once('open', () => resolve(assert.fail('a wrong token was accepted'))) })

  // The worker outlives a frontend restart; a new frontend serves its chat view again.
  await frontend.kill('SIGKILL')
  frontend = await Frontend.start(profile)
  const again = await chatSocket((await frontend.rpc('durable.chat', { name: 'dur' })).url)
  t.after(() => again.socket.close())
  await again.request('subscribe')
  await until(async () => again.messages.find((message) => message.type === 'snapshot')?.snapshot.entries.length > 0, 5000, 'the snapshot after a restart')

  // Closed and reopened, it continues the same conversation.
  await until(async () => (await frontend.rpc('agent.status', { name: 'dur' })).state === 'idle', 10_000, 'dur to be idle')
  await frontend.rpc('terminal.close', { terminal: 'dur' })
  const [closed] = (await frontend.rpc('history.list')).sessions
  assert.equal(closed.name, 'dur')
  await frontend.rpc('history.reopen', { entry: closed.entry })
  await frontend.rpc('agent.send', { to: 'dur', text: 'after reopening' })
  assert.equal((await frontend.rpc('agent.wait', { name: 'dur', timeoutMs: 20_000 })).lastAssistantMessage, 'echo: after reopening')
  const reopened = await chatSocket((await frontend.rpc('durable.chat', { name: 'dur' })).url)
  t.after(() => reopened.socket.close())
  await reopened.request('subscribe')
  const history = await until(async () => reopened.messages.find((message) => message.type === 'snapshot'), 5000, 'the reopened snapshot')
  assert.equal(history.snapshot.entries.filter((entry: any) => entry.kind === 'pi.user').length, 4)
  await frontend.rpc('terminal.close', { terminal: 'dur' })
})

test("a long conversation's snapshot reaches the chat view whole and at once", async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  // The worker sends a snapshot of 32 MB, which the view's relay reads in thousands of chunks, and an event after it.
  const snapshot = JSON.stringify({ type: 'snapshot', snapshot: { entries: Array.from({ length: 4000 }, (_, id) => ({ id, text: 'x'.repeat(8000) })) } })
  const worker = createServer((socket) => socket.once('data', () => socket.write(`${snapshot}\n{"type":"events","events":[]}\n`)))
  const path = join(profile, 'worker.sock')
  await new Promise<void>((resolve) => worker.listen(path, resolve))
  t.after(() => worker.close())
  const chat = new ChatServer(() => path)
  await chat.listen()
  t.after(() => chat.close())

  const started = performance.now()
  const { socket, messages } = await chatSocket(chat.url('agent'))
  socket.send(JSON.stringify({ id: 1, method: 'subscribe' }))
  await until(async () => messages.length === 2, 10_000, 'the snapshot and the event')
  const elapsed = performance.now() - started
  assert.equal(JSON.stringify(messages[0]), snapshot)
  assert.equal(messages[1].type, 'events')
  assert.ok(elapsed < 1500, `the snapshot took ${Math.round(elapsed)} ms`)
})

test('a chat view gets the newest whole turns, older ones a page at a time, and only what is new when it comes back', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const project = join(profile, 'project')
  await mkdir(project)
  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  // Three turns of 72 entries each (a prompt, 35 tool calls with their results, an answer), and a short one.
  const steps = `steps: ${Array.from({ length: 35 }, () => 'run: true').join(' | ')}`
  await frontend.rpc('agent.spawn', { agent: 'durable', name: 'long', cwd: project, prompt: steps, args: ['--faux'] })
  for (const text of [steps, steps, 'hello']) {
    await frontend.rpc('agent.wait', { name: 'long', timeoutMs: 30_000 })
    await frontend.rpc('agent.send', { to: 'long', text })
  }
  assert.equal((await frontend.rpc('agent.wait', { name: 'long', timeoutMs: 30_000 })).lastAssistantMessage, 'echo: hello')
  const { url } = await frontend.rpc('durable.chat', { name: 'long' })
  const snapshotOf = async (params?: Record<string, unknown>) => {
    const view = await chatSocket(url)
    t.after(() => view.socket.close())
    await view.request('subscribe', params)
    return { view, snapshot: await until(async () => view.messages.find((message) => message.type === 'snapshot'), 5000, 'the snapshot') }
  }
  const ids = (entries: any[]) => entries.map((entry) => entry.id)
  const all = ids((await snapshotOf()).snapshot.snapshot.entries)

  // The newest 100 entries reach back into the second turn, so the view gets it whole.
  const { view, snapshot } = await snapshotOf({ pages: true })
  const first = snapshot.snapshot.entries
  assert.equal(first.length, 146)
  assert.equal(first[0].kind, 'pi.user')
  assert.deepEqual(ids(first), all.slice(-146))
  assert.equal(snapshot.older, true)
  assert.equal(snapshot.after, null)
  const pages = [first]
  for (let page = { older: true }; page.older;) {
    page = (await view.request('history', { before: pages[0][0].id })).result
    pages.unshift((page as any).entries)
  }
  assert.deepEqual(ids(pages.flat()), all)
  assert.equal(pages[1][0].kind, 'pi.user')

  // Back with what it saw, the view gets only what is new, and a view of another conversation starts over.
  const newest = all.at(-1)
  const back = (await snapshotOf({ pages: true, after: newest, conversation: snapshot.conversation })).snapshot
  assert.equal(back.after, newest)
  assert.deepEqual(back.snapshot.entries, [])
  await frontend.rpc('agent.send', { to: 'long', text: 'again' })
  await frontend.rpc('agent.wait', { name: 'long', timeoutMs: 30_000 })
  const delta = (await snapshotOf({ pages: true, after: newest, conversation: snapshot.conversation })).snapshot
  assert.deepEqual(delta.snapshot.entries.map((entry: any) => entry.kind), ['pi.user', 'pi.assistant'])
  const other = (await snapshotOf({ pages: true, after: newest, conversation: 'another' })).snapshot
  assert.equal(other.after, null)
  assert.equal(other.snapshot.entries.at(-1).kind, 'pi.assistant')
  assert.equal(other.snapshot.entries[0].kind, 'pi.user')
  await frontend.rpc('terminal.close', { terminal: 'long' })
})

test("views get models' messages without the providers' signatures", () => {
  const message = { role: 'assistant', content: [
    { type: 'thinking', thinking: 'plan', thinkingSignature: 'opaque' },
    { type: 'text', text: 'answer', textSignature: 'opaque' },
    { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'true' }, thoughtSignature: 'opaque' }
  ] } as any
  const entry = { id: 1, conversationId: 1, kind: 'pi.assistant', model: [message] } as any
  const unsigned = [
    { type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'answer' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'true' } }
  ]
  assert.deepEqual((viewEvent({ type: 'message_end', entry }) as any).entry.model[0].content, unsigned)
  assert.deepEqual((viewEvent({ type: 'snapshot', entries: [entry], generation: { attempt: 1, message }, tools: [], compactions: [], inbox: [], agent: {}, usage: {} } as any) as any)
    .generation.message.content, unsigned)
  assert.deepEqual((viewEvent({ type: 'message_update', usage: {}, changes: [{ type: 'block', contentIndex: 0, block: message.content[0] }] } as any) as any).changes[0].block, unsigned[0])
  assert.equal(message.content[0].thinkingSignature, 'opaque', 'the stored message is unchanged')
})

test('a phone opens a durable agent in native chat as omp, follows it, and types into it', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const project = join(profile, 'project')
  await mkdir(project)
  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  await frontend.rpc('agent.spawn', { agent: 'durable', name: 'dur', cwd: project, prompt: 'hello', args: ['--faux'] })
  await frontend.rpc('agent.wait', { name: 'dur', timeoutMs: 20_000 })
  const phone = await connectWithGrant(frontend.rpc.bind(frontend), 'mobile')
  t.after(() => phone.close())

  // The tab offers native chat: an omp agent with the conversation to read.
  let tab: any
  for (const row of (await phone.request('worktree.ps', { limit: 100 })).worktrees) {
    tab ??= (await phone.request('session.tabs.list', { worktree: `id:${row.worktreeId}` })).tabs.find((candidate: any) => candidate.title === 'dur')
  }
  assert.equal(tab.launchAgent, 'omp')
  assert.equal(tab.agentStatus.agentType, 'omp')
  const { id: sessionId, transcriptPath } = tab.agentStatus.providerSession
  assert.match(transcriptPath, /\/durable\/[0-9a-f]+\.sqlite$/)

  const chat = phone.stream('nativeChat.subscribe', { agent: 'omp', sessionId, transcriptPath, limit: 40, subscriptionId: `omp:${sessionId}`, capabilities: { transcriptPending: 1 } })
  const first = await chat.next((event) => event.type === 'snapshot')
  assert.deepEqual(first.messages.map((message: any) => [message.role, message.blocks[0].text]), [['user', 'hello'], ['assistant', 'echo: hello']])

  // The phone types a whole message, then Enter; its newlines stay in the message.
  await phone.request('terminal.send', { terminal: tab.terminal, text: 'first line\nsecond line', enter: true })
  const typed: any[] = []
  while (!typed.some((message) => message.role === 'assistant')) typed.push(...(await chat.next((event) => event.type === 'appended', 10_000)).messages)
  assert.deepEqual(typed.map((message) => [message.role, message.blocks[0].text]), [['user', 'first line\nsecond line'], ['assistant', 'echo: first line\nsecond line']])

  // A tool call and its result, then a new context typed as a command.
  await phone.request('terminal.send', { terminal: tab.terminal, text: 'run: echo from-phone', enter: true })
  const ran: any[] = []
  while (!ran.some((message) => message.role === 'assistant' && message.blocks[0].type === 'text')) ran.push(...(await chat.next((event) => event.type === 'appended', 10_000)).messages)
  assert.deepEqual(ran.find((message) => message.role === 'tool').blocks[0], { type: 'tool-result', output: 'from-phone' })
  await phone.request('terminal.send', { terminal: tab.terminal, text: '/new from the phone', enter: true })
  const reset = await chat.next((event) => event.type === 'appended' && event.messages.some((message: any) => message.role === 'system'), 10_000)
  assert.equal(reset.messages.at(-1).blocks[0].text, 'New context: from the phone')

  // Earlier pages, by whole entries.
  const page = await phone.request('nativeChat.readSession', { agent: 'omp', sessionId, transcriptPath, limit: 2 })
  assert.equal(page.hasMore, true)
  const earlier = await phone.request('nativeChat.readSession', { agent: 'omp', sessionId, transcriptPath, limit: 100, beforeOffset: page.beforeOffset })
  assert.deepEqual(earlier.messages[0].blocks[0].text, 'hello')
  await frontend.rpc('terminal.close', { terminal: 'dur' })
})

test('a durable agent on older code restarts in place once it is idle, keeping its session and conversation', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const project = join(profile, 'project')
  await mkdir(project)
  // Only the frontend sees the override, so its worker reports other code.
  const frontend = await Frontend.start(profile, [], { ORC_DURABLE_CODE_VERSION: 'newer' })
  t.after(() => frontend.kill('SIGKILL'))
  const spawned = await frontend.rpc('agent.spawn', { agent: 'durable', name: 'dur', cwd: project, prompt: 'hello', args: ['--faux'] })
  const meta = JSON.parse(await readFile(join(profile, 'sessions', 'dur', 'meta.json'), 'utf8'))
  const starts = async () => (await readFile(meta.events, 'utf8')).split('\n').filter((line) => line.includes('"SessionStart"')).length

  await until(async () => (await starts()) === 2, 20_000, 'the worker to start again', () => frontend.stderr)
  assert.match(frontend.stderr, /restarting durable agent dur on the current code/)
  await until(async () => (await frontend.rpc('agent.status', { name: 'dur' })).state === 'idle', 10_000, 'dur to be idle again')
  assert.equal((await frontend.rpc('agent.status', { name: 'dur' })).handle, spawned.handle)
  await frontend.rpc('agent.send', { to: 'dur', text: 'after the restart' })
  assert.equal((await frontend.rpc('agent.wait', { name: 'dur', timeoutMs: 20_000 })).lastAssistantMessage, 'echo: after the restart')
  const chat = await chatSocket((await frontend.rpc('durable.chat', { name: 'dur' })).url)
  t.after(() => chat.socket.close())
  await chat.request('subscribe')
  const snapshot = await until(async () => chat.messages.find((message) => message.type === 'snapshot'), 5000, 'the snapshot')
  assert.deepEqual(snapshot.snapshot.entries.filter((entry: any) => entry.kind === 'pi.user').map((entry: any) => entry.model[0].content),
    ['hello', 'after the restart'])

  // It still reports other code, and is not restarted for the same version again.
  await new Promise((resolve) => setTimeout(resolve, 2000))
  assert.equal(await starts(), 2)
  await frontend.rpc('terminal.close', { terminal: 'dur' })
})

test('a durable agent offers the models in Pi\'s scope with their thinking levels, and keeps the level one the model supports', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const piDir = join(profile, 'pi')
  await mkdir(piDir)
  // A keyless custom provider stands in for signed-in ones; the scripted model is signed in as well.
  await writeFile(join(piDir, 'models.json'), JSON.stringify({ providers: { lab: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'none',
    models: [{ id: 'small', reasoning: true }, { id: 'other' },
      { id: 'large', reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: null, xhigh: 'xhigh', max: null } }] } } }))
  await writeFile(join(piDir, 'settings.json'), JSON.stringify({ enabledModels: ['lab/large:high', 'lab/sm*', 'not-a-model'] }))
  const storage = join(profile, 'durable', 'scope.sqlite')
  const worker = spawn(process.execPath, [join(here, '../src/durable/worker.ts'), '--storage', storage, '--faux'],
    { cwd: profile, env: { ...process.env, PI_CODING_AGENT_DIR: piDir, ORC_AGENT_EVENTS: '' }, stdio: ['pipe', 'ignore', 'ignore'] })
  t.after(() => worker.kill('SIGKILL'))
  const socket = storage.replace(/\.sqlite$/, '.sock')
  await until(async () => existsSync(socket), 10_000, 'the worker socket')

  // The conversation's own model comes first, then the scope in its order.
  const { models } = await durableRequest(socket, 'models')
  assert.deepEqual(models.map((model: any) => [`${model.provider}/${model.modelId}`, model.thinkingLevel ?? null, model.thinkingLevels.join(' ')]), [
    ['faux/echo', null, 'off minimal low medium high'],
    ['lab/large', 'high', 'low medium xhigh'],
    ['lab/small', null, 'off minimal low medium high']
  ])
  // The scoped level is one the model lacks, so it moves to the nearest it has, upward first.
  const large = await durableRequest(socket, 'configure', { model: { provider: 'lab', modelId: 'large' } })
  assert.deepEqual([large.thinkingLevel, large.model.thinkingLevels], ['xhigh', ['low', 'medium', 'xhigh']])
  assert.equal((await durableRequest(socket, 'configure', { thinkingLevel: 'minimal' })).thinkingLevel, 'low')
  // Switching keeps the level where the next model supports it.
  assert.equal((await durableRequest(socket, 'configure', { model: { provider: 'lab', modelId: 'small' } })).thinkingLevel, 'low')
  assert.equal((await durableRequest(socket, 'configure', { model: { provider: 'lab', modelId: 'other' } })).thinkingLevel, 'off')
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { decodeLine, fallbackId, INTERRUPTED_TEXT, type TranscriptFormat } from '../src/native-chat/decoders.ts'
import { entryMessages, entryWindow } from '../src/native-chat/durable.ts'
import { destroyProfile, Frontend, makeProfile } from './harness.ts'
import { connectWithGrant } from './runtime-client.ts'

const AT = '2026-01-02T03:04:05.000Z'
const decode = (format: TranscriptFormat, value: unknown) => decodeLine(format, JSON.stringify(value), 'fallback')

test('Claude transcript lines decode to chat messages', () => {
  assert.deepEqual(decode('claude', { type: 'user', uuid: 'u1', timestamp: AT, message: { role: 'user', content: 'hello' } }),
    { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'hello' }], timestamp: Date.parse(AT), source: 'transcript' })
  assert.deepEqual(decode('claude', {
    type: 'assistant', message: { id: 'msg1', content: [
      { type: 'thinking', thinking: ' weighing it ' },
      { type: 'text', text: 'Listing files' },
      { type: 'tool_use', id: 'call1', name: 'Bash', input: { command: 'ls' } }
    ] }
  })?.blocks, [
    { type: 'text', text: 'weighing it' },
    { type: 'text', text: 'Listing files' },
    { type: 'tool-call', name: 'Bash', input: { command: 'ls' }, callId: 'call1' }
  ])
  const result = decode('claude', {
    type: 'user', uuid: 'u2',
    message: { content: [{ type: 'tool_result', tool_use_id: 'call1', content: [{ type: 'text', text: 'a.txt' }, { type: 'text', text: 'b.txt' }], is_error: true }] },
    toolUseResult: { filePath: '/w/a.txt', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }
  })
  assert.equal(result?.role, 'tool')
  assert.deepEqual(result?.blocks, [{
    type: 'tool-result', output: 'a.txt\nb.txt', isError: true,
    editPatch: { filePath: '/w/a.txt', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }
  }])
  assert.deepEqual(decode('claude', { type: 'user', uuid: 'u3', interruptedMessageId: 'msg1', message: { content: 'x' } })?.blocks,
    [{ type: 'text', text: INTERRUPTED_TEXT }])
  assert.equal(decode('claude', { type: 'user', uuid: 'u4', isMeta: true, message: { content: '<command-name>/model</command-name>' } }), null)
  assert.equal(decode('claude', { type: 'summary', summary: 'A chat' }), null)
  assert.equal(decode('claude', { type: 'assistant', message: { content: [{ type: 'text', text: 'no id' }] } })?.id, 'fallback')
  assert.equal(decodeLine('claude', '{"type":"user"', 'fallback'), null)
})

test('Codex rollout lines decode to chat messages', () => {
  const event = (payload: unknown) => decode('codex', { timestamp: AT, type: 'event_msg', payload })
  const item = (payload: unknown) => decode('codex', { timestamp: AT, type: 'response_item', payload })
  assert.deepEqual(event({ type: 'user_message', message: 'fix the bug' }), { id: 'fallback', role: 'user', blocks: [{ type: 'text', text: 'fix the bug' }], timestamp: Date.parse(AT), source: 'transcript' })
  assert.equal(event({ type: 'agent_message', message: 'Done.' })?.role, 'assistant')
  assert.deepEqual(event({ type: 'turn_aborted', reason: 'interrupted' })?.blocks, [{ type: 'text', text: INTERRUPTED_TEXT }])
  assert.deepEqual(item({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Reading files' }] })?.role, 'reasoning')
  assert.deepEqual(item({ type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c1' })?.blocks,
    [{ type: 'tool-call', name: 'shell', input: '{"command":["ls"]}', callId: 'c1' }])
  assert.deepEqual(item({ type: 'function_call_output', call_id: 'c1', output: 'a.txt' }),
    { id: 'fallback', role: 'tool', blocks: [{ type: 'tool-result', output: 'a.txt' }], timestamp: Date.parse(AT), source: 'transcript' })
  // Prose comes from the event records; the matching response items carry only Codex's own text types.
  assert.equal(item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the bug' }] }), null)
  assert.equal(item({ type: 'message', role: 'user', content: [{ type: 'text', text: '<skill>\nname: x' }] }), null)
  assert.equal(decode('codex', { timestamp: AT, type: 'session_meta', payload: { id: 's1', cwd: '/w' } }), null)
})

test('durable agent entries become chat messages, paged by whole entries', () => {
  const at = Date.parse(AT)
  const entries = [
    { id: 7, kind: 'pi.user', model: [{ role: 'user', content: '[from lead]\nFix the bug', timestamp: at }] },
    { id: 8, kind: 'pi.system', model: [{ role: 'system', content: '' }] },
    { id: 9, kind: 'pi.assistant', model: [{ role: 'assistant', timestamp: at, stopReason: 'toolUse', content: [
      { type: 'thinking', thinking: 'Look at math.ts first.' },
      { type: 'text', text: 'Fixing it.' },
      { type: 'toolCall', id: 'call-1', name: 'edit', arguments: { path: 'math.ts', edits: [] } }] }] },
    { id: 10, kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call-1', toolName: 'edit', isError: false, timestamp: at,
      content: [{ type: 'text', text: 'Replaced 1 block\n<harness>\n[info] Formatted the file\n</harness>' }],
      details: { diff: '-2 a - b\n+2 a + b', patch: '--- math.ts\n+++ math.ts\n@@ -2,1 +2,1 @@\n-  return a - b\n+  return a + b\n' } }] },
    { id: 11, kind: 'pi.assistant', model: [{ role: 'assistant', timestamp: at, stopReason: 'aborted', content: [] }] },
    { id: 12, kind: 'pi.reset', model: [{ role: 'user', content: 'we were fixing math.ts', timestamp: at }] }
  ]
  const window = entryWindow(entries, 100)
  assert.deepEqual(window.messages.map((message) => [message.id, message.role]), [
    ['durable:7', 'user'], ['durable:9:thinking', 'reasoning'], ['durable:9', 'assistant'], ['durable:10', 'tool'],
    ['durable:11:stopped', 'system'], ['durable:12', 'system']
  ])
  assert.deepEqual(window.messages[2].blocks, [{ type: 'text', text: 'Fixing it.' }, { type: 'tool-call', name: 'edit', input: { path: 'math.ts', edits: [] }, callId: 'call-1' }])
  assert.deepEqual(window.messages[3].blocks, [{ type: 'tool-result', output: 'Replaced 1 block\nFormatted the file',
    editPatch: { filePath: 'math.ts', hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-  return a - b', '+  return a + b'] }] } }])
  assert.deepEqual(window.messages[4].blocks, [{ type: 'text', text: INTERRUPTED_TEXT }])
  assert.deepEqual(window.messages[5].blocks, [{ type: 'text', text: 'New context: we were fixing math.ts' }])
  assert.deepEqual([window.hasMore, window.beforeOffset], [false, 7])

  // A page never splits an entry's messages, and the next page ends where it began.
  const last = entryWindow(entries, 2)
  assert.deepEqual(last.messages.map((message) => message.id), ['durable:11:stopped', 'durable:12'])
  const before = entryWindow(entries, 2, last.beforeOffset)
  assert.deepEqual(before.messages.map((message) => message.id), ['durable:9:thinking', 'durable:9', 'durable:10'])
  assert.deepEqual([before.hasMore, before.beforeOffset], [true, 9])
  assert.equal(entryMessages(entries[1]).length, 0)
})

test('omp and Pi session lines decode to chat messages', () => {
  const message = (body: unknown, extra: Record<string, unknown> = {}) => decode('omp', { type: 'message', id: 'm1', timestamp: AT, message: body, ...extra })
  assert.deepEqual(message({ role: 'user', content: [{ type: 'text', text: 'hi' }] })?.blocks, [{ type: 'text', text: 'hi' }])
  assert.deepEqual(message({ role: 'assistant', content: [{ type: 'thinking', thinking: 'plan' }, { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a' } }] })?.blocks,
    [{ type: 'text', text: 'plan' }, { type: 'tool-call', name: 'read', input: { path: 'a' } }])
  assert.deepEqual(message({ role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'contents' }], isError: false }),
    { id: 'm1', role: 'tool', blocks: [{ type: 'tool-result', output: 'contents' }], timestamp: Date.parse(AT), source: 'transcript' })
  assert.deepEqual(message({ role: 'bashExecution', command: 'false', output: '', exitCode: 1 })?.blocks,
    [{ type: 'tool-call', name: 'bash', input: 'false' }, { type: 'tool-result', output: '', isError: true }])
  assert.deepEqual(message({ role: 'assistant', content: [], stopReason: 'aborted' })?.blocks, [{ type: 'text', text: INTERRUPTED_TEXT }])
  assert.equal(message({ role: 'custom', content: 'hidden' }), null)
  assert.equal(decode('omp', { type: 'custom_message', id: 'c1', display: true, content: 'shown' })?.role, 'system')
  assert.equal(decode('omp', { type: 'custom_message', id: 'c2', content: 'hidden' }), null)
  assert.equal(decode('omp', { type: 'session', id: 's1', cwd: '/w' }), null)
})

test('a phone follows a transcript: a window, earlier pages, appended and rewritten lines, clipped text', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const phone = await connectWithGrant(frontend.rpc.bind(frontend), 'mobile')
  t.after(() => phone.close())
  await mkdir(join(profile, 'chat'))
  const transcript = join(profile, 'chat', 'session.jsonl')
  const turns = (count: number) => Array.from({ length: count }, (_, index) => JSON.stringify(index % 2
    ? { type: 'assistant', uuid: `m${index}`, timestamp: AT, message: { content: [{ type: 'text', text: `answer ${index}` }] } }
    : { type: 'user', uuid: `m${index}`, timestamp: AT, message: { content: `question ${index}` } }) + '\n').join('')
  // The last line is still being written.
  await writeFile(transcript, turns(6) + '{"type":"user","uuid":"late"')
  const sessionId = `slim-test-${randomUUID()}`
  const subscriptionId = `claude:${sessionId}`
  const chat = phone.stream('nativeChat.subscribe', { agent: 'claude', sessionId, transcriptPath: transcript, limit: 4, subscriptionId, capabilities: { transcriptPending: 1 } })

  const first = await chat.next((event) => event.type === 'snapshot')
  assert.deepEqual(first.messages.map((message: any) => message.id), ['m2', 'm3', 'm4', 'm5'])
  assert.equal(first.hasMore, true)
  const earlier = await phone.request('nativeChat.readSession', { agent: 'claude', sessionId, transcriptPath: transcript, limit: 4, beforeOffset: first.beforeOffset })
  assert.deepEqual(earlier.messages.map((message: any) => message.id), ['m0', 'm1'])
  assert.deepEqual([earlier.hasMore, earlier.beforeOffset], [false, 0])

  await appendFile(transcript, ',"message":{"content":"finished"}}\n' + JSON.stringify({ type: 'assistant', uuid: 'long', message: { content: [{ type: 'text', text: 'x'.repeat(70_000) }] } }) + '\n')
  const appended: any[] = []
  while (!appended.some((message) => message.id === 'long')) appended.push(...(await chat.next((event) => event.type === 'appended')).messages)
  assert.deepEqual(appended.map((message) => message.id), ['late', 'long'])
  const clipped = appended[1].blocks[0].text as string
  assert.equal(clipped.length, 64_000 + '\n… (truncated)'.length)
  assert.ok(clipped.endsWith('(truncated)'))

  await writeFile(transcript, turns(2))
  const replaced = await chat.next((event) => event.type === 'replacement')
  assert.deepEqual(replaced.messages.map((message: any) => message.id), ['m0', 'm1'])
  assert.deepEqual(await phone.request('nativeChat.unsubscribe', { subscriptionId }), { unsubscribed: true })
  await chat.next((event) => event.type === 'end')
  assert.ok(chat.envelopes.every((envelope) => envelope.streaming === true))

  // A chat opened before its agent writes a transcript waits for it.
  const later = join(profile, 'chat', 'later.jsonl')
  const waiting = phone.stream('nativeChat.subscribe', { agent: 'codex', sessionId: `slim-test-${randomUUID()}`, transcriptPath: later, limit: 10, capabilities: { transcriptPending: 1 } })
  assert.equal((await waiting.next((event) => event.type === 'snapshot')).pending, true)
  await writeFile(later, JSON.stringify({ timestamp: AT, type: 'event_msg', payload: { type: 'user_message', message: 'hello codex' } }) + '\n')
  const arrived = await waiting.next((event) => event.type === 'snapshot' && !event.pending)
  assert.deepEqual(arrived.messages.map((message: any) => [message.id, message.blocks[0].text]), [[fallbackId(later, 0), 'hello codex']])

  assert.equal((await phone.request('nativeChat.readSession', { agent: 'claude', sessionId: `slim-test-${randomUUID()}`, limit: 5 })).notFound, true)
  await assert.rejects(phone.request('nativeChat.readSession', { agent: 'grok', sessionId }), { code: 'invalid_argument' })

  // Chat is served to phones only: not over the local socket, nor to runtime-scope devices such as Orc.
  const read = { agent: 'claude', sessionId, transcriptPath: transcript, limit: 4 }
  await assert.rejects(frontend.rpc('nativeChat.readSession', read), { code: 'method_not_found' })
  const desktop = await connectWithGrant(frontend.rpc.bind(frontend), 'runtime')
  t.after(() => desktop.close())
  await assert.rejects(desktop.request('nativeChat.readSession', read), { code: 'method_not_found' })
  const refused = desktop.stream('nativeChat.subscribe', { ...read, subscriptionId })
  assert.equal((await refused.next((event) => event.ok === false)).error.code, 'method_not_found')
})

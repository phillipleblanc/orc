import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { briefPrompt, parseBrief, type Brief } from '../src/brief/prompt.ts'
import { BriefService, FIRST_RETRY_MS, MIN_INTERVAL_MS, SETTLE_MS, type BriefRequest, type BriefSource } from '../src/brief/service.ts'
import { durableDigest, LOG_CHARS, transcriptDigest } from '../src/brief/transcript.ts'

async function temporary(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orc-brief-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

const jsonl = (lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n'

test('a Pi digest follows the active branch back to its latest compaction and condenses what followed', async (t) => {
  const directory = await temporary(t)
  const path = join(directory, 'pi.jsonl')
  const message = (id: string, parentId: string, message: unknown) => ({ type: 'message', id, parentId, timestamp: '2026-10-05T00:00:00Z', message })
  await writeFile(path, jsonl([
    { type: 'session', id: 'session', cwd: '/code' },
    message('a', null as any, { role: 'user', content: 'Build the cache layer' }),
    { type: 'compaction', id: 'c1', parentId: 'a', summary: '## Goal\nOld summary' },
    message('b', 'c1', { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] }),
    { type: 'compaction', id: 'c2', parentId: 'b', summary: '## Goal\nShip the cache layer in three PRs' },
    message('d', 'c2', { role: 'user', content: [{ type: 'text', text: 'Fix the lint errors' }] }),
    message('e', 'd', { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'cargo clippy' } }] }),
    message('f', 'e', { role: 'toolResult', toolCallId: 't1', isError: true, content: [{ type: 'text', text: '45 errors' }] }),
    // An abandoned branch after `e`, left by /tree.
    message('g', 'e', { role: 'assistant', content: [{ type: 'text', text: 'abandoned' }] }),
    message('h', 'f', { role: 'assistant', content: [{ type: 'text', text: 'Clippy fails with 45 errors.' }] }),
    { type: 'custom', id: 'i', parentId: 'h', customType: 'orc' }
  ]) + '{"type":"message","id":"partial')
  const digest = await transcriptDigest('pi', path)
  assert.equal(digest.summary, '## Goal\nShip the cache layer in three PRs')
  assert.deepEqual(digest.items, [
    { role: 'user', text: 'Fix the lint errors' },
    { role: 'tool', text: 'bash {"command":"cargo clippy"}' },
    { role: 'error', text: '45 errors' },
    { role: 'assistant', text: 'Clippy fails with 45 errors.' }
  ])
  assert.equal(digest.truncated, false)
})

test('a Claude digest skips sidechains and injected context and stops at its compact summary; without one it has the first request', async (t) => {
  const directory = await temporary(t)
  const path = join(directory, 'claude.jsonl')
  const line = (uuid: string, parentUuid: string | null, type: string, content: unknown, extra: Record<string, unknown> = {}) => ({ uuid, parentUuid, type, message: { role: type, content }, ...extra })
  await writeFile(path, jsonl([
    line('1', null, 'user', 'Port the hooks'),
    { type: 'system', subtype: 'compact_boundary', uuid: '2', parentUuid: null },
    line('3', '2', 'user', 'This session is being continued. Summary: porting hooks, two left.', { isCompactSummary: true }),
    line('4', '3', 'user', '<system-reminder>context</system-reminder>', { isMeta: true }),
    line('5', '4', 'assistant', [{ type: 'text', text: 'Porting the last two.' }, { type: 'tool_use', id: 'u1', name: 'Edit', input: { file_path: 'hooks.ts' } }]),
    line('s', '5', 'assistant', [{ type: 'text', text: 'subagent noise' }], { isSidechain: true }),
    line('6', '5', 'user', [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }]),
    line('7', '6', 'assistant', [{ type: 'text', text: 'Both ported.' }])
  ]))
  const digest = await transcriptDigest('claude', path)
  assert.match(digest.summary!, /two left/)
  assert.deepEqual(digest.items.map((entry) => `${entry.role}: ${entry.text}`), ['assistant: Porting the last two.', 'tool: Edit {"file_path":"hooks.ts"}', 'result: ok', 'assistant: Both ported.'])

  const fresh = join(directory, 'fresh.jsonl')
  await writeFile(fresh, jsonl([line('1', null, 'user', 'Caveat: local command output'), line('2', '1', 'user', 'Port the hooks'), line('3', '2', 'assistant', [{ type: 'text', text: 'On it.' }])]))
  const first = await transcriptDigest('claude', fresh)
  assert.equal(first.summary, undefined)
  assert.equal(first.firstPrompt, 'Port the hooks')
})

test('a Codex digest stops at its latest compaction, keeping the requests it retained', async (t) => {
  const directory = await temporary(t)
  const path = join(directory, 'rollout.jsonl')
  const item = (payload: unknown) => ({ timestamp: 'x', type: 'response_item', payload })
  await writeFile(path, jsonl([
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Coordinate the fleet' }] }),
    { timestamp: 'x', type: 'compacted', payload: { message: '', retained_context: { user_messages: [{ text: '# AGENTS.md instructions for /code' }, { text: 'Coordinate the fleet' }], assistant_messages: [{ text: 'Three workers are running.' }] } } },
    item({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] }),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] }),
    item({ type: 'reasoning', summary: [] }),
    item({ type: 'custom_tool_call', name: 'exec', input: 'events_read()' }),
    item({ type: 'custom_tool_call_output', output: [{ type: 'input_text', text: '2 events' }] }),
    item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Acknowledged both events.' }] })
  ]))
  const digest = await transcriptDigest('codex', path)
  assert.equal(digest.summary, 'Requests kept from earlier:\n- Coordinate the fleet\n\nAnswers kept from earlier:\n- Three workers are running.')
  assert.deepEqual(digest.items.map((entry) => `${entry.role}: ${entry.text}`), ['tool: exec events_read()', 'result: 2 events', 'assistant: Acknowledged both events.'])
})

test('a digest keeps the newest log within its budget and still finds the summary before it', async (t) => {
  const directory = await temporary(t)
  const path = join(directory, 'pi.jsonl')
  const lines: unknown[] = [{ type: 'session', id: 'session' }, { type: 'compaction', id: 'c', parentId: null, summary: 'The summary' }]
  let parent = 'c'
  for (let index = 0; index < 200; index++) {
    lines.push({ type: 'message', id: `m${index}`, parentId: parent, message: { role: 'user', content: `${index} ${'x'.repeat(1990)}` } })
    parent = `m${index}`
  }
  await writeFile(path, jsonl(lines))
  const digest = await transcriptDigest('pi', path)
  assert.equal(digest.summary, 'The summary')
  assert.equal(digest.truncated, true)
  assert.ok(digest.items.reduce((total, entry) => total + entry.text.length, 0) <= LOG_CHARS)
  assert.match(digest.items.at(-1)!.text, /^199 /)
})

test('a durable digest starts after the latest compaction or new context', () => {
  const entry = (kind: string, content: unknown) => ({ kind, model: [{ role: kind === 'pi.assistant' ? 'assistant' : 'user', content }] })
  const digest = durableDigest([
    entry('pi.user', 'old'),
    entry('pi.compaction', 'The conversation history before this point was compacted into the following summary:\n\n<summary>\nGoal: ship it\n</summary>'),
    entry('pi.user', 'continue'),
    entry('pi.assistant', [{ type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }]),
    entry('pi.tool-result', [{ type: 'text', text: 'a.txt' }]),
    entry('pi.assistant', [{ type: 'text', text: 'Done.' }])
  ])
  assert.equal(digest.summary, 'Goal: ship it')
  assert.deepEqual(digest.items.map((item) => item.role), ['user', 'tool', 'result', 'assistant'])
  assert.equal(durableDigest([entry('pi.user', 'old'), entry('pi.reset', 'we were testing')]).summary, 'The agent started a new context with this note: we were testing.')
})

test('the brief prompt carries the summary and log, and a brief is read from an answer with reasoning or fences around it', () => {
  const prompt = briefPrompt({ summary: 'Goal: ship', items: [{ role: 'tool', text: 'bash ls' }], truncated: true }, { name: 'cdc', agent: 'pi', state: 'idle' })
  assert.match(prompt, /Session "cdc", a pi agent, is idle now/)
  assert.match(prompt, /<summary>\nGoal: ship\n<\/summary>/)
  assert.match(prompt, /<log note="older entries left out">\nTOOL CALL: bash ls\n<\/log>/)

  const brief = parseBrief('<think>Let me see</think>```json\n{"headline": "Checkpoint: fix Clippy", "goal": "Ship  the stack.", "progress": ["PR1 failed", ""], "now": "At a checkpoint.", "next": ["Fix", "Rerun", "Diagnose", "Extra"], "needsYou": "None"}\n```')
  assert.deepEqual(brief, { headline: 'Checkpoint: fix Clippy', goal: 'Ship the stack.', progress: ['PR1 failed'], now: 'At a checkpoint.', next: ['Fix', 'Rerun', 'Diagnose'], needsYou: null })
  assert.throws(() => parseBrief('I cannot help with that'), /did not answer with a brief/)
  assert.throws(() => parseBrief('{"headline": ""}'), /empty/)
})

const BRIEF: Brief = { headline: 'Fixing lint', goal: 'Ship it', progress: ['PR1 open'], now: 'Running clippy', next: ['a', 'b', 'c'], needsYou: null }

test('briefs are written when asked and after a turn, only for a changed transcript, apart, one at a time, and kept on disk', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const profile = await temporary(t)
  let now = 1_000_000
  let mark = 'm1'
  const state = { value: 'working' }
  const source: BriefSource = {
    name: 'cdc', agent: 'pi', get state() { return state.value },
    mark: async () => mark,
    transcript: async () => ({ digest: { summary: 'Goal', items: [], truncated: false }, mark })
  }
  const requests: BriefRequest[] = []
  let failure: Error | null = null
  const service = new BriefService({
    profile, sessions: () => [source], now: () => now,
    write: async (request) => {
      requests.push(request)
      if (failure) throw failure
      return { ...BRIEF, headline: `brief ${requests.length}` }
    }
  })
  t.after(() => service.stop())
  const flush = async () => { for (let index = 0; index < 20; index++) await new Promise((resolve) => setImmediate(resolve)) }
  // Writing a brief saves it to disk, so a brief that should follow is awaited by turns of the event loop, up to a bound.
  const settle = async (done: () => boolean) => { for (let index = 0; index < 5000 && !done(); index++) await new Promise((resolve) => setImmediate(resolve)) }
  const written = (headline: string) => () => service.get('cdc').brief?.headline === headline && !service.get('cdc').generating

  // Off until a model is chosen.
  await service.start()
  await assert.rejects(service.refresh('cdc'), /Choose one in Orc’s Settings/)
  await service.configure('lab/qwen')
  assert.deepEqual(JSON.parse(await readFile(join(profile, 'brief-settings.json'), 'utf8')), { model: 'lab/qwen' })
  await settle(written('brief 1'))
  // Choosing a model writes briefs for agents without one.
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].about, { name: 'cdc', agent: 'pi', state: 'working' })
  assert.equal(requests[0].model, 'lab/qwen')

  // A finished turn with an unchanged transcript writes nothing.
  service.observe('cdc')
  state.value = 'idle'
  service.observe('cdc')
  t.mock.timers.tick(SETTLE_MS)
  await flush()
  assert.equal(requests.length, 1)

  // A changed transcript is written once the settle time passes, but not within five minutes of the last brief.
  mark = 'm2'
  state.value = 'working'
  service.observe('cdc')
  state.value = 'idle'
  service.observe('cdc')
  t.mock.timers.tick(SETTLE_MS)
  await flush()
  assert.equal(requests.length, 1)
  now += MIN_INTERVAL_MS
  t.mock.timers.tick(MIN_INTERVAL_MS)
  await settle(written('brief 2'))
  assert.equal(requests.length, 2)
  assert.equal(service.get('cdc').brief?.headline, 'brief 2')
  assert.equal(service.get('cdc').mark, 'm2')

  // Asked for, a brief is written at once even for an unchanged transcript.
  const asked = await service.refresh('cdc', { wait: true })
  assert.equal(asked.brief?.headline, 'brief 3')
  assert.equal(asked.generating, false)

  // A failure keeps the last brief with the error. Automatic attempts wait out a backoff from the failure, then try
  // again, transcript changed or not since the failure.
  now += MIN_INTERVAL_MS
  failure = new Error('the lab is down')
  const failed = await service.refresh('cdc', { wait: true })
  assert.deepEqual([failed.brief?.headline, failed.error, requests.length], ['brief 3', 'the lab is down', 4])
  mark = 'm3'
  now += 60_000
  t.mock.timers.tick(60_000)
  await flush()
  assert.equal(requests.length, 4)
  failure = null
  now += FIRST_RETRY_MS - 60_000
  t.mock.timers.tick(FIRST_RETRY_MS - 60_000)
  await settle(written('brief 5'))
  assert.equal(requests.length, 5)
  assert.deepEqual([service.get('cdc').brief?.headline, service.get('cdc').error], ['brief 5', null])
  failure = new Error('the lab is down')
  await service.refresh('cdc', { wait: true })

  // Briefs and the model survive a restart.
  const again = new BriefService({ profile, sessions: () => [source], write: async () => BRIEF, now: () => now })
  await again.start()
  t.after(() => again.stop())
  assert.deepEqual([again.settings.model, again.get('cdc').brief?.headline, again.get('cdc').error], ['lab/qwen', 'brief 5', 'the lab is down'])
  assert.deepEqual(again.list().map((record) => record.name), ['cdc'])
})

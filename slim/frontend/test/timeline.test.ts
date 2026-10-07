import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changedFiles, patchCounts, summarize, timelineRows } from '../src/chat/shared/timeline.js'

type Item = Record<string, any> & { kind: string; id: string }
const prompt = (id: string, at: number, extra: Record<string, any> = {}): Item => ({ kind: 'user', id, at, text: id, ...extra })
const text = (id: string, at: number, extra: Record<string, any> = {}): Item => ({ kind: 'text', id, at, text: id, ...extra })
const thought = (id: string, at: number): Item => ({ kind: 'thinking', id, at, text: id })
const tool = (id: string, name: string, path: string | null, at: number): Item => ({ kind: 'tool', id, callId: id, name, args: path ? { path } : { command: id }, at })

// Tool calls are done unless listed, editing 3 lines in and 1 out; writes add 10.
function info(statuses: Record<string, string> = {}) {
  return (item: Item) => ({
    status: statuses[item.id] ?? 'done', path: item.args.path ?? null,
    added: item.name === 'write' ? 10 : item.name === 'edit' ? 3 : 0, removed: item.name === 'edit' ? 1 : 0
  })
}
const idle = { busy: false, runStartedAt: null }
const shape = (rows: any[]): any[] => rows.map((row) => row.kind === 'turn' ? { turn: row.prompt.id, status: row.status, rows: shape(row.rows) }
  : row.kind === 'fold' ? { fold: shape(row.rows), duration: row.duration, ...(row.thoughtOnly ? { thoughtOnly: true } : {}), ...(row.failed ? { failed: row.failed } : {}) }
  : row.kind === 'group' ? { group: row.items.map((item: Item) => item.id), summary: row.summary, ...(row.live ? { active: row.active.map((item: Item) => item.id) } : {}) }
  : row.kind === 'item' ? row.item.id : row.kind)

test('a finished turn folds its work behind one row and keeps its answer, and messages sent mid-run stay visible', () => {
  const rows = timelineRows([
    prompt('fix', 1000),
    thought('plan', 2000), tool('ls', 'bash', null, 3000), tool('r1', 'read', 'a.ts', 4000), tool('r2', 'read', 'a.ts', 5000),
    prompt('steer', 6000, { steer: true }), tool('t2', 'bash', null, 7000),
    text('done', 9000, { ends: true })
  ], info(), idle)
  assert.deepEqual(shape(rows), [{ turn: 'fix', status: 'done', rows: [
    { fold: ['plan', 'ls', 'r1', 'r2'], duration: 5000 },
    'steer',
    { fold: ['t2'], duration: 3000 },
    'done'
  ] }])
})

test('a turn that failed, stopped or never finished stays open, with its tool calls grouped', () => {
  const rows = timelineRows([
    prompt('one', 0), tool('a', 'bash', null, 1), tool('b', 'bash', null, 2), { kind: 'error', id: 'e', text: 'boom', at: 3, ends: true },
    prompt('two', 10), tool('c', 'edit', 'x.ts', 11), { kind: 'notice', id: 'n', text: 'Stopped', at: 12, ends: true },
    prompt('three', 20), tool('d', 'read', 'y.ts', 21),
    // A new prompt, not one sent mid-run, starts a turn even after one that never finished.
    prompt('four', 30), thought('t', 31), text('answer', 32, { ends: true })
  ], info(), idle)
  assert.deepEqual(shape(rows), [
    { turn: 'one', status: 'failed', rows: [{ group: ['a', 'b'], summary: 'Ran 2 commands' }, 'e'] },
    { turn: 'two', status: 'stopped', rows: ['c', 'n', 'changes'] },
    { turn: 'three', status: 'open', rows: ['d'] },
    { turn: 'four', status: 'done', rows: [{ fold: ['t'], duration: 2, thoughtOnly: true }, 'answer'] }
  ])
})

test('the running turn shows how long it has worked and its running calls apart from the finished ones', () => {
  const items = [prompt('go', 100), tool('a', 'bash', null, 101), tool('b', 'read', 'z.ts', 102), tool('c', 'bash', null, 103), tool('d', 'edit', 'z.ts', 104)]
  const rows = timelineRows(items, info({ c: 'running', d: 'pending' }), { busy: true, runStartedAt: 99 })
  assert.deepEqual(shape(rows), [{ turn: 'go', status: 'running', rows: ['working', { group: ['a', 'b', 'c', 'd'], summary: 'Ran a command and read a file', active: ['c', 'd'] }] }])
  assert.equal((rows[0] as any).rows[0].since, 99)
  // Narration between calls splits them into groups, and only the last is the running one.
  const split = timelineRows([prompt('go', 0), tool('a', 'bash', null, 1), tool('b', 'bash', null, 2), text('note', 3), tool('c', 'bash', null, 4)], info({ c: 'running' }), { busy: true, runStartedAt: null })
  assert.deepEqual(shape(split)[0].rows, ['working', { group: ['a', 'b'], summary: 'Ran 2 commands' }, 'note', 'c'])
})

test('a finished turn ends with the files it changed, and an answer before a compaction stays an answer', () => {
  const items = [
    prompt('edit', 0), tool('e1', 'edit', 'a.ts', 1), tool('w1', 'write', 'b.ts', 2), tool('e2', 'edit', 'a.ts', 3), tool('e3', 'edit', 'c.ts', 4),
    text('changed', 5, { ends: true }), { kind: 'compaction', id: 'cmp', text: 'summary', at: 6 }
  ]
  const rows = timelineRows(items, info({ e3: 'error' }), idle) as any[]
  assert.deepEqual(shape(rows)[0].rows, [{ fold: ['e1', 'w1', 'e2', 'e3'], duration: 5, failed: 1 }, 'changed', 'cmp', 'changes'])
  const changes = rows[0].rows.at(-1)
  assert.deepEqual(changes.files, [{ path: 'a.ts', added: 6, removed: 2 }, { path: 'b.ts', added: 10, removed: 0 }])
  assert.deepEqual([changes.added, changes.removed, changes.calls.map((item: Item) => item.id)], [16, 2, ['e1', 'w1', 'e2']])
  // Before the first prompt, items stand alone.
  assert.deepEqual(shape(timelineRows([{ kind: 'reset', id: 'r', text: '', at: 0 }, prompt('p', 1)], info(), idle)), ['r', { turn: 'p', status: 'open', rows: [] }])
})

test('a run of calls reads as a sentence, and a patch counts its lines without its headers', () => {
  const calls = [tool('a', 'bash', null, 0), tool('b', 'bash', null, 0), tool('c', 'read', 'x', 0), tool('d', 'read', 'y', 0), tool('e', 'grep', null, 0)]
  assert.equal(summarize(calls, info()), 'Ran 2 commands, read 2 files and used another tool')
  assert.equal(summarize([], info(), 2), 'Thought')
  assert.equal(summarize([tool('w', 'write', 'n', 0)], info()), 'Wrote a file')
  assert.deepEqual(changedFiles([tool('e', 'edit', 'a', 0)], info({ e: 'running' })).files, [])
  assert.deepEqual(patchCounts('--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n same\n-old\n+new\n+more'), { added: 2, removed: 1 })
})

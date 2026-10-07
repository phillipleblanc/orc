// The transcript as turns, for views that fold finished work: each turn opens with a prompt and runs to the
// agent's answer. Pure functions over the display items of format.js, so they can be tested without a page.
//
// Items need, beyond their kind and id: `at` (the message's timestamp), `ends` on the last item of an answer
// that ended the run, and `steer` on a user message the running agent was sent mid-run.

const WORK = new Set(['tool', 'thinking'])
const SEPARATORS = new Set(['user', 'compaction', 'reset', 'error', 'notice'])

/**
 * Rows to show: a `turn` for each prompt and what followed it, and an `item` for anything before the first prompt.
 * `info(item)` describes a tool call: `{ status, added, removed, path }`. `context` is `{ busy, runStartedAt }`.
 */
export function timelineRows(items, info, context) {
  const turns = []
  const rows = []
  let turn = null
  for (const item of items) {
    if (item.kind === 'user' && (!turn || turn.ended || !item.steer)) {
      turn = { kind: 'turn', id: `turn-${item.id}`, prompt: item, items: [], ended: false, failed: false, stopped: false }
      turns.push(turn)
      rows.push(turn)
      continue
    }
    if (!turn) {
      if (item.kind !== 'end') rows.push({ kind: 'item', id: item.id, item })
      continue
    }
    if (item.kind === 'error') turn.failed = true
    if (item.kind === 'notice') turn.stopped = true
    if (item.ends) turn.ended = true
    if (item.kind !== 'end') turn.items.push(item)
  }
  const last = turns.at(-1)
  for (const each of turns) {
    each.status = each === last && context.busy ? 'running' : each.failed ? 'failed' : each.stopped ? 'stopped' : each.ended ? 'done' : 'open'
    each.rows = turnRows(each, info, context)
  }
  return rows
}

function turnRows(turn, info, context) {
  const rows = []
  if (turn.status === 'running') rows.push({ kind: 'working', id: `${turn.id}-working`, since: context.runStartedAt ?? turn.prompt.at ?? null })
  if (turn.status === 'done') rows.push(...folded(turn, info))
  else rows.push(...grouped(turn.items, info, turn.status === 'running'))
  if (turn.status !== 'running') {
    const changes = changedFiles(turn.items, info)
    if (changes.files.length) rows.push({ kind: 'changes', id: `${turn.id}-changes`, ...changes })
  }
  return rows
}

/**
 * A finished turn's work behind folds: each stretch between visible separators (a message sent mid-run, an error,
 * a compaction) folds, except the answer that ended the run.
 */
function folded(turn, info) {
  const items = turn.items
  const end = items.findLastIndex((item) => item.ends)
  let answer = end + 1
  if (end >= 0 && items[end].kind === 'text') {
    answer = end
    while (answer > 0 && items[answer - 1].kind === 'text') answer--
  }
  const rows = []
  let start = turn.prompt.at ?? null
  let stretch = []
  const close = (until) => {
    if (!stretch.length) return
    const finish = until ?? stretch.at(-1).at ?? null
    // A fold whose work is one group opens straight to its calls.
    const inner = grouped(stretch, info, false)
    const only = inner.length === 1 && inner[0].kind === 'group' ? inner[0] : null
    rows.push({
      kind: 'fold', id: `fold-${stretch[0].id}`, items: stretch,
      rows: only ? only.items.map((item) => ({ kind: 'item', id: item.id, item })) : inner,
      failed: stretch.filter((item) => item.kind === 'tool' && info(item).status === 'error').length,
      thoughtOnly: stretch.every((item) => item.kind === 'thinking'), duration: start !== null && finish !== null ? Math.max(0, finish - start) : null
    })
    stretch = []
  }
  items.forEach((item, index) => {
    if (index >= answer && index <= end) {
      if (index === answer) close(item.at ?? null)
      rows.push({ kind: 'item', id: item.id, item })
    } else if (SEPARATORS.has(item.kind)) {
      close(item.at ?? null)
      rows.push({ kind: 'item', id: item.id, item })
      start = item.at ?? start
    } else {
      stretch.push(item)
    }
  })
  close()
  return rows
}

/**
 * Items with each run of consecutive tool calls and reasoning as a `group` row; a lone call or reasoning stays an
 * `item`. With `live`, the last group is the running one: it shows its calls that have not finished.
 */
export function grouped(items, info, live = false) {
  const rows = []
  let run = []
  const close = () => {
    if (!run.length) return
    const tools = run.filter((item) => item.kind === 'tool')
    if (run.length === 1) rows.push({ kind: 'item', id: run[0].id, item: run[0] })
    else rows.push({ kind: 'group', id: `group-${run[0].id}`, items: run, summary: summarize(tools, info, run.length - tools.length), failed: tools.filter((item) => info(item).status === 'error').length })
    run = []
  }
  for (const item of items) {
    if (WORK.has(item.kind)) {
      run.push(item)
      continue
    }
    close()
    rows.push({ kind: 'item', id: item.id, item })
  }
  close()
  const tail = rows.at(-1)
  if (live && tail?.kind === 'group') {
    tail.live = true
    tail.active = tail.items.filter((item) => item.kind === 'tool' && ['running', 'pending'].includes(info(item).status))
    const settled = tail.items.filter((item) => item.kind === 'tool' && !tail.active.includes(item))
    tail.summary = summarize(settled, info, tail.items.length - settled.length - tail.active.length)
  }
  return rows
}

/** What a run of tool calls did, in a sentence: "Ran 3 commands, read 5 files and edited 2 files". */
export function summarize(tools, info, thoughts = 0) {
  const commands = tools.filter((item) => item.name === 'bash').length
  const paths = (names) => new Set(tools.filter((item) => names.includes(item.name)).map((item) => info(item).path ?? item.id)).size
  const reads = paths(['read'])
  const edits = paths(['edit'])
  const writes = paths(['write'])
  const others = tools.filter((item) => !['bash', 'read', 'edit', 'write'].includes(item.name)).length
  const parts = [
    commands && `ran ${count(commands, 'command')}`,
    reads && `read ${count(reads, 'file')}`,
    edits && `edited ${count(edits, 'file')}`,
    writes && `wrote ${count(writes, 'file')}`,
    others && (others === 1 ? 'used another tool' : `used ${others} other tools`)
  ].filter(Boolean)
  if (!parts.length) return thoughts ? 'Thought' : 'Worked'
  const sentence = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
  return sentence[0].toUpperCase() + sentence.slice(1)
}

function count(n, noun) {
  return n === 1 ? `a ${noun}` : `${n} ${noun}s`
}

/** The files a turn's edits and writes changed, with the lines each added and removed, in the order first changed. */
export function changedFiles(items, info) {
  const files = new Map()
  const calls = []
  for (const item of items) {
    if (item.kind !== 'tool' || (item.name !== 'edit' && item.name !== 'write')) continue
    const about = info(item)
    if (about.status !== 'done' || !about.path) continue
    calls.push(item)
    const file = files.get(about.path) ?? { path: about.path, added: 0, removed: 0 }
    file.added += about.added ?? 0
    file.removed += about.removed ?? 0
    files.set(about.path, file)
  }
  const list = [...files.values()]
  return { files: list, calls, added: list.reduce((sum, file) => sum + file.added, 0), removed: list.reduce((sum, file) => sum + file.removed, 0) }
}

/** Lines a unified patch adds and removes, without its file headers. */
export function patchCounts(patch) {
  let added = 0
  let removed = 0
  for (const line of String(patch ?? '').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

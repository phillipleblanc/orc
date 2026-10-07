// The transcript as a document of turns: each prompt with what the agent did and answered. A finished turn's work
// folds behind one row and its tool calls group into sentences (see shared/timeline.js). Nodes are kept by item and
// row id and moved into place on each render, so streaming text, timers and open panes survive; a closed fold or
// group builds nothing inside it until it is opened.
import { describeTool, diffHtml, escapeHtml, formatDuration, liveItems, markdown, stickToBottom, toolState, transcriptItems } from '/chat/shared/format.js'
import { patchCounts, timelineRows } from '/chat/shared/timeline.js'
import { release, renderChanges, renderCode } from './pierre.js'
import { SPINNER, copyText, formatTime, h, icon, preciseDuration, shortPath } from './ui.js'

const TOOL_ICONS = { bash: 'terminal', read: 'read', write: 'write', edit: 'edit' }
const STATUS_GLYPHS = { done: icon('check'), error: icon('cross'), interrupted: icon('slash'), pending: icon('clock'), running: SPINNER }
const STATUS_LABELS = { running: 'Running', pending: 'Waiting', done: 'Done', error: 'Failed', interrupted: 'Interrupted' }
const LONG_PROMPT = { chars: 700, lines: 12 }
// A new turn is held this far below the top of the view while its answer fills the screen.
const ANCHOR_GAP = 16

export class Transcript {
  constructor(agent, { scroller, log, empty, onAway, onUnread, onOpenChanges, onTurns }) {
    this.agent = agent
    this.onUnread = onUnread
    this.onOpenChanges = onOpenChanges
    this.onTurns = onTurns
    this.scroller = scroller
    this.log = log
    this.empty = empty
    this.scroll = stickToBottom(scroller, (away) => {
      if (away && this.anchor && !this.anchoring) this.releaseAnchor()
      onAway?.(away && !this.anchor)
    })
    this.records = new Map()
    this.tools = new Map()
    this.rowRecords = new Map()
    this.open = new Set()
    this.expanded = new Set()
    this.callTimes = new Map()
    this.entryById = new Map()
    this.indexed = 0
    this.items = []
    this.rows = []
    this.turns = []
    this.seenTurns = null
    this.spacer = h('div', { class: 'anchor-spacer', 'aria-hidden': 'true' })
    log.addEventListener('click', (event) => this.click(event))
  }

  // ─── Updates ───────────────────────────────────────────────────────────

  reset() {
    const pinned = this.scroll.pinned
    this.log.replaceChildren()
    for (const record of this.records.values()) release(record.views)
    for (const map of [this.records, this.tools, this.rowRecords, this.callTimes, this.entryById]) map.clear()
    this.indexed = 0
    this.seenTurns = null
    this.releaseAnchor()
    this.render()
    if (pinned) this.scroller.scrollTop = this.scroller.scrollHeight
  }

  /** Applies a frame's worth of changes. */
  update(changes) {
    this.render()
    if (this.anchor) this.holdAnchor()
    else if (this.scroll.pinned) this.scroll.follow()
    else if (changes.has('entries') || changes.has('live')) this.onUnread?.()
  }

  render() {
    this.indexEntries()
    const settled = transcriptItems(this.agent)
    const ids = new Set(settled.map((item) => item.id))
    const live = liveItems(this.agent).filter((item) => !ids.has(item.id)).map((item) => ({ ...item, live: true }))
    this.items = [...settled, ...live]
    const infos = new Map()
    const info = (item) => {
      if (!infos.has(item.id)) infos.set(item.id, this.info(item))
      return infos.get(item.id)
    }
    this.rows = timelineRows(this.items, info, { busy: this.agent.busy, runStartedAt: this.agent.runStartedAt })
    this.turns = this.rows.filter((row) => row.kind === 'turn')
    const elements = this.rows.map((row) => this.rowElement(row))
    const compacting = this.compactingElement()
    if (compacting) elements.push(compacting)
    if (this.anchor) elements.push(this.spacer)
    this.place(this.log, elements)
    this.noticeNewTurn()
    const texts = this.log.querySelectorAll('.prose.live-text')
    texts.forEach((node, index) => node.classList.toggle('streaming', index === texts.length - 1 && this.agent.busy))
    this.empty.hidden = this.items.length > 0 || !this.agent.everConnected
    this.onTurns?.(this.turns)
  }

  /** Remembers each tool call's request time and each entry by id, for new entries only. */
  indexEntries() {
    const entries = this.agent.entries
    for (; this.indexed < entries.length; this.indexed++) {
      const entry = entries[this.indexed]
      this.entryById.set(entry.id, entry)
      const message = entry.model?.[0]
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
      for (const block of message.content) if (block?.type === 'toolCall') this.callTimes.set(block.id, message.timestamp)
    }
  }

  /** A tool call's status, file and changed lines, for grouping and the changed-files card. */
  info(item) {
    if (item.kind !== 'tool') return { status: null }
    const state = toolState(this.agent, item)
    const path = item.args?.path ?? item.args?.file_path ?? null
    let counts = { added: 0, removed: 0 }
    if (item.name === 'edit') counts = state.details?.patch ? patchCounts(state.details.patch) : diffCounts(state.details?.diff)
    if (item.name === 'write' && typeof item.args?.content === 'string') counts = { added: item.args.content.replace(/\n$/, '').split('\n').length, removed: 0 }
    return { status: state.status, path, ...counts }
  }

  /** Puts `elements` in `container` in order, moving those already there and removing the rest. */
  place(container, elements) {
    let index = 0
    for (const element of elements) {
      const current = container.children[index]
      if (current !== element) container.insertBefore(element, current ?? null)
      index++
    }
    while (container.children.length > elements.length) container.lastElementChild.remove()
  }

  /** A row below everything else while the context is being compacted. */
  compactingElement() {
    const [compaction] = this.agent.compactions
    if (!compaction) return null
    const label = compaction.blocking || compaction.reason === 'manual' ? 'Compacting context' : 'Compacting context in the background'
    if (this.compactingEl?.dataset.label !== label) {
      this.compactingEl = h('div', { class: 'divider divider-compact compacting', role: 'status', 'data-label': label },
        h('span', { class: 'divider-label', html: `${SPINNER}<span>${label}</span>` }))
    }
    return this.compactingEl
  }

  /** Updates running tools' durations and the working line; called once a second. */
  tick() {
    for (const record of this.tools.values()) {
      if (record.status === 'running' && record.el.isConnected) setText(record.time, formatDuration(Date.now() - this.timing(record).start))
    }
    for (const record of this.rowRecords.values()) {
      if (record.kind === 'working' && record.el.isConnected) this.paintWorking(record)
    }
  }

  // ─── Anchoring ─────────────────────────────────────────────────────────

  /** A turn that starts while the view is at the end is held near the top until its answer fills the screen. */
  noticeNewTurn() {
    const ids = new Set(this.turns.map((turn) => turn.id))
    if (this.seenTurns === null) {
      this.seenTurns = ids
      return
    }
    const fresh = this.turns.filter((turn) => !this.seenTurns.has(turn.id))
    this.seenTurns = ids
    const newest = fresh.at(-1)
    if (!newest || !this.scroll.pinned || this.turns.length < 2) return
    this.anchor = this.rowRecords.get(newest.id)?.el ?? null
    if (this.anchor) {
      this.log.append(this.spacer)
      this.holdAnchor()
    }
  }

  holdAnchor() {
    const anchor = this.anchor
    if (!anchor?.isConnected) return this.releaseAnchor()
    const top = anchor.offsetTop - ANCHOR_GAP
    const below = this.spacer.offsetTop - anchor.offsetTop + ANCHOR_GAP
    const room = this.scroller.clientHeight - below
    if (room <= 0) {
      this.releaseAnchor()
      this.scroll.jump()
      return
    }
    this.spacer.style.height = `${room}px`
    this.anchoring = true
    this.scroller.scrollTop = top
    requestAnimationFrame(() => { this.anchoring = false })
  }

  releaseAnchor() {
    this.anchor = null
    this.spacer.style.height = '0px'
    this.spacer.remove()
  }

  // ─── Rows ──────────────────────────────────────────────────────────────

  rowElement(row) {
    switch (row.kind) {
      case 'turn': return this.turnElement(row)
      case 'item': return this.itemElement(row.item)
      case 'fold': return this.foldElement(row)
      case 'group': return this.groupElement(row)
      case 'working': return this.workingElement(row)
      case 'changes': return this.changesElement(row)
      default: return h('div')
    }
  }

  rowRecord(row, create) {
    let record = this.rowRecords.get(row.id)
    if (!record) {
      record = { kind: row.kind, ...create() }
      this.rowRecords.set(row.id, record)
    }
    record.row = row
    return record
  }

  turnElement(row) {
    const record = this.rowRecord(row, () => {
      const body = h('div', { class: 'turn-body' })
      return { el: h('section', { class: 'turn-block', 'data-turn': row.id }, body), body }
    })
    record.el.dataset.status = row.status
    this.place(record.el, [this.itemElement(row.prompt), record.body])
    this.place(record.body, row.rows.map((child) => this.rowElement(child)))
    return record.el
  }

  foldElement(row) {
    const record = this.rowRecord(row, () => {
      const label = h('span', { class: 'fold-label' })
      const failed = h('span', { class: 'work-failed' })
      const head = h('button', { type: 'button', class: 'fold-head', 'data-action': 'toggle', 'data-row': row.id, 'aria-expanded': 'false' },
        label, failed, h('span', { class: 'fold-chev', html: icon('chevron') }))
      const body = h('div', { class: 'fold-body', hidden: true })
      return { el: h('div', { class: 'fold', 'data-row': row.id }, head, body), head, label, failed, body }
    })
    const verb = row.thoughtOnly ? 'Thought' : 'Worked'
    setText(record.label, row.duration === null ? verb : `${verb} for ${preciseDuration(row.duration, formatDuration)}`)
    setText(record.failed, row.failed ? `${row.failed} failed` : '')
    this.paintOpen(record, row.id, () => row.rows.map((child) => this.rowElement(child)))
    return record.el
  }

  groupElement(row) {
    const record = this.rowRecord(row, () => {
      const summary = h('span', { class: 'work-summary' })
      const failed = h('span', { class: 'work-failed' })
      const head = h('button', { type: 'button', class: 'work-head', 'data-action': 'toggle', 'data-row': row.id, 'aria-expanded': 'false' },
        h('span', { class: 'work-icon', html: icon('tool') }), summary, failed, h('span', { class: 'work-chev', html: icon('chevron') }))
      const body = h('div', { class: 'work-body', hidden: true })
      const tail = h('div', { class: 'work-tail' })
      return { el: h('div', { class: 'work', 'data-row': row.id }, head, body, tail), head, summary, failed, body, tail }
    })
    const active = row.live ? row.active : []
    const settled = row.items.filter((item) => !active.includes(item))
    setText(record.summary, row.summary)
    setText(record.failed, row.failed ? `${row.failed} failed` : '')
    record.head.hidden = settled.length === 0
    record.el.classList.toggle('live', Boolean(row.live))
    this.paintOpen(record, row.id, () => settled.map((item) => this.itemElement(item)))
    this.place(record.tail, active.map((item) => this.itemElement(item)))
    return record.el
  }

  /** Shows a fold's or group's contents while it is open; a closed one holds nothing. */
  paintOpen(record, id, children) {
    const open = this.open.has(id)
    record.head.setAttribute('aria-expanded', String(open))
    record.el.classList.toggle('open', open)
    record.body.hidden = !open
    if (open) this.place(record.body, children())
    else if (record.body.firstChild) record.body.replaceChildren()
  }

  workingElement(row) {
    const record = this.rowRecord(row, () => {
      const text = h('span', { class: 'working-text' })
      return { el: h('div', { class: 'working', role: 'status' }, h('span', { html: SPINNER }), text), text }
    })
    this.paintWorking(record)
    return record.el
  }

  paintWorking(record) {
    const since = record.row.since
    setText(record.text, since ? `Working for ${formatDuration(Date.now() - since)}` : 'Working')
  }

  changesElement(row) {
    const record = this.rowRecord(row, () => {
      const title = h('span', { class: 'changes-title' })
      const counts = h('span', { class: 'changes-counts' })
      const head = h('button', { type: 'button', class: 'changes-head', 'data-action': 'toggle', 'data-row': row.id, 'aria-expanded': 'false' },
        h('span', { class: 'changes-chev', html: icon('chevron') }), title, counts)
      const openDiff = h('button', { type: 'button', class: 'changes-open', 'data-action': 'open-changes', 'data-row': row.id, html: `${icon('edit')}<span>Open diff</span>` })
      const body = h('ul', { class: 'changes-files', hidden: true })
      return { el: h('div', { class: 'changes', 'data-row': row.id }, h('div', { class: 'changes-bar' }, head, openDiff), body), head, title, counts, body }
    })
    setText(record.title, `${row.files.length} changed file${row.files.length === 1 ? '' : 's'}`)
    const counts = `<span class="add">+${row.added}</span><span class="del">−${row.removed}</span>`
    if (record.countsHtml !== counts) record.counts.innerHTML = record.countsHtml = counts
    this.paintOpen(record, row.id, () => row.files.map((file) => {
      const key = `${row.id}:${file.path}`
      let item = this.rowRecords.get(key)
      if (!item) {
        item = { kind: 'file', el: h('li', { class: 'changes-file' }) }
        this.rowRecords.set(key, item)
      }
      const html = `<code title="${escapeHtml(file.path)}">${escapeHtml(shortPath(file.path))}</code><span class="add">+${file.added}</span><span class="del">−${file.removed}</span>`
      if (item.html !== html) item.el.innerHTML = item.html = html
      return item.el
    }))
    return record.el
  }

  // ─── Items ─────────────────────────────────────────────────────────────

  itemElement(item) {
    let record = this.records.get(item.id)
    // The in-flight answer's ids are positions, which the next answer reuses for other kinds of block.
    if (record && record.item?.kind !== item.kind) {
      release(record.views)
      record = null
    }
    if (!record) {
      record = this.create(item)
      this.records.set(item.id, record)
    } else {
      this.refresh(record, item)
    }
    record.item = item
    if (item.kind === 'tool') this.paintTool(record)
    return record.el
  }

  create(item) {
    switch (item.kind) {
      case 'user': return this.createPrompt(item)
      case 'thinking': return createReasoning(item)
      case 'text': return createProse(item)
      case 'tool': return this.createTool(item)
      case 'error': return { el: h('div', { class: 'marker marker-error', role: 'note', html: `${icon('warning')}<span>${escapeHtml(item.text)}</span>` }) }
      case 'notice': return { el: h('div', { class: 'marker marker-notice', role: 'note', html: `${icon('stopped')}<span>${escapeHtml(item.text)}</span>` }) }
      case 'compaction': {
        const reason = this.entryById.get(Number(item.id.slice(1)))?.data?.reason
        return createDivider('compact', reason && reason !== 'manual' ? 'Context compacted automatically' : 'Context compacted', summaryText(item.text))
      }
      case 'reset': return createDivider('reset', 'New context', item.text)
      default: return { el: h('div') }
    }
  }

  refresh(record, item) {
    if (item.kind === 'text' && record.text !== item.text) {
      record.text = item.text
      record.body.innerHTML = markdown(item.text)
      enhanceProse(record, item.live)
    } else if (item.kind === 'thinking' && record.text !== item.text) {
      record.text = item.text
      record.preview.textContent = preview(item.text)
      if (record.el.open) record.body.innerHTML = markdown(item.text)
    }
  }

  createPrompt(item) {
    const entry = this.entryById.get(Number(item.id.slice(1)))
    const time = entry?.model?.[0]?.timestamp
    const who = item.from
      ? h('span', { class: 'sender', html: `${icon('agent')}<span>${escapeHtml(item.from)}</span>` })
      : h('span', { class: 'you', html: `${icon('person')}<span>You</span>` })
    const head = h('header', { class: 'turn-head' }, who, item.steer ? h('span', { class: 'steer-note' }, 'while it worked') : null,
      time ? h('time', { datetime: new Date(time).toISOString() }, formatTime(time)) : null)
    const long = item.text.length > LONG_PROMPT.chars || item.text.split('\n').length > LONG_PROMPT.lines
    const body = h('div', { class: `prompt${long ? ' clamped' : ''}` }, item.text)
    const more = long ? h('button', { type: 'button', class: 'more', 'data-action': 'more' }, 'Show more') : null
    const classes = `turn${item.from ? ' from-agent' : ''}${item.steer ? ' steer' : ''}`
    return { el: h('article', { class: classes, 'data-id': item.id, 'aria-label': item.from ? `Message from ${item.from}` : 'Your message' }, head, body, more) }
  }

  createTool(item) {
    const about = describeTool(item.name, item.args)
    const target = firstLine(about.target)
    const row = h('button', { type: 'button', class: 'tool-row', 'aria-expanded': 'false', 'data-action': 'tool' },
      h('span', { class: 'tool-icon', html: icon(TOOL_ICONS[item.name] ?? 'tool') }),
      h('span', { class: 'tool-verb' }, about.verb),
      h('span', { class: `tool-target${about.mono ? ' mono' : ''}`, title: about.target }, target),
      h('span', { class: 'tool-meta' }),
      h('span', { class: 'tool-status' }),
      h('span', { class: 'tool-time' }),
      h('span', { class: 'tool-chev', html: icon('chevron') }))
    const pane = h('div', { class: 'tool-pane', hidden: true })
    const el = h('div', { class: 'tool', 'data-id': item.id, 'data-call': item.callId }, row, pane)
    const record = { el, row, pane, item, status: null, signature: '', meta: row.querySelector('.tool-meta'), glyph: row.querySelector('.tool-status'), time: row.querySelector('.tool-time'), target: row.querySelector('.tool-target'), verb: row.querySelector('.tool-verb') }
    this.tools.set(item.callId, record)
    if (this.expanded.has(item.callId)) this.setExpanded(record, true)
    return record
  }

  /** Brings a tool row's status, duration and open pane up to date; returns its state. */
  paintTool(record) {
    const state = toolState(this.agent, record.item)
    const { start, end } = this.timing(record)
    const elapsed = state.status === 'running' ? Date.now() - start : end && start ? end - start : null
    if (record.status !== state.status) {
      record.status = state.status
      record.el.dataset.status = state.status
      record.glyph.innerHTML = STATUS_GLYPHS[state.status] ?? ''
      record.glyph.title = STATUS_LABELS[state.status] ?? ''
      record.row.setAttribute('aria-label', `${record.verb.textContent} ${record.target.textContent}, ${STATUS_LABELS[state.status] ?? ''}`)
      this.autoExpand(record, state.status)
    }
    const about = describeTool(record.item.name, record.item.args)
    const target = firstLine(about.target)
    if (record.target.textContent !== target) {
      record.target.textContent = target
      record.target.title = about.target
    }
    setText(record.time, state.status === 'running' ? formatDuration(elapsed) : preciseDuration(elapsed, formatDuration))
    const meta = toolMeta(record.item, state, about)
    if (record.metaHtml !== meta) record.meta.innerHTML = record.metaHtml = meta
    if (record.open) this.paintPane(record, state)
    return state
  }

  /** A running bash command opens to show its output, and closes again when it succeeds. */
  autoExpand(record, status) {
    if (record.item.name !== 'bash' || record.touched) return
    if (status === 'running' && !record.open) {
      record.auto = true
      this.setExpanded(record, true)
    } else if (status === 'done' && record.auto) {
      record.auto = false
      this.setExpanded(record, false)
    }
  }

  /** When a tool call started and ended: the worker's clock while live, the transcript's otherwise. */
  timing(record) {
    const callId = record.item.callId
    const live = this.agent.tools.get(callId)
    const result = record.item.result ?? this.agent.resultFor(callId)
    const start = live?.startedAt ?? this.callTimes.get(callId) ?? null
    const end = live?.endedAt ?? result?.model?.[0]?.timestamp ?? null
    return { start, end }
  }

  setExpanded(record, open) {
    record.open = open
    record.row.setAttribute('aria-expanded', String(open))
    record.el.classList.toggle('open', open)
    record.pane.hidden = !open
    if (open) {
      this.expanded.add(record.item.callId)
      record.signature = ''
      this.paintPane(record, toolState(this.agent, record.item))
    } else {
      this.expanded.delete(record.item.callId)
    }
  }

  paintPane(record, state) {
    const { item } = record
    const signature = `${state.status}|${state.output?.length ?? 0}|${state.dropped ?? 0}|${Boolean(state.details?.diff || state.details?.patch)}|${JSON.stringify(item.args).length}`
    if (signature === record.signature) return
    const structural = record.signature.split('|')[0] !== state.status || !record.output
    record.signature = signature
    if (structural) {
      release(record.views)
      record.views = null
      record.pane.innerHTML = paneHtml(item, state)
      record.output = record.pane.querySelector('.term-output')
      if (record.output) record.output.scrollTop = record.output.scrollHeight
      this.highlightPane(record, state)
      return
    }
    const output = record.output
    const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 24
    output.querySelector('code').textContent = state.output ?? ''
    if (state.output) delete output.dataset.empty
    const trimmed = record.pane.querySelector('.term-trimmed')
    if (trimmed) trimmed.textContent = trimmedNote(state.dropped)
    if (atBottom) output.scrollTop = output.scrollHeight
  }

  /** Shows an edit's or write's changes with Pierre's diff, over the plain one, once the call is done. */
  highlightPane(record, state) {
    const host = record.pane.querySelector('.pierre-host')
    if (!host || state.status !== 'done') return
    const change = changeOf(record.item, state)
    if (!change) return
    const signature = record.signature
    renderChanges(host, change).then((views) => {
      if (!views) return
      if (record.signature !== signature || !host.isConnected) return release(views)
      record.views = views
      host.classList.add('rendered')
    })
  }

  // ─── Interaction ───────────────────────────────────────────────────────

  click(event) {
    const target = event.target.closest('[data-action]')
    if (!target) return
    switch (target.dataset.action) {
      case 'tool': {
        const record = this.tools.get(target.closest('.tool').dataset.call)
        if (!record) return
        record.touched = true
        this.setExpanded(record, !record.open)
        break
      }
      case 'toggle': {
        const id = target.dataset.row
        if (!this.open.delete(id)) this.open.add(id)
        this.render()
        break
      }
      case 'open-changes': {
        const row = this.rowRecords.get(target.dataset.row)?.row
        if (row) this.onOpenChanges?.(row, this.turns.find((turn) => turn.rows.includes(row)))
        break
      }
      case 'copy': {
        const block = target.closest('.codeblock')
        const source = block?.dataset.source ?? target.closest('.tool-pane')?.querySelector('[data-copy-source]')?.textContent ?? block?.querySelector('pre')?.textContent
        if (source !== undefined) copyText(source).then((copied) => flashCopied(target, copied))
        break
      }
      case 'more': {
        const prompt = target.previousElementSibling
        const clamped = prompt.classList.toggle('clamped')
        target.textContent = clamped ? 'Show more' : 'Show less'
        break
      }
    }
  }

  /** Opens whatever folds and groups hold an item, so it is in the document. */
  openTo(id) {
    const walk = (rows, path) => {
      for (const row of rows) {
        if (row.kind === 'item' && row.item.id === id) return path
        if (row.kind === 'turn' && row.prompt.id === id) return path
        const children = row.kind === 'turn' || row.kind === 'fold' ? row.rows : row.kind === 'group' ? row.items.map((item) => ({ kind: 'item', item })) : null
        const found = children && walk(children, row.kind === 'turn' ? path : [...path, row.id])
        if (found) return found
      }
      return null
    }
    const path = walk(this.rows, [])
    if (!path) return false
    for (const rowId of path) this.open.add(rowId)
    this.render()
    return true
  }

  /** Scrolls a tool call into view, opens it and highlights it. */
  reveal(callId) {
    this.openTo(`t${callId}`)
    const record = this.tools.get(callId)
    if (!record?.el.isConnected) return
    this.releaseAnchor()
    record.touched = true
    if (!record.open) this.setExpanded(record, true)
    record.el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    record.el.classList.remove('flash')
    void record.el.offsetWidth
    record.el.classList.add('flash')
    record.row.focus({ preventScroll: true })
  }

  /** Scrolls a turn's prompt to the top of the view. */
  showTurn(id) {
    const record = this.rowRecords.get(id)
    if (!record) return
    this.releaseAnchor()
    this.scroller.scrollTo({ top: record.el.offsetTop - ANCHOR_GAP, behavior: 'smooth' })
  }

  /** The tool calls since the latest prompt, settled and live, in order. */
  activity() {
    const calls = []
    for (let index = this.items.length - 1; index >= 0; index--) {
      const item = this.items[index]
      if (item.kind === 'user' && !item.steer) break
      if (item.kind === 'tool') calls.unshift(item)
    }
    return calls.map((item) => {
      const record = this.tools.get(item.callId)
      // A call in a closed group is not painted, so its record's status can be old.
      const status = toolState(this.agent, item).status
      const { start, end } = record ? this.timing(record) : {}
      return { callId: item.callId, name: item.name, args: item.args, status, start, end }
    })
  }
}

// ─── Item builders ───────────────────────────────────────────────────────

function createProse(item) {
  const body = h('div', { class: `prose${item.live ? ' live-text' : ''}`, html: markdown(item.text) })
  const record = { el: body, body, text: item.text }
  enhanceProse(record, item.live)
  return record
}

function createReasoning(item) {
  const label = item.redacted ? 'Reasoning (redacted)' : 'Reasoning'
  const summary = h('summary', { html: `${icon('chevron', 'chev')}${icon('reasoning')}<span class="reasoning-label">${label}</span>` })
  const previewEl = h('span', { class: 'reasoning-preview' }, preview(item.text))
  summary.append(previewEl)
  const body = h('div', { class: 'reasoning-body prose' })
  const el = h('details', { class: `reasoning${item.live ? ' live' : ''}` }, summary, body)
  const record = { el, body, preview: previewEl, text: item.text }
  el.addEventListener('toggle', () => {
    if (el.open) body.innerHTML = markdown(record.text)
  })
  return record
}

/** A compaction summary without the framing the model reads it in. */
function summaryText(text) {
  const match = /<summary>\s*([\s\S]*?)\s*<\/summary>\s*$/.exec(text ?? '')
  return match ? match[1] : text
}

function createDivider(kind, label, text) {
  const head = h('span', { class: 'divider-label', html: `${icon(kind)}<span>${label}</span>` })
  if (!text?.trim()) return { el: h('div', { class: `divider divider-${kind}`, role: 'separator' }, head) }
  head.insertAdjacentHTML('beforeend', icon('chevron', 'chev'))
  const summary = h('summary', { class: 'divider divider-' + kind }, head)
  const body = h('div', { class: 'divider-body prose', html: markdown(text) })
  return { el: h('details', { class: 'divider-wrap' }, summary, body) }
}

/**
 * Code blocks get a language label and a copy button, and once the text is settled, Pierre's highlighting; tables
 * scroll sideways.
 */
export function enhanceProse(record, live = false) {
  const container = record.body
  release(record.views)
  record.views = []
  for (const pre of container.querySelectorAll('pre')) {
    if (pre.parentElement.classList.contains('codeblock')) continue
    const code = pre.querySelector('code')
    const language = /language-([\w+#-]+)/.exec(code?.className ?? '')?.[1] ?? ''
    const block = h('div', { class: 'codeblock', 'data-source': (code ?? pre).textContent.replace(/\n$/, '') })
    const head = h('div', { class: 'codeblock-head' }, h('span', { class: 'lang' }, language || 'text'), copyButton('Copy code'))
    pre.replaceWith(block)
    block.append(head, pre)
    if (live) continue
    const host = h('div', { class: 'pierre-host' })
    block.append(host)
    renderCode(host, block.dataset.source, language.toLowerCase()).then((view) => {
      if (!view) return host.remove()
      if (!host.isConnected && !container.contains(host)) return release(view)
      record.views.push(view)
      block.classList.add('highlighted')
    })
  }
  for (const table of container.querySelectorAll('table')) {
    if (table.parentElement.classList.contains('table-wrap')) continue
    const wrap = h('div', { class: 'table-wrap' })
    table.replaceWith(wrap)
    wrap.append(table)
  }
}

function copyButton(label) {
  return h('button', { type: 'button', class: 'copy', 'data-action': 'copy', 'aria-label': label, html: `${icon('copy')}<span>Copy</span>` })
}

function flashCopied(button, copied) {
  const text = button.querySelector('span')
  if (!text) return
  text.textContent = copied ? 'Copied' : 'Failed'
  button.classList.add('done')
  setTimeout(() => {
    text.textContent = 'Copy'
    button.classList.remove('done')
  }, 1400)
}

// ─── Tool panes ──────────────────────────────────────────────────────────

/** What an edit or write changed, for Pierre: the edit's patch, or the file written whole. */
export function changeOf(item, state) {
  if (item.name === 'edit' && state.details?.patch) return { patch: state.details.patch }
  if (item.name === 'write' && typeof item.args?.content === 'string') return { path: String(item.args.path ?? item.args.file_path ?? 'file'), contents: item.args.content }
  return null
}

function paneHtml(item, state) {
  const body = String(state.output ?? '')
  const notes = String(state.note ?? '').split('\n').filter(Boolean)
  const exit = notes.map((note) => /exited with code (\d+)/.exec(note)?.[1]).find(Boolean)
  const running = state.status === 'running' || state.status === 'pending'
  switch (item.name) {
    case 'bash': {
      const command = String(item.args?.command ?? '')
      return `<div class="pane-head"><span class="prompt-sign">$</span><code class="pane-command" data-copy-source>${escapeHtml(command)}</code>${copyButtonHtml('Copy command')}</div>${terminal(body, state, running ? 'Waiting for output…' : 'No output')}${paneFoot(state, notes, exit)}`
    }
    case 'edit': {
      const diff = state.details?.diff
      if (diff) return `<div class="pierre-host">${diffView(diff)}</div>${paneFoot(state, notes)}`
      return `${terminal(body, state, running ? 'Editing…' : 'No changes shown')}${paneFoot(state, notes)}`
    }
    case 'write': {
      const content = String(item.args?.content ?? '')
      const lines = content.replace(/\n$/, '').split('\n')
      const rows = lines.map((line, index) => `<div class="dl diff-add"><span class="ln">${index + 1}</span><span class="sg">+</span><span class="tx">${escapeHtml(line) || ' '}</span></div>`).join('')
      return `${content ? `<div class="pierre-host"><div class="diff" role="region" aria-label="Written content">${rows}</div></div>` : ''}${body ? `<div class="pane-result">${escapeHtml(body)}</div>` : ''}${paneFoot(state, notes)}`
    }
    case 'read':
      return `${terminal(body, state, running ? 'Reading…' : 'Empty')}${paneFoot(state, notes)}`
    default:
      return `<pre class="pane-args"><code>${escapeHtml(JSON.stringify(item.args ?? {}, null, 2))}</code></pre>${terminal(body, state, running ? 'Running…' : 'No output')}${paneFoot(state, notes)}`
  }
}

function terminal(text, state, emptyText) {
  const trimmed = state.dropped ? `<div class="term-trimmed">${trimmedNote(state.dropped)}</div>` : ''
  const placeholder = text ? '' : ` data-empty="${escapeHtml(emptyText)}"`
  return `<div class="term${state.status === 'error' ? ' failed' : ''}">${trimmed}<pre class="term-output"${placeholder}><code>${escapeHtml(text)}</code></pre></div>`
}

function paneFoot(state, notes, exit) {
  const parts = []
  if (state.status === 'running') parts.push(`<span class="foot-running">${SPINNER}Running</span>`)
  if (state.status === 'interrupted') parts.push('<span class="foot-note">Interrupted before it finished</span>')
  if (exit) parts.push(`<span class="exit-chip">exit ${escapeHtml(exit)}</span>`)
  for (const note of notes) {
    if (!exit || !/exited with code/.test(note)) parts.push(`<span class="foot-note">${escapeHtml(note)}</span>`)
  }
  return parts.length ? `<div class="pane-foot">${parts.join('')}</div>` : ''
}

function copyButtonHtml(label) {
  return `<button type="button" class="copy" data-action="copy" aria-label="${label}">${icon('copy')}<span>Copy</span></button>`
}

/** The edit tool's numbered diff (`+12 text`), or a unified diff, as gutter rows. */
function diffView(diff) {
  if (/^@@/m.test(diff)) return `<pre class="diff unified">${diffHtml(diff)}</pre>`
  const rows = String(diff).split('\n').map((line) => {
    if (/^ \s*\.\.\.$/.test(line)) return '<div class="dl skip"><span class="ln"></span><span class="sg"></span><span class="tx">⋯</span></div>'
    const match = /^([+\- ])(\s*\d+)(?: (.*))?$/.exec(line)
    if (!match) return `<div class="dl diff-ctx"><span class="ln"></span><span class="sg"></span><span class="tx">${escapeHtml(line) || ' '}</span></div>`
    const [, sign, number, text = ''] = match
    const kind = sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx'
    return `<div class="dl diff-${kind}"><span class="ln">${number.trim()}</span><span class="sg">${sign === ' ' ? '' : sign === '-' ? '−' : '+'}</span><span class="tx">${escapeHtml(text) || ' '}</span></div>`
  })
  return `<div class="diff" role="region" aria-label="Changes">${rows.join('')}</div>`
}

function diffCounts(diff) {
  let added = 0
  let removed = 0
  for (const line of String(diff ?? '').split('\n')) {
    if (/^\+(?!\+\+)/.test(line)) added++
    else if (/^-(?!--)/.test(line)) removed++
  }
  return { added, removed }
}

function toolMeta(item, state, about) {
  if (item.name === 'edit' && (state.details?.patch || state.details?.diff)) {
    const { added, removed } = state.details.patch ? patchCounts(state.details.patch) : diffCounts(state.details.diff)
    return `<span class="add">+${added}</span><span class="del">−${removed}</span>`
  }
  if (item.name === 'write' && typeof item.args?.content === 'string') {
    const lines = item.args.content.replace(/\n$/, '').split('\n').length
    return `<span class="add">+${lines}</span>`
  }
  if (about.detail) return escapeHtml(about.detail)
  return ''
}

function trimmedNote(bytes) {
  if (!bytes) return ''
  const size = bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${size} of earlier output not shown`
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text
}

function firstLine(text) {
  const value = shortPath(String(text ?? ''))
  const newline = value.indexOf('\n')
  return newline < 0 ? value : `${value.slice(0, newline)} …`
}

function preview(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean
}

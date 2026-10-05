// The transcript as a document: one DOM node per display item, keyed by item id. Settled items are
// appended as entries arrive; the in-flight answer lives in a separate live container.
import { describeTool, diffHtml, escapeHtml, formatDuration, liveItems, markdown, stickToBottom, toolState, transcriptItems } from '/chat/shared/format.js'
import { SPINNER, copyText, formatTime, h, icon, preciseDuration, shortPath } from './ui.js'

const TOOL_ICONS = { bash: 'terminal', read: 'read', write: 'write', edit: 'edit' }
const STATUS_GLYPHS = { done: icon('check'), error: icon('cross'), interrupted: icon('slash'), pending: icon('clock'), running: SPINNER }
const STATUS_LABELS = { running: 'Running', pending: 'Waiting', done: 'Done', error: 'Failed', interrupted: 'Interrupted' }
const LONG_PROMPT = { chars: 700, lines: 12 }

export class Transcript {
  constructor(agent, { scroller, log, live, empty, onAway, onUnread }) {
    this.agent = agent
    this.onUnread = onUnread
    this.scroller = scroller
    this.log = log
    this.liveEl = live
    this.empty = empty
    this.scroll = stickToBottom(scroller, onAway)
    this.nodes = new Map()
    this.liveNodes = new Map()
    this.tools = new Map()
    this.active = new Set()
    this.expanded = new Set()
    this.callTimes = new Map()
    this.entryById = new Map()
    this.indexed = 0
    this.items = []
    for (const container of [log, live]) container.addEventListener('click', (event) => this.click(event))
  }

  // ─── Updates ───────────────────────────────────────────────────────────

  reset() {
    const pinned = this.scroll.pinned
    this.log.replaceChildren()
    this.liveEl.replaceChildren()
    for (const map of [this.nodes, this.liveNodes, this.tools, this.callTimes, this.entryById]) map.clear()
    this.active.clear()
    this.indexed = 0
    this.syncEntries()
    this.renderLive()
    this.refreshActive()
    if (pinned) this.scroller.scrollTop = this.scroller.scrollHeight
  }

  /** Applies a frame's worth of changes. */
  update(changes) {
    if (changes.has('entries')) this.syncEntries()
    this.renderLive()
    this.refreshActive()
    if (this.scroll.pinned) this.scroll.follow()
    else if (changes.has('entries') || changes.has('live')) this.onUnread?.()
  }

  syncEntries() {
    this.indexEntries()
    this.items = transcriptItems(this.agent)
    const fragment = document.createDocumentFragment()
    for (const item of this.items) {
      if (this.nodes.has(item.id)) continue
      let record = item.kind === 'tool' ? this.tools.get(item.callId) : null
      if (record && this.liveNodes.get(item.id) === record) this.liveNodes.delete(item.id)
      else record = this.create(item)
      if (item.kind === 'thinking' && this.liveNodes.get(`live-${item.id.split('-')[1]}`)?.el.open) record.el.open = true
      record.item = item
      this.nodes.set(item.id, record)
      fragment.append(record.el)
      if (item.kind === 'tool') this.active.add(item.callId)
    }
    this.log.append(fragment)
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

  renderLive() {
    const items = liveItems(this.agent)
    const seen = new Set()
    let previous = null
    for (const item of items) {
      if (this.nodes.has(item.id)) continue
      seen.add(item.id)
      let record = this.liveNodes.get(item.id)
      if (record && record.item?.kind !== item.kind) {
        record.el.remove()
        record = null
      }
      if (!record) {
        record = this.create(item, true)
        this.liveNodes.set(item.id, record)
        if (item.kind === 'tool') this.active.add(item.callId)
      } else {
        this.refreshLiveItem(record, item)
      }
      record.item = item
      const expected = previous ? previous.nextSibling : this.liveEl.firstChild
      if (expected !== record.el) this.liveEl.insertBefore(record.el, expected)
      previous = record.el
    }
    for (const [id, record] of this.liveNodes) {
      if (seen.has(id)) continue
      record.el.remove()
      this.liveNodes.delete(id)
      if (record.item?.kind === 'tool' && !this.nodes.has(id)) {
        this.tools.delete(record.item.callId)
        this.active.delete(record.item.callId)
      }
    }
    this.renderCompacting()
    const texts = this.liveEl.querySelectorAll('.prose')
    texts.forEach((node, index) => node.classList.toggle('streaming', index === texts.length - 1 && this.agent.busy))
    this.empty.hidden = this.items.length > 0 || items.length > 0 || !this.agent.everConnected
  }

  /** A row below everything else while the context is being compacted. */
  renderCompacting() {
    const [compaction] = this.agent.compactions
    if (!compaction) {
      this.compactingEl?.remove()
      return
    }
    const label = compaction.blocking || compaction.reason === 'manual' ? 'Compacting context' : 'Compacting context in the background'
    if (this.compactingEl?.dataset.label !== label) {
      this.compactingEl?.remove()
      this.compactingEl = h('div', { class: 'divider divider-compact compacting', role: 'status', 'data-label': label },
        h('span', { class: 'divider-label', html: `${SPINNER}<span>${label}</span>` }))
    }
    if (this.liveEl.lastChild !== this.compactingEl) this.liveEl.append(this.compactingEl)
  }

  refreshLiveItem(record, item) {
    if (item.kind === 'text' && record.text !== item.text) {
      record.text = item.text
      record.body.innerHTML = markdown(item.text)
      enhanceProse(record.body)
    } else if (item.kind === 'thinking' && record.text !== item.text) {
      record.text = item.text
      record.preview.textContent = preview(item.text)
      if (record.el.open) record.body.innerHTML = markdown(item.text)
    } else if (item.kind === 'tool') {
      record.item = item
      this.paintTool(record)
    }
  }

  refreshActive() {
    for (const callId of this.active) {
      const record = this.tools.get(callId)
      if (!record) {
        this.active.delete(callId)
        continue
      }
      const state = this.paintTool(record)
      if (state.status !== 'running' && state.status !== 'pending') this.active.delete(callId)
    }
  }

  /** Updates running tools' durations; called once a second. */
  tick() {
    for (const callId of this.active) {
      const record = this.tools.get(callId)
      if (record?.status === 'running') setText(record.time, formatDuration(Date.now() - this.timing(record).start))
    }
  }

  // ─── Items ─────────────────────────────────────────────────────────────

  create(item, live = false) {
    switch (item.kind) {
      case 'user': return this.createPrompt(item)
      case 'thinking': return createReasoning(item, live)
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

  createPrompt(item) {
    const entry = this.entryById.get(Number(item.id.slice(1)))
    const time = entry?.model?.[0]?.timestamp
    const who = item.from
      ? h('span', { class: 'sender', html: `${icon('agent')}<span>${escapeHtml(item.from)}</span>` })
      : h('span', { class: 'you', html: `${icon('person')}<span>You</span>` })
    const head = h('header', { class: 'turn-head' }, who, time ? h('time', { datetime: new Date(time).toISOString() }, formatTime(time)) : null)
    const long = item.text.length > LONG_PROMPT.chars || item.text.split('\n').length > LONG_PROMPT.lines
    const body = h('div', { class: `prompt${long ? ' clamped' : ''}` }, item.text)
    const more = long ? h('button', { type: 'button', class: 'more', 'data-action': 'more' }, 'Show more') : null
    return { el: h('article', { class: `turn${item.from ? ' from-agent' : ''}`, 'data-id': item.id, 'aria-label': item.from ? `Message from ${item.from}` : 'Your message' }, head, body, more) }
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
    const signature = `${state.status}|${state.output?.length ?? 0}|${state.dropped ?? 0}|${Boolean(state.details?.diff)}|${JSON.stringify(item.args).length}`
    if (signature === record.signature) return
    const structural = record.signature.split('|')[0] !== state.status || !record.output
    record.signature = signature
    if (structural) {
      record.pane.innerHTML = paneHtml(item, state)
      record.output = record.pane.querySelector('.term-output')
      if (record.output) record.output.scrollTop = record.output.scrollHeight
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
      case 'copy': {
        const source = target.closest('.codeblock, .tool-pane')?.querySelector('[data-copy-source]') ?? target.closest('.codeblock')?.querySelector('pre')
        if (source) copyText(source.textContent).then((copied) => flashCopied(target, copied))
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

  /** Scrolls a tool call into view, opens it and highlights it. */
  reveal(callId) {
    const record = this.tools.get(callId)
    if (!record) return
    record.touched = true
    if (!record.open) this.setExpanded(record, true)
    record.el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    record.el.classList.remove('flash')
    void record.el.offsetWidth
    record.el.classList.add('flash')
    record.row.focus({ preventScroll: true })
  }

  /** The tool calls since the latest prompt, settled and live, in order. */
  activity() {
    const calls = []
    for (let index = this.items.length - 1; index >= 0; index--) {
      const item = this.items[index]
      if (item.kind === 'user') break
      if (item.kind === 'tool') calls.unshift(item)
    }
    for (const record of this.liveNodes.values()) if (record.item?.kind === 'tool') calls.push(record.item)
    return calls.map((item) => {
      const record = this.tools.get(item.callId)
      const status = record?.status ?? toolState(this.agent, item).status
      const { start, end } = record ? this.timing(record) : {}
      return { callId: item.callId, name: item.name, args: item.args, status, start, end }
    })
  }
}

// ─── Item builders ───────────────────────────────────────────────────────

function createProse(item) {
  const body = h('div', { class: 'prose', html: markdown(item.text) })
  enhanceProse(body)
  return { el: body, body, text: item.text }
}

function createReasoning(item, live) {
  const label = item.redacted ? 'Reasoning (redacted)' : 'Reasoning'
  const summary = h('summary', { html: `${icon('chevron', 'chev')}${icon('reasoning')}<span class="reasoning-label">${label}</span>` })
  const previewEl = h('span', { class: 'reasoning-preview' }, preview(item.text))
  summary.append(previewEl)
  const body = h('div', { class: 'reasoning-body prose' })
  const el = h('details', { class: `reasoning${live ? ' live' : ''}` }, summary, body)
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

/** Code blocks get a language label and a copy button; tables scroll sideways. */
export function enhanceProse(container) {
  for (const pre of container.querySelectorAll('pre')) {
    if (pre.parentElement.classList.contains('codeblock')) continue
    const language = /language-([\w+#-]+)/.exec(pre.querySelector('code')?.className ?? '')?.[1] ?? ''
    const block = h('div', { class: 'codeblock' })
    const head = h('div', { class: 'codeblock-head' }, h('span', { class: 'lang' }, language || 'text'), copyButton('Copy code'))
    pre.replaceWith(block)
    block.append(head, pre)
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
      if (diff) return `${diffView(diff)}${paneFoot(state, notes)}`
      return `${terminal(body, state, running ? 'Editing…' : 'No changes shown')}${paneFoot(state, notes)}`
    }
    case 'write': {
      const content = String(item.args?.content ?? '')
      const lines = content.replace(/\n$/, '').split('\n')
      const rows = lines.map((line, index) => `<div class="dl diff-add"><span class="ln">${index + 1}</span><span class="sg">+</span><span class="tx">${escapeHtml(line) || ' '}</span></div>`).join('')
      return `${content ? `<div class="diff" role="region" aria-label="Written content">${rows}</div>` : ''}${body ? `<div class="pane-result">${escapeHtml(body)}</div>` : ''}${paneFoot(state, notes)}`
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
  if (item.name === 'edit' && state.details?.diff) {
    const { added, removed } = diffCounts(state.details.diff)
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

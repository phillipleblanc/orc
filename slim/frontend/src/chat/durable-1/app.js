import { DurableAgent } from '/chat/shared/agent.js'
import {
  contextTokens, describeTool, diffHtml, escapeHtml, formatCost, formatDuration, formatTokens, liveItems,
  markdown, modelLabel, stickToBottom, thinkingLevels, toolState, totalUsage, transcriptItems
} from '/chat/shared/format.js'

const $ = (id) => document.getElementById(id)
const agent = new DurableAgent()
const scroller = $('scroller')
const log = $('log')
const live = $('live')
const input = $('input')
const send = $('send')

const rendered = new Map()
// Tool rows whose call may still change: running, or waiting for a result.
const openTools = new Map()
// Tool rows the reader opened or closed; others follow their state.
const toggled = new Map()
const stick = stickToBottom(scroller, (away) => { $('jump').hidden = !away })
let liveFrame = 0
let modelList = null

const ICONS = {
  bash: '<path d="M2.5 4.5 6 8l-3.5 3.5M8 11.5h5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  read: '<path d="M3 3.5h4.2c.7 0 1.3.3 1.8.8.5-.5 1.1-.8 1.8-.8H13v9h-2.2c-.7 0-1.3.3-1.8.8-.5-.5-1.1-.8-1.8-.8H3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  write: '<path d="M4 2.5h5.5L12 5v8.5H4z M9.5 2.5V5H12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  edit: '<path d="m10.2 3.3 2.5 2.5-6.8 6.8H3.4v-2.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  other: '<circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" stroke-width="1.3"/>'
}
const STATE = {
  done: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error: '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7m0-7-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  interrupted: '<svg viewBox="0 0 16 16"><path d="M8 4v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="12" r="1.1" fill="currentColor"/></svg>',
  running: '<span class="spinner"></span>',
  pending: '<span class="pending-dot"></span>'
}
const CHEVRON = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 6.5 5l-3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const CLOSE = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6m0-6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
const AGENT_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="3" width="8" height="6.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="4.6" cy="6.2" r=".8" fill="currentColor"/><circle cx="7.4" cy="6.2" r=".8" fill="currentColor"/><path d="M6 1.2V3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'

function element(tag, className, html) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (html !== undefined) node.innerHTML = html
  return node
}

/** Markdown with a copy button on each code block. */
function prose(text, streaming = false) {
  const node = element('div', `text prose${streaming ? ' streaming' : ''}`, markdown(text))
  for (const pre of node.querySelectorAll('pre')) {
    const copy = element('button', 'copy', 'Copy')
    copy.type = 'button'
    pre.append(copy)
  }
  return node
}

// ─── Items ────────────────────────────────────────────────────────────────

function renderItem(item, streaming = false) {
  switch (item.kind) {
    case 'user': {
      const node = element('div', `user${item.from ? ' agent' : ''}`)
      if (item.from) node.append(element('div', 'sender', `${AGENT_ICON}${escapeHtml(item.from)}`))
      node.append(element('div', 'bubble', escapeHtml(item.text)))
      return node
    }
    case 'text':
      return prose(item.text, streaming)
    case 'thinking': {
      const node = element('details', 'thought')
      node.innerHTML = `<summary>${CHEVRON}<span class="${streaming ? 'shimmer' : ''}">${streaming ? 'Thinking' : 'Thought'}</span></summary><div class="body">${escapeHtml(item.text)}</div>`
      if (toggled.get(item.id)) node.open = true
      node.addEventListener('toggle', () => toggled.set(item.id, node.open))
      return node
    }
    case 'tool':
      return toolRow(item)
    case 'error':
      return element('div', 'callout', escapeHtml(item.text))
    case 'notice':
      return element('div', 'notice', `<span>${escapeHtml(item.text)}</span>`)
    case 'compaction': {
      const node = element('div')
      const divider = element('div', 'divider', '<button type="button" aria-expanded="false">Earlier context summarized</button>')
      const summary = element('div', 'summary prose', markdown(item.text.replace(/^<summary>\s*|\s*<\/summary>$/g, '')))
      summary.hidden = true
      divider.querySelector('button').addEventListener('click', (event) => {
        summary.hidden = !summary.hidden
        event.currentTarget.setAttribute('aria-expanded', String(!summary.hidden))
      })
      node.append(divider, summary)
      return node
    }
    case 'reset':
      return element('div', 'divider', `<span>New context${item.text ? ` · ${escapeHtml(item.text.slice(0, 80))}` : ''}</span>`)
    default:
      return element('div')
  }
}

function toolRow(item) {
  const node = element('div', 'tool')
  const { verb, target, detail } = describeTool(item.name, item.args)
  const head = element('button', 'tool-head')
  head.type = 'button'
  head.innerHTML = `<svg class="tool-icon" viewBox="0 0 16 16" aria-hidden="true">${ICONS[item.name] ?? ICONS.other}</svg>` +
    `<span class="verb">${escapeHtml(verb)}</span><span class="target" title="${escapeHtml(target)}">${escapeHtml(target)}</span>` +
    `<span class="meta">${detail ? escapeHtml(detail) : ''}</span><span class="state"></span>`
  const body = element('div', 'tool-body')
  head.addEventListener('click', () => {
    toggled.set(item.id, body.hidden)
    updateTool(node, item)
  })
  node.append(head, body)
  updateTool(node, item)
  return node
}

function updateTool(node, item) {
  const state = toolState(agent, item)
  node.dataset.status = state.status
  const head = node.firstElementChild
  const body = node.lastElementChild
  const glyph = STATE[state.status] ?? STATE.pending
  const stateNode = head.querySelector('.state')
  if (stateNode.dataset.glyph !== state.status) {
    stateNode.innerHTML = glyph
    stateNode.dataset.glyph = state.status
  }
  const elapsed = state.status === 'running' && state.startedAt ? Date.now() - state.startedAt : state.elapsed
  const meta = head.querySelector('.meta')
  const detail = describeTool(item.name, item.args).detail
  meta.textContent = [detail, elapsed >= 1000 ? formatDuration(elapsed) : ''].filter(Boolean).join(' · ')
  // Running commands, failures and edits show themselves; the reader can still open or close any.
  const open = toggled.has(item.id) ? toggled.get(item.id) : state.status === 'running' || state.status === 'error' || Boolean(state.details?.diff)
  head.setAttribute('aria-expanded', String(open))
  body.hidden = !open
  if (open) fillBody(body, state)
  if (state.status === 'running' || state.status === 'pending') openTools.set(item.id, { node, item })
  else openTools.delete(item.id)
}

function fillBody(body, state) {
  const diff = state.details?.diff
  const key = diff ? `diff:${diff.length}` : `out:${state.output?.length ?? 0}:${state.status}`
  if (body.dataset.key === key) return
  body.dataset.key = key
  if (diff) {
    body.innerHTML = `<pre class="output diff">${diffHtml(diff)}</pre>`
    return
  }
  const text = (state.output ?? '').replace(/\n+$/, '')
  const lines = text.split('\n')
  const shown = lines.length > 400 ? lines.slice(-400).join('\n') : text
  const dropped = (state.dropped ?? 0) > 0 || lines.length > 400 ? '<div class="dropped">Earlier output not shown</div>' : ''
  const note = state.note ? `<div class="note-line">${escapeHtml(state.note)}</div>` : ''
  const tail = state.status === 'running' && text ? ' tail' : ''
  body.innerHTML = `${dropped}<pre class="output${text ? '' : ' empty'}${tail}"><code>${text ? escapeHtml(shown) : state.status === 'running' ? 'Waiting for output…' : 'No output'}</code></pre>${note}`
}

// ─── Rendering ────────────────────────────────────────────────────────────

function appendItems(items) {
  for (const item of items) {
    if (rendered.has(item.id)) continue
    const node = renderItem(item)
    rendered.set(item.id, node)
    log.append(node)
  }
}

function renderAll() {
  log.replaceChildren()
  rendered.clear()
  openTools.clear()
  appendItems(transcriptItems(agent))
  renderLive()
  renderStatus()
  renderQueue()
  renderUsage()
  renderInfo()
  updateEmpty()
  requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight })
}

function renderEntries() {
  appendItems(transcriptItems(agent))
  for (const { node, item } of [...openTools.values()]) updateTool(node, item)
  updateEmpty()
  scheduleLive()
}

function scheduleLive() {
  if (liveFrame) return
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0
    renderLive()
    for (const { node, item } of [...openTools.values()]) if (log.contains(node)) updateTool(node, item)
    stick.follow()
  })
}

function renderLive() {
  const items = liveItems(agent).filter((item) => !rendered.has(item.id))
  live.replaceChildren(...items.map((item, index) => {
    const node = renderItem(item, index === items.length - 1 && (item.kind === 'text' || item.kind === 'thinking'))
    if (item.kind === 'tool') openTools.set(item.id, { node, item })
    return node
  }))
  const running = [...agent.tools.values()].some((tool) => tool.status === 'running')
  if (agent.busy && items.length === 0 && !running) live.append(element('div', 'working shimmer', agent.retry ? 'Waiting to retry' : 'Working'))
}

function renderStatus() {
  const status = $('status')
  const state = !agent.connected ? 'offline' : agent.retry ? 'retrying' : agent.busy ? 'working' : 'idle'
  $('state-dot').dataset.state = state
  $('banner').hidden = agent.connected || !agent.everConnected
  $('banner').textContent = 'Reconnecting to the agent…'
  updateComposer()
  if (Date.now() < errorUntil) return
  status.className = 'status'
  if (agent.retry) {
    status.classList.add('retry')
    const seconds = Math.max(0, Math.round((agent.retry.at - Date.now()) / 1000))
    status.innerHTML = `<span>Retrying in ${seconds}s</span><span class="grow">${escapeHtml(agent.retry.error.slice(0, 120))}</span>`
  } else if (agent.compactions.length > 0 && !agent.busy) {
    status.innerHTML = '<span class="pulse"></span><span>Summarizing earlier context…</span>'
  } else if (agent.busy) {
    const elapsed = agent.runStartedAt ? formatDuration(Date.now() - agent.runStartedAt) : ''
    status.innerHTML = `<span class="pulse"></span><span>Working</span><span class="elapsed">${elapsed}</span><span class="grow"></span><span><kbd>esc</kbd> to stop</span>`
  } else {
    status.replaceChildren()
  }
}

function renderQueue() {
  $('queue').replaceChildren(...agent.inbox.map((item) => {
    const chip = element('div', 'chip')
    chip.innerHTML = `<b>${item.mode === 'steer' ? 'Next step' : 'Queued'}</b><span class="what" title="${escapeHtml(item.text)}">${escapeHtml(item.text)}</span>`
    const withdraw = element('button', '', CLOSE)
    withdraw.type = 'button'
    withdraw.setAttribute('aria-label', 'Withdraw')
    withdraw.title = 'Withdraw'
    withdraw.addEventListener('click', () => agent.withdraw(item.id).catch(showError))
    chip.append(withdraw)
    return chip
  }))
}

function renderUsage() {
  const total = totalUsage(agent.usage)
  const used = contextTokens(agent)
  const limit = agent.info?.model?.contextWindow ?? 0
  const share = limit ? Math.min(1, used / limit) : 0
  const circumference = 2 * Math.PI * 6
  $('usage').innerHTML = (limit ? `<svg viewBox="0 0 16 16" aria-hidden="true"><circle class="track" cx="8" cy="8" r="6" fill="none" stroke-width="2"/>` +
    `<circle class="fill" cx="8" cy="8" r="6" fill="none" stroke-width="2" stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${circumference * (1 - share)}"/></svg>` : '') +
    `<span>${formatTokens(used)}${limit ? ` / ${formatTokens(limit)}` : ''}</span><span class="cost">${formatCost(total.cost)}</span>`
  $('usage').title = `Context: ${used.toLocaleString()} tokens${limit ? ` of ${limit.toLocaleString()}` : ''}\nIn ${total.input.toLocaleString()} · out ${total.output.toLocaleString()} · cached ${total.cacheRead.toLocaleString()}\nSpend ${formatCost(total.cost)}`
}

function renderInfo() {
  const info = agent.info
  $('session-name').textContent = info?.name || agent.session
  document.title = `${info?.name || agent.session} · Conversation`
  $('model-name').textContent = modelLabel(info)
  $('thinking-level').textContent = info?.model?.reasoning && info.thinkingLevel && info.thinkingLevel !== 'off' ? info.thinkingLevel : ''
  $('empty-detail').textContent = [modelLabel(info), info?.cwd?.replace(/^\/Users\/[^/]+/, '~')].filter(Boolean).join(' · ')
  $('menu-info').innerHTML = info ? `<div>${escapeHtml(info.cwd ?? '')}</div><div>${escapeHtml(info.storage ?? '')}</div>` : ''
  renderUsage()
}

function updateEmpty() {
  $('empty').hidden = agent.entries.length > 0 || !agent.everConnected
}

let errorUntil = 0
function showError(error) {
  const status = $('status')
  status.className = 'status error'
  status.textContent = error?.message ?? String(error)
  errorUntil = Date.now() + 6000
  setTimeout(renderStatus, 6000)
}

// ─── Composer ─────────────────────────────────────────────────────────────

function updateComposer() {
  const hasText = input.value.trim().length > 0
  const stop = agent.busy && !hasText
  send.dataset.mode = stop ? 'stop' : 'send'
  send.setAttribute('aria-label', stop ? 'Stop' : agent.busy ? 'Steer' : 'Send')
  send.title = stop ? 'Stop (esc)' : agent.busy ? 'Send now: reaches the agent at its next step (↵)' : 'Send (↵)'
  send.disabled = !agent.connected || (!stop && !hasText)
  $('queue-button').hidden = !(agent.busy && hasText)
  $('queue-button').title = 'Send after the current work finishes (⌥↵)'
  $('hint').textContent = agent.busy ? '↵ steers the current work · ⌥↵ queues for after' : '↵ to send · ⇧↵ for a new line'
  input.placeholder = agent.busy ? 'Steer the agent, or queue a follow-up' : 'Message the agent'
}

function autosize() {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`
}

function submit(mode) {
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  autosize()
  updateComposer()
  stick.jump()
  agent.send(text, mode).catch((error) => {
    input.value = text
    autosize()
    updateComposer()
    showError(error)
  })
}

$('composer').addEventListener('submit', (event) => {
  event.preventDefault()
  if (send.dataset.mode === 'stop') agent.stop().catch(showError)
  else submit('steer')
})
$('queue-button').addEventListener('click', () => submit('followUp'))
input.addEventListener('input', () => { autosize(); updateComposer() })
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submit(agent.busy && (event.altKey || event.metaKey) ? 'followUp' : 'steer')
  }
})
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (!$('model-popover').hidden || !$('menu').hidden) closePopovers()
  else if (agent.busy) agent.stop().catch(showError)
})

// ─── Model and menu ───────────────────────────────────────────────────────

function place(popover, anchor, alignRight = false) {
  const box = anchor.getBoundingClientRect()
  popover.style.top = `${box.bottom + 6}px`
  if (alignRight) {
    popover.style.left = ''
    popover.style.right = `${Math.max(8, window.innerWidth - box.right)}px`
  } else {
    popover.style.right = ''
    popover.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - popover.offsetWidth - 8))}px`
  }
}

function closePopovers() {
  $('model-popover').hidden = true
  $('menu').hidden = true
  $('model-button').setAttribute('aria-expanded', 'false')
  $('menu-button').setAttribute('aria-expanded', 'false')
}

async function openModels() {
  closePopovers()
  const popover = $('model-popover')
  popover.hidden = false
  $('model-button').setAttribute('aria-expanded', 'true')
  place(popover, $('model-button'))
  $('model-filter').value = ''
  $('model-filter').focus()
  renderLevels()
  if (!modelList) {
    $('model-list').innerHTML = '<div class="note">Loading models…</div>'
    modelList = await agent.models().catch((error) => { showError(error); return [] })
  }
  renderModels()
}

function renderModels() {
  const filter = $('model-filter').value.trim().toLowerCase()
  const current = agent.info?.model
  const matching = (modelList ?? []).filter((model) => !filter || `${model.provider} ${model.modelId} ${model.name}`.toLowerCase().includes(filter))
  const list = $('model-list')
  list.replaceChildren()
  if (matching.length === 0) list.append(element('div', 'note', modelList?.length ? 'No matching models' : 'No signed-in providers. Sign in with pi /login.'))
  let provider = ''
  for (const model of matching.slice(0, 200)) {
    if (model.provider !== provider) {
      provider = model.provider
      list.append(element('div', 'group', escapeHtml(provider)))
    }
    const option = element('button', '', `<span>${escapeHtml(model.name || model.modelId)}</span><span class="id">${escapeHtml(model.modelId)}</span>`)
    option.type = 'button'
    option.setAttribute('role', 'option')
    option.setAttribute('aria-selected', String(current?.provider === model.provider && current?.modelId === model.modelId))
    option.addEventListener('click', () => {
      agent.configure({ model: { provider: model.provider, modelId: model.modelId } }).then(renderLevels, showError)
      closePopovers()
    })
    list.append(option)
  }
}

function renderLevels() {
  const levels = thinkingLevels(agent.info)
  $('levels').replaceChildren(...levels.map((level) => {
    const button = element('button', '', level)
    button.type = 'button'
    button.setAttribute('role', 'radio')
    button.setAttribute('aria-checked', String((agent.info?.thinkingLevel ?? 'off') === level))
    button.disabled = levels.length < 2
    button.title = levels.length < 2 ? 'This model does not think' : `Thinking: ${level}`
    button.addEventListener('click', () => agent.configure({ thinkingLevel: level }).then(renderLevels, showError))
    return button
  }))
}

function openMenu() {
  const opening = $('menu').hidden
  closePopovers()
  if (!opening) return
  const menu = $('menu')
  menu.querySelector('.handoff')?.remove()
  menu.hidden = false
  $('menu-button').setAttribute('aria-expanded', 'true')
  place(menu, $('menu-button'), true)
}

$('model-button').addEventListener('click', () => ($('model-popover').hidden ? openModels() : closePopovers()))
$('model-filter').addEventListener('input', renderModels)
$('menu-button').addEventListener('click', openMenu)
$('menu').addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action
  if (action === 'compact') {
    agent.compact().catch(showError)
    closePopovers()
  } else if (action === 'new' && !$('menu').querySelector('.handoff')) {
    // A new context needs confirming; a note carries what the agent should remember.
    const form = element('div', 'handoff', '<textarea placeholder="Optional note for the new context, e.g. what we were doing"></textarea><div class="row"><button type="button" data-cancel>Cancel</button><button type="button" class="primary" data-start>Start new context</button></div>')
    $('menu-info').before(form)
    form.querySelector('textarea').focus()
    form.querySelector('[data-cancel]').addEventListener('click', closePopovers)
    form.querySelector('[data-start]').addEventListener('click', () => {
      agent.newContext(form.querySelector('textarea').value.trim()).catch(showError)
      closePopovers()
    })
  }
})
document.addEventListener('mousedown', (event) => {
  if (!event.target.closest('.popover, .menu, #model-button, #menu-button')) closePopovers()
})

// ─── Wiring ───────────────────────────────────────────────────────────────

log.addEventListener('click', (event) => {
  const copy = event.target.closest('.copy')
  if (!copy) return
  const code = copy.parentElement.querySelector('code')?.textContent ?? ''
  navigator.clipboard?.writeText(code).then(() => {
    copy.textContent = 'Copied'
    setTimeout(() => { copy.textContent = 'Copy' }, 1200)
  })
})
$('jump').addEventListener('click', () => stick.jump())

agent.addEventListener('change', (event) => {
  switch (event.detail) {
    case 'reset': renderAll(); break
    case 'entries': renderEntries(); break
    case 'live': scheduleLive(); break
    case 'status': renderStatus(); scheduleLive(); break
    case 'inbox': renderQueue(); break
    case 'usage': renderUsage(); break
    case 'info': renderInfo(); renderLevels(); break
    case 'error': showError(agent.errors.at(-1)); break
  }
})

// Elapsed times while the agent works.
setInterval(() => {
  if (!agent.busy && !agent.retry) return
  renderStatus()
  for (const { node, item } of openTools.values()) updateTool(node, item)
}, 1000)

renderStatus()
updateComposer()
agent.connect()
input.focus()

// Workbench: a durable agent's transcript as a document, beside an inspector rail.
import { DurableAgent } from '/chat/shared/agent.js'
import { escapeHtml, formatDuration } from '/chat/shared/format.js'
import { ChangesPanel } from './changes-panel.js'
import { Composer } from './composer.js'
import { Minimap } from './minimap.js'
import { ModelPicker } from './model-picker.js'
import { olderPuller } from './older.js'
import { QueueView } from './queue.js'
import { Rail } from './rail.js'
import { agentStatus } from './status.js'
import { Transcript } from './transcript.js'
import { h, icon, prefs } from './ui.js'

const $ = (id) => document.getElementById(id)
const TOAST_MS = 8000
const narrow = matchMedia('(max-width: 900px)')

const agent = new DurableAgent()
const app = $('app')

const changes = new ChangesPanel(agent, { root: $('changes'), title: $('changes-title'), counts: $('changes-counts'), body: $('changes-body'), close: $('changes-close') })
changes.onToggle = (open) => {
  app.dataset.panel = open ? 'changes' : ''
  if (open) $('changes').focus({ preventScroll: true })
}

const transcript = new Transcript(agent, {
  scroller: $('scroller'),
  log: $('log'),
  empty: $('empty'),
  onAway(away) {
    $('jump').hidden = !away
    if (!away) delete $('jump').dataset.unread
  },
  onUnread: () => { $('jump').dataset.unread = '' },
  onOpenChanges: (row, turn) => changes.open(row, turn),
  onTurns: (turns) => minimap.render(turns)
})

const minimap = new Minimap({
  root: $('minimap'),
  scroller: $('scroller'),
  elementOf: (id) => transcript.rowRecords.get(id)?.el,
  onSelect: (id) => transcript.showTurn(id)
})

const rail = new Rail(agent, {
  root: $('rail'),
  toast,
  onNewContext: () => confirmNewContext()
})

const picker = new ModelPicker(agent, {
  button: $('model-button'),
  popover: $('model-popover'),
  filter: $('model-filter'),
  list: $('model-list'),
  levels: $('levels'),
  toast
})

const composer = new Composer(agent, {
  form: $('composer'),
  input: $('input'),
  segment: $('segment'),
  hint: $('hint'),
  send: $('send'),
  stop: $('stop'),
  toast,
  onHeld: () => queue.render()
})

const queue = new QueueView(agent, composer, { root: $('queue'), toast })
const pullOlder = olderPuller(agent, $('scroller'))

// ─── Rendering ───────────────────────────────────────────────────────────

let pending = new Set()
let frame = 0
let errorsShown = 0
let modelsRequested = false

agent.addEventListener('change', (event) => {
  if (event.detail === 'reset') {
    cancelAnimationFrame(frame)
    frame = 0
    pending.clear()
    renderAll()
    return
  }
  pending.add(event.detail)
  if (!frame) frame = requestAnimationFrame(flush)
})

function renderAll() {
  transcript.reset()
  rail.signatures = {}
  renderChrome()
  pullOlder()
}

/** Applies the changes gathered since the last frame. */
function flush() {
  frame = 0
  const changes = pending
  pending = new Set()
  if (changes.has('older')) transcript.prepend()
  if (changes.has('entries') || changes.has('live') || changes.has('status')) transcript.update(changes)
  if (changes.has('error')) showAgentErrors()
  if (changes.has('status') && !agent.connected) modelsRequested = false
  renderChrome()
  pullOlder()
}

function renderChrome() {
  if (agent.connected && !modelsRequested) {
    modelsRequested = true
    picker.load().then(() => rail.setModels(picker.models), () => {})
  }
  const status = agentStatus(agent)
  renderTopbar(status)
  picker.render()
  rail.render(status)
  queue.render()
  composer.sync()
  composer.release()
  $('connecting').hidden = agent.everConnected
  const offline = !agent.connected && (agent.everConnected || performance.now() > 1500)
  $('banner').hidden = !offline
  if (offline) $('banner-text').textContent = agent.everConnected ? 'Connection lost. Reconnecting…' : 'Can’t reach the agent yet. Retrying…'
  app.dataset.state = status.key
}

let topbarSignature = ''

function renderTopbar(status) {
  const name = agent.info?.name || agent.session || 'Agent'
  const timer = status.since ? formatDuration(Date.now() - status.since) : ''
  const signature = [name, status.key, status.label, timer].join('|')
  if (signature === topbarSignature) return
  topbarSignature = signature
  $('tb-name').textContent = name
  document.title = `${name} · Workbench`
  $('tb-dot').dataset.state = status.key
  $('tb-state').innerHTML = `<span class="tb-state-label">${escapeHtml(status.label)}</span>${timer ? `<span class="tb-timer">${timer}</span>` : ''}`
  $('tb-state').dataset.state = status.key
}

setInterval(() => {
  if (!agent.busy && !agent.retry) return
  const status = agentStatus(agent)
  transcript.tick()
  rail.tick(status)
  renderTopbar(status)
}, 1000)

// ─── Toasts ──────────────────────────────────────────────────────────────

function toast(message, kind = 'error') {
  const node = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('span', { class: 'toast-icon', html: icon(kind === 'error' ? 'warning' : 'info') }),
    h('span', { class: 'toast-text' }, message),
    h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', html: icon('close'), onclick: () => node.remove() }))
  $('toasts').append(node)
  setTimeout(() => node.remove(), kind === 'error' ? TOAST_MS * 2 : TOAST_MS)
}

function showAgentErrors() {
  for (; errorsShown < agent.errors.length; errorsShown++) toast(agent.errors[errorsShown].message)
}

// ─── Rail and dialogs ────────────────────────────────────────────────────

let railOpen = false

/** Wide layouts show or hide the rail in place; narrow ones slide it over the transcript. */
function setRail(open) {
  if (narrow.matches) {
    railOpen = open
    app.dataset.drawer = open ? 'open' : 'closed'
    $('scrim').hidden = !open
  } else {
    app.dataset.rail = open ? 'shown' : 'hidden'
    prefs.set('rail', open ? undefined : 'hidden')
  }
  syncRailToggle()
  if (open && narrow.matches) $('rail').focus({ preventScroll: true })
}

function railVisible() {
  return narrow.matches ? railOpen : app.dataset.rail !== 'hidden'
}

function syncRailToggle() {
  const visible = railVisible()
  $('rail-toggle').setAttribute('aria-expanded', String(visible))
  $('rail-toggle').setAttribute('aria-label', visible ? 'Hide inspector' : 'Show inspector')
  $('rail').inert = narrow.matches && !railOpen
}

$('rail-toggle').addEventListener('click', () => setRail(!railVisible()))
$('scrim').addEventListener('click', () => setRail(false))
narrow.addEventListener('change', () => {
  railOpen = false
  app.dataset.drawer = 'closed'
  $('scrim').hidden = true
  syncRailToggle()
})
app.dataset.rail = prefs.get('rail', 'shown')
syncRailToggle()

$('jump').addEventListener('click', () => transcript.scroll.jump())

function confirmNewContext() {
  const dialog = $('new-context')
  $('new-context-note').value = ''
  dialog.returnValue = ''
  dialog.showModal()
  $('new-context-note').focus()
}

$('new-context').addEventListener('close', () => {
  const dialog = $('new-context')
  if (dialog.returnValue !== 'confirm') return
  agent.newContext($('new-context-note').value.trim() || undefined)
    .then(() => toast('Started a new context', 'info'))
    .catch((error) => toast(`Could not start a new context: ${error.message}`))
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
  if ($('new-context').open) return
  if (changes.isOpen) {
    changes.close()
    return
  }
  if (picker.isOpen) {
    picker.close()
    $('model-button').focus()
    return
  }
  if (narrow.matches && railOpen) {
    setRail(false)
    $('rail-toggle').focus()
    return
  }
  if (agent.busy || agent.compactions.length) {
    event.preventDefault()
    composer.stop()
  }
})

renderChrome()
setTimeout(renderChrome, 1600)
agent.connect()

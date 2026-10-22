import { Bridge, BridgeError, CLIENT, type Init } from './bridge.ts'
import { DurableChat, statusText } from './durable-chat.ts'
import { TerminalView } from './terminal-view.ts'

type ProgramRecord = { id: string; state: string; kind?: string; progress?: number; title?: string; msg?: string }
type TerminalRow = {
  handle: string; title: string; worktreeId: string; worktreePath: string; connected: boolean; agentIdentity: string | null
  programStatus?: { state: string; records: ProgramRecord[] }
}
type AgentRow = { name: string; agent: string; state: string; since: number; dialog?: unknown }
type BriefRow = { name: string; brief: { headline: string; now: string; needsYou: string | null } | null; generatedAt: number | null }
type RepoRow = { id: string; displayName: string }
type Status = 'needs-you' | 'working' | 'idle' | 'ended'
type Session = {
  name: string; handle: string; project: string; agent: string | null; status: Status; connected: boolean
  headline: string; now: string; question: string | null
  /** What a program in the session says it is doing, with OSC 7501. */
  program: string | null
}
type View = { kind: 'home' } | { kind: 'session'; name: string } | { kind: 'unknown' }

const POLL_MS = 3000
const STATUS_TEXT: Record<Status, string> = { 'needs-you': 'Needs you', working: 'Working', idle: 'Idle', ended: 'Ended' }
const KEYS: [label: string, key: string][] = [['Esc', 'escape'], ['Tab', 'tab'], ['←', 'left'], ['↑', 'up'], ['↓', 'down'], ['→', 'right'], ['^C', 'interrupt'], ['⏎', 'enter']]

const app = document.getElementById('app')!
const bridge = Bridge.find()
let init: Init | null = null
let hostId = ''
/** What this document was opened on; Back from a screen the page drew over it returns here. */
let root: View = { kind: 'home' }
let view: View = { kind: 'home' }
let sessions: Session[] | null = null
let loadError: string | null = null
let pollTimer = 0
let painted = false
let terminal: TerminalView | null = null
let terminalName = ''
let chat: DurableChat | null = null
let chatName = ''
/** A durable agent's screen shows its chat, or else its terminal. */
let chatShown = true
let backClaimed = false

if (!bridge) {
  app.replaceChildren(screenMessage('Open this in the Orca app', 'This page is how the Orca phone app shows Orc. Pair your phone with Orc, then open your computer in the app.'))
} else {
  bridge.onInit = (next, fresh) => {
    init = next
    applyInsets()
    if (!fresh) return
    hostId = next.host?.id ?? ''
    root = viewOf(next.route?.pathname ?? '')
    view = root
    sessions = null
    render()
    void refresh()
  }
  bridge.onConnection = (state) => {
    if (init) init.connection.state = state
    renderBanner()
    if (state === 'connected') void refresh()
  }
  bridge.onBack = () => chat?.overlayOpen ? chat.closeOverlay() : show(root)
  bridge.start()
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh() })
}

function viewOf(pathname: string): View {
  const segments = pathname.split('/').filter(Boolean).map((segment) => { try { return decodeURIComponent(segment) } catch { return segment } })
  if (segments[0] !== 'h') return { kind: 'unknown' }
  if (segments.length === 2) return { kind: 'home' }
  if (segments.length === 4 && segments[2] === 'orc') return { kind: 'session', name: segments[3] }
  return { kind: 'unknown' }
}

function hrefOf(target: View): string {
  const host = `/h/${encodeURIComponent(hostId)}`
  return target.kind === 'session' ? `${host}/orc/${encodeURIComponent(target.name)}` : host
}

const wide = () => init?.ownsHostArea === true

/** Opens a session: a pushed screen of its own on a phone, the detail pane on a wide screen. */
function open(name: string): void {
  const target: View = { kind: 'session', name }
  if (!wide() && bridge!.can('navigate') && root.kind !== 'session') {
    bridge!.notify('navigate', { href: hrefOf(target) })
    return
  }
  show(target)
}

function back(): void {
  if (hrefOf(view) !== hrefOf(root)) return show(root)
  if (bridge!.can('navigate')) bridge!.notify('navigate-back')
}

function show(next: View): void {
  view = next
  render()
}

/** Back belongs to the page while it draws a screen or a panel over the one it was opened on. */
function claimBack(): void {
  const claim = (!wide() && hrefOf(view) !== hrefOf(root)) || Boolean(chat?.overlayOpen)
  if (claim === backClaimed) return
  backClaimed = claim
  bridge!.notify('back-claim', { claimed: claim })
}

async function refresh(): Promise<void> {
  window.clearTimeout(pollTimer)
  if (!init) return
  try {
    const [terminals, agents, briefs, repos] = await Promise.all([
      bridge!.request<{ terminals: TerminalRow[] }>('terminal.list', {}),
      bridge!.request<{ agents: AgentRow[] }>('agent.list').catch(() => ({ agents: [] })),
      bridge!.request<{ briefs: BriefRow[] }>('brief.list').catch(() => ({ briefs: [] })),
      bridge!.request<{ repos: RepoRow[] }>('repo.list').catch(() => ({ repos: [] }))
    ])
    sessions = describe(terminals.terminals, agents.agents, briefs.briefs, repos.repos)
    loadError = null
  } catch (error) {
    loadError = error instanceof BridgeError ? error.message : String(error)
  }
  update()
  if (document.visibilityState === 'visible') pollTimer = window.setTimeout(() => void refresh(), POLL_MS)
}

function describe(terminals: TerminalRow[], agents: AgentRow[], briefs: BriefRow[], repos: RepoRow[]): Session[] {
  const agentOf = new Map(agents.map((agent) => [agent.name, agent]))
  const briefOf = new Map(briefs.map((brief) => [brief.name, brief]))
  const repoName = new Map(repos.map((repo) => [repo.id, repo.displayName]))
  return terminals.map((row) => {
    const agent = agentOf.get(row.title)
    const record = briefOf.get(row.title)
    const brief = record?.brief ?? null
    // A brief's question counts only if it was written after the agent last changed state, so an answered one does not linger.
    const asks = brief?.needsYou && agent && (record?.generatedAt ?? 0) >= agent.since ? brief.needsYou : null
    const program = row.programStatus?.state
    const status: Status = !row.connected ? 'ended'
      : agent?.state === 'permission' || program === 'blocked' ? 'needs-you'
      : agent?.state === 'working' || program === 'working' ? 'working'
      : asks ? 'needs-you' : 'idle'
    const repoId = row.worktreeId.split('::')[0]
    return {
      name: row.title, handle: row.handle, connected: row.connected, status,
      project: repoId === 'local' ? folderName(row.worktreePath) : repoName.get(repoId) ?? folderName(row.worktreePath),
      agent: agent?.agent ?? row.agentIdentity,
      headline: brief?.headline ?? '', now: brief?.now ?? '',
      question: agent?.state === 'permission' ? 'Waiting for your permission' : asks,
      program: row.programStatus ? programText(row.programStatus) : null
    }
  })
}

/** The most urgent record's own words, or its state, as Orc's desktop shows it. */
function programText(status: { state: string; records: ProgramRecord[] }): string {
  const urgent = status.records.filter((record) => record.state === status.state)
  const lead = urgent.find((record) => record.id === '') ?? urgent[0] ?? status.records[0]
  if (!lead) return status.state
  const said = lead.msg ?? lead.title
  if (said) return lead.state === 'working' && lead.progress !== undefined ? `${said} · ${lead.progress}%` : said
  switch (lead.state) {
    case 'working': return lead.progress !== undefined ? `Working, ${lead.progress}%` : 'Working'
    case 'blocked': return lead.kind === 'permission' ? 'Needs permission' : lead.kind === 'question' ? 'Has a question' : lead.kind === 'auth' ? 'Needs you to sign in' : 'Needs you'
    case 'error': return 'Failed'
    default: return lead.state[0].toUpperCase() + lead.state.slice(1)
  }
}

function folderName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

// Rendering.

function render(): void {
  // The screen is rebuilt, and a session's terminal and chat with it.
  closeTerminal()
  closeChat()
  document.body.classList.toggle('wide', wide())
  const banner = el('div', { class: 'banner', role: 'status' })
  if (wide()) {
    const detail = view.kind === 'session' ? sessionScreen(view.name) : view.kind === 'unknown' ? unknownScreen() : placeholder()
    app.replaceChildren(banner, el('div', { class: 'split' }, el('aside', { class: 'sidebar' }, homeScreen()), el('section', { class: 'detail' }, detail)))
  } else {
    app.replaceChildren(banner, view.kind === 'session' ? sessionScreen(view.name) : view.kind === 'unknown' ? unknownScreen() : homeScreen())
  }
  claimBack()
  renderBanner()
  update()
}

function renderBanner(): void {
  const banner = app.querySelector<HTMLElement>('.banner')
  if (!banner) return
  const state = init?.connection.state ?? 'connected'
  banner.hidden = state === 'connected'
  banner.textContent = state === 'auth-failed' ? 'Your computer no longer accepts this phone. Pair it again from Orc.' : 'Reconnecting to your computer…'
}

/** Fills the parts of the screen that follow the session list. */
function update(): void {
  const list = app.querySelector<HTMLElement>('.sessions')
  if (list) list.replaceChildren(...sessionList())
  const count = app.querySelector<HTMLElement>('.home .subtitle')
  if (count) count.textContent = sessions ? `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}` : ''
  const screen = app.querySelector<HTMLElement>('.session-screen')
  const shown = view.kind === 'session' ? view.name : null
  if (screen && shown) fillSession(screen, sessions?.find((session) => session.name === shown))
  if (!painted && (sessions || loadError || view.kind !== 'home')) {
    painted = true
    requestAnimationFrame(() => bridge!.notify('painted'))
  }
}

function homeScreen(): HTMLElement {
  const title = init?.host?.name ? init.host.name : 'Orc'
  const leading = bridge!.can('navigate') && !wide() ? backButton(null) : null
  return el('div', { class: 'screen home' },
    el('header', { class: 'bar' }, leading, el('div', { class: 'titles' }, el('h1', {}, title), el('span', { class: 'subtitle' }))),
    el('main', { class: 'sessions scroll' }))
}

function sessionList(): HTMLElement[] {
  if (!sessions) {
    return [loadError ? errorBlock(loadError) : el('p', { class: 'empty' }, 'Loading sessions…')]
  }
  if (sessions.length === 0) {
    return [el('div', { class: 'empty' }, el('p', {}, 'No sessions are running.'), el('p', { class: 'hint' }, 'Start one on your computer with orc new.'))]
  }
  const blocks: HTMLElement[] = []
  if (loadError) blocks.push(errorBlock(loadError))
  const waiting = sessions.filter((session) => session.status === 'needs-you')
  if (waiting.length) blocks.push(group('Needs you', waiting, 'needs'))
  const projects = new Map<string, Session[]>()
  for (const session of sessions) {
    if (session.status === 'needs-you') continue
    projects.set(session.project, [...(projects.get(session.project) ?? []), session])
  }
  for (const [project, members] of [...projects].sort(([a], [b]) => a.localeCompare(b))) {
    blocks.push(group(project, members.sort(byStatus)))
  }
  return blocks
}

function byStatus(a: Session, b: Session): number {
  const order: Status[] = ['needs-you', 'working', 'idle', 'ended']
  return order.indexOf(a.status) - order.indexOf(b.status) || a.name.localeCompare(b.name)
}

function group(title: string, members: Session[], kind = ''): HTMLElement {
  return el('section', { class: `group ${kind}` }, el('h2', {}, title), ...members.map(sessionRow))
}

function sessionRow(session: Session): HTMLElement {
  const detail = session.question ?? (session.headline || (session.connected ? session.program : null) || STATUS_TEXT[session.status])
  const selected = view.kind === 'session' && view.name === session.name
  const row = el('button', { class: `row ${session.status}${selected ? ' selected' : ''}`, type: 'button' },
    el('span', { class: 'dot', 'aria-label': STATUS_TEXT[session.status] }),
    el('span', { class: 'row-text' },
      el('span', { class: 'row-title' }, el('span', { class: 'name' }, session.name), session.agent ? el('span', { class: 'badge' }, session.agent) : null),
      el('span', { class: 'row-detail' }, detail)))
  row.addEventListener('click', () => open(session.name))
  return row
}

function sessionScreen(name: string): HTMLElement {
  chatShown = true
  const modes = el('div', { class: 'modes', role: 'tablist', hidden: '' }, modeButton('Chat', 'chat'), modeButton('Terminal', 'terminal'))
  const screen = el('div', { class: 'screen session-screen' },
    el('header', { class: 'bar' }, backButton(null),
      el('div', { class: 'titles' }, el('h1', {}, name), el('span', { class: 'subtitle' })), modes),
    el('div', { class: 'chat-slot' }),
    el('div', { class: 'brief', hidden: '' }),
    el('div', { class: 'terminal-slot' }, el('p', { class: 'empty' }, 'Connecting…')),
    keyRow(),
    composer())
  if (wide()) screen.querySelector('.bar .back')?.remove()
  return screen
}

function modeButton(label: string, mode: 'chat' | 'terminal'): HTMLElement {
  const button = el('button', { type: 'button', role: 'tab', 'data-mode': mode }, label)
  button.addEventListener('click', () => {
    chatShown = mode === 'chat'
    update()
  })
  return button
}

/**
 * Shows the session once it is known: a durable agent's chat, or the terminal with the session's status and brief. A
 * terminal is open only while shown, since a phone viewing it sizes the session to the phone.
 */
function fillSession(screen: HTMLElement, session: Session | undefined): void {
  const subtitle = screen.querySelector<HTMLElement>('.subtitle')!
  const slot = screen.querySelector<HTMLElement>('.terminal-slot')!
  const brief = screen.querySelector<HTMLElement>('.brief')!
  const modes = screen.querySelector<HTMLElement>('.modes')!
  if (!session) {
    if (sessions) {
      closeTerminal()
      closeChat()
      modes.hidden = true
      screen.dataset.mode = 'terminal'
      subtitle.textContent = 'Not running'
      slot.replaceChildren(el('div', { class: 'empty' }, el('p', {}, 'This session is not running anymore.')))
    }
    return
  }
  const durable = session.agent === 'durable' && session.connected
  const mode = durable && chatShown ? 'chat' : 'terminal'
  screen.dataset.mode = mode
  modes.hidden = !durable
  for (const button of modes.querySelectorAll('button')) button.setAttribute('aria-selected', String(button.dataset.mode === mode))
  if (!durable) closeChat()
  else if (chatName !== session.name) {
    closeChat()
    chat = new DurableChat(bridge!, session.name)
    chatName = session.name
    chat.onStatus = (status) => {
      if (screen.dataset.mode === 'chat') subtitle.textContent = `${session.agent} · ${statusText(status)}`
    }
    chat.onOverlay = () => claimBack()
    screen.querySelector<HTMLElement>('.chat-slot')!.replaceChildren(chat.element)
    chat.mount()
  }
  if (mode === 'chat') {
    closeTerminal()
    subtitle.textContent = `${session.agent} · ${statusText(chat!.status)}`
    return
  }
  subtitle.textContent = [session.agent, session.question ? STATUS_TEXT[session.status] : session.program ?? STATUS_TEXT[session.status]].filter(Boolean).join(' · ')
  screen.dataset.status = session.status
  const items = [session.question ? el('p', { class: 'question' }, session.question) : null,
    session.headline ? el('p', { class: 'headline' }, session.headline) : null,
    session.now ? el('p', { class: 'now' }, session.now) : null].filter((item): item is HTMLElement => item !== null)
  brief.hidden = items.length === 0
  brief.replaceChildren(...items)
  if (terminalName !== session.name || !terminal) {
    closeTerminal()
    terminal = new TerminalView(bridge!, session.handle)
    terminalName = session.name
    slot.replaceChildren(terminal.element)
    terminal.onState = (state) => slot.classList.toggle('connecting', state !== 'live')
    terminal.mount()
  }
  const input = screen.querySelector<HTMLTextAreaElement>('.composer textarea')!
  input.placeholder = session.agent ? `Message ${session.name}` : 'Type a command'
}

function closeTerminal(): void {
  terminal?.dispose()
  terminal = null
  terminalName = ''
}

function closeChat(): void {
  chat?.dispose()
  chat = null
  chatName = ''
}

function keyRow(): HTMLElement {
  return el('div', { class: 'keys' }, ...KEYS.map(([label, key]) => {
    const button = el('button', { type: 'button', class: 'key', 'aria-label': key }, label)
    // Keeps the keyboard and the terminal's focus where they are.
    button.addEventListener('pointerdown', (event) => event.preventDefault())
    button.addEventListener('click', () => void terminal?.key(key).catch(() => {}))
    return button
  }))
}

function composer(): HTMLElement {
  const input = el('textarea', { rows: '1', enterkeyhint: 'send', autocapitalize: 'sentences' }) as HTMLTextAreaElement
  const send = el('button', { type: 'button', class: 'send' }, 'Send') as HTMLButtonElement
  const error = el('p', { class: 'send-error', hidden: '' })
  const grow = () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`
    input.style.overflowY = input.scrollHeight > 140 ? 'auto' : 'hidden'
  }
  const submit = async () => {
    const text = input.value.trim()
    const shown = view.kind === 'session' ? view.name : null
    const session = sessions?.find((candidate) => candidate.name === shown)
    if (!text || !session || send.disabled) return
    send.disabled = true
    error.hidden = true
    try {
      if (session.agent) await bridge!.request('agent.send', { to: session.name, text })
      else await bridge!.request('terminal.send', { terminal: session.handle, text, enter: true, client: CLIENT })
      input.value = ''
      grow()
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure)
      error.hidden = false
    } finally {
      send.disabled = false
    }
  }
  input.addEventListener('input', grow)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void submit()
    }
  })
  send.addEventListener('click', () => void submit())
  return el('div', { class: 'composer' }, el('div', { class: 'compose-row' }, input, send), error)
}

function backButton(label: string | null): HTMLElement {
  const button = el('button', { type: 'button', class: 'back', 'aria-label': `Back${label ? ` to ${label}` : ''}` }, el('span', { class: 'chevron' }), label)
  button.addEventListener('click', back)
  return button
}

function unknownScreen(): HTMLElement {
  const message = screenMessage('Not in Orc', 'Orc does not have this screen. Your computer runs Orc, which shows its sessions here.')
  const home = el('button', { type: 'button', class: 'primary' }, 'Show sessions')
  home.addEventListener('click', () => (root.kind === 'home' || !bridge!.can('navigate') ? show({ kind: 'home' }) : bridge!.notify('navigate-back')))
  message.append(home)
  return el('div', { class: 'screen' }, el('header', { class: 'bar' }, wide() ? null : backButton(null)), message)
}

function placeholder(): HTMLElement {
  return screenMessage('Choose a session', 'Its terminal opens here.')
}

function screenMessage(title: string, body: string): HTMLElement {
  return el('div', { class: 'message' }, el('h2', {}, title), el('p', {}, body))
}

function errorBlock(message: string): HTMLElement {
  const retry = el('button', { type: 'button', class: 'primary' }, 'Try again')
  retry.addEventListener('click', () => void refresh())
  return el('div', { class: 'error' }, el('p', {}, `Orc did not answer: ${message}`), retry)
}

function applyInsets(): void {
  const insets = init?.safeAreaInsets ?? { top: 0, right: 0, bottom: 0, left: 0 }
  const style = document.documentElement.style
  for (const side of ['top', 'right', 'bottom', 'left'] as const) style.setProperty(`--safe-${side}`, `${insets[side]}px`)
  style.setProperty('--keyboard', `${init?.keyboardInset ?? 0}px`)
}

function el(tag: string, attributes: Record<string, string> = {}, ...children: (Node | string | null)[]): HTMLElement {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
  for (const child of children) if (child !== null) element.append(child)
  return element
}

import { DurableAgent } from '/chat/shared/agent.js'
import { formatDuration } from '/chat/shared/format.js'
import { RelaySocket } from '/chat/shared/relay-socket.js'
import { ChangesPanel } from '/chat/workbench/changes-panel.js'
import { Composer } from '/chat/workbench/composer.js'
import { olderPuller } from '/chat/workbench/older.js'
import { QueueView } from '/chat/workbench/queue.js'
import { agentStatus } from '/chat/workbench/status.js'
import { Transcript } from '/chat/workbench/transcript.js'
import { h, icon } from '/chat/workbench/ui.js'
import type { Bridge } from './bridge.ts'

const TOAST_MS = 8000

const ARROW_DOWN = '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v9.5M4 8.5l4 4 4-4"/></svg>'
const ARROW_UP = '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3.25M3.75 7.5 8 3.25l4.25 4.25"/></svg>'
const SQUARE = '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>'
const CROSS = '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.75 4.75 6.5 6.5m0-6.5-6.5 6.5"/></svg>'

// The Workbench's conversation column and changes panel, styled by its own stylesheet inside a shadow root.
const MARKUP = `<link rel="stylesheet" href="assets/chat.css">
<div class="body">
  <section class="main" aria-label="Conversation">
    <div class="banner" data-el="banner" role="status" hidden><span class="spinner" aria-hidden="true"></span><span data-el="bannerText"></span></div>
    <div class="scroller" data-el="scroller">
      <div class="doc">
        <div class="placeholder" data-el="connecting"><span class="spinner" aria-hidden="true"></span><span>Connecting to the agent…</span></div>
        <div class="placeholder empty" data-el="empty" hidden><h2>No messages yet</h2><p>Describe a task below. Tool calls, output and diffs appear here as the agent works.</p></div>
        <div class="log" data-el="log"></div>
      </div>
    </div>
    <div class="float-anchor">
      <button class="jump" data-el="jump" type="button" hidden>${ARROW_DOWN}<span>Jump to latest</span></button>
      <div class="toasts" data-el="toasts" aria-live="polite"></div>
    </div>
    <form class="composer" data-el="composer">
      <div class="queue" data-el="queue" aria-label="Waiting messages"></div>
      <div class="composer-box">
        <textarea data-el="input" rows="1" aria-label="Message" placeholder="Ask the agent to do something…" autocomplete="off" spellcheck="true" enterkeyhint="enter"></textarea>
        <div class="composer-bar">
          <div class="seg" data-el="segment" role="radiogroup" aria-label="Send while the agent works" hidden>
            <button type="button" role="radio" aria-checked="true" data-mode="steer">Steer</button>
            <button type="button" role="radio" aria-checked="false" data-mode="followUp">Queue</button>
          </div>
          <span class="hint" data-el="hint"></span>
          <span class="grow"></span>
          <button class="btn btn-stop" data-el="stop" type="button" hidden aria-label="Stop the agent">${SQUARE}<span>Stop</span></button>
          <button class="btn btn-send" data-el="send" type="submit" aria-label="Send" disabled><span class="send-label">Send</span>${ARROW_UP}</button>
        </div>
      </div>
    </form>
  </section>
  <aside class="changes-panel" data-el="changes" aria-label="Changes" tabindex="-1" hidden>
    <header class="changes-panel-head">
      <div class="changes-panel-title"><span class="changes-panel-name" data-el="changesTitle"></span><span class="changes-panel-counts" data-el="changesCounts"></span></div>
      <button class="icon-btn" data-el="changesClose" type="button" aria-label="Close changes">${CROSS}</button>
    </header>
    <div class="changes-panel-body" data-el="changesBody"></div>
  </aside>
</div>`

export type ChatStatus = { key: string; label: string; since?: number | null; step?: { verb: string; target?: string } | null }

/**
 * A durable agent's conversation as the Workbench shows it, on the phone: its turns, answers as they stream, tool calls
 * with their output and diffs, and a composer that sends, steers, queues and stops.
 */
export class DurableChat {
  readonly element = document.createElement('div')
  /** What the agent is doing, for the screen's title bar. */
  onStatus: (status: ChatStatus) => void = () => {}
  /** The changes panel opened or closed over the conversation. */
  onOverlay: (open: boolean) => void = () => {}
  private readonly agent: any
  private readonly transcript: any
  private readonly composer: any
  private readonly queue: any
  private readonly changes: any
  private readonly pullOlder: () => void
  private readonly part: (name: string) => HTMLElement
  private pending = new Set<string>()
  private frame = 0
  private ticker = 0
  private errorsShown = 0

  constructor(bridge: Bridge, session: string) {
    this.element.className = 'chat-host'
    const root = this.element.attachShadow({ mode: 'open' })
    root.innerHTML = MARKUP
    this.part = (name) => root.querySelector<HTMLElement>(`[data-el="${name}"]`)!
    const part = this.part
    const toast = (message: string) => this.toast(message)
    const connection: any = { session, token: '', openSocket: () => new RelaySocket(bridge, session) }
    this.agent = new DurableAgent(connection)
    this.changes = new ChangesPanel(this.agent, { root: part('changes'), title: part('changesTitle'), counts: part('changesCounts'), body: part('changesBody'), close: part('changesClose') })
    this.changes.onToggle = (open: boolean) => this.onOverlay(open)
    const view: any = {
      scroller: part('scroller'),
      log: part('log'),
      empty: part('empty'),
      onAway: (away: boolean) => {
        part('jump').hidden = !away
        if (!away) delete part('jump').dataset.unread
      },
      onUnread: () => { part('jump').dataset.unread = '' },
      onOpenChanges: (row: unknown, turn: unknown) => this.changes.open(row, turn)
    }
    this.transcript = new Transcript(this.agent, view)
    this.composer = new Composer(this.agent, {
      form: part('composer'), input: part('input'), segment: part('segment'), hint: part('hint'), send: part('send'), stop: part('stop'),
      toast, onHeld: () => this.queue.render()
    })
    this.queue = new QueueView(this.agent, this.composer, { root: part('queue'), toast })
    this.pullOlder = olderPuller(this.agent, part('scroller'))
    // A phone's Return starts a new line; Send sends.
    part('composer').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target === part('input')) event.stopPropagation()
    }, { capture: true })
    part('jump').addEventListener('click', () => this.transcript.scroll.jump())
    this.agent.addEventListener('change', (event: CustomEvent<string>) => {
      if (event.detail === 'reset') {
        cancelAnimationFrame(this.frame)
        this.frame = 0
        this.pending.clear()
        this.transcript.reset()
        this.renderChrome()
        this.pullOlder()
        return
      }
      this.pending.add(event.detail)
      if (!this.frame) this.frame = requestAnimationFrame(() => this.flush())
    })
  }

  mount(): void {
    this.agent.connect()
    this.renderChrome()
    window.setTimeout(() => this.renderChrome(), 1600)
    this.ticker = window.setInterval(() => {
      if (!this.agent.busy && !this.agent.retry) return
      this.transcript.tick()
      this.onStatus(agentStatus(this.agent))
    }, 1000)
  }

  dispose(): void {
    cancelAnimationFrame(this.frame)
    window.clearInterval(this.ticker)
    this.changes.close()
    this.agent.close()
  }

  get status(): ChatStatus { return agentStatus(this.agent) }

  get overlayOpen(): boolean { return this.changes.isOpen }

  closeOverlay(): void { this.changes.close() }

  private flush(): void {
    this.frame = 0
    const changes = this.pending
    this.pending = new Set()
    if (changes.has('older')) this.transcript.prepend()
    if (changes.has('entries') || changes.has('live') || changes.has('status')) this.transcript.update(changes)
    if (changes.has('error')) {
      for (; this.errorsShown < this.agent.errors.length; this.errorsShown++) this.toast(this.agent.errors[this.errorsShown].message)
    }
    this.renderChrome()
    this.pullOlder()
  }

  private renderChrome(): void {
    this.onStatus(agentStatus(this.agent))
    this.queue.render()
    this.composer.sync()
    this.composer.release()
    this.part('connecting').hidden = this.agent.everConnected
    const offline = !this.agent.connected && (this.agent.everConnected || performance.now() > 1500)
    this.part('banner').hidden = !offline
    if (offline) this.part('bannerText').textContent = this.agent.everConnected ? 'Connection lost. Reconnecting…' : 'Can’t reach the agent yet. Retrying…'
  }

  private toast(message: string): void {
    const node: HTMLElement = h('div', { class: 'toast toast-error', role: 'alert' },
      h('span', { class: 'toast-icon', html: icon('warning') }),
      h('span', { class: 'toast-text' }, message),
      h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', html: icon('close'), onclick: () => node.remove() }))
    this.part('toasts').append(node)
    window.setTimeout(() => node.remove(), TOAST_MS * 2)
  }
}

/** A chat's status in a few words for a title bar: its state, how long it has run, and its step. */
export function statusText(status: ChatStatus): string {
  const timer = status.since ? formatDuration(Date.now() - status.since) : ''
  return [status.label + (timer ? ` ${timer}` : ''), status.step?.verb].filter(Boolean).join(' · ')
}

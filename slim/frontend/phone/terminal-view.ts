import { Terminal } from '@xterm/xterm'
import { CLIENT, type Bridge } from './bridge.ts'

const FONT = 'ui-monospace, Menlo, monospace'
const THEME = { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3', selectionBackground: '#264f78' }
// A snapshot must fit one bridge frame of 640 KiB with its envelope.
const SNAPSHOT_BUDGET = 600 * 1024
const KEYS: Record<string, string> = { escape: '\x1b', tab: '\t', interrupt: '\x03', enter: '\r' }
const ARROWS: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D' }

/**
 * A session's terminal, live: the runtime's snapshot, then its output, at the size that fits this view. While a phone
 * views a session the runtime sizes it to the phone, and gives desktops their size back when the phone leaves.
 */
export class TerminalView {
  readonly element = document.createElement('div')
  onState: (state: 'connecting' | 'live') => void = () => {}
  private readonly bridge: Bridge
  private readonly handle: string
  private readonly term: Terminal
  private readonly observer = new ResizeObserver(() => this.fit())
  private cancel: (() => void) | null = null
  private size = { cols: 0, rows: 0 }
  private retry = 1000
  private disposed = false

  constructor(bridge: Bridge, handle: string) {
    this.bridge = bridge
    this.handle = handle
    this.element.className = 'terminal'
    this.term = new Terminal({ fontFamily: FONT, fontSize: 12, scrollback: 3000, cursorBlink: false, theme: THEME })
    this.term.onData((data) => void this.send(data).catch(() => {}))
  }

  mount(): void {
    this.term.open(this.element)
    this.observer.observe(this.element)
    this.fit()
    this.connect()
  }

  dispose(): void {
    this.disposed = true
    this.cancel?.()
    this.observer.disconnect()
    this.term.dispose()
  }

  send(text: string, enter = false): Promise<unknown> {
    return this.bridge.request('terminal.send', { terminal: this.handle, text, enter, client: CLIENT })
  }

  /** Sends a key the phone's keyboard lacks, as the program's current cursor-key mode expects it. */
  key(name: string): Promise<unknown> {
    const arrow = ARROWS[name]
    const text = arrow ? (this.term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + arrow : KEYS[name]
    return text ? this.send(text) : Promise.resolve()
  }

  private connect(): void {
    this.onState('connecting')
    const viewport = this.size.cols ? this.size : undefined
    this.cancel = this.bridge.subscribe('terminal.subscribe', {
      terminal: this.handle, client: CLIENT, viewport, capabilities: { terminalBinaryStream: 1 }, snapshotByteBudget: SNAPSHOT_BUDGET
    }, (event) => this.receive(event))
  }

  private receive(event: any): void {
    switch (event?.type) {
      case 'scrollback':
        this.term.reset()
        this.resizeTo(event)
        this.term.write(String(event.serialized ?? ''))
        this.retry = 1000
        this.onState('live')
        break
      case 'resized':
        this.resizeTo(event)
        if (typeof event.serialized === 'string') {
          this.term.reset()
          this.term.write(event.serialized)
        }
        break
      case 'data':
        this.term.write(String(event.chunk ?? ''))
        break
      case 'end':
      case 'error':
        this.cancel = null
        if (this.disposed) return
        this.onState('connecting')
        window.setTimeout(() => { if (!this.disposed && !this.cancel) this.connect() }, this.retry)
        this.retry = Math.min(this.retry * 2, 10_000)
        break
    }
  }

  private resizeTo(event: { cols?: unknown; rows?: unknown }): void {
    const cols = Number(event.cols), rows = Number(event.rows)
    if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 && (cols !== this.term.cols || rows !== this.term.rows)) this.term.resize(cols, rows)
  }

  /** Fits the terminal to its element, as xterm's fit addon does, and tells the runtime the phone's size. */
  private fit(): void {
    const cell = (this.term as any)._core?._renderService?.dimensions?.css?.cell as { width: number; height: number } | undefined
    if (!cell?.width || !cell.height || !this.element.clientWidth || !this.element.clientHeight) return
    const cols = Math.max(20, Math.floor((this.element.clientWidth - 2) / cell.width))
    const rows = Math.max(5, Math.floor(this.element.clientHeight / cell.height))
    if (cols === this.size.cols && rows === this.size.rows) return
    this.size = { cols, rows }
    this.term.resize(cols, rows)
    if (!this.cancel) return
    void this.bridge.request('terminal.updateViewport', { terminal: this.handle, viewport: this.size, client: CLIENT }).catch(() => {})
    // The app replays subscriptions after a reconnect with the size it last heard.
    this.bridge.notify('terminalViewport', { terminal: this.handle, cols, rows })
  }
}

import { EventEmitter } from 'node:events'
import { open, stat } from 'node:fs/promises'
import type { AgentKind } from './agent-hooks.ts'
import type { TerminalSession } from './terminal-session.ts'

/**
 * - `starting`: launched, not yet able to take a prompt
 * - `idle`: waiting for input
 * - `working`: processing a turn
 * - `permission`: waiting for the user to answer an approval, question or dialog
 * - `ended`: the agent's conversation ended. Agents end a conversation and start another without
 *   exiting (Pi switching sessions, Claude's /clear), so this lasts only until the next event or the
 *   program's exit, which is final (`exited`).
 */
export type AgentState = 'starting' | 'idle' | 'working' | 'permission' | 'ended'

export type AgentEvent = { agent: string; event: string; time: number; payload: Record<string, any> | null }

const POLL_MS = 200
const TITLE_SETTLE_MS = 500
// Claude fires no hook when a turn is interrupted; its idle title then stands in for Stop.
const CLAUDE_IDLE_TITLE = /^✳/
const CLAUDE_IDLE_SETTLE_MS = 1500
const SPINNER = /^[⠀-⣿◐◑◒◓]/
// Full-screen prompts where a stray Enter picks an option. Text is matched on the visible screen.
const BLOCKING_DIALOGS: Record<AgentKind, RegExp[]> = {
  codex: [/Trust this folder\?/, /Hooks need review/],
  claude: [/Quick safety check/, /Do you trust the files in this folder\?/],
  pi: []
}

/**
 * An agent's state, derived from the lifecycle events its hooks append to the session's event file.
 * The file persists across frontend restarts, so a new monitor replays it from the start.
 */
export class AgentMonitor extends EventEmitter {
  readonly kind: AgentKind
  readonly file: string
  private readonly session: TerminalSession
  state: AgentState = 'starting'
  /** The agent's program has exited; nothing changes the state after this. */
  exited = false
  ready = false
  providerSession: { id?: string; transcriptPath?: string } = {}
  lastAssistantMessage: string | undefined
  /** When the most recent turn finished, in milliseconds. */
  lastIdleAt = 0
  lastEventAt = 0
  dialog: string | null = null
  private interruptRequested = false
  private offset = 0
  private partial = ''
  private poll: NodeJS.Timeout | null = null
  private titleTimer: NodeJS.Timeout | null = null
  private screenTimer: NodeJS.Timeout | null = null
  private reading = false
  private readonly onTitle = (title: string) => this.observeTitle(title)
  private readonly onApplied = () => this.scheduleScreenCheck()
  private readonly onExit = () => this.markExited()

  constructor(kind: AgentKind, file: string, session: TerminalSession) {
    super()
    this.kind = kind
    this.file = file
    this.session = session
  }

  async start(): Promise<void> {
    await this.read(false)
    this.session.on('title', this.onTitle)
    this.session.on('applied', this.onApplied)
    this.session.on('exit', this.onExit)
    if (this.session.exit) this.markExited()
    if (this.kind === 'codex' && !this.ready) this.observeTitle(this.session.title)
    this.poll = setInterval(() => void this.read(true), POLL_MS)
    this.scheduleScreenCheck()
  }

  stop(): void {
    if (this.poll) clearInterval(this.poll)
    if (this.titleTimer) clearTimeout(this.titleTimer)
    if (this.screenTimer) clearTimeout(this.screenTimer)
    this.session.off('title', this.onTitle)
    this.session.off('applied', this.onApplied)
    this.session.off('exit', this.onExit)
  }

  /** The state clients should see: a blocking dialog outranks what the hooks last reported. */
  get effectiveState(): AgentState {
    return this.dialog && this.state !== 'ended' ? 'permission' : this.state
  }

  private async read(live: boolean): Promise<void> {
    if (this.reading) return
    this.reading = true
    try {
      const size = (await stat(this.file).catch(() => null))?.size ?? 0
      if (size <= this.offset) return
      const handle = await open(this.file, 'r')
      try {
        const buffer = Buffer.alloc(size - this.offset)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset)
        this.offset += bytesRead
        const lines = (this.partial + buffer.subarray(0, bytesRead).toString('utf8')).split('\n')
        this.partial = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            this.apply(JSON.parse(line) as AgentEvent, live)
          } catch {}
        }
      } finally {
        await handle.close()
      }
    } finally {
      this.reading = false
    }
  }

  private apply(record: AgentEvent, live: boolean): void {
    const at = live ? Date.now() : (record.time ?? 0) * 1000
    const payload = record.payload ?? {}
    this.lastEventAt = at
    if (typeof payload.session_id === 'string') this.providerSession.id = payload.session_id
    if (typeof payload.transcript_path === 'string') this.providerSession.transcriptPath = payload.transcript_path
    if (typeof payload.last_assistant_message === 'string') this.lastAssistantMessage = payload.last_assistant_message
    switch (record.event) {
      case 'SessionStart':
        this.ready = true
        if (this.state === 'starting' || this.state === 'ended') this.transition('idle', at)
        break
      case 'UserPromptSubmit':
      case 'PreToolUse':
      case 'PostToolUse':
      case 'SubagentStart':
      case 'SubagentStop':
      case 'PermissionResolved':
        this.ready = true
        this.transition('working', at)
        break
      case 'PermissionRequest':
        this.ready = true
        this.transition('permission', at)
        break
      case 'Notification':
        if (payload.notification_type === 'permission_prompt') this.transition('permission', at)
        else if (payload.notification_type === 'idle_prompt' && this.state !== 'working') this.transition('idle', at)
        break
      case 'Stop':
      case 'StopFailure':
      case 'Interrupt':
        this.ready = true
        this.transition('idle', at)
        break
      case 'SessionEnd':
        this.transition('ended', at)
        break
    }
  }

  private markExited(): void {
    this.transition('ended')
    this.exited = true
  }

  private transition(state: AgentState, at = Date.now()): void {
    if (this.exited) return
    if (state === 'idle') this.interruptRequested = false
    if (state === 'idle' && this.state !== 'idle') this.lastIdleAt = at
    const changed = state !== this.state
    this.state = state
    if (changed) this.emit('change', this)
  }

  /** Records that Orc interrupted the current turn, so an idle title may end a pending approval too. */
  noteInterrupt(): void {
    this.interruptRequested = true
    this.observeTitle(this.session.title)
  }

  /**
   * Codex fires no hook until its first prompt; a settled title without a spinner means it is ready.
   * Claude fires none for an interrupted turn; a settled idle title means the turn ended.
   */
  private observeTitle(title: string): void {
    if (this.kind === 'claude') return this.observeClaudeTitle(title)
    if (this.kind !== 'codex' || this.ready) return
    if (this.titleTimer) clearTimeout(this.titleTimer)
    this.titleTimer = null
    if (!title || SPINNER.test(title)) return
    this.titleTimer = setTimeout(() => {
      if (this.ready || !this.session.title || SPINNER.test(this.session.title)) return
      this.ready = true
      if (this.state === 'starting') this.transition('idle')
      else this.emit('change', this)
    }, TITLE_SETTLE_MS)
  }

  private observeClaudeTitle(title: string): void {
    if (this.titleTimer) clearTimeout(this.titleTimer)
    this.titleTimer = null
    const interruptible = this.state === 'working' || (this.interruptRequested && this.state === 'permission')
    if (!interruptible || !CLAUDE_IDLE_TITLE.test(title)) return
    const since = this.lastEventAt
    this.titleTimer = setTimeout(() => {
      const stillInterruptible = this.state === 'working' || (this.interruptRequested && this.state === 'permission')
      if (!stillInterruptible || this.lastEventAt !== since || !CLAUDE_IDLE_TITLE.test(this.session.title)) return
      this.interruptRequested = false
      this.transition('idle')
    }, CLAUDE_IDLE_SETTLE_MS)
  }

  private scheduleScreenCheck(): void {
    if (BLOCKING_DIALOGS[this.kind].length === 0 || this.screenTimer) return
    this.screenTimer = setTimeout(() => {
      this.screenTimer = null
      void this.session.screenText().then((rows) => {
        const text = rows.join('\n')
        const dialog = BLOCKING_DIALOGS[this.kind].find((pattern) => pattern.test(text))?.source ?? null
        if (dialog !== this.dialog) {
          this.dialog = dialog
          this.emit('change', this)
        }
      }, () => {})
    }, 150)
  }
}

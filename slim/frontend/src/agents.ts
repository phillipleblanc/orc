import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentArgv, installAgentHooks, isAgentKind, type AgentHooks, type AgentKind, type ProviderSession } from './agent-hooks.ts'
import { AgentMonitor } from './agent-monitor.ts'
import { loginEnvironment, resolveExecutable } from './login-environment.ts'
import type { Projects } from './projects.ts'
import { RpcError } from './rpc-server.ts'
import { sessionEnvironment } from './session-environment.ts'
import type { SessionStore } from './session-store.ts'
import type { TerminalSession } from './terminal-session.ts'

type QueuedMessage = { id: string; text: string; from?: string; queuedAt: number }
type Delivery = { message: QueuedMessage; since: number }

type AgentRecord = {
  session: TerminalSession
  monitor: AgentMonitor
  queue: QueuedMessage[]
  delivering: Delivery | null
  lastDeliveredAt: number
  unconfirmed: number
  pumping: boolean
  confirmTimer: NodeJS.Timeout | null
}

export type SpawnOptions = {
  agent: AgentKind
  name: string
  project?: string
  cwd?: string
  prompt?: string
  parent?: string
  model?: string
  effort?: string
  args?: string[]
  /** A conversation to continue instead of starting a new one. */
  resume?: ProviderSession
  /** Files copied into the new session's directory, such as a queue to keep. */
  files?: string[]
  cols?: number
  rows?: number
  timeoutMs?: number
}

// A delivered message is confirmed by the agent starting a turn; until then no other message is typed.
const CONFIRM_MS = 20_000
// Pasted text must be accepted before the separate Enter that submits it.
const PASTE_SETTLE_MS = 150
const DEFAULT_TIMEOUT_MS = 90_000

/**
 * Agents are sessions started with Orc's status hooks. They are addressed by session name; messages
 * wait in a per-agent queue until the agent is idle and are typed in one at a time.
 */
export class AgentDirectory extends EventEmitter {
  private readonly store: SessionStore
  private readonly projects: Projects
  private readonly profile: string
  private readonly records = new Map<TerminalSession, AgentRecord>()
  private hooks: Promise<AgentHooks> | null = null

  constructor(store: SessionStore, projects: Projects, profile: string) {
    super()
    this.store = store
    this.projects = projects
    this.profile = profile
    store.on('added', (session: TerminalSession) => void this.attach(session))
    store.on('ended', (session: TerminalSession) => this.detach(session))
  }

  /** Starts an agent in a new session, without waiting for it. */
  async launch(options: SpawnOptions): Promise<TerminalSession> {
    if (!isAgentKind(options.agent)) throw new RpcError('invalid_argument', 'agent must be codex, claude or pi')
    const project = options.project ? this.projects.resolve(options.project) : options.cwd ? this.projects.containing(options.cwd) : undefined
    if (options.project && !project) throw new RpcError('not_found', `no project ${options.project}`)
    const cwd = options.cwd ?? project?.path
    if (!cwd) throw new RpcError('invalid_argument', 'choose a project or a working directory')
    const login = await loginEnvironment()
    const executable = resolveExecutable(options.agent, login)
    if (!executable) throw new RpcError('not_found', `${options.agent} is not on the login shell's PATH`)
    this.hooks ??= installAgentHooks(this.profile)
    const hooks = await this.hooks
    await mkdir(join(this.profile, 'agent-events'), { recursive: true, mode: 0o700 })
    const events = join(this.profile, 'agent-events', `${randomUUID()}.jsonl`)
    return this.store.create({
      name: options.name,
      cwd,
      argv: agentArgv(options.agent, executable, hooks, options),
      env: sessionEnvironment(login, options.name, { ORC_AGENT_EVENTS: events, ORC_RUNTIME_DIR: this.profile }),
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      project: project?.id,
      agent: options.agent,
      parent: options.parent,
      events,
      files: options.files
    })
  }

  /** Starts an agent, types `prompt` once it is ready, and reports its state after delivery or the timeout. */
  async spawn(options: SpawnOptions): Promise<Record<string, unknown>> {
    const session = await this.launch(options)
    const record = await this.recordFor(session)
    const prompt = options.prompt?.replace(/\s+$/, '')
    if (prompt) this.enqueue(record, { id: randomUUID(), text: prompt, queuedAt: Date.now() })
    const delivered = await this.until(record, () => !prompt || (record.queue.length === 0 && !record.delivering && record.lastDeliveredAt > 0),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    return { ...this.describe(record), delivered: Boolean(prompt) && delivered }
  }

  send(to: string, text: string, from?: string): Record<string, unknown> {
    const record = this.get(to)
    const body = text.replace(/\s+$/, '')
    if (!body) throw new RpcError('invalid_argument', 'the message is empty')
    this.enqueue(record, { id: randomUUID(), text: body, from, queuedAt: Date.now() })
    return this.describe(record)
  }

  /** Resolves when the agent has finished a turn after the last delivered message and has nothing queued. */
  async wait(name: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const record = this.get(name)
    const done = await this.until(record, () => this.finished(record), timeoutMs)
    return { ...this.describe(record), done }
  }

  stop(name: string, kill: boolean): Promise<Record<string, unknown>> | Record<string, unknown> {
    const record = this.get(name)
    const dropped = record.queue.length
    record.queue = []
    void this.save(record)
    if (kill) return this.store.end(record.session).then(() => ({ ...this.describe(record), dropped, killed: true }))
    record.monitor.noteInterrupt()
    record.session.input('\x1b')
    return { ...this.describe(record), dropped, interrupted: true }
  }

  list(): Record<string, unknown>[] {
    return [...this.records.values()].map((record) => this.describe(record))
  }

  status(name: string): Record<string, unknown> {
    return this.describe(this.get(name))
  }

  monitor(session: TerminalSession): AgentMonitor | undefined {
    return this.records.get(session)?.monitor
  }

  isAgent(session: TerminalSession): boolean {
    return isAgentKind(session.meta.agent) && Boolean(session.meta.events)
  }

  /** Queues a message for an agent session that is still running; other sessions are ignored. */
  async deliver(session: TerminalSession, text: string, from: string): Promise<void> {
    if (this.store.get(session.meta.name) !== session) return
    const record = this.records.get(session) ?? (await this.attach(session))
    if (record) this.enqueue(record, { id: randomUUID(), text, from, queuedAt: Date.now() })
  }

  describe(record: AgentRecord): Record<string, unknown> {
    const { session, monitor } = record
    return {
      name: session.meta.name,
      handle: session.handle,
      agent: monitor.kind,
      state: monitor.effectiveState,
      ready: monitor.ready,
      ...(monitor.dialog ? { dialog: monitor.dialog } : {}),
      cwd: session.meta.cwd,
      ...(session.meta.project ? { project: session.meta.project } : {}),
      ...(session.meta.parent ? { parent: session.meta.parent } : {}),
      queued: record.queue.length,
      delivering: Boolean(record.delivering),
      unconfirmedDeliveries: record.unconfirmed,
      createdAt: session.meta.createdAt,
      ...(monitor.providerSession.id ? { providerSession: monitor.providerSession } : {}),
      ...(monitor.lastAssistantMessage ? { lastAssistantMessage: monitor.lastAssistantMessage } : {})
    }
  }

  private get(name: string): AgentRecord {
    const session = this.store.get(name)
    const record = session && this.records.get(session)
    if (!record) throw new RpcError('not_found', session ? `${name} is not an agent session` : `no agent named ${name}`)
    return record
  }

  private async recordFor(session: TerminalSession): Promise<AgentRecord> {
    return this.records.get(session) ?? (await this.attach(session))!
  }

  private async attach(session: TerminalSession): Promise<AgentRecord | undefined> {
    const existing = this.records.get(session)
    if (existing) return existing
    if (!this.isAgent(session)) return undefined
    const monitor = new AgentMonitor(session.meta.agent as AgentKind, session.meta.events!, session)
    const saved = await readFile(join(session.dir, 'queue.json'), 'utf8').then(JSON.parse, () => ({}))
    const record: AgentRecord = {
      session, monitor, queue: Array.isArray(saved.queue) ? saved.queue : [], delivering: null,
      lastDeliveredAt: saved.lastDeliveredAt ?? 0, unconfirmed: saved.unconfirmed ?? 0, pumping: false, confirmTimer: null
    }
    if (this.records.has(session)) return this.records.get(session)
    this.records.set(session, record)
    monitor.on('change', () => {
      if (record.delivering && monitor.state !== 'idle' && monitor.state !== 'starting') this.confirm(record)
      void this.pump(record)
      this.emit('change', session)
    })
    await monitor.start()
    void this.pump(record)
    return record
  }

  private detach(session: TerminalSession): void {
    const record = this.records.get(session)
    if (!record) return
    record.monitor.stop()
    if (record.confirmTimer) clearTimeout(record.confirmTimer)
    this.records.delete(session)
  }

  private enqueue(record: AgentRecord, message: QueuedMessage): void {
    record.queue.push(message)
    void this.save(record)
    void this.pump(record)
  }

  private confirm(record: AgentRecord): void {
    record.delivering = null
    if (record.confirmTimer) clearTimeout(record.confirmTimer)
    record.confirmTimer = null
    void this.save(record)
  }

  private finished(record: AgentRecord): boolean {
    const { monitor } = record
    if (monitor.exited) return true
    return record.queue.length === 0 && !record.delivering && monitor.effectiveState === 'idle' && monitor.lastIdleAt >= record.lastDeliveredAt
  }

  private async pump(record: AgentRecord): Promise<void> {
    if (record.pumping) return
    record.pumping = true
    try {
      while (!record.delivering && record.queue.length > 0 && record.session.connected) {
        const { monitor } = record
        if (!monitor.ready || monitor.effectiveState !== 'idle') return
        const message = record.queue[0]
        const body = message.from ? `[from ${message.from}]\n${message.text}` : message.text
        const bracketed = await record.session.bracketedPaste()
        record.session.input(bracketed ? `\x1b[200~${body}\x1b[201~` : body)
        await new Promise((resolve) => setTimeout(resolve, PASTE_SETTLE_MS))
        record.session.input('\r')
        record.queue.shift()
        record.delivering = { message, since: Date.now() }
        record.lastDeliveredAt = Date.now()
        record.confirmTimer = setTimeout(() => {
          record.unconfirmed++
          this.confirm(record)
          void this.pump(record)
        }, CONFIRM_MS)
        await this.save(record)
      }
    } finally {
      record.pumping = false
    }
  }

  private until(record: AgentRecord, predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    if (predicate()) return Promise.resolve(true)
    return new Promise((resolve) => {
      const check = () => {
        if (!predicate() && !record.monitor.exited) return
        cleanup()
        resolve(predicate())
      }
      const interval = setInterval(check, 100)
      const timer = setTimeout(() => {
        cleanup()
        resolve(predicate())
      }, timeoutMs)
      const cleanup = () => {
        clearInterval(interval)
        clearTimeout(timer)
        record.monitor.off('change', check)
      }
      record.monitor.on('change', check)
    })
  }

  private async save(record: AgentRecord): Promise<void> {
    const path = join(record.session.dir, 'queue.json')
    const body = JSON.stringify({ queue: record.queue, lastDeliveredAt: record.lastDeliveredAt, unconfirmed: record.unconfirmed })
    await writeFile(`${path}.tmp`, body, { mode: 0o600 }).then(() => rename(`${path}.tmp`, path)).catch(() => {})
  }
}

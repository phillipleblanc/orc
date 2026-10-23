import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Catalog } from './catalog.ts'
import { RpcError, type Handlers } from './rpc-server.ts'
import { reorder, sidebarOrder, type SessionOrder } from './session-order.ts'
import type { SessionStore } from './session-store.ts'
import type { TerminalSession } from './terminal-session.ts'

const SCRIPT = fileURLToPath(new URL('./rex-sync.lua', import.meta.url))
// Sessions often come and go together, as when a computer restart restores them.
const SYNC_DELAY_MS = 300
// How often a sync looks for tabs moved in Rex.
const POLL_MS = 3000
const SYNC_TIMEOUT_MS = 60_000
// Rex picks a tab's icon from the name its program was started by; an agent's tab starts `orc` under the agent's.
const AGENT_PROGRAMS: Record<string, string> = { claude: 'claude', codex: 'codex', pi: 'pi', durable: 'pi' }

/** How to reach a Rex server, as `orc rex start` found it in the Rex terminal it ran in. */
export type RexLink = { rex: string; server: string | null; orc: string; config: string | null }
/** A tab showing an Orc session: one the sync made, or, `adopted`, the user's own in which `orc new` started it. */
type RexTab = { session: string; window: string; name: string; project: string; adopted?: boolean }
type RexProject = { session: string; name: string }
/** `seen` is the order of the synced tabs in each Rex session as the last sync left it, to tell when they are moved in Rex. */
type RexState = { link: RexLink; syncing: boolean; map: Record<string, RexTab>; projects: Record<string, RexProject>; dismissed: string[]; seen: Record<string, string[]> }
type SyncSession = { handle: string; name: string; cwd: string; command: string[]; project: { id: string; name: string } }
export type RexSyncResult = { created: string[]; renamed: string[]; closed: string[]; removed: string[]; kept: string[]; errors: string[] }

/**
 * Keeps a Rex server in sync with this runtime's sessions once `orc rex start` links it: one Rex session per Orc
 * project, labeled with the project's name, with a tab for each of its Orc sessions, labeled with the session's
 * name, that runs `orc attach` for it as a viewer that leaves the session's size alone until someone types there. The
 * tabs follow the sessions' order, and tabs moved in Rex change it. It syncs when linked, when the frontend starts,
 * when a session is added, renamed or ends, when the order changes, and every few seconds to find tabs moved in Rex,
 * by running `rex-sync.lua` with Rex's own CLI. A Rex session or tab closed in Rex stays out of Rex until
 * `orc rex start` runs again. `orc rex stop` stops syncing and keeps the Rex sessions; `orc rex clear` then removes
 * them. The link, the Rex session made for each project and the tab made for each Orc session are kept in
 * `rex.json` in the profile.
 */
export class RexSync {
  private state: RexState | null = null
  private timer: NodeJS.Timeout | null = null
  private poll: NodeJS.Timeout | null = null
  private running = false
  private saved = ''
  private queue: Promise<unknown> = Promise.resolve()
  private lastError: string | null = null
  private lastSyncAt: number | null = null

  private readonly options: { profile: string; store: SessionStore; catalog: Catalog; order: SessionOrder; log: (line: string) => void }

  constructor(options: { profile: string; store: SessionStore; catalog: Catalog; order: SessionOrder; log: (line: string) => void }) {
    this.options = options
    for (const event of ['added', 'ended', 'renamed']) options.store.on(event, () => this.schedule())
    options.order.on('change', () => this.schedule())
  }

  private get file(): string { return join(this.options.profile, 'rex.json') }

  async load(): Promise<void> {
    this.state = await readFile(this.file, 'utf8').then((text) => ({ syncing: true, projects: {}, seen: {}, ...JSON.parse(text) }) as RexState, () => null)
    this.schedule()
    this.polling()
  }

  /** Links a Rex server, brings back every Orc session closed in Rex, and syncs now. */
  async start(link: RexLink): Promise<RexSyncResult> {
    const same = this.state?.link.server === link.server
    this.state = { link, syncing: true, map: same ? this.state!.map : {}, projects: same ? this.state!.projects : {}, dismissed: [], seen: same ? this.state!.seen : {} }
    await this.save(this.state)
    this.polling()
    return this.enqueue(() => this.syncOnce())
  }

  /** Stops syncing, keeping the Rex sessions made so far and what they are, for `clear`. */
  async stop(): Promise<boolean> {
    if (!this.state?.syncing) return false
    this.state.syncing = false
    if (this.timer) clearTimeout(this.timer)
    this.polling()
    await this.save(this.state)
    return true
  }

  /** Once stopped, removes the Rex sessions the sync made, except ones with other tabs open in them, and forgets the link. */
  clear(): Promise<RexSyncResult> {
    if (this.state?.syncing) throw new RpcError('conflict', 'Orc is syncing sessions to Rex; run `orc rex stop` first')
    return this.enqueue(async () => {
      const state = this.state
      if (!state || this.state?.syncing) return emptyResult()
      const result = Object.keys(state.map).length || Object.keys(state.projects).length ? await this.run(state, [], true) : emptyResult()
      if (Object.keys(state.map).length === 0 && Object.keys(state.projects).length === 0) {
        this.state = null
        await rm(this.file, { force: true })
        this.saved = ''
      }
      return result
    })
  }

  /**
   * Records that `tab`, the Rex tab `orc new` ran in, now shows `session`, so syncs relabel it with the session's name
   * rather than make another tab, and leave it open when the session ends. Its map changes before any sync can start.
   */
  async adopt(session: TerminalSession, tab: unknown): Promise<void> {
    const state = this.state
    if (!state?.syncing || !tab || typeof tab !== 'object') return
    const { session: rexSession, window, server } = tab as Record<string, unknown>
    if (typeof rexSession !== 'string' || typeof window !== 'string' || (server ?? null) !== state.link.server) return
    for (const [handle, entry] of Object.entries(state.map)) if (entry.window === window) delete state.map[handle]
    state.map[session.handle] = { session: rexSession, window, name: session.meta.name, project: this.options.catalog.worktreeFor(session).id, adopted: true }
    await this.save(state)
  }

  status(): Record<string, unknown> {
    return {
      syncing: this.state?.syncing ?? false, server: this.state?.link.server ?? null, sessions: Object.keys(this.state?.map ?? {}).length,
      projects: Object.keys(this.state?.projects ?? {}).length,
      lastSyncAt: this.lastSyncAt, lastError: this.lastError
    }
  }

  private schedule(): void {
    if (!this.state?.syncing) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.enqueue(() => this.syncOnce()).catch(() => {}) }, SYNC_DELAY_MS)
    this.timer.unref()
  }

  /** While syncing, a sync every few seconds unless one is due or under way. */
  private polling(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    if (!this.state?.syncing) return
    this.poll = setInterval(() => { if (!this.timer && !this.running) this.schedule() }, POLL_MS)
    this.poll.unref()
  }

  /** Runs `work` after any sync or clear already under way. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work)
    this.queue = run.catch(() => {})
    return run
  }

  private async syncOnce(): Promise<RexSyncResult> {
    const state = this.state
    if (!state?.syncing) return emptyResult()
    this.running = true
    try {
      await this.linkPrograms(state.link)
      return await this.run(state, this.options.store.list().filter((session) => session.connected).map((session) => {
        const worktree = this.options.catalog.worktreeFor(session)
        return { handle: session.handle, name: session.meta.name, cwd: worktree.path, command: attachCommand(state.link, this.options.profile, session),
          project: { id: worktree.id, name: worktree.name } }
      }), false)
    } finally {
      this.running = false
    }
  }

  /** Runs the script with `sessions`, or to `clear`, and keeps what it made unless the link changed meanwhile. */
  private async run(state: RexState, sessions: SyncSession[], clear: boolean): Promise<RexSyncResult> {
    const sent = state.map
    // The sessions as Orc.app's sidebar shows them, each project's in their order.
    const keys = this.options.order.get().keys
    const projects = new Map<string, SyncSession[]>()
    for (const session of sessions) projects.set(session.project.id, [...projects.get(session.project.id) ?? [], session])
    const byName = new Map(sessions.map((session) => [session.name, session]))
    const shown = [...projects.values()].flatMap((members) => sidebarOrder(members.map((session) => session.name), keys))
    const order = shown.map((name) => byName.get(name)!.handle)
    let output: Record<string, unknown>
    try {
      output = JSON.parse(await runRex(state.link, JSON.stringify({ sessions, map: sent, projects: state.projects, dismissed: state.dismissed, order, seen: state.seen ?? {}, clear })))
    } catch (error) {
      const message = (error as Error).message
      if (message !== this.lastError) this.options.log(`rex sync failed: ${message}`)
      this.lastError = message
      throw new RpcError('rex_unavailable', message)
    }
    const result = { created: strings(output.created), renamed: strings(output.renamed), closed: strings(output.closed), removed: strings(output.removed),
      kept: strings(output.kept), errors: strings(output.errors) }
    if (this.state === state) {
      // A tab adopted while the script ran is kept.
      const adopted = Object.entries(state.map).filter(([handle, tab]) => tab.adopted && !(handle in sent))
      state.map = { ...record(output.map) as Record<string, RexTab>, ...Object.fromEntries(adopted) }
      state.projects = record(output.projects) as Record<string, RexProject>
      state.dismissed = strings(output.dismissed)
      state.seen = Object.fromEntries(Object.entries(record(output.seen)).map(([session, windows]) => [session, strings(windows)]))
      await this.save(state)
      // Tabs moved in Rex move their sessions.
      const names = new Map(sessions.map((session) => [session.handle, session.name]))
      const moved = (Array.isArray(output.reordered) ? output.reordered : []).map((handles) => strings(handles).flatMap((handle) => names.get(handle) ?? []))
      if (moved.length) await this.options.order.replace(moved.reduce((next, tabs) => reorder(next, shown, tabs), this.options.order.get().keys))
    }
    this.lastSyncAt = Date.now()
    this.lastError = result.errors[0] ?? null
    if (result.errors.length) this.options.log(`rex sync: ${result.errors.join('; ')}`)
    return result
  }

  /** `rex-programs/NAME` in the profile, a symlink to `orc` for each agent's name. */
  private async linkPrograms(link: RexLink): Promise<void> {
    const directory = join(this.options.profile, 'rex-programs')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (const name of new Set(Object.values(AGENT_PROGRAMS))) {
      const path = join(directory, name)
      if (await readlink(path).catch(() => null) === link.orc) continue
      const temporary = `${path}.${process.pid}.tmp`
      await rm(temporary, { force: true })
      await symlink(link.orc, temporary)
      await rename(temporary, path)
    }
  }

  private async save(state: RexState): Promise<void> {
    const text = JSON.stringify(state, null, 2)
    if (text === this.saved) return
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, text, { mode: 0o600 })
    await rename(temporary, this.file)
    this.saved = text
  }
}

function emptyResult(): RexSyncResult {
  return { created: [], renamed: [], closed: [], removed: [], kept: [], errors: [] }
}

/** A JSON object, which Lua writes as an empty array when it has no keys. */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** A viewer of `session` in its Rex tab, started as the session's agent for Rex to show its icon. */
function attachCommand(link: RexLink, profile: string, session: TerminalSession): string[] {
  const program = AGENT_PROGRAMS[session.meta.agent ?? ''] ? join(profile, 'rex-programs', AGENT_PROGRAMS[session.meta.agent!]) : link.orc
  return ['/usr/bin/env', `ORC_RUNTIME_DIR=${profile}`, ...(link.config ? [`ORC_CONFIG_DIR=${link.config}`] : []),
    program, 'attach', session.meta.name, '--no-session-switch', '--client-id', `rex-${session.handle}`, '--viewport-ownership']
}

function runRex(link: RexLink, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(link.rex, ['--autostart=false', ...(link.server ? ['-S', link.server] : []), 'do', SCRIPT, '--json', '--args', '-'],
      { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), SYNC_TIMEOUT_MS)
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(`cannot run ${link.rex}: ${error.message}; run \`orc rex start\` in a Rex terminal again`)) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim().split('\n').at(-1) || `rex exited with status ${code}`))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

async function executable(path: unknown, name: string): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new RpcError('invalid_argument', `${name} must be an absolute path`)
  await access(path, constants.X_OK).catch(() => { throw new RpcError('invalid_argument', `${path} is not an executable`) })
  return path
}

function optional(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) throw new RpcError('invalid_argument', `${name} must be text`)
  return value
}

/** `orc.rex.*`, on the local socket only: the link reaches a Rex server and runs programs through it. */
export function rexHandlers(sync: RexSync): Handlers {
  return {
    'orc.rex.start': async (params) => {
      const link = { rex: await executable(params.rex, 'rex'), server: optional(params.server, 'server'), orc: await executable(params.orc, 'orc'),
        config: optional(params.config, 'config') }
      return { ...(await sync.start(link)), ...sync.status() }
    },
    'orc.rex.stop': async () => ({ stopped: await sync.stop() }),
    'orc.rex.clear': async () => ({ ...(await sync.clear()), ...sync.status() }),
    'orc.rex.status': () => sync.status()
  }
}

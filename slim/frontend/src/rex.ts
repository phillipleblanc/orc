import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Catalog } from './catalog.ts'
import { RpcError, type Handlers } from './rpc-server.ts'
import type { SessionStore } from './session-store.ts'
import type { TerminalSession } from './terminal-session.ts'

const SCRIPT = fileURLToPath(new URL('./rex-sync.lua', import.meta.url))
// Sessions often come and go together, as when a computer restart restores them.
const SYNC_DELAY_MS = 300
const SYNC_TIMEOUT_MS = 60_000

/** How to reach a Rex server, as `orc rex start` found it in the Rex terminal it ran in. */
export type RexLink = { rex: string; server: string | null; orc: string; config: string | null }
type RexEntry = { session: string; window: string; name: string }
type RexState = { link: RexLink; map: Record<string, RexEntry>; dismissed: string[] }
export type RexSyncResult = { created: string[]; renamed: string[]; closed: string[]; errors: string[] }

/**
 * Keeps a Rex server in sync with this runtime's sessions once `orc rex start` links it: one Rex session per Orc
 * session, labeled with its name, whose tab runs `orc attach` for it as a viewer that leaves the session's size alone
 * until someone types there. It syncs when linked, when the frontend starts, and when a session is added, renamed
 * or ends, by running `rex-sync.lua` with Rex's own CLI. A Rex session or tab closed in Rex stays out of Rex until
 * `orc rex start` runs again. The link, and the Rex session and tab made for each Orc session, are kept in
 * `rex.json` in the profile.
 */
export class RexSync {
  private state: RexState | null = null
  private timer: NodeJS.Timeout | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private lastError: string | null = null
  private lastSyncAt: number | null = null

  private readonly options: { profile: string; store: SessionStore; catalog: Catalog; log: (line: string) => void }

  constructor(options: { profile: string; store: SessionStore; catalog: Catalog; log: (line: string) => void }) {
    this.options = options
    for (const event of ['added', 'ended', 'renamed']) options.store.on(event, () => this.schedule())
  }

  private get file(): string { return join(this.options.profile, 'rex.json') }

  async load(): Promise<void> {
    this.state = await readFile(this.file, 'utf8').then((text) => JSON.parse(text) as RexState, () => null)
    this.schedule()
  }

  /** Links a Rex server, brings back every Orc session closed in Rex, and syncs now. */
  async start(link: RexLink): Promise<RexSyncResult> {
    const same = this.state?.link.server === link.server
    this.state = { link, map: same ? this.state!.map : {}, dismissed: [] }
    await this.save(this.state)
    return this.sync()
  }

  /** Stops syncing. The Rex sessions made so far stay. */
  async stop(): Promise<boolean> {
    const linked = this.state !== null
    this.state = null
    if (this.timer) clearTimeout(this.timer)
    await rm(this.file, { force: true })
    return linked
  }

  status(): Record<string, unknown> {
    return {
      linked: this.state !== null, server: this.state?.link.server ?? null, sessions: Object.keys(this.state?.map ?? {}).length,
      lastSyncAt: this.lastSyncAt, lastError: this.lastError
    }
  }

  private schedule(): void {
    if (!this.state) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.sync().catch(() => {}) }, SYNC_DELAY_MS)
    this.timer.unref()
  }

  /** Runs one sync after any already under way. */
  private sync(): Promise<RexSyncResult> {
    const run = this.queue.then(() => this.syncOnce())
    this.queue = run.catch(() => {})
    return run
  }

  private async syncOnce(): Promise<RexSyncResult> {
    const state = this.state
    if (!state) return { created: [], renamed: [], closed: [], errors: [] }
    const sessions = this.options.store.list().filter((session) => session.connected).map((session) => ({
      handle: session.handle, name: session.meta.name, cwd: this.options.catalog.worktreeFor(session).path,
      command: attachCommand(state.link, this.options.profile, session)
    }))
    let output: Record<string, unknown>
    try {
      output = JSON.parse(await runRex(state.link, JSON.stringify({ sessions, map: state.map, dismissed: state.dismissed })))
    } catch (error) {
      const message = (error as Error).message
      if (message !== this.lastError) this.options.log(`rex sync failed: ${message}`)
      this.lastError = message
      throw new RpcError('rex_unavailable', message)
    }
    const result = { created: strings(output.created), renamed: strings(output.renamed), closed: strings(output.closed), errors: strings(output.errors) }
    // A stop, or a start with another server, during the sync leaves its outcome unrecorded.
    if (this.state === state) {
      state.map = output.map && typeof output.map === 'object' && !Array.isArray(output.map) ? output.map as Record<string, RexEntry> : {}
      state.dismissed = strings(output.dismissed)
      await this.save(state)
    }
    this.lastSyncAt = Date.now()
    this.lastError = result.errors[0] ?? null
    if (result.errors.length) this.options.log(`rex sync: ${result.errors.join('; ')}`)
    return result
  }

  private async save(state: RexState): Promise<void> {
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
    await rename(temporary, this.file)
  }
}

/** A viewer of `session` in its Rex tab. */
function attachCommand(link: RexLink, profile: string, session: TerminalSession): string[] {
  return ['/usr/bin/env', `ORC_RUNTIME_DIR=${profile}`, ...(link.config ? [`ORC_CONFIG_DIR=${link.config}`] : []),
    link.orc, 'attach', session.meta.name, '--no-session-switch', '--client-id', `rex-${session.handle}`, '--viewport-ownership']
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
    'orc.rex.status': () => sync.status()
  }
}

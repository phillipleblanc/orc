import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { HolderClient } from './holder-client.ts'
import { TerminalSession, type CheckpointPolicy, type SessionMeta } from './terminal-session.ts'

const SOCKET_PATH_LIMIT = 103

export class SessionError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export type CreateOptions = {
  name: string
  cwd: string
  argv: string[]
  env: Record<string, string>
  cols: number
  rows: number
  project?: string
  agent?: string
  parent?: string
  /** Where the agent's status hooks append lifecycle events. */
  events?: string
}

export type StoreOptions = {
  profile: string
  holderSource: string
  policy?: Partial<CheckpointPolicy>
  answerQueries?: boolean
}

/**
 * Sessions live under `<profile>/sessions/<name>/`. The directory name is the session's identity:
 * creating it is the uniqueness check, and it survives any frontend restart.
 */
export class SessionStore extends EventEmitter {
  readonly profile: string
  readonly sessionsDir: string
  readonly endedDir: string
  private readonly options: StoreOptions
  private readonly sessions = new Map<string, TerminalSession>()
  /** Names of finished sessions whose directories are still being moved to `ended/`. */
  private readonly retiring = new Map<string, Promise<void>>()
  private holderPath: string | null = null

  constructor(options: StoreOptions) {
    super()
    this.options = options
    this.profile = options.profile
    this.sessionsDir = join(options.profile, 'sessions')
    this.endedDir = join(options.profile, 'ended')
  }

  list(): TerminalSession[] {
    return [...this.sessions.values()].sort((left, right) => left.meta.createdAt.localeCompare(right.meta.createdAt))
  }

  get(selector: string): TerminalSession | undefined {
    const byName = this.sessions.get(selector)
    if (byName) return byName
    return this.list().find((session) => session.handle === selector || session.meta.id === selector)
  }

  /** Reconnects to every holder that is still serving; retires sessions whose holder is gone. */
  async discover(): Promise<{ attached: string[]; retired: string[] }> {
    await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 })
    const attached: string[] = []
    const retired: string[] = []
    const names = await readdir(this.sessionsDir)
    await Promise.all(names.map(async (name) => {
      const dir = join(this.sessionsDir, name)
      const meta = await readMeta(dir)
      if (!meta) return
      try {
        const session = await TerminalSession.open(dir, meta, this.sessionOptions())
        this.track(session)
        attached.push(name)
      } catch {
        await this.retire(name, dir, existsSync(join(dir, 'exit.json')) ? 'exited' : 'lost')
        retired.push(name)
      }
    }))
    return { attached, retired }
  }

  async create(options: CreateOptions): Promise<TerminalSession> {
    validateName(options.name)
    const dir = join(this.sessionsDir, options.name)
    if (join(dir, 'sock').length > SOCKET_PATH_LIMIT) throw new SessionError('invalid_argument', 'session name is too long for this profile path')
    await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 })
    // A session that just finished frees its name once its directory has moved.
    await this.retiring.get(options.name)
    try {
      await mkdir(dir, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SessionError('name_taken', `a session named ${options.name} already exists`)
      throw error
    }
    const meta: SessionMeta = {
      id: randomUUID(),
      name: options.name,
      incarnationId: randomUUID(),
      createdAt: new Date().toISOString(),
      cwd: options.cwd,
      argv: options.argv,
      ...(options.project ? { project: options.project } : {}),
      ...(options.agent ? { agent: options.agent } : {}),
      ...(options.parent ? { parent: options.parent } : {}),
      ...(options.events ? { events: options.events } : {})
    }
    try {
      await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), { mode: 0o600 })
      await this.startHolder(dir, options)
      const session = await TerminalSession.open(dir, meta, this.sessionOptions())
      this.track(session)
      return session
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      throw error
    }
  }

  /** Gives a session a new name. The name is the session's identity, so references to the old name stop resolving. */
  async rename(session: TerminalSession, name: string): Promise<void> {
    if (name === session.meta.name) return
    validateName(name)
    await this.retiring.get(name)
    if (this.sessions.has(name) || existsSync(join(this.sessionsDir, name))) throw new SessionError('name_taken', `a session named ${name} already exists`)
    const target = join(this.sessionsDir, name)
    if (join(target, 'sock').length > SOCKET_PATH_LIMIT) throw new SessionError('invalid_argument', 'session name is too long for this profile path')
    await rename(session.dir, target)
    this.sessions.delete(session.meta.name)
    session.relocate(target, name)
    this.sessions.set(name, session)
    await writeFile(join(target, 'meta.json'), JSON.stringify(session.meta, null, 2), { mode: 0o600 })
  }

  /** Saves checkpoints and disconnects from every holder without ending sessions. */
  async detachAll(): Promise<void> {
    const sessions = this.list()
    this.sessions.clear()
    await Promise.all(sessions.map((session) => session.detach()))
  }

  private sessionOptions() {
    return { policy: this.options.policy, answerQueries: this.options.answerQueries }
  }

  private track(session: TerminalSession): void {
    this.sessions.set(session.meta.name, session)
    this.emit('added', session)
    const finish = async () => {
      const name = session.meta.name
      if (this.sessions.get(name) !== session) return
      this.sessions.delete(name)
      const retired = (async () => {
        await session.checkpoint().catch(() => {})
        await session.close().catch(() => {})
        await this.retire(name, session.dir, session.exit ? 'exited' : 'lost')
      })()
      this.retiring.set(name, retired.catch(() => {}))
      try {
        await retired
      } finally {
        this.retiring.delete(name)
      }
      this.emit('ended', session)
    }
    session.on('exit', () => void finish())
    session.on('lost', () => void finish())
    if (session.exit) void finish()
  }

  /** Moves a finished session out of the namespace so its name can be reused. */
  private async retire(name: string, dir: string, reason: 'exited' | 'lost'): Promise<void> {
    await mkdir(this.endedDir, { recursive: true, mode: 0o700 })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await writeFile(join(dir, 'retired.json'), JSON.stringify({ reason, retiredAt: new Date().toISOString() }), { mode: 0o600 }).catch(() => {})
    await rename(dir, join(this.endedDir, `${name}.${stamp}`)).catch(() => rm(dir, { recursive: true, force: true }))
  }

  private async startHolder(dir: string, options: CreateOptions): Promise<void> {
    const holder = await this.installedHolder()
    const child = spawn(holder, [
      '--dir', dir, '--cols', String(options.cols), '--rows', String(options.rows), '--cwd', options.cwd, '--', ...options.argv
    ], { detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: options.env })
    let stderr = ''
    child.stderr!.on('data', (chunk) => { stderr += chunk })
    let exited: number | null = null
    child.once('exit', (code) => { exited = code ?? -1 })
    const deadline = Date.now() + 5000
    try {
      while (Date.now() < deadline) {
        if (exited !== null) throw new SessionError('spawn_failed', stderr.trim() || `holder exited with status ${exited}`)
        if (existsSync(join(dir, 'sock'))) {
          try {
            const probe = await HolderClient.connect(join(dir, 'sock'), 500)
            probe.disconnect()
            return
          } catch {}
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      child.kill('SIGTERM')
      throw new SessionError('spawn_failed', 'holder did not start listening within 5 seconds')
    } finally {
      child.stderr!.destroy()
      child.unref()
    }
  }

  /** Copies the holder to a content-addressed path, so an app update never replaces a running binary. */
  private async installedHolder(): Promise<string> {
    if (this.holderPath && existsSync(this.holderPath)) return this.holderPath
    const bytes = await readFile(this.options.holderSource)
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
    const dir = join(this.profile, 'holders', digest)
    const target = join(dir, 'orc-holder')
    if (!existsSync(target)) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const temporary = `${target}.${process.pid}.tmp`
      await copyFile(this.options.holderSource, temporary)
      await chmod(temporary, 0o755)
      await rename(temporary, target)
    }
    this.holderPath = target
    return target
  }
}

export function validateName(name: string): void {
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) throw new SessionError('invalid_argument', 'session names must be 1-64 characters')
  if (name !== name.normalize('NFC') || name.trim() !== name) throw new SessionError('invalid_argument', 'session names must be trimmed NFC text')
  if (/[\/\u0000-\u001f\u007f]/.test(name) || name.startsWith('.')) throw new SessionError('invalid_argument', 'session names cannot contain "/", control characters, or start with "."')
}

async function readMeta(dir: string): Promise<SessionMeta | null> {
  try {
    if (!(await stat(dir)).isDirectory()) return null
    return JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as SessionMeta
  } catch {
    return null
  }
}

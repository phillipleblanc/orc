import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentDirectory } from './agents.ts'
import { writeJsonFile } from './json-file.ts'
import { loginEnvironment } from './login-environment.ts'
import { RpcError } from './rpc-server.ts'
import { sessionEnvironment } from './session-environment.ts'
import type { SessionStore } from './session-store.ts'
import type { TerminalSession } from './terminal-session.ts'

type Common = { id: string; message: string; createdAt: number }
/** `started` is the process's start time as `ps` reports it, so a reused pid is not mistaken for it. */
export type Wake =
  | Common & { kind: 'timer'; dueAt: number }
  | Common & { kind: 'pid'; pid: number; command: string; started: string }
  | Common & { kind: 'script'; script: string; cwd: string; pid: number; started: string }

const TICK_MS = 1000
// Signal 0 cannot tell a zombie or a reused pid from the watched process; `ps` can, at a higher cost.
const VERIFY_MS = 15_000
const OUTPUT_BYTES = 8000
const LOG_RETENTION_MS = 7 * 86_400_000
const DEFAULT_MESSAGE = 'continue'
// Runs the script, then records its exit status in a file that any later frontend can read.
const WRAPPER = 'if [ -x "$1" ]; then "$1"; else /bin/bash "$1"; fi; status=$?; printf "%s\\n" "$status" > "$2.tmp" && mv -f "$2.tmp" "$2"'
const run = promisify(execFile)

/**
 * Wakes send an agent a message later: after a delay, when a process exits, or when a script started
 * for the wake finishes. They are kept in the session's `wakes.json`, so they outlive frontend
 * restarts; wake scripts run in their own process group and outlive them too. A fired wake's message
 * waits in the agent's queue like any other, from `wake`. Ending a session stops its wake scripts.
 */
export class WakeDirectory {
  private readonly store: SessionStore
  private readonly agents: AgentDirectory
  private readonly profile: string
  private readonly logs: string
  private readonly lists = new Map<TerminalSession, Promise<Wake[]>>()
  private verifiedAt = 0
  private timer: NodeJS.Timeout | null = null
  private closed = false

  constructor(store: SessionStore, agents: AgentDirectory, profile: string) {
    this.store = store
    this.agents = agents
    this.profile = profile
    this.logs = join(profile, 'wake-logs')
    store.on('added', (session: TerminalSession) => void this.loaded(session))
    store.on('ended', (session: TerminalSession) => void this.drop(session))
    this.loop()
  }

  async create(name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = this.agentSession(name)
    const common = { id: randomUUID(), message: typeof params.message === 'string' ? params.message.trim() : '', createdAt: Date.now() }
    let wake: Wake
    if (params.kind === 'timer') {
      const delay = Number(params.delayMs)
      if (!Number.isFinite(delay) || delay <= 0) throw new RpcError('invalid_argument', 'delayMs must be a positive number')
      wake = { ...common, kind: 'timer', message: common.message || DEFAULT_MESSAGE, dueAt: common.createdAt + Math.ceil(delay) }
    } else if (params.kind === 'pid') {
      const pid = Number(params.pid)
      const info = Number.isInteger(pid) && pid > 0 ? await processInfo(pid) : null
      if (!info || info.stat.startsWith('Z')) throw new RpcError('not_found', `no process ${String(params.pid)}`)
      wake = { ...common, kind: 'pid', pid, command: info.command, started: info.started }
    } else if (params.kind === 'script') {
      wake = await this.start(session, common, params.script, params.cwd)
    } else {
      throw new RpcError('invalid_argument', 'kind must be timer, pid or script')
    }
    const list = await this.loaded(session)
    list.push(wake)
    await this.save(session, list)
    return describe(wake)
  }

  async list(name: string): Promise<Record<string, unknown>[]> {
    return (await this.loaded(this.agentSession(name))).map(describe)
  }

  /** Cancels the wake whose id is, or uniquely starts with, `id`. A running wake script is stopped. */
  async cancel(name: string, id: string): Promise<Record<string, unknown>> {
    const session = this.agentSession(name)
    const list = await this.loaded(session)
    const matches = id ? list.filter((wake) => wake.id.startsWith(id)) : []
    if (matches.length === 0) throw new RpcError('not_found', `no wake ${id}`)
    if (matches.length > 1) throw new RpcError('invalid_argument', `${id} matches more than one wake`)
    const [wake] = matches
    list.splice(list.indexOf(wake), 1)
    await this.save(session, list)
    await this.stop(wake)
    return describe(wake)
  }

  private agentSession(name: string): TerminalSession {
    const session = this.store.get(name)
    if (!session) throw new RpcError('not_found', `no session named ${name}`)
    if (!this.agents.isAgent(session)) throw new RpcError('invalid_argument', `${name} is not an agent session`)
    return session
  }

  private loaded(session: TerminalSession): Promise<Wake[]> {
    let list = this.lists.get(session)
    if (!list) {
      list = readFile(join(session.dir, 'wakes.json'), 'utf8').then((text) => {
        const saved = JSON.parse(text)
        return Array.isArray(saved) ? saved : []
      }, () => [])
      this.lists.set(session, list)
    }
    return list
  }

  private async drop(session: TerminalSession): Promise<void> {
    const list = this.lists.get(session)
    this.lists.delete(session)
    for (const wake of (await list) ?? []) await this.stop(wake)
  }

  private async start(session: TerminalSession, common: Common, script: unknown, cwd: unknown): Promise<Wake> {
    if (typeof script !== 'string' || !isAbsolute(script)) throw new RpcError('invalid_argument', 'script must be an absolute path')
    if (!(await stat(script).then((info) => info.isFile(), () => false))) throw new RpcError('not_found', `no script ${script}`)
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || !(await stat(cwd).then((info) => info.isDirectory(), () => false))) {
      throw new RpcError('invalid_argument', 'cwd must be an existing absolute directory')
    }
    await mkdir(this.logs, { recursive: true, mode: 0o700 })
    await this.prune()
    const env = sessionEnvironment(await loginEnvironment(), session.meta.name, { ORC_RUNTIME_DIR: this.profile })
    const log = await open(this.logPath(common.id), 'w', 0o600)
    let pid: number
    try {
      const child = spawn('/bin/sh', ['-c', WRAPPER, 'orc-wake', script, this.exitPath(common.id)], {
        cwd, env, detached: true, stdio: ['ignore', log.fd, log.fd]
      })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      child.unref()
      pid = child.pid!
    } finally {
      await log.close()
    }
    // A script that has already finished has written its exit status, so no start time is needed.
    const started = (await processInfo(pid))?.started ?? ''
    return { ...common, kind: 'script', script, cwd, pid, started }
  }

  private async stop(wake: Wake): Promise<void> {
    if (wake.kind !== 'script') return
    // Without a start time the pid may since belong to another process group.
    if (wake.started && await running(wake.pid, wake.started, true)) {
      try { process.kill(-wake.pid, 'SIGTERM') } catch {}
    }
    await rm(this.exitPath(wake.id), { force: true })
  }

  /** Stops checking wakes. Pending wakes and their scripts are left for the next frontend. */
  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
  }

  private loop(): void {
    if (this.closed) return
    this.timer = setTimeout(() => void this.tick().catch(() => {}).finally(() => this.loop()), TICK_MS)
    this.timer.unref()
  }

  private async tick(): Promise<void> {
    const verify = Date.now() - this.verifiedAt >= VERIFY_MS
    if (verify) this.verifiedAt = Date.now()
    for (const [session, pending] of [...this.lists]) {
      const list = await pending
      for (const wake of [...list]) {
        const text = await this.outcome(wake, verify).catch(() => null)
        if (text === null || this.lists.get(session) !== pending || !list.includes(wake)) continue
        list.splice(list.indexOf(wake), 1)
        await this.agents.deliver(session, text, 'wake').catch(() => {})
        await this.save(session, list)
        await rm(this.exitPath(wake.id), { force: true })
      }
    }
  }

  /** The message to deliver if the wake has fired, otherwise null. */
  private async outcome(wake: Wake, verify: boolean): Promise<string | null> {
    if (wake.kind === 'timer') return Date.now() >= wake.dueAt ? wake.message : null
    if (wake.kind === 'pid') {
      if (await running(wake.pid, wake.started, verify)) return null
      return withMessage(wake.message, `pid ${wake.pid} (${wake.command}) exited`)
    }
    const status = () => readFile(this.exitPath(wake.id), 'utf8').then((text) => text.trim(), () => null)
    let code = await status()
    if (code === null) {
      if (await running(wake.pid, wake.started, verify)) return null
      // The wrapper writes the status just before exiting.
      code = await status()
    }
    const output = await this.output(wake.id)
    const result = `${wake.script} ${code === null ? 'finished (exit status unknown)' : `exited ${code}`}`
    return withMessage(wake.message, output ? `${result}\noutput:\n${output}` : result)
  }

  private async output(id: string): Promise<string> {
    const path = this.logPath(id)
    const file = await open(path, 'r').catch(() => null)
    if (!file) return ''
    try {
      const { size } = await file.stat()
      const length = Math.min(size, OUTPUT_BYTES)
      const { buffer } = await file.read(Buffer.alloc(length), 0, length, size - length)
      const text = buffer.toString('utf8')
      if (size <= length) return text.trimEnd()
      return `… (the full output is in ${path})\n${text.slice(text.indexOf('\n') + 1).trimEnd()}`
    } finally {
      await file.close()
    }
  }

  /** Removes old logs of wakes that are no longer pending. */
  private async prune(): Promise<void> {
    const pending = new Set((await Promise.all(this.lists.values())).flat().map((wake) => wake.id))
    const cutoff = Date.now() - LOG_RETENTION_MS
    for (const entry of await readdir(this.logs).catch(() => [])) {
      if (pending.has(entry.replace(/\.(log|exit)$/, ''))) continue
      const path = join(this.logs, entry)
      if (((await stat(path).catch(() => null))?.mtimeMs ?? Infinity) < cutoff) await rm(path, { force: true })
    }
  }

  private logPath(id: string): string {
    return join(this.logs, `${id}.log`)
  }

  private exitPath(id: string): string {
    return join(this.logs, `${id}.exit`)
  }

  private save(session: TerminalSession, list: Wake[]): Promise<void> {
    return writeJsonFile(join(session.dir, 'wakes.json'), list).catch(() => {})
  }
}

function describe(wake: Wake): Record<string, unknown> {
  const { started: _, ...rest } = wake as Wake & { started?: string }
  return rest
}

function withMessage(message: string, status: string): string {
  return message ? `${message}\n\n${status}` : status
}

async function running(pid: number, started: string, verify: boolean): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
  }
  if (!verify) return true
  const info = await processInfo(pid)
  return Boolean(info) && !info!.stat.startsWith('Z') && (!started || info!.started === started)
}

/** A process's state, start time and command line, or null when there is no such process. */
async function processInfo(pid: number): Promise<{ stat: string; started: string; command: string } | null> {
  try {
    const { stdout } = await run('/bin/ps', ['-o', 'stat=,lstart=,command=', '-p', String(pid)], { env: { LC_ALL: 'C' } })
    const match = /^\s*(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(stdout.trimEnd())
    if (!match) return null
    const command = match[3].length > 200 ? `${match[3].slice(0, 200)}…` : match[3]
    return { stat: match[1], started: match[2].replace(/\s+/g, ' '), command }
  } catch {
    return null
  }
}

import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { callerArguments, isAgentKind, type ProviderSession } from './agent-hooks.ts'
import type { AgentDirectory } from './agents.ts'
import { writeJsonFile } from './json-file.ts'
import { loginEnvironment } from './login-environment.ts'
import type { Projects } from './projects.ts'
import { sessionEnvironment } from './session-environment.ts'
import type { SessionStore } from './session-store.ts'
import type { SessionMeta } from './terminal-session.ts'

// On shutdown, programs can exit and be retired before the frontend is told to stop.
const SHUTDOWN_MS = 30_000
const RECORD_MS = 30_000

/**
 * `boot.json` holds the boot of the computer the frontend last ran in and when it last recorded it,
 * which is at most 30 s before it stopped. A different boot at startup means the computer restarted
 * since, taking every session with it.
 */
export class BootRecord {
  readonly previous: { boot: string; at: number } | null
  private readonly path: string
  private readonly boot: string | null
  private timer: NodeJS.Timeout | null = null

  private constructor(path: string, boot: string | null, previous: BootRecord['previous']) {
    this.path = path
    this.boot = boot
    this.previous = previous
  }

  static async load(profile: string): Promise<BootRecord> {
    const path = join(profile, 'boot.json')
    const saved = await readFile(path, 'utf8').then(JSON.parse, () => null)
    const previous = typeof saved?.boot === 'string' && typeof saved?.at === 'number' ? { boot: saved.boot, at: saved.at } : null
    return new BootRecord(path, currentBoot(), previous)
  }

  /** When the computer restarted since the last record, the earliest time a session could have ended with it. */
  get restartedSince(): number | null {
    return this.boot && this.previous && this.previous.boot !== this.boot ? this.previous.at - SHUTDOWN_MS : null
  }

  /** Records this boot now and every 30 s. Until then the previous record stays, so an interrupted restore is retried. */
  keep(): void {
    if (this.timer || !this.boot) return
    this.timer = setInterval(() => void this.save(), RECORD_MS)
    this.timer.unref()
    void this.save()
  }

  /** Records this boot now, if `keep` has been called. */
  async save(): Promise<void> {
    if (this.timer) await writeJsonFile(this.path, { boot: this.boot, at: Date.now() }).catch(() => {})
  }
}

/** Identifies this boot of the computer, or null when it cannot be read. */
function currentBoot(): string | null {
  try {
    return execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

/**
 * Starts again, under their names, the sessions that ended at or after `since`: after a restart, the
 * ones that were running when the computer went down. An agent continues its conversation and keeps
 * its undelivered messages and wakes; a shell starts in the same directory. Sessions that ran any
 * other command are not started again, and a name that is in use again is skipped. Returns the names
 * started.
 */
export async function restoreSessions(runtime: { store: SessionStore; agents: AgentDirectory; projects: Projects }, since: number,
  log: (line: string) => void): Promise<string[]> {
  const { store, agents, projects } = runtime
  const latest = new Map<string, { dir: string; meta: SessionMeta; endedAt: number }>()
  for (const entry of await readdir(store.endedDir).catch(() => [] as string[])) {
    const dir = join(store.endedDir, entry)
    const endedAt = Date.parse((await readJson(join(dir, 'retired.json')))?.retiredAt ?? '')
    if (!(endedAt >= since)) continue
    const meta = await readJson(join(dir, 'meta.json')) as SessionMeta | null
    if (!meta?.name || !Array.isArray(meta.argv)) continue
    if ((latest.get(meta.name)?.endedAt ?? -Infinity) < endedAt) latest.set(meta.name, { dir, meta, endedAt })
  }
  const restored: string[] = []
  for (const { dir, meta } of [...latest.values()].sort((left, right) => left.meta.createdAt.localeCompare(right.meta.createdAt))) {
    if (store.get(meta.name)) continue
    const project = meta.project ? projects.resolve(`id:${meta.project}`) : undefined
    try {
      if (isAgentKind(meta.agent) && meta.events) {
        await agents.launch({
          agent: meta.agent, name: meta.name, cwd: meta.cwd, project: project && `id:${project.id}`, parent: meta.parent,
          args: callerArguments(meta.agent, meta.argv), resume: await providerSession(meta.events),
          files: [join(dir, 'queue.json'), join(dir, 'wakes.json')]
        })
      } else if (meta.argv.length === 2 && meta.argv[1] === '-l') {
        await store.create({
          name: meta.name, cwd: meta.cwd, argv: meta.argv, cols: 120, rows: 40,
          env: sessionEnvironment(await loginEnvironment(), meta.name, { ORC_RUNTIME_DIR: store.profile }),
          project: (project ?? projects.containing(meta.cwd))?.id, parent: meta.parent
        })
      } else {
        continue
      }
      restored.push(meta.name)
      log(`restored ${meta.name}`)
    } catch (error) {
      log(`could not restore ${meta.name}: ${(error as Error).message}`)
    }
  }
  return restored
}

/** The last conversation an agent's hooks reported. */
async function providerSession(events: string): Promise<ProviderSession> {
  const session: ProviderSession = {}
  for (const line of (await readFile(events, 'utf8').catch(() => '')).split('\n')) {
    try {
      const payload = JSON.parse(line)?.payload
      if (typeof payload?.session_id === 'string') session.id = payload.session_id
      if (typeof payload?.transcript_path === 'string') session.transcriptPath = payload.transcript_path
    } catch {}
  }
  return session
}

function readJson(path: string): Promise<any> {
  return readFile(path, 'utf8').then(JSON.parse, () => null)
}

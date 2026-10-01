import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentDirectory } from './agents.ts'
import { endedSessions, latestByName, startAgain } from './history.ts'
import { writeJsonFile } from './json-file.ts'
import type { Projects } from './projects.ts'
import type { SessionStore } from './session-store.ts'

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
 * ones that were running when the computer went down. Agents continue their conversations and shells
 * start in the same directory (see `startAgain`). A name that is in use again is skipped. Returns the
 * names started.
 */
export async function restoreSessions(runtime: { store: SessionStore; agents: AgentDirectory; projects: Projects }, since: number,
  log: (line: string) => void): Promise<string[]> {
  const candidates = latestByName((await endedSessions(runtime.store)).filter((session) => session.endedAt >= since))
    .filter((session) => !session.reopened)
    .sort((left, right) => left.meta.createdAt.localeCompare(right.meta.createdAt))
  const restored: string[] = []
  for (const ended of candidates) {
    if (runtime.store.get(ended.meta.name)) continue
    try {
      if (!(await startAgain(runtime, ended))) continue
      restored.push(ended.meta.name)
      log(`restored ${ended.meta.name}`)
    } catch (error) {
      log(`could not restore ${ended.meta.name}: ${(error as Error).message}`)
    }
  }
  return restored
}

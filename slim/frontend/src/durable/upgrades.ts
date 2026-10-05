import { resumedConversation } from '../agent-hooks.ts'
import type { AgentDirectory } from '../agents.ts'
import type { SessionStore } from '../session-store.ts'
import type { TerminalSession } from '../terminal-session.ts'
import { durableRequest } from './connection.ts'
import { durableSocket, restartsInPlace } from './paths.ts'
import { durableCodeVersion } from './version.ts'

// Sessions already running when the frontend starts are checked once their monitors have caught up.
const STARTUP_CHECK_MS = 3000

/**
 * Keeps durable agents on the code this frontend serves. A worker reports the code version it
 * started with; one that runs older code is restarted at its next idle moment, and continues its
 * conversation. A session running the restart loop restarts its worker in place, keeping the session;
 * any other is ended and started again under its name, as reopening does. Each session is restarted
 * at most once per version, so a worker that still reports another version is left running.
 */
export class DurableUpgrades {
  readonly version = durableCodeVersion()
  private readonly store: SessionStore
  private readonly agents: AgentDirectory
  private readonly restartSession: (session: TerminalSession) => Promise<unknown>
  private readonly log: (line: string) => void
  private readonly attempted = new Map<string, string>()
  private readonly checking = new Set<string>()

  constructor(store: SessionStore, agents: AgentDirectory, restartSession: (session: TerminalSession) => Promise<unknown>, log: (line: string) => void) {
    this.store = store
    this.agents = agents
    this.restartSession = restartSession
    this.log = log
    agents.on('change', (session: TerminalSession) => void this.check(session))
    setTimeout(() => { for (const session of store.list()) void this.check(session) }, STARTUP_CHECK_MS).unref()
  }

  private idle(session: TerminalSession): boolean {
    const monitor = this.agents.monitor(session)
    return Boolean(monitor?.ready && monitor.effectiveState === 'idle')
  }

  private async check(session: TerminalSession): Promise<void> {
    const key = session.meta.id
    if (session.meta.agent !== 'durable' || !session.connected || this.store.get(session.meta.name) !== session) return
    if (this.checking.has(key) || this.attempted.get(key) === this.version || !this.idle(session)) return
    const storage = resumedConversation('durable', session.meta.argv).transcriptPath
    if (!storage) return
    this.checking.add(key)
    try {
      const info = await durableRequest(durableSocket(storage), 'info').catch(() => null)
      if (!info || info.version === this.version || !this.idle(session)) return
      this.attempted.set(key, this.version)
      this.log(`restarting durable agent ${session.meta.name} on the current code`)
      if (restartsInPlace(session.meta.argv)) await durableRequest(durableSocket(storage), 'upgrade')
      else await this.restartSession(session)
    } catch (error) {
      this.log(`could not restart durable agent ${session.meta.name}: ${(error as Error).message}`)
    } finally {
      this.checking.delete(key)
    }
  }
}

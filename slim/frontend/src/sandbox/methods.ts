import type { AgentDirectory } from '../agents.ts'
import { restartSession } from '../history.ts'
import type { Projects } from '../projects.ts'
import { RpcError, type Handlers } from '../rpc-server.ts'
import type { SessionStore } from '../session-store.ts'
import type { TerminalSession } from '../terminal-session.ts'
import { sandboxOf, type Sandboxes } from './sandboxes.ts'
import { buildTemplate } from './template.ts'

type Runtime = { store: SessionStore; agents: AgentDirectory; projects: Projects; sandboxes: Sandboxes; log: (line: string) => void }

const IDLE_WAIT_MS = 10 * 60_000

/**
 * The owner's sandbox methods, served on the local socket only: grants of folders to agent names, the
 * machines, the template, and throwaway machines for commands. An agent never reaches these.
 */
export function sandboxHandlers(runtime: Runtime): Handlers {
  const { store, sandboxes } = runtime
  let building: Promise<{ template: string; seconds: number }> | null = null
  const text = (value: unknown, field: string) => {
    if (typeof value !== 'string' || !value) throw new RpcError('invalid_argument', `${field} is required`)
    return value
  }
  return {
    'sandbox.list': async () => {
      const machines = await sandboxes.orb.machines().catch(() => [])
      return {
        sessions: await Promise.all(store.list().filter((session) => sandboxOf(session)).map(async (session) => {
          const machine = machines.find((candidate) => candidate.name === sandboxOf(session)!.machine)
          return {
            name: session.meta.name, machine: sandboxOf(session)!.machine, state: machine?.state ?? 'missing',
            folders: (machine?.mounts ?? []).map((mount) => mount.source), grants: await sandboxes.grants(session.meta.name)
          }
        })),
        settings: await sandboxes.settings()
      }
    },

    // Gives the agent named `name` a folder. A running sandboxed agent that lacks it restarts when it is next idle,
    // continuing its conversation; one that starts later gets it when it starts.
    'sandbox.grant': async (params) => {
      const name = text(params.name, 'name')
      const grants = await sandboxes.grant(name, text(params.path, 'path'))
      const session = store.get(name)
      const relaunch = session && sandboxOf(session) ? await missingMount(sandboxes, session, grants) : false
      if (relaunch) void relaunchWhenIdle(runtime, session!, `Orc restarted you to give you ${params.path}; it is mounted now.`, 0)
      return { name, grants, relaunch: relaunch ? 'when idle' : session && sandboxOf(session) ? 'none' : 'at start' }
    },

    // Takes a folder back. A running sandboxed agent that has it restarts without it, when idle or at once with
    // `now`; the reply comes once it no longer has the folder.
    'sandbox.revoke': async (params) => {
      const name = text(params.name, 'name')
      const grants = await sandboxes.revoke(name, text(params.path, 'path'))
      const session = store.get(name)
      if (!session || !sandboxOf(session)) return { name, grants, relaunched: false }
      const machine = await sandboxes.orb.machine(sandboxOf(session)!.machine)
      const wanted = new Set((await sandboxes.mounts(name, session.meta.cwd)).map((mount) => mount.source))
      if (!machine?.mounts.some((mount) => !wanted.has(mount.source))) return { name, grants, relaunched: false }
      const waitMs = params.now === true ? 0 : Math.min(Number(params.timeoutMs ?? IDLE_WAIT_MS), IDLE_WAIT_MS)
      await relaunchWhenIdle(runtime, session, `Orc restarted you: ${params.path} is no longer given to you.`, waitMs, true)
      return { name, grants, relaunched: true }
    },

    'sandbox.template': async () => {
      building ??= sandboxes.settings().then((settings) => buildTemplate({ orb: sandboxes.orb, profile: sandboxes.profile, template: settings.template, log: runtime.log }))
        .finally(() => { building = null })
      return building
    },

    'sandbox.exec': async (params) => {
      const grants = Array.isArray(params.grants) ? params.grants.map(String) : []
      const argv = Array.isArray(params.argv) ? params.argv.map(String) : []
      return sandboxes.exec({ grants, argv, cwd: typeof params.cwd === 'string' ? params.cwd : undefined, timeoutMs: Number(params.timeoutMs) || undefined })
    }
  }
}

async function missingMount(sandboxes: Sandboxes, session: TerminalSession, grants: string[]): Promise<boolean> {
  const machine = await sandboxes.orb.machine(sandboxOf(session)!.machine)
  const mounted = new Set((machine?.mounts ?? []).map((mount) => mount.source))
  return grants.some((folder) => !mounted.has(folder))
}

/**
 * Restarts a sandboxed agent once it is idle with nothing queued, or after `waitMs` regardless when `force`,
 * then tells it why. Its machine is kept, and its mounts follow its grants when it starts again.
 */
async function relaunchWhenIdle(runtime: Runtime, session: TerminalSession, note: string, waitMs: number, force = false): Promise<void> {
  const { agents, store } = runtime
  const name = session.meta.name
  const deadline = Date.now() + waitMs
  for (;;) {
    if (store.get(name) !== session) return
    const status = agents.status(name)
    const idle = status.state === 'idle' && !status.delivering && Number(status.queued) === 0
    if (idle || (force && Date.now() >= deadline)) break
    if (!force && waitMs > 0 && Date.now() >= deadline) return
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  try {
    await restartSession({ store, agents, projects: runtime.projects }, session)
    await agents.send(name, note, { from: 'orc', whenIdle: true })
  } catch (error) {
    runtime.log(`restarting ${name} for its grants failed: ${(error as Error).message}`)
    throw error
  }
}

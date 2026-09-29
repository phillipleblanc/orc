import { homedir } from 'node:os'
import type { AgentMonitor, AgentState } from './agent-monitor.ts'
import { isAgentKind, type AgentKind } from './agent-hooks.ts'
import type { AgentDirectory } from './agents.ts'
import { rowText } from './emulator.ts'
import { loginEnvironment, userShell } from './login-environment.ts'
import { RpcError, type Handlers } from './rpc-server.ts'
import type { Projects } from './projects.ts'
import { sessionEnvironment } from './session-environment.ts'
import type { SessionStore } from './session-store.ts'
import { checkpointSamples, type TerminalSession } from './terminal-session.ts'

export const RUNTIME_PROTOCOL_VERSION = 3
export const CAPABILITIES = ['terminal.binary-stream.v1', 'terminal.multiplex.v1', 'orc.agents.v1']

export type Runtime = {
  runtimeId: string
  version: string
  store: SessionStore
  projects: Projects
  agents: AgentDirectory
}

const MAX_WAIT_MS = 10 * 60_000

/** `codex …`, `claude …` or `pi …` commands start an agent with status reporting. */
function agentCommand(command: string): { agent: AgentKind; args: string[] } | null {
  const words = command.trim().split(/\s+/)
  const agent = words[0]?.split('/').pop()
  if (!isAgentKind(agent) || words.some((word) => /['"\\$`;&|<>()]/.test(word))) return null
  return { agent, args: words.slice(1).filter((word) => !(agent === 'codex' && word === '--no-daemon')) }
}

/** Orc's `terminal.agentStatus` vocabulary. */
function terminalStatus(state: AgentState | undefined): string | null {
  return state === 'working' ? 'working' : state === 'permission' ? 'permission' : state === 'idle' ? 'idle' : null
}

/** Orca's session-tab `agentStatus` shape, which Orc and the mobile app read for activity and chat. */
function tabAgentStatus(monitor: AgentMonitor | undefined): Record<string, unknown> | null {
  if (!monitor || monitor.state === 'ended') return null
  const state = monitor.effectiveState
  return {
    agentType: monitor.kind,
    state: state === 'working' ? 'working' : state === 'permission' ? 'blocked' : state === 'idle' ? 'done' : 'waiting',
    ...(monitor.providerSession.id ? { providerSession: monitor.providerSession } : {}),
    ...(monitor.lastAssistantMessage ? { lastAssistantMessage: monitor.lastAssistantMessage } : {}),
    ...(monitor.dialog ? { interactivePrompt: monitor.dialog } : {}),
    restoredUnconfirmed: false
  }
}

export function createHandlers(runtime: Runtime): Handlers {
  const { store, projects, agents } = runtime
  const mutations = new Map<string, Promise<unknown>>()

  const session = (selector: unknown): TerminalSession => {
    const found = typeof selector === 'string' ? store.get(selector) : undefined
    if (!found) throw new RpcError('not_found', `no session ${String(selector)}`)
    return found
  }

  const worktreeFor = (target: TerminalSession) => {
    const project = target.meta.project ? projects.list().find((candidate) => candidate.id === target.meta.project) : undefined
    return { id: project ? projects.worktreeId(project) : `local::${target.meta.cwd}`, path: project?.path ?? target.meta.cwd }
  }

  const describe = (target: TerminalSession) => {
    const worktree = worktreeFor(target)
    return {
      handle: target.handle,
      title: target.meta.name,
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      connected: target.connected,
      writable: target.connected,
      agentIdentity: target.meta.agent ?? null,
      incarnationId: target.meta.incarnationId,
      tabId: target.meta.id,
      leafId: target.meta.id,
      executionHostId: 'local'
    }
  }

  const create = async (params: Record<string, any>) => {
    const project = params.worktree ? projects.resolve(String(params.worktree)) : undefined
    if (params.worktree && !project) throw new RpcError('not_found', `no project ${params.worktree}`)
    const name = String(params.name ?? params.title ?? '')
    const cwd = typeof params.cwd === 'string' ? params.cwd : project?.path ?? homedir()
    const launch = isAgentKind(params.agent) ? { agent: params.agent as AgentKind, args: [] }
      : typeof params.command === 'string' && !Array.isArray(params.argv) ? agentCommand(params.command) : null
    if (launch) {
      const created = await agents.launch({ agent: launch.agent, args: launch.args, name, cwd, project: project ? projects.worktreeId(project) : undefined,
        cols: Number(params.cols ?? 120), rows: Number(params.rows ?? 40) })
      return { terminal: { handle: created.handle, title: created.meta.name, worktreeId: worktreeFor(created).id } }
    }
    const argv: string[] = Array.isArray(params.argv) ? params.argv.map(String)
      : params.command ? [userShell(), '-l', '-c', String(params.command)] : [userShell(), '-l']
    const created = await store.create({
      name,
      cwd,
      argv,
      env: sessionEnvironment(await loginEnvironment(), name, { ORCA_USER_DATA_PATH: store.profile }),
      cols: Number(params.cols ?? 120),
      rows: Number(params.rows ?? 40),
      project: project?.id,
      parent: typeof params.parent === 'string' ? params.parent : undefined
    })
    return { terminal: { handle: created.handle, title: created.meta.name, worktreeId: worktreeFor(created).id } }
  }

  return {
    'status.get': () => ({
      runtimeId: runtime.runtimeId,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: RUNTIME_PROTOCOL_VERSION,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleMobileVersion: 2,
      capabilities: CAPABILITIES,
      appVersion: runtime.version,
      desktopWindowStatus: 'unavailable'
    }),

    'worktree.list': () => {
      const worktrees = projects.list().map((project) => ({ id: projects.worktreeId(project), path: project.path, displayName: project.displayName, hostId: 'local' }))
      return { worktrees, totalCount: worktrees.length, truncated: false }
    },

    'repo.add': async (params) => {
      if (typeof params.path !== 'string') throw new RpcError('invalid_argument', 'path is required')
      const project = await projects.add(params.path, params.kind === 'folder' ? 'folder' : 'git')
      return { repo: { id: project.id, path: project.path, displayName: project.displayName } }
    },

    'terminal.list': () => {
      const terminals = store.list().map(describe)
      return { terminals, totalCount: terminals.length, truncated: false, visualLayouts: [] }
    },

    'session.tabs.listAll': () => ({
      snapshots: [{
        tabs: store.list().map((target) => ({
          type: 'terminal', terminal: target.handle, parentTabId: target.meta.id, leafId: target.meta.id, title: target.meta.name,
          agentStatus: tabAgentStatus(agents.monitor(target)), ...(target.meta.agent ? { launchAgent: target.meta.agent } : {})
        }))
      }]
    }),

    'terminal.create': (params) => {
      const key = typeof params.clientMutationId === 'string' ? params.clientMutationId : null
      if (key && mutations.has(key)) return mutations.get(key)
      const result = create(params)
      if (key) {
        mutations.set(key, result)
        result.catch(() => mutations.delete(key))
      }
      return result
    },

    'terminal.rename': async (params) => {
      const target = session(params.terminal)
      await store.rename(target, String(params.title ?? ''))
      return { rename: { handle: target.handle, title: target.meta.name } }
    },

    'terminal.send': async (params) => {
      const target = session(params.terminal)
      if (params.claimViewport && params.viewport) await target.resize(Number(params.viewport.cols), Number(params.viewport.rows))
      const text = typeof params.text === 'string' ? params.text : ''
      target.input(text + (params.enter ? '\r' : ''))
      return { send: { handle: target.handle, accepted: target.connected } }
    },

    'terminal.close': async (params) => {
      const target = session(params.terminal)
      await target.close()
      return { close: { handle: target.handle } }
    },

    'terminal.agentStatus': (params) => {
      const target = session(params.terminal)
      const monitor = agents.monitor(target)
      const running = Boolean(monitor && monitor.state !== 'ended' && target.connected)
      return { agentStatus: { handle: target.handle, isRunningAgent: running, status: running ? terminalStatus(monitor!.effectiveState) : null } }
    },

    'agent.spawn': (params) => {
      if (!isAgentKind(params.agent)) throw new RpcError('invalid_argument', 'agent must be codex, claude or pi')
      if (typeof params.name !== 'string') throw new RpcError('invalid_argument', 'name is required')
      return agents.spawn({
        agent: params.agent, name: params.name,
        project: typeof params.project === 'string' ? params.project : undefined,
        cwd: typeof params.cwd === 'string' ? params.cwd : undefined,
        prompt: typeof params.prompt === 'string' ? params.prompt : undefined,
        parent: typeof params.parent === 'string' ? params.parent : undefined,
        model: typeof params.model === 'string' ? params.model : undefined,
        effort: typeof params.effort === 'string' ? params.effort : undefined,
        args: Array.isArray(params.args) ? params.args.map(String) : undefined,
        timeoutMs: Math.min(MAX_WAIT_MS, Number(params.timeoutMs ?? 90_000))
      })
    },

    'agent.send': (params) => {
      if (typeof params.to !== 'string' || typeof params.text !== 'string') throw new RpcError('invalid_argument', 'to and text are required')
      return agents.send(params.to, params.text, typeof params.from === 'string' && params.from ? params.from : undefined)
    },

    'agent.list': () => ({ agents: agents.list() }),

    'agent.status': (params) => agents.status(String(params.name)),

    'agent.wait': (params) => agents.wait(String(params.name), Math.min(MAX_WAIT_MS, Number(params.timeoutMs ?? 30_000))),

    'agent.stop': (params) => agents.stop(String(params.name), params.kill === true),

    'terminal.read': async (params) => {
      const target = session(params.terminal)
      const state = await target.state(Number(params.scrollbackRows ?? 0))
      return { read: { handle: target.handle, lines: (state.alternate ?? state.normal).map(rowText) } }
    },

    'slim.screen': async (params) => {
      const target = session(params.terminal)
      const [state, info] = await Promise.all([target.state(Number(params.scrollbackRows ?? 200)), target.info()])
      return { state, info, receivedOffset: target.receivedOffset, gapBytes: target.gapBytes, replayedBytes: target.replayedBytes, restoredFrom: target.restoredFrom, checkpointsDeferred: target.checkpointsDeferred }
    },

    'slim.checkpoint': async (params) => {
      const target = session(params.terminal)
      await target.checkpoint()
      return { appliedOffset: target.appliedOffset }
    },

    'slim.stats': () => ({ checkpoints: checkpointSamples }),

    'slim.resize': async (params) => {
      await session(params.terminal).resize(Number(params.cols), Number(params.rows))
      return {}
    },

    'slim.signal': async (params) => {
      await session(params.terminal).signal(String(params.signal), params.target === 'child' ? 'child' : 'foreground')
      return {}
    }
  }
}

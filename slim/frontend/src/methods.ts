import { homedir, userInfo } from 'node:os'
import { rowText } from './emulator.ts'
import { RpcError, type Handlers } from './rpc-server.ts'
import type { Projects } from './projects.ts'
import type { SessionStore } from './session-store.ts'
import { checkpointSamples, type TerminalSession } from './terminal-session.ts'

export const RUNTIME_PROTOCOL_VERSION = 3
export const CAPABILITIES = ['terminal.binary-stream.v1', 'terminal.multiplex.v1']

export type Runtime = {
  runtimeId: string
  version: string
  store: SessionStore
  projects: Projects
}

const STRIPPED_PREFIXES = ['ORCA_', 'ORC_', 'ELECTRON_', 'HERDR_', 'TERM_PROGRAM']
const STRIPPED_KEYS = new Set(['NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'TMUX', 'TMUX_PANE', 'TERM_SESSION_ID', 'ITERM_SESSION_ID'])

/** The environment a session's program starts with: the frontend's own, minus host-terminal and runtime identity. */
export function sessionEnvironment(base: NodeJS.ProcessEnv, name: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || STRIPPED_KEYS.has(key) || STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.LANG ??= 'en_US.UTF-8'
  env.ORC_SESSION_NAME = name
  return env
}

function userShell(): string {
  return userInfo().shell || process.env.SHELL || '/bin/zsh'
}

export function createHandlers(runtime: Runtime): Handlers {
  const { store, projects } = runtime
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
      agentIdentity: null,
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
    const argv: string[] = Array.isArray(params.argv) ? params.argv.map(String)
      : params.command ? [userShell(), '-l', '-c', String(params.command)] : [userShell(), '-l']
    const created = await store.create({
      name,
      cwd: typeof params.cwd === 'string' ? params.cwd : project?.path ?? homedir(),
      argv,
      env: sessionEnvironment(process.env, name),
      cols: Number(params.cols ?? 120),
      rows: Number(params.rows ?? 40),
      project: project?.id,
      agent: typeof params.agent === 'string' ? params.agent : undefined,
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
          type: 'terminal', terminal: target.handle, parentTabId: target.meta.id, leafId: target.meta.id, title: target.meta.name, agentStatus: null
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
      return { agentStatus: { handle: target.handle, isRunningAgent: false, status: null } }
    },

    'terminal.read': async (params) => {
      const target = session(params.terminal)
      const state = await target.state(Number(params.scrollbackRows ?? 0))
      return { read: { handle: target.handle, lines: state.normal.map(rowText) } }
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

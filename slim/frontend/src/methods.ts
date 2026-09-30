import { homedir } from 'node:os'
import type { AgentMonitor, AgentState } from './agent-monitor.ts'
import { isAgentKind, type AgentKind } from './agent-hooks.ts'
import type { AgentDirectory } from './agents.ts'
import type { Catalog } from './catalog.ts'
import { holdStream, type ConnectionSubscriptions } from './subscriptions.ts'
import type { StreamingHandler } from './websocket-server.ts'
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
  catalog: Catalog
  subscriptions: ConnectionSubscriptions
}

// Orca waits this long after typing a message before pressing Enter, so the program has read the text.
const ENTER_DELAY_MS = 500

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

export function createHandlers(runtime: Runtime): Handlers {
  const { store, projects, agents, catalog, subscriptions } = runtime
  const mutations = new Map<string, Promise<unknown>>()

  const session = (selector: unknown): TerminalSession => {
    const found = typeof selector === 'string' ? store.get(selector) : undefined
    if (!found) throw new RpcError('not_found', `no session ${String(selector)}`)
    return found
  }

  const worktreeFor = (target: TerminalSession) => catalog.worktreeFor(target)

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
      executionHostId: 'local',
      orphaned: false
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
      env: sessionEnvironment(await loginEnvironment(), name, { ORC_RUNTIME_DIR: store.profile }),
      cols: Number(params.cols ?? 120),
      rows: Number(params.rows ?? 40),
      project: (project ?? projects.containing(cwd))?.id,
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
      desktopWindowStatus: 'unavailable',
      floatingWorkspaceEnabled: false,
      hostPlatform: process.platform
    }),

    'runtime.clientCapabilities.update': (params) => ({ clientCapabilities: Array.isArray(params.clientCapabilities) ? params.clientCapabilities : [] }),

    'worktree.ps': (params) => {
      const worktrees = catalog.worktreeRows()
      if (!('afterSnapshotId' in params)) return { worktrees, totalCount: worktrees.length, truncated: false }
      const snapshotId = catalog.snapshotId(worktrees)
      return params.afterSnapshotId === snapshotId ? { unchanged: true, snapshotId } : { worktrees, totalCount: worktrees.length, truncated: false, snapshotId }
    },

    'worktree.show': (params) => {
      const worktree = catalog.resolveWorktree(String(params.worktree ?? ''))
      if (!worktree) throw new RpcError('selector_not_found', `no workspace ${String(params.worktree)}`)
      return { worktree: { worktreeId: worktree.id, displayName: worktree.name, repo: worktree.project?.displayName ?? worktree.name, path: worktree.path } }
    },

    'worktree.activate': () => ({}),

    'repo.list': () => ({ repos: catalog.repoRows() }),

    'session.tabs.list': (params) => {
      const worktree = catalog.resolveWorktree(String(params.worktree ?? ''))
      if (!worktree) throw new RpcError('selector_not_found', `no workspace ${String(params.worktree)}`)
      return catalog.tabSnapshot(worktree)
    },

    'session.tabs.unsubscribe': (params, context) => {
      const worktree = catalog.resolveWorktree(String(params.worktree ?? ''))
      const unsubscribed = worktree ? subscriptions.cancel(context.connectionId, `tabs:${worktree.id}`) : subscriptions.cancelPrefix(context.connectionId, 'tabs:') > 0
      return { unsubscribed }
    },

    'session.tabs.activate': () => ({}),

    'terminal.setDisplayMode': () => ({}),

    'orchestration.workerTerminalUserInput': () => ({ changed: 0 }),

    'worktree.list': () => {
      const worktrees = projects.list().map((project) => ({ id: projects.worktreeId(project), path: project.path, displayName: project.displayName, hostId: 'local' }))
      return { worktrees, totalCount: worktrees.length, truncated: false }
    },

    'repo.add': async (params) => {
      if (typeof params.path !== 'string') throw new RpcError('invalid_argument', 'path is required')
      const project = await projects.add(params.path)
      catalog.changed()
      return { repo: { id: project.id, path: project.path, displayName: project.displayName } }
    },

    'terminal.list': (params) => {
      const worktree = typeof params.worktree === 'string' ? catalog.resolveWorktree(params.worktree) : undefined
      const terminals = (worktree ? catalog.sessionsIn(worktree.id) : store.list()).map(describe)
      return { terminals, totalCount: terminals.length, truncated: false, visualLayouts: [] }
    },

    'session.tabs.listAll': () => ({
      snapshots: catalog.worktrees().filter((worktree) => catalog.sessionsIn(worktree.id).length > 0).map((worktree) => catalog.tabSnapshot(worktree))
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
      if (!target.connected) return { send: { handle: target.handle, accepted: false, bytesWritten: 0 } }
      if (text) target.input(text)
      if (params.enter) {
        if (text) await new Promise((resolve) => setTimeout(resolve, ENTER_DELAY_MS))
        target.input('\r')
      }
      return { send: { handle: target.handle, accepted: true, bytesWritten: Buffer.byteLength(text) + (params.enter ? 1 : 0) } }
    },

    'terminal.close': async (params) => {
      const target = session(params.terminal)
      await store.end(target)
      return { close: { handle: target.handle } }
    },

    'terminal.agentStatus': (params) => {
      // Orc's activity vocabulary: working, permission or idle.
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

/** Streams served over the WebSocket. */
export function createSessionStreams(runtime: Runtime): Record<string, StreamingHandler> {
  const { catalog, subscriptions } = runtime
  return {
    'session.tabs.subscribe': (params, context, emit) => {
      const worktree = catalog.resolveWorktree(String(params.worktree ?? ''))
      if (!worktree) throw new RpcError('selector_not_found', `no workspace ${String(params.worktree)}`)
      return holdStream(subscriptions, context, `tabs:${worktree.id}`, () => {
        let tabs = ''
        const publish = (type: 'snapshot' | 'updated') => {
          const snapshot = catalog.tabSnapshot(worktree)
          const next = JSON.stringify(snapshot.tabs)
          if (type === 'updated' && next === tabs) return
          tabs = next
          emit({ type, ...snapshot })
        }
        const changed = () => publish('updated')
        catalog.on('changed', changed)
        publish('snapshot')
        return () => catalog.off('changed', changed)
      })
    }
  }
}

import { spawn } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { isAgentKind } from '../agent-hooks.ts'
import { loginEnvironment, resolveExecutable } from '../login-environment.ts'
import type { Projects } from '../projects.ts'
import { RpcError, type CallContext, type Handlers } from '../rpc-server.ts'
import { sessionEnvironment } from '../session-environment.ts'
import type { SessionStore } from '../session-store.ts'
import type { TerminalSession } from '../terminal-session.ts'
import type { Channel } from './bridge.ts'
import { SANDBOXABLE } from './settings.ts'
import type { Sandboxes } from './sandboxes.ts'

const MAX_LINE = 1 << 20

type Runtime = { store: SessionStore; projects: Projects; sandboxes: Sandboxes; handlers: Handlers; profile: string; log: (line: string) => void }

/**
 * What a sandboxed agent's `orc` channel may do. The agent is whoever runs in the machine, so every call
 * acts as that session: messages come from it, wakes and notifications are its own, its children are
 * sandboxed and start only in folders granted to them or to it, and it closes only itself and its children.
 * Anything else is refused.
 */
export function sandboxService(runtime: Runtime): (session: TerminalSession, channel: Channel) => void {
  return (session, channel) => {
    let buffered = ''
    let first = true
    let pending = 0
    let ended = false
    const finish = () => { if (ended && pending === 0 && !channel.writableEnded) channel.end() }
    const context: CallContext = { connectionId: `sandbox-${session.meta.id}-${channel.id}`, scope: 'local', onClose: (handler) => channel.on('close', handler) }
    const onEnd = () => { ended = true; finish() }
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      if (buffered.length > MAX_LINE && !buffered.includes('\n')) return void channel.destroy()
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (!line.trim()) continue
        if (first) {
          first = false
          const mcp = mcpRequest(line)
          if (mcp) {
            // Nothing may flow until the server's streams are piped.
            channel.pause()
            channel.off('data', onData)
            channel.off('end', onEnd)
            void relayMcp(runtime, session, channel, mcp, buffered)
            return
          }
        }
        pending++
        void answer(runtime, session, line, context).then((reply) => {
          if (!channel.writableEnded) channel.write(JSON.stringify(reply) + '\n')
          pending--
          finish()
        })
      }
    }
    channel.on('data', onData)
    channel.on('end', onEnd)
  }
}

function mcpRequest(line: string): string | null {
  try {
    const parsed = JSON.parse(line)
    return typeof parsed?.mcp === 'string' && parsed.mcp ? parsed.mcp : null
  } catch {
    return null
  }
}

async function answer(runtime: Runtime, session: TerminalSession, line: string, context: CallContext): Promise<Record<string, unknown>> {
  let id: unknown = null
  try {
    const request = JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown }
    id = request.id ?? null
    const method = typeof request.method === 'string' ? request.method : ''
    const params = request.params && typeof request.params === 'object' ? request.params as Record<string, any> : {}
    const result = await call(runtime, session, method, params, context)
    return { id, ok: true, result: result ?? {} }
  } catch (error) {
    const code = error instanceof RpcError || (error as { code?: unknown }).code ? String((error as { code: unknown }).code) : 'internal_error'
    return { id, ok: false, error: { code, message: (error as Error).message } }
  }
}

const READ_ONLY = new Set(['status.get', 'agent.list', 'agent.status', 'agent.wait', 'terminal.list', 'pr.list', 'brief.list'])

async function call(runtime: Runtime, session: TerminalSession, method: string, params: Record<string, any>, context: CallContext): Promise<unknown> {
  const self = session.meta.name
  const handler = runtime.handlers[method]
  if (!handler) throw new RpcError('method_not_found', `${method} is not available to sandboxed agents`)
  const own = (name: unknown) => {
    if (typeof name !== 'string' || !isSelfOrChild(runtime.store, self, name)) throw new RpcError('forbidden', `${self} can act only for itself and the agents it started`)
  }
  if (READ_ONLY.has(method)) return handler(params, context)
  switch (method) {
    case 'agent.send':
      return handler({ ...params, from: self }, context)
    case 'wake.create':
    case 'wake.list':
    case 'wake.cancel':
    case 'notify.post':
      return handler({ ...params, name: self }, context)
    case 'terminal.close':
      own(runtime.store.get(String(params.terminal ?? ''))?.meta.name)
      return handler(params, context)
    case 'pr.watch':
    case 'pr.unwatch':
    case 'brief.refresh':
    case 'brief.dismiss':
      own(params.name)
      return handler(params, context)
    case 'agent.spawn':
      return handler(await childSpawn(runtime, session, params), context)
    default:
      throw new RpcError('method_not_found', `${method} is not available to sandboxed agents`)
  }
}

/** A child of a sandboxed agent is sandboxed, starts in a folder granted to it or to its parent, and is the parent's. */
async function childSpawn(runtime: Runtime, session: TerminalSession, params: Record<string, any>): Promise<Record<string, any>> {
  const kind = params.agent
  if (!isAgentKind(kind) || !SANDBOXABLE.includes(kind)) throw new RpcError('forbidden', `a sandboxed agent can start only sandboxed agents: ${SANDBOXABLE.join(', ')}`)
  const name = typeof params.name === 'string' ? params.name : ''
  const project = typeof params.project === 'string' ? runtime.projects.resolve(params.project) : undefined
  if (params.project && !project) throw new RpcError('not_found', `no project ${params.project}`)
  const folder = project?.path ?? (typeof params.cwd === 'string' ? params.cwd : '')
  if (!folder) throw new RpcError('invalid_argument', 'choose a project or a working directory')
  const allowed = [...await runtime.sandboxes.grants(name), ...await runtime.sandboxes.grants(session.meta.name), session.meta.cwd]
  const real = await realpath(folder).catch(() => resolve(folder))
  if (!allowed.some((granted) => inside(real, granted) || inside(resolve(folder), granted))) {
    throw new RpcError('forbidden', `${folder} is not granted to ${name || 'the new agent'} or to ${session.meta.name}; a grant from the Mac (orc sandbox grant) gives it`)
  }
  return { ...params, parent: session.meta.name, sandbox: true }
}

function isSelfOrChild(store: SessionStore, self: string, name: string): boolean {
  for (let current: string | undefined = name, hops = 0; current && hops < 32; hops++) {
    if (current === self) return true
    current = store.get(current)?.meta.parent
  }
  return false
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * Runs one of the user's or the session folder's stdio MCP servers (from `~/.claude.json`) on the Mac for the agent, as Claude
 * would, with `ORC_SESSION_NAME` set to the agent's name, and carries its standard streams over the channel.
 */
async function relayMcp(runtime: Runtime, session: TerminalSession, channel: Channel, name: string, pending: string): Promise<void> {
  const claude = await readFile(resolve(homedir(), '.claude.json'), 'utf8').then(JSON.parse, () => ({}))
  const folder = await realpath(session.meta.cwd).catch(() => session.meta.cwd)
  // A server of the session's folder comes before the user's own of the same name, as in Claude.
  const server = claude?.projects?.[folder]?.mcpServers?.[name] ?? claude?.mcpServers?.[name]
  if (!server || typeof server.command !== 'string') {
    runtime.log(`${session.meta.name} asked for MCP server ${name}, which is not a stdio server in ~/.claude.json`)
    return void channel.end()
  }
  const login = await loginEnvironment()
  const env = { ...sessionEnvironment(login, session.meta.name, { ORC_RUNTIME_DIR: runtime.profile }), ...(server.env ?? {}) }
  env.ORC_SESSION_NAME = session.meta.name
  const command = resolveExecutable(server.command, login) ?? server.command
  const args = Array.isArray(server.args) ? server.args.map(String) : []
  const child = spawn(command, args, { cwd: typeof server.cwd === 'string' ? server.cwd : session.meta.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.on('error', (error) => { runtime.log(`MCP server ${name} for ${session.meta.name}: ${error.message}`); channel.end() })
  child.stderr!.on('data', () => {})
  child.stdin!.on('error', () => {})
  if (pending) child.stdin!.write(pending)
  channel.pipe(child.stdin!)
  child.stdout!.pipe(channel)
  channel.on('close', () => child.kill('SIGTERM'))
  child.on('exit', () => channel.end())
}

import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { callerArguments, isAgentKind, type AgentKind, type ProviderSession } from './agent-hooks.ts'
import type { AgentDirectory } from './agents.ts'
import { createTerminal, write } from './emulator.ts'
import { loginEnvironment } from './login-environment.ts'
import type { Projects } from './projects.ts'
import { RpcError } from './rpc-server.ts'
import { sessionEnvironment } from './session-environment.ts'
import type { SessionStore } from './session-store.ts'
import type { SessionMeta, TerminalSession } from './terminal-session.ts'

const RECENT_MS = 7 * 86_400_000
const RETAIN_MS = 30 * 86_400_000
const PRUNE_EVERY_MS = 86_400_000
const MESSAGE_CHARS = 4000

type Runtime = { store: SessionStore; agents: AgentDirectory; projects: Projects }

/** A finished session, kept in `<profile>/ended/ENTRY/`. `reopened` marks one that was started again. */
export type EndedSession = { entry: string; dir: string; meta: SessionMeta; endedAt: number; reopened: boolean }

type AgentMeta = SessionMeta & { agent: AgentKind; events: string }

/** Every ended session whose records are readable. */
export async function endedSessions(store: SessionStore): Promise<EndedSession[]> {
  const ended: EndedSession[] = []
  for (const entry of await readdir(store.endedDir).catch(() => [] as string[])) {
    const dir = join(store.endedDir, entry)
    const endedAt = Date.parse((await readJson(join(dir, 'retired.json')))?.retiredAt ?? '')
    const meta = await readJson(join(dir, 'meta.json')) as SessionMeta | null
    if (!Number.isFinite(endedAt) || !meta?.name || !Array.isArray(meta.argv)) continue
    ended.push({ entry, dir, meta, endedAt, reopened: await exists(join(dir, 'reopened.json')) })
  }
  return ended.sort((left, right) => right.endedAt - left.endedAt)
}

/** The most recent ended session of each name. */
export function latestByName(ended: EndedSession[]): EndedSession[] {
  const latest = new Map<string, EndedSession>()
  for (const session of ended) {
    if ((latest.get(session.meta.name)?.endedAt ?? -Infinity) < session.endedAt) latest.set(session.meta.name, session)
  }
  return [...latest.values()]
}

/**
 * Starts an ended session again as `name`: an agent continues its conversation with its undelivered
 * messages and wakes, and a login shell starts in the same directory. Returns null for a session
 * that ran any other command.
 */
export async function startAgain(runtime: Runtime, ended: EndedSession, name = ended.meta.name): Promise<TerminalSession | null> {
  const { store, agents, projects } = runtime
  const { meta, dir } = ended
  const project = meta.project ? projects.resolve(`id:${meta.project}`) : undefined
  let session: TerminalSession
  if (isAgentMeta(meta)) {
    session = await agents.launch({
      agent: meta.agent, name, cwd: meta.cwd, project: project && `id:${project.id}`, parent: meta.parent,
      args: callerArguments(meta.agent, meta.argv), resume: (await agentRecord(meta)).conversation,
      files: [join(dir, 'queue.json'), join(dir, 'wakes.json')]
    })
  } else if (meta.argv.length === 2 && meta.argv[1] === '-l') {
    session = await store.create({
      name, cwd: meta.cwd, argv: meta.argv, cols: 120, rows: 40,
      env: sessionEnvironment(await loginEnvironment(), name, { ORC_RUNTIME_DIR: store.profile }),
      project: (project ?? projects.containing(meta.cwd))?.id, parent: meta.parent
    })
  } else {
    return null
  }
  await writeFile(join(dir, 'reopened.json'), JSON.stringify({ reopenedAt: new Date().toISOString(), name }), { mode: 0o600 }).catch(() => {})
  return session
}

/**
 * Recently closed agent sessions: those that ended in the last 7 days, were not started again, can
 * resume a conversation, and whose name is not running again. Ended sessions are deleted 30 days
 * after they end, with their agent events.
 */
export class SessionHistory {
  private readonly runtime: Runtime
  private readonly screens = new Map<string, Promise<string[]>>()

  constructor(runtime: Runtime) {
    this.runtime = runtime
    void this.prune()
    setInterval(() => void this.prune(), PRUNE_EVERY_MS).unref()
  }

  async list(): Promise<Record<string, unknown>[]> {
    return Promise.all((await this.closed()).map(async ({ session, record }) => ({
      entry: session.entry,
      name: session.meta.name,
      agent: session.meta.agent,
      cwd: session.meta.cwd,
      ...(session.meta.project ? { project: session.meta.project } : {}),
      ...(session.meta.parent ? { parent: session.meta.parent } : {}),
      closedAt: new Date(session.endedAt).toISOString(),
      conversation: record.conversation,
      ...(record.lastMessage ? { lastMessage: record.lastMessage } : {}),
      screen: await this.screen(session)
    })))
  }

  /** Starts a recently closed agent session again, by entry or by name, as `as` or its own name. */
  async reopen(selector: { entry?: string; name?: string }, as?: string): Promise<Record<string, unknown>> {
    const closed = await this.closed()
    const match = closed.find(({ session }) => selector.entry ? session.entry === selector.entry : session.meta.name === selector.name)
    if (!match) throw new RpcError('not_found', `no recently closed agent session ${selector.entry ?? selector.name ?? ''}`)
    const name = as ?? match.session.meta.name
    if (this.runtime.store.get(name)) throw new RpcError('name_taken', `a session named ${name} is running; reopen it under another name`)
    const session = await startAgain(this.runtime, match.session, name)
    return { handle: session!.handle, name: session!.meta.name, agent: session!.meta.agent }
  }

  private async closed(): Promise<{ session: EndedSession; record: Awaited<ReturnType<typeof agentRecord>> }[]> {
    const since = Date.now() - RECENT_MS
    const candidates = latestByName(await endedSessions(this.runtime.store))
      .filter((session) => session.endedAt >= since && !session.reopened && isAgentMeta(session.meta) && !this.runtime.store.get(session.meta.name))
    const closed = await Promise.all(candidates.map(async (session) => ({ session, record: await agentRecord(session.meta as AgentMeta) })))
    return closed.filter(({ record }) => record.conversation.id || record.conversation.transcriptPath)
      .sort((left, right) => right.session.endedAt - left.session.endedAt)
  }

  /** The non-blank lines of the session's last screen. */
  private screen(session: EndedSession): Promise<string[]> {
    let screen = this.screens.get(session.entry)
    if (!screen) {
      screen = lastScreen(session.dir)
      this.screens.set(session.entry, screen)
    }
    return screen
  }

  private async prune(): Promise<void> {
    const { store } = this.runtime
    const cutoff = Date.now() - RETAIN_MS
    const live = new Set(store.list().map((session) => session.meta.events).filter(Boolean))
    for (const entry of await readdir(store.endedDir).catch(() => [] as string[])) {
      const dir = join(store.endedDir, entry)
      const endedAt = Date.parse((await readJson(join(dir, 'retired.json')))?.retiredAt ?? '') || (await stat(dir).catch(() => null))?.mtimeMs
      if (!endedAt || endedAt >= cutoff) continue
      const events = (await readJson(join(dir, 'meta.json')))?.events
      if (typeof events === 'string' && events.startsWith(join(store.profile, 'agent-events')) && !live.has(events)) await rm(events, { force: true })
      await rm(dir, { recursive: true, force: true })
      this.screens.delete(entry)
    }
  }
}

function isAgentMeta(meta: SessionMeta): meta is AgentMeta {
  return isAgentKind(meta.agent) && typeof meta.events === 'string'
}

/**
 * The conversation an agent session last reported and its last reply. A session whose agent never
 * reported one, such as a resume that failed at startup, is resuming the conversation named in its argv.
 */
async function agentRecord(meta: AgentMeta): Promise<{ conversation: ProviderSession; lastMessage?: string }> {
  const conversation: ProviderSession = {}
  let lastMessage: string | undefined
  for (const line of (await readFile(meta.events, 'utf8').catch(() => '')).split('\n')) {
    try {
      const payload = JSON.parse(line)?.payload
      if (typeof payload?.session_id === 'string') conversation.id = payload.session_id
      if (typeof payload?.transcript_path === 'string') conversation.transcriptPath = payload.transcript_path
      if (typeof payload?.last_assistant_message === 'string') lastMessage = payload.last_assistant_message.slice(0, MESSAGE_CHARS)
    } catch {}
  }
  if (!conversation.id && !conversation.transcriptPath) {
    const flag = meta.agent === 'codex' ? 'resume' : meta.agent === 'claude' ? '--resume' : '--session'
    const value = meta.argv[meta.argv.indexOf(flag) + 1]
    if (meta.argv.includes(flag) && value && !value.startsWith('-')) {
      if (meta.agent === 'pi' && value.includes('/')) conversation.transcriptPath = value
      else conversation.id = value
    }
  }
  return { conversation, ...(lastMessage ? { lastMessage } : {}) }
}

async function lastScreen(dir: string): Promise<string[]> {
  const checkpoint = await readJson(join(dir, 'checkpoint.json'))
  if (typeof checkpoint?.serialized !== 'string') return []
  const { term } = createTerminal(checkpoint.cols ?? 120, checkpoint.rows ?? 40)
  try {
    await write(term, checkpoint.serialized)
    const buffer = term.buffer.active
    const lines: string[] = []
    for (let y = buffer.baseY; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
    return lines.filter((line) => line.trim())
  } finally {
    term.dispose()
  }
}

function readJson(path: string): Promise<any> {
  return readFile(path, 'utf8').then(JSON.parse, () => null)
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

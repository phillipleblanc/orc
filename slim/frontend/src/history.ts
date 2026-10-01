import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { callerArguments, isAgentKind, resumedConversation, type AgentKind, type ProviderSession } from './agent-hooks.ts'
import type { AgentDirectory } from './agents.ts'
import type { Conversation, ConversationIndex } from './conversations.ts'
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
const SEARCH_LIMIT = 50
// A conversation can be named by a prefix of its id this long or longer.
const ID_PREFIX_CHARS = 6

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
 * after they end, with their agent events. Also every agent conversation, from the agents' own
 * histories, to search and open.
 */
export class SessionHistory {
  private readonly runtime: Runtime
  private readonly index: ConversationIndex
  private readonly screens = new Map<string, Promise<string[]>>()

  constructor(runtime: Runtime, index: ConversationIndex) {
    this.runtime = runtime
    this.index = index
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

  /**
   * Conversations whose words include every word of `query`, most recently updated first, in a
   * registered project unless `allProjects`. Conversations of recently closed sessions are listed
   * as those sessions instead. `openIn` names the running session that has the conversation open.
   */
  async conversations(query = '', allProjects = false, limit = SEARCH_LIMIT): Promise<Record<string, unknown>[]> {
    const { projects } = this.runtime
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const closed = (await this.closed()).map(({ session, record }) => ({ agent: session.meta.agent as AgentKind, conversation: record.conversation }))
    const results: Record<string, unknown>[] = []
    for (const conversation of await this.index.all()) {
      if (results.length >= limit) break
      const project = projects.containing(conversation.cwd)
      if (!allProjects && !project) continue
      if (closed.some((session) => sameConversation(conversation, session.agent, session.conversation))) continue
      const words = [conversation.title, conversation.firstPrompt, conversation.lastMessage, conversation.cwd, conversation.agent, conversation.id].join('\n').toLowerCase()
      if (!terms.every((term) => words.includes(term))) continue
      const openIn = this.openIn(conversation)
      results.push({
        ...conversation, updatedAt: new Date(conversation.updatedAt).toISOString(),
        ...(project ? { project: project.id } : {}), ...(openIn ? { openIn } : {})
      })
    }
    return results
  }

  /**
   * Starts a recently closed agent session again, by entry or by name, as `as` or its own name; or
   * opens a conversation by id or id prefix, which a name that matches no closed session also tries.
   */
  async reopen(selector: { entry?: string; name?: string; conversation?: string }, as?: string): Promise<Record<string, unknown>> {
    if (selector.conversation) return this.open(selector.conversation, as)
    const closed = await this.closed()
    const match = closed.find(({ session }) => selector.entry ? session.entry === selector.entry : session.meta.name === selector.name)
    if (!match && selector.name) return this.open(selector.name, as, `no recently closed agent session or conversation ${selector.name}`)
    if (!match) throw new RpcError('not_found', `no recently closed agent session ${selector.entry ?? ''}`)
    const name = as ?? match.session.meta.name
    if (this.runtime.store.get(name)) throw new RpcError('name_taken', `a session named ${name} is running; reopen it under another name`)
    const session = await startAgain(this.runtime, match.session, name)
    return { handle: session!.handle, name: session!.meta.name, agent: session!.meta.agent }
  }

  /**
   * Opens a conversation in a new session in its folder, named after its title unless `as`. A
   * conversation that a running session has open is not opened twice: that session is returned. One
   * that belongs to a recently closed session reopens that session.
   */
  private async open(selector: string, as?: string, missing = `no conversation ${selector}`): Promise<Record<string, unknown>> {
    const all = await this.index.all()
    let matches = all.filter((conversation) => conversation.id === selector)
    if (!matches.length && selector.length >= ID_PREFIX_CHARS) matches = all.filter((conversation) => conversation.id.startsWith(selector))
    if (!matches.length) throw new RpcError('not_found', missing)
    if (matches.length > 1) throw new RpcError('invalid_argument', `${selector} matches ${matches.length} conversations; give more of its id`)
    const [conversation] = matches
    const { store, agents } = this.runtime
    const openIn = this.openIn(conversation)
    if (openIn) return { handle: store.get(openIn)!.handle, name: openIn, agent: conversation.agent, alreadyOpen: true }
    const closed = (await this.closed()).find(({ session, record }) => sameConversation(conversation, session.meta.agent as AgentKind, record.conversation))
    if (closed) return this.reopen({ entry: closed.session.entry }, as)
    if (!(await stat(conversation.cwd).then((info) => info.isDirectory(), () => false))) {
      throw new RpcError('not_found', `the conversation's folder ${conversation.cwd} no longer exists`)
    }
    if (as && store.get(as)) throw new RpcError('name_taken', `a session named ${as} is running; choose another name`)
    const session = await agents.launch({
      agent: conversation.agent, name: as ?? this.nameFor(conversation), cwd: conversation.cwd,
      resume: { id: conversation.id, transcriptPath: conversation.transcriptPath }
    })
    return { handle: session.handle, name: session.meta.name, agent: conversation.agent }
  }

  private openIn(conversation: Conversation): string | undefined {
    return this.runtime.agents.conversations().find((live) => sameConversation(conversation, live.agent, live.conversation))?.name
  }

  /** A session name from the conversation's title or first prompt, unique among running sessions. */
  private nameFor(conversation: Conversation): string {
    const words = (conversation.title ?? conversation.firstPrompt ?? '').normalize('NFKD').toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 4)
    const base = words.join('-').slice(0, 40).replace(/-+$/, '') || `${conversation.agent}-${conversation.id.slice(0, 8)}`
    let name = base
    for (let suffix = 2; this.runtime.store.get(name); suffix++) name = `${base}-${suffix}`
    return name
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

function sameConversation(conversation: Conversation, agent: AgentKind, other: ProviderSession): boolean {
  return conversation.agent === agent && ((Boolean(other.id) && other.id === conversation.id)
    || (Boolean(other.transcriptPath) && other.transcriptPath === conversation.transcriptPath))
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
  const resumed = conversation.id || conversation.transcriptPath ? conversation : resumedConversation(meta.agent, meta.argv)
  return { conversation: resumed, ...(lastMessage ? { lastMessage } : {}) }
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

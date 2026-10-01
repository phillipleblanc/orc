import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { AgentKind } from './agent-hooks.ts'
import { writeJsonFile } from './json-file.ts'
import { loginEnvironment } from './login-environment.ts'

/** One agent conversation, as the agent itself stored it. */
export type Conversation = {
  agent: AgentKind
  id: string
  transcriptPath: string
  cwd: string
  title?: string
  firstPrompt?: string
  lastMessage?: string
  updatedAt: number
}

type Cached = { mtimeMs: number; size: number; parsed: Parsed | null }

// Transcripts are read only at their start and end: the start holds the folder and first prompt,
// the end the latest title and reply.
const EDGE_BYTES = 256 * 1024
const PROMPT_CHARS = 300
const MESSAGE_CHARS = 1500
const CACHE_VERSION = 2

/**
 * Conversations from Codex, Claude and Pi's own histories, including ones started outside Orc. A
 * conversation without a prompt from a person is left out. Parsed transcripts are cached in
 * `<profile>/conversations.json` by size and modification time, so only new or changed transcripts
 * are read again.
 */
export class ConversationIndex {
  private readonly cachePath: string
  private cache: Map<string, Cached> | null = null
  private refreshing: Promise<Conversation[]> | null = null

  constructor(profile: string) {
    this.cachePath = join(profile, 'conversations.json')
  }

  /** Every conversation, most recently updated first. */
  all(): Promise<Conversation[]> {
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = null })
    return this.refreshing
  }

  private async refresh(): Promise<Conversation[]> {
    if (!this.cache) {
      const saved = await readFile(this.cachePath, 'utf8').then(JSON.parse, () => null)
      this.cache = new Map(saved?.version === CACHE_VERSION ? Object.entries(saved.files) as [string, Cached][] : [])
    }
    const cache = this.cache
    const env = await loginEnvironment()
    const codexHome = env.CODEX_HOME || join(homedir(), '.codex')
    const claudeHome = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    const piSessions = env.PI_CODING_AGENT_SESSION_DIR || join(env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'sessions')
    const codexTitles = await readCodexTitles(join(codexHome, 'session_index.jsonl'))
    const files: [AgentKind, string][] = [
      ...(await transcripts(join(codexHome, 'sessions'), true)).map((path) => ['codex', path] as [AgentKind, string]),
      ...(await transcripts(join(claudeHome, 'projects'), false, 1)).map((path) => ['claude', path] as [AgentKind, string]),
      ...(await transcripts(piSessions, false, 1)).map((path) => ['pi', path] as [AgentKind, string])
    ]
    const seen = new Set<string>()
    let changed = false
    for (const [agent, path] of files) {
      seen.add(path)
      const info = await stat(path).catch(() => null)
      if (!info) continue
      const cached = cache.get(path)
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) continue
      cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, parsed: await parse(agent, path, info.size).catch(() => null) })
      changed = true
    }
    for (const path of cache.keys()) {
      if (!seen.has(path)) { cache.delete(path); changed = true }
    }
    if (changed) await writeJsonFile(this.cachePath, { version: CACHE_VERSION, files: Object.fromEntries(cache) }).catch(() => {})

    const conversations: Conversation[] = []
    for (const [agent, path] of files) {
      const entry = cache.get(path)
      const parsed = entry?.parsed
      if (!entry || !parsed?.id || !parsed.cwd || !parsed.firstPrompt) continue
      const title = agent === 'codex' ? codexTitles.get(parsed.id) ?? parsed.title : parsed.title
      conversations.push(conversation(agent, path, { ...parsed, title }, entry.mtimeMs))
    }
    // A Codex thread can span several transcripts; the latest one represents it.
    const byId = new Map<string, Conversation>()
    for (const item of conversations) {
      const key = `${item.agent}:${item.id}`
      if ((byId.get(key)?.updatedAt ?? -Infinity) < item.updatedAt) byId.set(key, item)
    }
    return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt)
  }
}

function conversation(agent: AgentKind, path: string, parsed: Parsed, updatedAt: number): Conversation {
  return {
    agent, transcriptPath: path, updatedAt, id: parsed.id!, cwd: parsed.cwd!,
    ...(parsed.title ? { title: parsed.title } : {}),
    firstPrompt: clip(parsed.firstPrompt!, PROMPT_CHARS),
    ...(parsed.lastMessage ? { lastMessage: clip(parsed.lastMessage, MESSAGE_CHARS) } : {})
  }
}

/** `.jsonl` files under `root`: all of them, or only those `depth` directories down. */
async function transcripts(root: string, recursive: boolean, depth = 0): Promise<string[]> {
  if (recursive) {
    const entries = await readdir(root, { recursive: true }).catch(() => [] as string[])
    return entries.filter((entry) => entry.endsWith('.jsonl')).map((entry) => join(root, entry))
  }
  if (depth === 0) return (await readdir(root).catch(() => [] as string[])).filter((entry) => entry.endsWith('.jsonl')).map((entry) => join(root, entry))
  const nested = await Promise.all((await readdir(root).catch(() => [] as string[])).map((entry) => transcripts(join(root, entry), false, depth - 1)))
  return nested.flat()
}

async function readCodexTitles(path: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  for (const line of (await readFile(path, 'utf8').catch(() => '')).split('\n')) {
    try {
      const entry = JSON.parse(line)
      if (typeof entry?.id === 'string' && typeof entry.thread_name === 'string' && entry.thread_name) titles.set(entry.id, entry.thread_name)
    } catch {}
  }
  return titles
}

/** The complete JSON lines at the start and end of a transcript, without reading its middle. */
async function edges(path: string, size: number): Promise<{ head: any[]; tail: any[] }> {
  const file = await open(path, 'r')
  try {
    const read = async (position: number, length: number) => {
      const { buffer, bytesRead } = await file.read(Buffer.alloc(length), 0, length, position)
      return buffer.subarray(0, bytesRead).toString('utf8')
    }
    const parse = (lines: string[]) => lines.flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
    if (size <= 2 * EDGE_BYTES) {
      const all = parse((await read(0, size)).split('\n'))
      return { head: all, tail: all }
    }
    const head = (await read(0, EDGE_BYTES)).split('\n')
    head.pop()
    const tail = (await read(size - EDGE_BYTES, EDGE_BYTES)).split('\n')
    tail.shift()
    return { head: parse(head), tail: parse(tail) }
  } finally {
    await file.close()
  }
}

async function parse(agent: AgentKind, path: string, size: number): Promise<Parsed | null> {
  const { head, tail } = await edges(path, size)
  const parsed = agent === 'codex' ? parseCodex(head, tail) : agent === 'claude' ? parseClaude(path, head, tail) : parsePi(head, tail)
  return parsed && {
    ...parsed,
    ...(parsed.firstPrompt ? { firstPrompt: clip(parsed.firstPrompt, PROMPT_CHARS) } : {}),
    ...(parsed.lastMessage ? { lastMessage: clip(parsed.lastMessage, MESSAGE_CHARS) } : {})
  }
}

type Parsed = { id?: string; cwd?: string; title?: string; firstPrompt?: string; lastMessage?: string }

/** Only conversations a person started; reviewer, subagent and voice threads are left out. */
function parseCodex(head: any[], tail: any[]): Parsed | null {
  const meta = head[0]?.type === 'session_meta' ? head[0].payload : null
  if (!meta || (meta.thread_source != null && meta.thread_source !== 'user')) return null
  const message = (line: any, role: string) => line?.type === 'response_item' && line.payload?.type === 'message' && line.payload.role === role
    ? text(line.payload.content) : undefined
  return {
    id: meta.id, cwd: meta.cwd,
    firstPrompt: head.map((line) => message(line, 'user')).find((value) => value && !injected(value)),
    lastMessage: last(tail.map((line) => message(line, 'assistant')))
  }
}

function parseClaude(path: string, head: any[], tail: any[]): Parsed | null {
  const own = (line: any) => !line?.isSidechain
  const prompt = (line: any) => line?.type === 'user' && own(line) && !line.isMeta ? text(line.message?.content) : undefined
  const reply = (line: any) => line?.type === 'assistant' && own(line) ? text(line.message?.content) : undefined
  const lines = [...head, ...tail]
  return {
    id: basename(path, '.jsonl'),
    cwd: lines.find((line) => typeof line?.cwd === 'string')?.cwd,
    title: last(lines.map((line) => line?.type === 'custom-title' ? line.customTitle : undefined))
      ?? last(lines.map((line) => line?.type === 'ai-title' ? line.aiTitle : undefined)),
    firstPrompt: head.map(prompt).find((value) => value && !injected(value)),
    lastMessage: last(tail.map(reply))
  }
}

function parsePi(head: any[], tail: any[]): Parsed | null {
  const session = head[0]?.type === 'session' ? head[0] : null
  if (!session) return null
  const message = (line: any, role: string) => line?.type === 'message' && line.message?.role === role ? text(line.message.content) : undefined
  return {
    id: session.id, cwd: session.cwd,
    title: last([...head, ...tail].map((line) => line?.type === 'session_info' ? line.name : undefined)),
    firstPrompt: head.map((line) => message(line, 'user')).find(Boolean),
    lastMessage: last(tail.map((line) => message(line, 'assistant')))
  }
}

/** The text of a message's content, whether a string or a list of blocks. */
function text(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined
  if (!Array.isArray(content)) return undefined
  const joined = content.filter((block) => typeof block?.text === 'string' && block.type !== 'thinking').map((block) => block.text).join('\n').trim()
  return joined || undefined
}

/** Instructions and context an agent adds to the conversation as user messages. */
function injected(value: string): boolean {
  return value.startsWith('<') || value.startsWith('# AGENTS.md instructions')
}

function last<T>(values: (T | undefined)[]): T | undefined {
  for (let index = values.length - 1; index >= 0; index--) if (values[index] !== undefined && values[index] !== '') return values[index]
  return undefined
}

function clip(value: string, chars: number): string {
  return value.length > chars ? `${value.slice(0, chars - 1)}…` : value
}

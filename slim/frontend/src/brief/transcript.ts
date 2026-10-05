import { open, stat } from 'node:fs/promises'
import type { AgentKind } from '../agent-hooks.ts'

// What a status brief is written from: an agent's latest summary of its own conversation (written when it
// compacted its context) and a condensed log of what followed, from the transcript the agent itself keeps.

export type DigestItem = { role: 'user' | 'assistant' | 'tool' | 'result' | 'error'; text: string }

export type Digest = {
  /** The agent's latest summary of the conversation before `items`, or the requests it kept when compacting. */
  summary?: string
  /** The conversation's first request, when there is no summary. */
  firstPrompt?: string
  /** The conversation since the summary, oldest first; the oldest are left out beyond the log's budget. */
  items: DigestItem[]
  /** Whether older items were left out. */
  truncated: boolean
}

/** The log keeps the newest items up to this many characters, about 30k tokens. */
export const LOG_CHARS = 120_000
const SUMMARY_CHARS = 40_000
const LIMITS: Record<DigestItem['role'], number> = { user: 2000, assistant: 1500, tool: 300, result: 400, error: 600 }
const CHUNK = 1 << 20

export function clip(text: string, limit: number): string {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)} … [${trimmed.length - limit} more characters]` : trimmed
}

function item(role: DigestItem['role'], text: string | undefined): DigestItem[] {
  const clipped = clip(text ?? '', LIMITS[role])
  return clipped ? [{ role, text: clipped }] : []
}

/** Text blocks of a message's content, whether a string or a list of blocks. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => typeof block?.text === 'string' && block.type !== 'thinking').map((block) => block.text).join('\n')
}

function json(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? {})
}

/** Instructions and context agents add to the conversation as user messages. */
function injected(text: string): boolean {
  const start = text.trimStart()
  return /^<[a-z_-]+>/i.test(start) || start.startsWith('# AGENTS.md instructions') || start.startsWith('Caveat:')
}

/** The file's lines from the last to the first, read in chunks from its end. A partial last line is yielded too. */
export async function* linesFromEnd(path: string): AsyncGenerator<string> {
  const handle = await open(path, 'r')
  try {
    let position = (await handle.stat()).size
    let carry = Buffer.alloc(0)
    while (position > 0) {
      const length = Math.min(CHUNK, position)
      position -= length
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, position)
      const data = carry.length ? Buffer.concat([buffer, carry]) : buffer
      let end = data.length
      for (let index = data.length - 1; index >= 0; index--) {
        if (data[index] !== 10) continue
        if (end > index + 1) yield data.subarray(index + 1, end).toString('utf8')
        end = index
      }
      carry = data.subarray(0, end)
    }
    if (carry.length) yield carry.toString('utf8')
  } finally {
    await handle.close()
  }
}

/** Collects items newest first within the log's budget, and reports when they are full. */
class Collector {
  private readonly groups: DigestItem[][] = []
  private chars = 0
  truncated = false
  /** Adds one entry's items, newest entry first. */
  add(items: DigestItem[]): void {
    if (this.truncated || items.length === 0) return
    const size = items.reduce((total, entry) => total + entry.text.length, 0)
    if (this.chars + size > LOG_CHARS && this.groups.length > 0) {
      this.truncated = true
      return
    }
    this.chars += size
    this.groups.push(items)
  }
  items(): DigestItem[] {
    return this.groups.reverse().flat()
  }
}

function parse(line: string): any {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/** The first request of the conversation, from the start of the transcript. */
async function firstPrompt(path: string, pick: (line: any) => string | undefined): Promise<string | undefined> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(512 * 1024, (await handle.stat()).size))
    await handle.read(buffer, 0, buffer.length, 0)
    for (const line of buffer.toString('utf8').split('\n')) {
      const text = pick(parse(line))
      if (text && !injected(text)) return clip(text, LIMITS.user * 2)
    }
  } finally {
    await handle.close()
  }
  return undefined
}

function piItems(message: any): DigestItem[] {
  if (message?.role === 'user') return item('user', textOf(message.content))
  if (message?.role === 'toolResult') return item(message.isError ? 'error' : 'result', textOf(message.content))
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return []
  return message.content.flatMap((block: any) =>
    block?.type === 'text' ? item('assistant', block.text) : block?.type === 'toolCall' ? item('tool', `${block.name} ${json(block.arguments)}`) : [])
}

/**
 * A Pi session: a tree of entries, read along the active branch from its newest entry back to the latest
 * compaction, whose summary is Pi's own account of the conversation before it.
 */
async function piDigest(path: string): Promise<Digest> {
  const collector = new Collector()
  let wanted: string | undefined
  let summary: string | undefined
  for await (const line of linesFromEnd(path)) {
    // Past the log's budget only the compaction is still wanted, so other lines are not parsed.
    if (collector.truncated && !line.includes('"type":"compaction"') && !line.includes('"type":"branch_summary"')) continue
    const entry = parse(line)
    if (!entry?.id || entry.type === 'session') continue
    wanted ??= entry.id
    if (entry.id !== wanted && !collector.truncated) continue
    wanted = entry.parentId
    if (entry.type === 'compaction') {
      summary = entry.summary
      break
    }
    if (entry.type === 'branch_summary') collector.add(item('assistant', `(summary of an abandoned branch) ${entry.summary ?? ''}`))
    else if (entry.type === 'message') collector.add(piItems(entry.message))
    if (!wanted) break
  }
  return finish(collector, summary, () => firstPrompt(path, (line) => line?.type === 'message' && line.message?.role === 'user' ? textOf(line.message.content) : undefined))
}

function claudeItems(line: any): DigestItem[] {
  const content = line.message?.content
  if (line.type === 'user') {
    if (line.isMeta) return []
    if (typeof content === 'string') return injected(content) ? [] : item('user', content)
    return (Array.isArray(content) ? content : []).flatMap((block: any) =>
      block?.type === 'tool_result' ? item(block.is_error ? 'error' : 'result', textOf(block.content))
        : block?.type === 'text' && !injected(block.text) ? item('user', block.text) : [])
  }
  if (line.type !== 'assistant' || !Array.isArray(content)) return []
  return content.flatMap((block: any) =>
    block?.type === 'text' ? item('assistant', block.text) : block?.type === 'tool_use' ? item('tool', `${block.name} ${json(block.input)}`) : [])
}

/**
 * A Claude Code transcript: a tree of lines, read along the chain from its newest message back to the
 * summary Claude wrote when it compacted, skipping subagents' sidechains.
 */
async function claudeDigest(path: string): Promise<Digest> {
  const collector = new Collector()
  let wanted: string | undefined
  let summary: string | undefined
  for await (const line of linesFromEnd(path)) {
    if (collector.truncated && !line.includes('"isCompactSummary":true')) continue
    const entry = parse(line)
    if (!entry?.uuid || entry.isSidechain) continue
    if (wanted === undefined) {
      if (entry.type !== 'user' && entry.type !== 'assistant') continue
      wanted = entry.uuid
    }
    if (entry.uuid !== wanted && !collector.truncated) continue
    wanted = entry.parentUuid ?? undefined
    if (entry.isCompactSummary) {
      summary = textOf(entry.message?.content)
      break
    }
    collector.add(claudeItems(entry))
    if (!wanted) break
  }
  return finish(collector, summary, () => firstPrompt(path, (line) => line?.type === 'user' && !line.isMeta && !line.isSidechain ? textOf(line.message?.content) : undefined))
}

function codexItems(payload: any): DigestItem[] {
  switch (payload?.type) {
    case 'message': {
      const text = textOf(payload.content)
      if (payload.role === 'user') return injected(text) ? [] : item('user', text)
      return payload.role === 'assistant' ? item('assistant', text) : []
    }
    case 'function_call': return item('tool', `${payload.name} ${json(payload.arguments)}`)
    case 'custom_tool_call': return item('tool', `${payload.name} ${json(payload.input)}`)
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const output = payload.output
      return item('result', typeof output === 'string' ? output : Array.isArray(output) ? textOf(output) : textOf(output?.content) || json(output))
    }
    default: return []
  }
}

/** A Codex rollout: one line per item, read back to its latest compaction, which keeps the conversation's requests. */
async function codexDigest(path: string): Promise<Digest> {
  const collector = new Collector()
  let summary: string | undefined
  for await (const line of linesFromEnd(path)) {
    if (collector.truncated && !line.includes('"type":"compacted"')) continue
    const entry = parse(line)
    if (entry?.type === 'compacted') {
      const retained = entry.payload?.retained_context
      const texts = (list: unknown) => (Array.isArray(list) ? list : []).map((message: any) => typeof message === 'string' ? message : message?.text).filter((text): text is string => typeof text === 'string')
      const requests = texts(retained?.user_messages).filter((text) => !injected(text)).map((text) => `- ${clip(text, LIMITS.user)}`)
      const answers = texts(retained?.assistant_messages).map((text) => `- ${clip(text, LIMITS.assistant)}`)
      summary = [requests.length ? `Requests kept from earlier:\n${requests.join('\n')}` : '', answers.length ? `Answers kept from earlier:\n${answers.join('\n')}` : '']
        .filter(Boolean).join('\n\n') || undefined
      break
    }
    if (entry?.type === 'response_item') collector.add(codexItems(entry.payload))
  }
  return finish(collector, summary, () => firstPrompt(path, (line) => line?.type === 'response_item' && line.payload?.type === 'message' && line.payload.role === 'user' ? textOf(line.payload.content) : undefined))
}

async function finish(collector: Collector, summary: string | undefined, first: () => Promise<string | undefined>): Promise<Digest> {
  return {
    ...(summary ? { summary: clip(summary, SUMMARY_CHARS) } : { firstPrompt: await first() }),
    items: collector.items(),
    truncated: collector.truncated
  }
}

function durableItems(entry: any): DigestItem[] {
  const message = entry?.model?.[0]
  if (entry?.kind === 'pi.user') return item('user', textOf(message?.content))
  if (entry?.kind === 'pi.tool-result') return item(message?.isError ? 'error' : 'result', textOf(message?.content))
  if (entry?.kind === 'pi.assistant') return piItems(message)
  return []
}

/** A durable agent's entries as its worker reports them, back to its latest compaction or new context. */
export function durableDigest(entries: readonly any[]): Digest {
  const collector = new Collector()
  let summary: string | undefined
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry?.kind === 'pi.compaction') {
      summary = textOf(entry.model?.[0]?.content).replace(/^[\s\S]*?<summary>\s*/, '').replace(/\s*<\/summary>\s*$/, '')
      break
    }
    if (entry?.kind === 'pi.reset') {
      summary = `The agent started a new context${textOf(entry.model?.[0]?.content) ? ` with this note: ${textOf(entry.model[0].content)}` : ''}.`
      break
    }
    collector.add(durableItems(entry))
    if (collector.truncated) break
  }
  const first = entries.find((entry) => entry?.kind === 'pi.user')
  return { ...(summary ? { summary: clip(summary, SUMMARY_CHARS) } : { firstPrompt: clip(textOf(first?.model?.[0]?.content), LIMITS.user * 2) || undefined }), items: collector.items(), truncated: collector.truncated }
}

/** The digest of a Codex, Claude or Pi transcript. */
export function transcriptDigest(kind: Exclude<AgentKind, 'durable'>, path: string): Promise<Digest> {
  return kind === 'pi' ? piDigest(path) : kind === 'claude' ? claudeDigest(path) : codexDigest(path)
}

/** A transcript's size and modification time, which change when the agent writes to it. */
export async function transcriptMark(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    return `${info.size}:${Math.floor(info.mtimeMs)}`
  } catch {
    return null
  }
}

import { createConnection, type Socket } from 'node:net'
import { INTERRUPTED_TEXT, type EditPatch, type NativeChatBlock, type NativeChatMessage } from './decoders.ts'
import type { TranscriptListener, TranscriptWindow } from './transcripts.ts'

// A durable agent's conversation is a database its worker serves, so its chat comes from the worker's
// socket (see durable/worker.ts) instead of a transcript file. Entry ids stand in for byte offsets.

const RECONNECT_MS = 1000
const MAX_EDIT_PATCH_HUNKS = 40
const MAX_EDIT_PATCH_HUNK_LINES = 400

type Entry = { id: number; kind: string; model?: any[] }

function textOf(message: any): string {
  if (typeof message?.content === 'string') return message.content
  return (message?.content ?? []).filter((block: any) => block?.type === 'text').map((block: any) => block.text ?? '').join('')
}

/** A tool result's text without the blocks the harness adds for the model, which it states in words instead. */
function resultOutput(message: any): string {
  return textOf(message).replace(/\n*<diagnostics>[\s\S]*$/, '').replace(/\n*<harness>\s*(?:\[[a-z]+\]\s*)?([\s\S]*?)\s*<\/harness>/gi, '\n$1').trim()
}

/** The edit tool's unified patch as the chat's hunks. */
function editPatch(details: any, path: unknown): EditPatch | undefined {
  if (typeof details?.patch !== 'string') return undefined
  const hunks: EditPatch['hunks'] = []
  for (const line of details.patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header) {
      if (hunks.length === MAX_EDIT_PATCH_HUNKS) break
      hunks.push({ oldStart: Number(header[1]), oldLines: Number(header[2] ?? 1), newStart: Number(header[3]), newLines: Number(header[4] ?? 1), lines: [] })
    } else if (hunks.length > 0 && /^[ +-]/.test(line) && hunks.at(-1)!.lines.length < MAX_EDIT_PATCH_HUNK_LINES) {
      hunks.at(-1)!.lines.push(line)
    }
  }
  return hunks.length > 0 ? { ...(typeof path === 'string' ? { filePath: path } : {}), hunks } : undefined
}

/** One entry as chat messages: thinking as reasoning, the answer with its tool calls, a tool's result. */
export function entryMessages(entry: Entry, callPaths: Map<string, unknown> = new Map()): NativeChatMessage[] {
  const message = entry.model?.[0]
  const id = `durable:${entry.id}`
  const time = typeof message?.timestamp === 'number' ? message.timestamp : null
  const of = (role: NativeChatMessage['role'], blocks: NativeChatBlock[], suffix = ''): NativeChatMessage =>
    ({ id: id + suffix, role, blocks, timestamp: time, source: 'transcript' })
  switch (entry.kind) {
    case 'pi.user': {
      const text = textOf(message)
      return text.trim() ? [of('user', [{ type: 'text', text }])] : []
    }
    case 'pi.assistant': {
      const content: any[] = Array.isArray(message?.content) ? message.content : []
      const thinking = content.filter((block) => block?.type === 'thinking' && block.thinking?.trim()).map((block) => block.thinking.trim()).join('\n\n')
      const blocks: NativeChatBlock[] = []
      for (const block of content) {
        if (block?.type === 'text' && block.text?.trim()) blocks.push({ type: 'text', text: block.text })
        else if (block?.type === 'toolCall') {
          callPaths.set(block.id, block.arguments?.path)
          blocks.push({ type: 'tool-call', name: block.name ?? 'tool', input: block.arguments ?? {}, ...(block.id ? { callId: block.id } : {}) })
        }
      }
      const messages = thinking ? [of('reasoning', [{ type: 'text', text: thinking }], ':thinking')] : []
      if (blocks.length > 0) messages.push(of('assistant', blocks))
      if (message?.stopReason === 'aborted') messages.push(of('system', [{ type: 'text', text: INTERRUPTED_TEXT }], ':stopped'))
      else if (message?.stopReason === 'error' && message.errorMessage) messages.push(of('system', [{ type: 'text', text: message.errorMessage }], ':error'))
      return messages
    }
    case 'pi.tool-result': {
      const patch = editPatch(message?.details, callPaths.get(message?.toolCallId))
      return [of('tool', [{ type: 'tool-result', output: resultOutput(message), ...(message?.isError ? { isError: true } : {}), ...(patch ? { editPatch: patch } : {}) }])]
    }
    case 'pi.compaction':
      return [of('system', [{ type: 'text', text: 'Earlier context summarized' }])]
    case 'pi.reset': {
      const note = textOf(message).trim()
      return [of('system', [{ type: 'text', text: note ? `New context: ${note}` : 'New context' }])]
    }
    default:
      return []
  }
}

/**
 * The last `limit` messages of the entries before `beforeOffset` (an entry id), whole entries only;
 * `beforeOffset` of the result is where the next page ends.
 */
export function entryWindow(entries: Entry[], limit: number, beforeOffset?: number): TranscriptWindow {
  const callPaths = new Map<string, unknown>()
  const each = entries.map((entry) => ({ entry, messages: entryMessages(entry, callPaths) }))
  let end = beforeOffset === undefined ? each.length : each.findIndex(({ entry }) => entry.id >= beforeOffset)
  if (end < 0) end = each.length
  let start = end
  let count = 0
  while (start > 0 && count < limit) count += each[--start].messages.length
  return { messages: each.slice(start, end).flatMap(({ messages }) => messages), hasMore: start > 0, beforeOffset: each[start]?.entry.id ?? 0 }
}

/** Subscribes to a worker's conversation: its snapshot entries, then entries as they are committed. */
function subscribe(socketPath: string, handlers: { snapshot(entries: Entry[]): void; entries(entries: Entry[]): void; closed(error: Error | null): void }): Socket {
  const socket = createConnection(socketPath)
  let buffered = ''
  let failure: Error | null = null
  socket.setEncoding('utf8')
  socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method: 'subscribe' }) + '\n'))
  socket.on('error', (error) => { failure = error })
  socket.on('close', () => handlers.closed(failure))
  socket.on('data', (chunk: string) => {
    buffered += chunk
    let newline: number
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        socket.destroy(new Error('the durable agent sent an unreadable message'))
        return
      }
      if (message.type === 'snapshot') handlers.snapshot(message.snapshot.entries)
      if (message.type !== 'events') continue
      const added: Entry[] = []
      for (const event of message.events) {
        if (event.type === 'snapshot') handlers.snapshot(event.entries)
        else if ((event.type === 'message_end' || event.type === 'entry_appended') && event.entry) added.push(event.entry)
      }
      if (added.length > 0) handlers.entries(added)
    }
  })
  return socket
}

/** One page of a durable agent's chat. */
export function readDurableWindow(socketPath: string, limit: number, beforeOffset?: number): Promise<TranscriptWindow> {
  return new Promise((resolve, reject) => {
    const socket = subscribe(socketPath, {
      snapshot: (entries) => {
        socket.destroy()
        resolve(entryWindow(entries, limit, beforeOffset))
      },
      entries: () => {},
      closed: (error) => reject(error ?? new Error('the durable agent closed its conversation'))
    })
  })
}

/**
 * Follows a durable agent's chat like `TranscriptFollower` follows a transcript: a snapshot, then
 * appended messages, and a replacement after reconnecting to a worker that stopped or restarted.
 */
export class DurableFollower {
  private readonly socketPath: string
  private readonly limit: number
  private readonly listener: TranscriptListener
  private readonly seen = new Set<number>()
  private readonly callPaths = new Map<string, unknown>()
  private socket: Socket | null = null
  private retry: NodeJS.Timeout | null = null
  private loaded = false
  private announced = false
  private stopped = false

  constructor(socketPath: string, limit: number, listener: TranscriptListener) {
    this.socketPath = socketPath
    this.limit = limit
    this.listener = listener
  }

  start(): void {
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    this.socket?.destroy()
  }

  private connect(): void {
    this.socket = subscribe(this.socketPath, {
      snapshot: (entries) => {
        this.seen.clear()
        this.callPaths.clear()
        for (const entry of entries) {
          this.seen.add(entry.id)
          entryMessages(entry, this.callPaths)
        }
        if (!this.stopped) this.listener[this.loaded ? 'replacement' : 'snapshot'](entryWindow(entries, this.limit))
        this.loaded = true
      },
      entries: (entries) => {
        const messages = entries.filter((entry) => !this.seen.has(entry.id)).flatMap((entry) => {
          this.seen.add(entry.id)
          return entryMessages(entry, this.callPaths)
        })
        if (messages.length > 0 && !this.stopped) this.listener.appended(messages)
      },
      closed: () => {
        if (this.stopped) return
        if (!this.loaded && !this.announced) this.listener.pending()
        this.announced = true
        this.retry = setTimeout(() => this.connect(), RECONNECT_MS)
      }
    })
  }
}

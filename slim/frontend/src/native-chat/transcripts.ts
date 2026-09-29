import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decodeLine, fallbackId, type NativeChatMessage, type TranscriptFormat } from './decoders.ts'

const READ_CHUNK = 256 * 1024
const POLL_MS = 250
// Finding a missing transcript can walk every dated session folder, so it is retried less often.
const RESOLVE_INTERVAL_MS = 1000

export type TranscriptWindow = { messages: NativeChatMessage[]; hasMore: boolean; beforeOffset: number }
type WindowRead = TranscriptWindow & { completeEnd: number }

/** The transcript decoder for an agent id as clients send it. */
export function transcriptFormat(agent: string): TranscriptFormat | null {
  if (agent === 'claude' || agent === 'openclaude') return 'claude'
  if (agent === 'codex') return 'codex'
  if (agent === 'omp' || agent === 'pi') return 'omp'
  return null
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isFile(), () => false)
}

/**
 * The transcript file for a session. A `.jsonl` path reported by the agent's hooks wins; otherwise
 * Claude and Codex sessions are found by id in their standard session directories.
 */
export async function resolveTranscript(format: TranscriptFormat, sessionId: string, transcriptPath?: string): Promise<string | null> {
  if (transcriptPath?.endsWith('.jsonl') && (await exists(transcriptPath))) return transcriptPath
  if (!/^[\w.-]+$/.test(sessionId)) return null
  if (format === 'claude') {
    const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
    for (const project of await readdir(root).catch(() => [] as string[])) {
      const candidate = join(root, project, `${sessionId}.jsonl`)
      if (await exists(candidate)) return candidate
    }
  }
  if (format === 'codex') {
    const root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')
    const years = (await readdir(root).catch(() => [] as string[])).sort().reverse()
    for (const year of years) for (const month of (await readdir(join(root, year)).catch(() => [] as string[])).sort().reverse()) {
      for (const day of (await readdir(join(root, year, month)).catch(() => [] as string[])).sort().reverse()) {
        const names = await readdir(join(root, year, month, day)).catch(() => [] as string[])
        const match = names.find((name) => name.startsWith('rollout-') && name.endsWith(`-${sessionId}.jsonl`))
        if (match) return join(root, year, month, day, match)
      }
    }
  }
  return null
}

/**
 * The last `limit` messages before byte `beforeOffset` (the end of the file when absent).
 * `beforeOffset` in the result is where the oldest returned line starts, for the next page; `hasMore`
 * says whether any decodable line precedes it.
 */
export async function readWindow(path: string, format: TranscriptFormat, limit: number, beforeOffset?: number): Promise<WindowRead> {
  const handle = await open(path, 'r')
  try {
    const size = (await handle.stat()).size
    let end = Math.min(beforeOffset ?? size, size)
    // A final line without its newline is still being written; it is read once it is complete.
    let completeEnd = end
    if (end === size && end > 0) {
      const probe = Buffer.alloc(Math.min(end, READ_CHUNK))
      await handle.read(probe, 0, probe.length, end - probe.length)
      const newline = probe.lastIndexOf(0x0a)
      completeEnd = newline >= 0 ? end - probe.length + newline + 1 : (probe.length === end ? 0 : end)
      end = completeEnd
    }
    let carry = Buffer.alloc(0)
    const messages: NativeChatMessage[] = []
    let oldest = end
    let hasMore = false
    while (end > 0 || carry.length > 0) {
      const start = Math.max(0, end - READ_CHUNK)
      const chunk = Buffer.alloc(end - start)
      if (chunk.length > 0) await handle.read(chunk, 0, chunk.length, start)
      let data = Buffer.concat([chunk, carry])
      // Lines are complete only after a newline; the part before the first one may continue earlier.
      const lines: { offset: number; text: string }[] = []
      let lineEnd = data.length
      for (let index = data.length - 1; index >= 0; index--) {
        if (data[index] !== 0x0a) continue
        if (index + 1 < lineEnd) lines.push({ offset: start + index + 1, text: data.subarray(index + 1, lineEnd).toString('utf8') })
        lineEnd = index
      }
      if (start === 0 && lineEnd > 0) {
        lines.push({ offset: 0, text: data.subarray(0, lineEnd).toString('utf8') })
        lineEnd = 0
      }
      carry = Buffer.from(data.subarray(0, lineEnd))
      data = Buffer.alloc(0)
      for (const line of lines) {
        const message = decodeLine(format, line.text, fallbackId(path, line.offset))
        if (!message) continue
        if (messages.length >= limit) {
          hasMore = true
          break
        }
        messages.push(message)
        oldest = line.offset
      }
      if (hasMore || start === 0) break
      end = start
    }
    return { messages: messages.reverse(), hasMore, beforeOffset: oldest, completeEnd }
  } finally {
    await handle.close()
  }
}

export type TranscriptListener = {
  pending(): void
  snapshot(window: TranscriptWindow): void
  replacement(window: TranscriptWindow): void
  appended(messages: NativeChatMessage[]): void
  error(message: string): void
}

/**
 * Follows a transcript: a snapshot of the last `limit` messages, then messages from appended lines,
 * and a replacement snapshot when the file is truncated or replaced. Waits for a missing file.
 */
export class TranscriptFollower {
  private readonly format: TranscriptFormat
  private readonly sessionId: string
  private readonly transcriptPath: string | undefined
  private readonly limit: number
  private readonly listener: TranscriptListener
  private path: string | null = null
  private offset = 0
  private inode = 0
  private partial = Buffer.alloc(0)
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private busy = false
  private resolvedAt = 0

  constructor(format: TranscriptFormat, sessionId: string, transcriptPath: string | undefined, limit: number, listener: TranscriptListener) {
    this.format = format
    this.sessionId = sessionId
    this.transcriptPath = transcriptPath
    this.limit = limit
    this.listener = listener
  }

  async start(): Promise<void> {
    this.resolvedAt = Date.now()
    this.path = await resolveTranscript(this.format, this.sessionId, this.transcriptPath)
    if (this.path) await this.load('snapshot')
    else this.listener.pending()
    this.timer = setInterval(() => void this.poll(), POLL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
  }

  private async load(kind: 'snapshot' | 'replacement'): Promise<void> {
    const info = await stat(this.path!)
    const { completeEnd, ...window } = await readWindow(this.path!, this.format, this.limit)
    this.offset = completeEnd
    this.inode = info.ino
    this.partial = Buffer.alloc(0)
    if (!this.stopped) this.listener[kind](window)
  }

  private async poll(): Promise<void> {
    if (this.busy || this.stopped) return
    this.busy = true
    try {
      if (!this.path) {
        if (Date.now() - this.resolvedAt < RESOLVE_INTERVAL_MS) return
        this.resolvedAt = Date.now()
        this.path = await resolveTranscript(this.format, this.sessionId, this.transcriptPath)
        if (this.path) await this.load('snapshot')
        return
      }
      const info = await stat(this.path).catch(() => null)
      if (!info) return
      if (info.ino !== this.inode || info.size < this.offset) return await this.load('replacement')
      if (info.size === this.offset) return
      const handle = await open(this.path, 'r')
      const chunk = Buffer.alloc(info.size - this.offset)
      try {
        await handle.read(chunk, 0, chunk.length, this.offset)
      } finally {
        await handle.close()
      }
      const start = this.offset - this.partial.length
      const data = Buffer.concat([this.partial, chunk])
      this.offset = info.size
      const messages: NativeChatMessage[] = []
      let lineStart = 0
      for (let index = 0; index < data.length; index++) {
        if (data[index] !== 0x0a) continue
        const message = decodeLine(this.format, data.subarray(lineStart, index).toString('utf8'), fallbackId(this.path, start + lineStart))
        if (message) messages.push(message)
        lineStart = index + 1
      }
      this.partial = Buffer.from(data.subarray(lineStart))
      if (messages.length > 0 && !this.stopped) this.listener.appended(messages)
    } catch (error) {
      if (!this.stopped) this.listener.error((error as Error).message)
    } finally {
      this.busy = false
    }
  }
}

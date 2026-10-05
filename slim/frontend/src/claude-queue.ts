import { open, stat } from 'node:fs/promises'

// The first read of a transcript starts this far from its end; queued input is always recent.
const TAIL_BYTES = 8 * 1024 * 1024

/**
 * Input Claude queued during a turn, from the `queue-operation` lines of its transcript. Queued text
 * is read at the turn's next step (`remove`) or, once the turn has ended, taken (`dequeue`) to start
 * another turn under a new prompt id. Claude fires no hook for that turn until it stops.
 */
export class ClaudeQueue {
  private path = ''
  private offset = 0
  private partial = ''
  private queued = 0
  private promptId: string | undefined
  private dequeuedSincePrompt = false

  /** Whether Claude goes on working after the turn for `promptId` stopped. */
  async continuesAfter(path: string, promptId: unknown): Promise<boolean> {
    await this.read(path)
    if (this.queued > 0 || this.dequeuedSincePrompt) return true
    return typeof promptId === 'string' && this.promptId !== undefined && this.promptId !== promptId
  }

  private reset(path: string): void {
    this.path = path
    this.offset = 0
    this.partial = ''
    this.queued = 0
    this.promptId = undefined
    this.dequeuedSincePrompt = false
  }

  private async read(path: string): Promise<void> {
    if (path !== this.path) this.reset(path)
    const size = (await stat(path).catch(() => null))?.size ?? 0
    if (size < this.offset) this.reset(path)
    if (size <= this.offset) return
    let skipFirstLine = false
    if (this.offset === 0 && size > TAIL_BYTES) {
      this.offset = size - TAIL_BYTES
      skipFirstLine = true
    }
    const handle = await open(path, 'r')
    let text: string
    try {
      const buffer = Buffer.alloc(size - this.offset)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset)
      this.offset += bytesRead
      text = this.partial + buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
    const lines = text.split('\n')
    this.partial = lines.pop() ?? ''
    if (skipFirstLine) lines.shift()
    for (const line of lines) {
      if (!line.includes('"queue-operation"') && !line.includes('"promptId"')) continue
      try {
        this.apply(JSON.parse(line))
      } catch {}
    }
  }

  private apply(entry: Record<string, any>): void {
    if (entry.type === 'queue-operation') {
      switch (entry.operation) {
        case 'enqueue':
          this.queued++
          break
        case 'dequeue':
          this.dequeuedSincePrompt = true
          this.queued = Math.max(0, this.queued - 1)
          break
        case 'remove':
          this.queued = Math.max(0, this.queued - 1)
          break
        case 'popAll':
          this.queued = 0
          break
      }
    } else if (entry.type === 'user' && typeof entry.promptId === 'string' && entry.promptId !== this.promptId) {
      // A prompt not taken from the queue was submitted to an idle Claude, whose queue is empty.
      if (!this.dequeuedSincePrompt) this.queued = 0
      this.promptId = entry.promptId
      this.dequeuedSincePrompt = false
    }
  }
}

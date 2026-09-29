import type { Terminal } from './emulator.ts'

type Operation =
  | { kind: 'output'; bytes: Uint8Array; applied: () => void }
  | { kind: 'action'; run: () => void }

/**
 * Feeds output to an emulator in stream order, and runs resizes, snapshots and other state access
 * between writes. Consecutive writes go to xterm back to back; an action waits until every earlier
 * write has been parsed and runs outside xterm's write loop. xterm discards writes queued behind a
 * callback that resizes the terminal, so nothing here touches the terminal from a write callback.
 */
export class TerminalFeed {
  private readonly term: Terminal
  private readonly queue: Operation[] = []
  private inFlight = 0
  private scheduled = false
  private inCallback = false

  constructor(term: Terminal) {
    this.term = term
  }

  write(bytes: Uint8Array, applied: () => void = () => {}): void {
    this.queue.push({ kind: 'output', bytes, applied })
    this.pump()
  }

  /** Runs `action` once all output queued before it has been parsed. */
  run<T>(action: () => T): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({ kind: 'action', run: () => { try { resolve(action()) } catch (error) { reject(error) } } })
      this.pump()
    })
  }

  private pump(): void {
    if (this.inCallback) {
      this.schedule()
      return
    }
    while (this.queue.length > 0) {
      const next = this.queue[0]
      if (next.kind === 'output') {
        this.queue.shift()
        this.inFlight++
        this.term.write(next.bytes, () => {
          this.inFlight--
          this.inCallback = true
          try {
            next.applied()
          } finally {
            this.inCallback = false
          }
          if (this.inFlight === 0 && this.queue.length > 0) this.schedule()
        })
        continue
      }
      if (this.inFlight > 0 || this.scheduled) return
      this.queue.shift()
      next.run()
    }
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    // Leaves xterm's write loop before touching the terminal again.
    setImmediate(() => {
      this.scheduled = false
      this.pump()
    })
  }
}

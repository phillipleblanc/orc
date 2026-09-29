import { EventEmitter } from 'node:events'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HolderClient, type HolderExit, type HolderInfo } from './holder-client.ts'
import {
  createTerminal,
  extrasSequence,
  restoreScreen,
  screenState,
  serializeScreen,
  type SerializedScreen,
  type Terminal
} from './emulator.ts'
import { captureState, encodeState, loadState, STATE_FORMAT, type EmulatorState } from './emulator-state.ts'
import { TerminalFeed } from './terminal-feed.ts'

export type SessionMeta = {
  id: string
  name: string
  incarnationId: string
  createdAt: string
  cwd: string
  argv: string[]
  project?: string
  agent?: string
  parent?: string
}

/**
 * `state` restores exactly into the same xterm build. `serialized` is an approximate screen for any
 * other build, so a frontend upgrade degrades one restore instead of failing it.
 */
export type Checkpoint = SerializedScreen & { version: 2; offset: number; savedAt: string; state: EmulatorState }

/** A screen image for a client terminal, positioned at `offset` in the output stream. */
export type ClientSnapshot = {
  cols: number
  rows: number
  data: string
  offset: number
  kittyKeyboardFlags: number
  alternateScreen: boolean
}

/**
 * Receives a snapshot, then the session's output in parse order starting exactly where the snapshot
 * ends. Every callback runs outside xterm's write loop or after the write it reports.
 */
export type Subscriber = {
  snapshot(screen: ClientSnapshot): void
  output(bytes: Buffer, offset: number): void
  resized(cols: number, rows: number): void
  exited(exit: HolderExit): void
}

export type CheckpointPolicy = { quietMs: number; maxDelayMs: number; maxUntrimmedBytes: number }

/** Recent checkpoint costs across sessions: time spent on the event loop capturing state, and file size. */
export const checkpointSamples: { captureMs: number; bytes: number }[] = []
/** Scrollback kept in the approximate screen used only when a different xterm build restores the checkpoint. */
const FALLBACK_SCROLLBACK_ROWS = 500
const DEFAULT_POLICY: CheckpointPolicy = { quietMs: 1000, maxDelayMs: 5000, maxUntrimmedBytes: 1 << 20 }

/**
 * The frontend's view of one holder-owned terminal: an emulator rebuilt from the last checkpoint
 * plus the holder's retained output, kept current from the live stream.
 */
export class TerminalSession extends EventEmitter {
  dir: string
  readonly meta: SessionMeta
  readonly term: Terminal
  private readonly feed: TerminalFeed
  private readonly serializer: ReturnType<typeof createTerminal>['serializer']
  private holder: HolderClient
  private detached = false
  private readonly policy: CheckpointPolicy
  private readonly subscribers = new Set<Subscriber>()
  /** Output before this offset has been parsed by `term`. */
  appliedOffset = 0
  /** Output before this offset has been received from the holder. */
  receivedOffset = 0
  /** Output before this offset was replayed; query replies for it were answered by an earlier frontend. */
  private liveFrom = Number.POSITIVE_INFINITY
  private parsingLive = false
  private checkpointOffset = 0
  private checkpointing: Promise<boolean> | null = null
  private quietTimer: NodeJS.Timeout | null = null
  private maxTimer: NodeJS.Timeout | null = null
  cols: number
  rows: number
  gapBytes = 0
  exit: HolderExit | null = null
  holderInfo: HolderInfo
  replayedBytes = 0
  /** How this session's emulator was rebuilt when it was opened. */
  restoredFrom: 'none' | 'state' | 'serialized' = 'none'
  checkpointsDeferred = 0

  private constructor(dir: string, meta: SessionMeta, holder: HolderClient, info: HolderInfo, cols: number, rows: number, policy: CheckpointPolicy) {
    super()
    this.dir = dir
    this.meta = meta
    this.holder = holder
    this.holderInfo = info
    this.policy = policy
    this.cols = cols
    this.rows = rows
    const { term, serializer } = createTerminal(cols, rows)
    this.term = term
    this.feed = new TerminalFeed(term)
    this.serializer = serializer
  }

  static async open(dir: string, meta: SessionMeta, options: { policy?: Partial<CheckpointPolicy>; answerQueries?: boolean } = {}): Promise<TerminalSession> {
    const holder = await HolderClient.connect(join(dir, 'sock'))
    try {
      const info = await holder.hello()
      const checkpoint = await readCheckpoint(dir)
      const session = new TerminalSession(dir, meta, holder, info, checkpoint?.cols ?? info.cols, checkpoint?.rows ?? info.rows,
        { ...DEFAULT_POLICY, ...options.policy })
      if (checkpoint) {
        if (checkpoint.state?.format === STATE_FORMAT) {
          loadState(session.term, checkpoint.state)
          session.restoredFrom = 'state'
        } else {
          await restoreScreen(session.term, checkpoint)
          session.restoredFrom = 'serialized'
        }
        session.appliedOffset = session.receivedOffset = session.checkpointOffset = checkpoint.offset
      }
      if (options.answerQueries !== false) {
        session.term.onData((reply) => { if (session.parsingLive) holder.input(reply) })
      }
      session.wire(holder)
      // Replay frames can be dispatched before this continuation runs; receive() handles their
      // offsets and any gap, and they stay non-live until liveFrom is known.
      const attached = await holder.attach(session.appliedOffset)
      session.holderInfo = attached
      session.liveFrom = attached.headOffset
      if (session.appliedOffset >= session.liveFrom) session.parsingLive = true
      session.replayedBytes = attached.headOffset - attached.from
      if (attached.exited) session.exit = { exitCode: attached.exitCode, exitSignal: attached.exitSignal, headOffset: attached.headOffset }
      return session
    } catch (error) {
      holder.disconnect()
      throw error
    }
  }

  private wire(holder: HolderClient): void {
    holder.on('output', (offset: number, bytes: Buffer) => this.receive(offset, bytes))
    holder.on('resize', (_offset: number, cols: number, rows: number) => this.applyResize(cols, rows))
    holder.on('exit', (exit: HolderExit) => this.receiveExit(exit))
    holder.on('close', () => { if (!this.detached && !this.exit) void this.reconnect() })
  }

  /** Reattaches from the last received offset after the holder dropped this connection. */
  private async reconnect(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const holder = await HolderClient.connect(join(this.dir, 'sock'), 1000)
        this.holder = holder
        await holder.hello()
        this.wire(holder)
        const attached = await holder.attach(this.receivedOffset)
        this.holderInfo = attached
        if (attached.exited && !this.exit) this.receiveExit({ exitCode: attached.exitCode, exitSignal: attached.exitSignal, headOffset: attached.headOffset })
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
      }
    }
    this.emit('lost')
  }

  relocate(dir: string, name: string): void {
    this.dir = dir
    this.meta.name = name
  }

  get handle(): string {
    return `term_${this.meta.id}`
  }

  get connected(): boolean {
    return !this.holder.closed && this.exit === null
  }

  /** Resolves once everything received so far has been parsed. */
  caughtUp(): Promise<void> {
    return this.barrier(() => undefined)
  }

  input(data: string | Buffer): void {
    this.holder.input(data)
  }

  resize(cols: number, rows: number): Promise<void> {
    return this.holder.resize(cols, rows)
  }

  signal(signal: string, target: 'foreground' | 'child' = 'foreground'): Promise<void> {
    return this.holder.signal(signal, target)
  }

  info(): Promise<HolderInfo> {
    return this.holder.info()
  }

  /** Ends the session's process and its holder. */
  close(): Promise<void> {
    return this.holder.closeSession()
  }

  /** Saves a checkpoint and drops the connection, leaving the session running. */
  async detach(): Promise<void> {
    this.detached = true
    this.clearTimers()
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await this.checkpoint().catch(() => true)) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    this.holder.disconnect()
  }

  snapshot(scrollback?: number): Promise<SerializedScreen & { offset: number }> {
    return this.barrier(() => ({ ...serializeScreen(this.term, this.serializer, scrollback), offset: this.appliedOffset }))
  }

  /** Delivers a snapshot to `subscriber` and then every later output chunk, with nothing missed or repeated. */
  subscribe(subscriber: Subscriber, scrollback: number): Promise<void> {
    return this.barrier(() => {
      subscriber.snapshot(this.clientSnapshot(scrollback))
      this.subscribers.add(subscriber)
    })
  }

  /** Sends a fresh snapshot to an existing subscriber, ordered with its output. */
  resnapshot(subscriber: Subscriber, scrollback: number): Promise<void> {
    return this.barrier(() => {
      if (this.subscribers.has(subscriber)) subscriber.snapshot(this.clientSnapshot(scrollback))
    })
  }

  private clientSnapshot(scrollback: number): ClientSnapshot {
    const screen = serializeScreen(this.term, this.serializer, scrollback)
    // Synchronized output belongs to the client's own snapshot replay, not the restored screen.
    const extras = { ...screen.extras, synchronizedOutput: false }
    return {
      cols: screen.cols,
      rows: screen.rows,
      data: screen.serialized + extrasSequence(extras, this.term),
      offset: this.appliedOffset,
      kittyKeyboardFlags: extras.kitty?.flags ?? 0,
      alternateScreen: this.term.buffer.active.type === 'alternate'
    }
  }

  unsubscribe(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber)
  }

  state(scrollbackRows?: number) {
    return this.barrier(() => ({ ...screenState(this.term, scrollbackRows), appliedOffset: this.appliedOffset }))
  }

  /** Resolves false when the parser was mid-sequence; the caller retries after more output. */
  checkpoint(): Promise<boolean> {
    if (this.checkpointing) return this.checkpointing
    this.checkpointing = (async () => {
      try {
        let captureMs = 0
        const captured = await this.barrier(() => {
          const started = performance.now()
          const state = captureState(this.term)
          const result = state && { state, ...serializeScreen(this.term, this.serializer, FALLBACK_SCROLLBACK_ROWS), offset: this.appliedOffset }
          captureMs = performance.now() - started
          return result
        })
        if (!captured) {
          this.checkpointsDeferred++
          return false
        }
        if (captured.offset === this.checkpointOffset && this.checkpointOffset > 0) return true
        const checkpoint: Checkpoint = { version: 2, savedAt: new Date().toISOString(), ...captured, state: await encodeState(captured.state) }
        const path = join(this.dir, 'checkpoint.json')
        const encoded = JSON.stringify(checkpoint)
        checkpointSamples.push({ captureMs, bytes: encoded.length })
        if (checkpointSamples.length > 10_000) checkpointSamples.splice(0, 5_000)
        // A frontend crash cannot lose a completed rename; an OS crash ends the holder too, so no fsync.
        await writeFile(`${path}.tmp`, encoded, { mode: 0o600 })
        await rename(`${path}.tmp`, path)
        this.checkpointOffset = captured.offset
        if (!this.holder.closed) await this.holder.trim(captured.offset)
        return true
      } finally {
        this.checkpointing = null
      }
    })()
    return this.checkpointing
  }

  private receive(offset: number, bytes: Buffer): void {
    if (offset + bytes.length <= this.receivedOffset) return
    if (offset < this.receivedOffset) bytes = bytes.subarray(this.receivedOffset - offset)
    else if (offset > this.receivedOffset) this.gapBytes += offset - this.receivedOffset
    const start = Math.max(offset, this.receivedOffset)
    const end = start + bytes.length
    this.receivedOffset = end
    this.feed.write(bytes, () => {
      this.appliedOffset = end
      if (end >= this.liveFrom) this.parsingLive = true
      for (const subscriber of this.subscribers) subscriber.output(bytes, start)
      this.scheduleCheckpoint()
    })
  }

  private applyResize(cols: number, rows: number): void {
    void this.feed.run(() => {
      if (cols === this.term.cols && rows === this.term.rows) return
      this.term.resize(cols, rows)
      this.cols = cols
      this.rows = rows
      for (const subscriber of this.subscribers) subscriber.resized(cols, rows)
    })
  }

  private receiveExit(exit: HolderExit): void {
    void this.feed.run(() => {
      this.exit = exit
      for (const subscriber of this.subscribers) subscriber.exited(exit)
      this.emit('exit', exit)
    })
  }

  private barrier<T>(action: () => T): Promise<T> {
    return this.feed.run(action)
  }

  private scheduleCheckpoint(): void {
    if (this.appliedOffset - this.checkpointOffset >= this.policy.maxUntrimmedBytes && !this.checkpointing) {
      this.fireCheckpoint()
      return
    }
    if (this.quietTimer) clearTimeout(this.quietTimer)
    this.quietTimer = setTimeout(() => this.fireCheckpoint(), this.policy.quietMs)
    this.maxTimer ??= setTimeout(() => this.fireCheckpoint(), this.policy.maxDelayMs)
  }

  private fireCheckpoint(): void {
    this.clearTimers()
    void this.checkpoint().then((saved) => {
      if (!saved) this.quietTimer = setTimeout(() => this.fireCheckpoint(), 20)
    }, () => {})
  }

  private clearTimers(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer)
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.quietTimer = this.maxTimer = null
  }
}

async function readCheckpoint(dir: string): Promise<Checkpoint | null> {
  try {
    const checkpoint = JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8')) as Checkpoint
    return checkpoint.version === 2 ? checkpoint : null
  } catch {
    return null
  }
}

import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Duplex } from 'node:stream'

const OPEN = 1
const DATA = 2
const END = 3
const HEADER = 9
const MAX_FRAME = 16 << 20

/**
 * One connection a program in a machine made to a socket of the bridge. The machine side writes what
 * the connection sent; `end()` tells it nothing more comes from Orc. Data from a channel is untrusted.
 */
export class Channel extends Duplex {
  readonly id: number
  readonly kind: string
  private readonly bridge: SandboxBridge

  constructor(bridge: SandboxBridge, id: number, kind: string) {
    super({ allowHalfOpen: true })
    this.bridge = bridge
    this.id = id
    this.kind = kind
  }

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.bridge.send(DATA, this.id, chunk)
    callback()
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.bridge.send(END, this.id)
    callback()
  }
}

/**
 * Orc's end of a machine's bridge (guest/bridge.py), which runs in the machine with its standard streams
 * piped to Orc. Every connection to one of the bridge's sockets arrives as a channel of that socket's kind;
 * `onChannel` serves it. The bridge belongs to one machine, so a channel's machine is its caller's identity.
 */
export class SandboxBridge extends EventEmitter {
  readonly process: ChildProcess
  private readonly channels = new Map<number, Channel>()
  private buffer: Buffer = Buffer.alloc(0)
  private closed = false

  constructor(child: ChildProcess, onChannel: (channel: Channel) => void) {
    super()
    this.process = child
    child.stdout!.on('data', (chunk: Buffer) => this.receive(chunk, onChannel))
    child.stdin!.on('error', () => {})
    child.stderr!.on('data', (chunk: Buffer) => this.emit('log', chunk.toString('utf8')))
    child.once('exit', (code) => this.close(code))
  }

  send(type: number, id: number, payload: Buffer = Buffer.alloc(0)): void {
    if (this.closed || !this.process.stdin!.writable) return
    const header = Buffer.alloc(HEADER)
    header.writeUInt8(type, 0)
    header.writeUInt32BE(id, 1)
    header.writeUInt32BE(payload.length, 5)
    this.process.stdin!.write(Buffer.concat([header, payload]))
  }

  /** Stops the bridge; its sockets in the machine stop answering. */
  stop(): void {
    this.process.stdin!.end()
    this.process.kill('SIGTERM')
  }

  get running(): boolean {
    return !this.closed
  }

  private receive(chunk: Buffer, onChannel: (channel: Channel) => void): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (this.buffer.length >= HEADER) {
      const type = this.buffer.readUInt8(0)
      const id = this.buffer.readUInt32BE(1)
      const length = this.buffer.readUInt32BE(5)
      if (length > MAX_FRAME) {
        this.emit('log', `a frame of ${length} bytes is too large; stopping the bridge`)
        this.stop()
        return
      }
      if (this.buffer.length < HEADER + length) return
      const payload = this.buffer.subarray(HEADER, HEADER + length)
      this.buffer = this.buffer.subarray(HEADER + length)
      if (type === OPEN && !this.channels.has(id)) {
        const channel = new Channel(this, id, payload.toString('utf8'))
        this.channels.set(id, channel)
        const forget = () => { if (channel.writableFinished && channel.readableEnded) this.channels.delete(id) }
        channel.on('finish', forget)
        channel.on('end', forget)
        channel.on('error', () => {})
        onChannel(channel)
      } else if (type === DATA) {
        this.channels.get(id)?.push(Buffer.from(payload))
      } else if (type === END) {
        this.channels.get(id)?.push(null)
      }
    }
  }

  private close(code: number | null): void {
    if (this.closed) return
    this.closed = true
    for (const channel of this.channels.values()) channel.destroy()
    this.channels.clear()
    this.emit('exit', code)
  }
}

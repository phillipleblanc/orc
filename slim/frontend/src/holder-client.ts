import { EventEmitter } from 'node:events'
import { createConnection, type Socket } from 'node:net'

const REQUEST = 0x01
const INPUT = 0x02
const REPLY = 0x81
const OUTPUT = 0x82
const RESIZE = 0x84
export const HOLDER_PROTOCOL = 1

export type HolderInfo = {
  protocol: number
  holderVersion: string
  pid: number
  childPid: number
  cols: number
  rows: number
  baseOffset: number
  headOffset: number
  retainedBytes: number
  exited: boolean
  exitCode?: number
  exitSignal?: number
  foregroundGroup?: number
  startedAt: string
}

export type AttachReply = HolderInfo & { from: number; gap: boolean }

export type HolderExit = { exitCode?: number; exitSignal?: number; headOffset: number }

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }

/**
 * Client for one holder socket. Emits `output(offset, bytes)` and `resize(offset, cols, rows)` in
 * stream order after `attach`, `exit(HolderExit)`, and `close` when the connection ends.
 */
export class HolderClient extends EventEmitter {
  private readonly socket: Socket
  private buffered: Buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  closed = false

  private constructor(socket: Socket) {
    super()
    this.socket = socket
    socket.on('data', (chunk: Buffer) => this.receive(chunk))
    socket.on('close', () => {
      this.closed = true
      for (const { reject } of this.pending.values()) reject(new Error('holder connection closed'))
      this.pending.clear()
      this.emit('close')
    })
    socket.on('error', () => {})
  }

  static connect(path: string, timeoutMs = 2000): Promise<HolderClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`holder at ${path} did not accept a connection`))
      }, timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(new HolderClient(socket))
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  async hello(): Promise<HolderInfo> {
    return (await this.request('hello', { protocol: HOLDER_PROTOCOL })) as unknown as HolderInfo
  }

  async info(): Promise<HolderInfo> {
    return (await this.request('info')) as unknown as HolderInfo
  }

  async attach(from: number): Promise<AttachReply> {
    return (await this.request('attach', { from })) as unknown as AttachReply
  }

  async resize(cols: number, rows: number): Promise<void> {
    await this.request('resize', { cols, rows })
  }

  async signal(signal: string, target: 'foreground' | 'child' = 'foreground'): Promise<void> {
    await this.request('signal', { signal, target })
  }

  async trim(offset: number): Promise<void> {
    await this.request('trim', { offset })
  }

  async closeSession(): Promise<void> {
    await this.request('close')
  }

  input(bytes: Buffer | string): void {
    const payload = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes
    if (payload.length > 0) this.write(INPUT, payload)
  }

  disconnect(): void {
    this.socket.destroy()
  }

  request(op: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('holder connection closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write(REQUEST, Buffer.from(JSON.stringify({ ...fields, id, op }), 'utf8'))
    })
  }

  private write(type: number, payload: Buffer): void {
    const header = Buffer.alloc(5)
    header.writeUInt32LE(payload.length + 1, 0)
    header.writeUInt8(type, 4)
    this.socket.write(Buffer.concat([header, payload]))
  }

  private receive(chunk: Buffer): void {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk])
    let start = 0
    while (this.buffered.length - start >= 5) {
      const length = this.buffered.readUInt32LE(start)
      if (this.buffered.length - start < 4 + length) break
      const type = this.buffered.readUInt8(start + 4)
      const payload = this.buffered.subarray(start + 5, start + 4 + length)
      start += 4 + length
      this.dispatch(type, payload)
    }
    this.buffered = start === this.buffered.length ? Buffer.alloc(0) : Buffer.from(this.buffered.subarray(start))
  }

  private dispatch(type: number, payload: Buffer): void {
    if (type === OUTPUT) {
      this.emit('output', Number(payload.readBigUInt64LE(0)), Buffer.from(payload.subarray(8)))
    } else if (type === RESIZE) {
      this.emit('resize', Number(payload.readBigUInt64LE(0)), payload.readUInt16LE(8), payload.readUInt16LE(10))
    } else if (type === REPLY) {
      const message = JSON.parse(payload.toString('utf8')) as Record<string, unknown>
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)!
        this.pending.delete(message.id)
        if (message.ok) resolve(message)
        else reject(new Error(String(message.error ?? 'holder request failed')))
      } else if (message.event === 'exit') {
        this.emit('exit', message as unknown as HolderExit)
      } else if (message.event) {
        this.emit('event', message)
      }
    }
  }
}

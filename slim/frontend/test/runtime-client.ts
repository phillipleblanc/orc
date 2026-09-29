import { randomUUID } from 'node:crypto'
import nacl from 'tweetnacl'
import WebSocket from 'ws'
import { E2EEChannel } from '../src/e2ee.ts'
import { decodeFrame, encodeFrame, type TerminalFrame } from '../src/terminal-frames.ts'

export type PairingOffer = { endpoint: string; deviceToken: string; publicKeyB64: string }

export function parsePairingLink(link: string): PairingOffer {
  const code = new URL(link).searchParams.get('code')!
  return JSON.parse(Buffer.from(code, 'base64url').toString('utf8'))
}

/** The events of one stream, in arrival order, with the reply envelopes that carried them. */
export class StreamEvents {
  readonly events: any[] = []
  readonly envelopes: any[] = []
  private readonly taken = new Set<number>()
  private readonly waiters = new Set<() => boolean>()

  push(event: any, envelope: any): void {
    this.events.push(event)
    this.envelopes.push(envelope)
    for (const waiter of [...this.waiters]) waiter()
  }

  /** The first event matching `predicate` that no earlier call returned. */
  next(predicate: (event: any) => boolean = () => true, timeoutMs = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const index = this.events.findIndex((event, position) => !this.taken.has(position) && predicate(event))
        if (index < 0) return false
        this.taken.add(index)
        this.waiters.delete(check)
        clearTimeout(timer)
        resolve(this.events[index])
        return true
      }
      const timer = setTimeout(() => {
        this.waiters.delete(check)
        reject(new Error(`no matching stream event among ${JSON.stringify(this.events.map((event) => event.type))}`))
      }, timeoutMs)
      if (!check()) this.waiters.add(check)
    })
  }

  /** Whether the stream is still open (no `end` or `error` yet). */
  get open(): boolean {
    return !this.events.some((event) => event.type === 'end' || event.type === 'error')
  }
}

/** An Orca-protocol client: E2EE v1 handshake, JSON RPC, streaming methods and terminal frames. */
export class RuntimeClient {
  private readonly socket: WebSocket
  private readonly channel: E2EEChannel
  private readonly token: string
  private readonly pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private readonly streams = new Map<string, (event: any, envelope: any) => void>()
  onFrame: (frame: TerminalFrame) => void = () => {}

  private constructor(socket: WebSocket, channel: E2EEChannel, token: string) {
    this.socket = socket
    this.channel = channel
    this.token = token
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      const opened = channel.open(isBinary ? data : Buffer.from(data.toString('utf8'), 'base64'))
      if (!opened) return
      if (isBinary) {
        const frame = decodeFrame(opened)
        if (frame) this.onFrame(frame)
        return
      }
      const message = JSON.parse(opened.toString('utf8'))
      const stream = this.streams.get(message.id)
      if (stream) return stream(message.result ?? message, message)
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.ok) waiter.resolve(message.result)
      else waiter.reject(Object.assign(new Error(message.error?.message), { code: message.error?.code }))
    })
  }

  static connect(offer: PairingOffer, endpoint = offer.endpoint): Promise<RuntimeClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint)
      const keys = nacl.box.keyPair()
      const channel = new E2EEChannel(Buffer.from(offer.publicKeyB64, 'base64'), keys.secretKey)
      let stage = 0
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('handshake timed out')) }, 10_000)
      const fail = (error: Error) => { clearTimeout(timer); reject(error) }
      socket.once('error', fail)
      socket.once('close', (code) => fail(new Error(`closed during handshake (${code})`)))
      socket.on('open', () => socket.send(JSON.stringify({ type: 'e2ee_hello', publicKeyB64: Buffer.from(keys.publicKey).toString('base64') })))
      const onHandshake = (data: Buffer) => {
        if (stage === 0) {
          if (JSON.parse(data.toString('utf8')).type !== 'e2ee_ready') return fail(new Error('no e2ee_ready'))
          stage = 1
          socket.send(channel.seal(Buffer.from(JSON.stringify({ type: 'e2ee_auth', deviceToken: offer.deviceToken }))).toString('base64'))
          return
        }
        const opened = channel.open(Buffer.from(data.toString('utf8'), 'base64'))
        socket.off('message', onHandshake)
        if (!opened || JSON.parse(opened.toString('utf8')).type !== 'e2ee_authenticated') return fail(new Error('authentication failed'))
        clearTimeout(timer)
        socket.removeAllListeners('close')
        socket.removeAllListeners('error')
        socket.on('error', () => {})
        resolve(new RuntimeClient(socket, channel, offer.deviceToken))
      }
      socket.on('message', onHandshake)
    })
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.sendJSON({ id, method, params, deviceToken: this.token })
    })
  }

  /** Starts a stream; `onEvent` also receives the whole reply envelope. */
  subscribe(method: string, params: Record<string, unknown>, onEvent: (event: any, envelope: any) => void): string {
    const id = randomUUID()
    this.streams.set(id, onEvent)
    this.sendJSON({ id, method, params, deviceToken: this.token })
    return id
  }

  stream(method: string, params: Record<string, unknown>): StreamEvents {
    const events = new StreamEvents()
    this.subscribe(method, params, (event, envelope) => events.push(event, envelope))
    return events
  }

  sendFrame(opcode: number, streamId: number, payload: Uint8Array = Buffer.alloc(0)): void {
    this.socket.send(this.channel.seal(encodeFrame(opcode, streamId, 0, payload)), { binary: true })
  }

  close(): void {
    this.socket.close()
  }

  /** Resolves when the server closes the connection. */
  closed(): Promise<void> {
    return new Promise((resolve) => this.socket.once('close', () => resolve()))
  }

  private sendJSON(value: unknown): void {
    this.socket.send(this.channel.seal(Buffer.from(JSON.stringify(value))).toString('base64'))
  }
}

/** A client holding a new grant of `scope`, connected over loopback. */
export async function connectWithGrant(rpc: (method: string, params: Record<string, unknown>) => Promise<any>, scope: 'mobile' | 'runtime'): Promise<RuntimeClient> {
  const { link } = await rpc('slim.pairing.create', { scope, name: `test ${scope}` })
  return RuntimeClient.connect(parsePairingLink(link))
}

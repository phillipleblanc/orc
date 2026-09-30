import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import type { Devices, Device } from './devices.ts'
import { E2EEChannel, type ServerKeypair } from './e2ee.ts'
import { RpcError, type CallContext, type Handlers } from './rpc-server.ts'
import { decodeFrame, type TerminalFrame } from './terminal-frames.ts'

export type StreamContext = CallContext & {
  device: Device
  sendBinary(frame: Uint8Array): void
  /** Receives binary terminal frames for `streamId` until the returned function is called. */
  onFrames(streamId: number, handler: (frame: TerminalFrame) => void): () => void
  onClose(handler: () => void): void
}

/** Emits events until the returned promise settles; the client then receives `{type: 'end'}`. */
export type StreamingHandler = (params: Record<string, any>, context: StreamContext, emit: (event: Record<string, unknown>) => void) => Promise<void>

export type WebSocketOptions = {
  /** Listens on every interface; 0 picks a free port. */
  port: number
  keypair: ServerKeypair
  devices: Devices
  runtimeId: string
  handlers: Handlers
  streaming: Record<string, StreamingHandler>
  /** Methods a mobile-scope device may call. */
  mobileMethods: Set<string>
  /** Methods served to mobile-scope devices only; each must also be in `mobileMethods`. */
  mobileHandlers: Handlers
  mobileStreaming: Record<string, StreamingHandler>
}

const HANDSHAKE_TIMEOUT_MS = 10_000
const MAX_MESSAGE_BYTES = 16 << 20

/**
 * Orca-compatible runtime WebSocket: an E2EE v1 handshake authenticated by a paired device token,
 * then encrypted JSON RPC in text frames and encrypted terminal stream frames in binary frames.
 */
export class WebSocketRpcServer {
  private readonly options: WebSocketOptions
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  private readonly server: Server
  private readonly devicesByConnection = new Map<WebSocket, () => Device | null>()
  port = 0

  constructor(options: WebSocketOptions) {
    this.options = options
    this.port = options.port
    this.server = createServer((_request, response) => response.writeHead(426).end())
    this.server.on('upgrade', (request, socket, head) => this.sockets.handleUpgrade(request, socket, head, (ws) => this.accept(ws)))
  }

  /** Starts listening; returns the port. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '0.0.0.0', () => {
        this.server.off('error', reject)
        const address = this.server.address()
        if (typeof address === 'object' && address) this.port = address.port
        resolve(this.port)
      })
    })
  }

  /** Closes every connection authenticated as `deviceId`. */
  disconnectDevice(deviceId: string): void {
    for (const [socket, device] of this.devicesByConnection) {
      if (device()?.deviceId === deviceId) socket.close(4001, 'revoked')
    }
  }

  async close(): Promise<void> {
    for (const client of this.sockets.clients) client.terminate()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private accept(socket: WebSocket): void {
    const connectionId = randomUUID()
    let channel: E2EEChannel | null = null
    let device: Device | null = null
    const frameHandlers = new Map<number, (frame: TerminalFrame) => void>()
    const closeHandlers: (() => void)[] = []
    const timer = setTimeout(() => socket.close(4003, 'handshake timeout'), HANDSHAKE_TIMEOUT_MS)
    const sendJSON = (value: unknown) => {
      if (channel && socket.readyState === socket.OPEN) socket.send(channel.seal(Buffer.from(JSON.stringify(value))).toString('base64'))
    }
    const context = (): StreamContext => ({
      connectionId,
      scope: device!.scope,
      device: device!,
      sendBinary: (frame) => { if (channel && socket.readyState === socket.OPEN) socket.send(channel.seal(frame), { binary: true }) },
      onFrames: (streamId, handler) => {
        frameHandlers.set(streamId, handler)
        return () => { if (frameHandlers.get(streamId) === handler) frameHandlers.delete(streamId) }
      },
      onClose: (handler) => closeHandlers.push(handler)
    })

    this.devicesByConnection.set(socket, () => device)
    socket.on('close', () => {
      clearTimeout(timer)
      this.devicesByConnection.delete(socket)
      for (const handler of closeHandlers.splice(0)) handler()
    })
    socket.on('error', () => {})
    socket.on('message', (data: RawData, isBinary: boolean) => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)])
      if (!channel) {
        const hello = parseJSON(bytes)
        const key = typeof hello?.publicKeyB64 === 'string' ? Buffer.from(hello.publicKeyB64, 'base64') : null
        if (isBinary || hello?.type !== 'e2ee_hello' || key?.length !== 32) return socket.close(4001, 'expected e2ee_hello')
        channel = new E2EEChannel(key, this.options.keypair.secretKey)
        socket.send(JSON.stringify({ type: 'e2ee_ready' }))
        return
      }
      const opened = channel.open(isBinary ? bytes : Buffer.from(bytes.toString('utf8'), 'base64'))
      if (!opened) return socket.close(4003, 'decryption failed')
      if (!device) {
        const auth = parseJSON(opened)
        const found = auth?.type === 'e2ee_auth' && typeof auth.deviceToken === 'string' ? this.options.devices.find(auth.deviceToken) : undefined
        if (!found) {
          sendJSON({ type: 'e2ee_error', error: { code: 'unauthorized' } })
          return socket.close(4001, 'unauthorized')
        }
        device = found
        clearTimeout(timer)
        void this.options.devices.seen(found)
        sendJSON({ type: 'e2ee_authenticated' })
        return
      }
      if (isBinary) {
        const frame = decodeFrame(opened)
        if (frame) frameHandlers.get(frame.streamId)?.(frame)
        return
      }
      void this.dispatch(parseJSON(opened), device, sendJSON, context)
    })
  }

  private async dispatch(request: Record<string, any> | null, device: Device, sendJSON: (value: unknown) => void, context: () => StreamContext): Promise<void> {
    const id = request?.id ?? null
    const meta = { runtimeId: this.options.runtimeId }
    try {
      if (!request || typeof request.method !== 'string') throw new RpcError('invalid_request', 'malformed request')
      if (request.deviceToken !== device.token) throw new RpcError('unauthorized', 'device token does not match this connection')
      const mobile = device.scope === 'mobile'
      if (mobile && !this.options.mobileMethods.has(request.method)) throw new RpcError('forbidden', `${request.method} is not available to mobile devices`)
      const params = (request.params ?? {}) as Record<string, any>
      const streaming = this.options.streaming[request.method] ?? (mobile ? this.options.mobileStreaming[request.method] : undefined)
      if (streaming) {
        await streaming(params, context(), (event) => sendJSON({ id, ok: true, streaming: true, result: event, _meta: meta }))
        sendJSON({ id, ok: true, streaming: true, result: { type: 'end' }, _meta: meta })
        return
      }
      const handler = this.options.handlers[request.method] ?? (mobile ? this.options.mobileHandlers[request.method] : undefined)
      if (!handler) throw new RpcError('method_not_found', `Unknown method: ${request.method}`)
      const result = (await handler(params, context())) ?? {}
      // Orca stamps the caller's grant scope onto status replies.
      const stamped = request.method === 'status.get' ? { ...(result as object), deviceScope: device.scope } : result
      sendJSON({ id, ok: true, result: stamped, _meta: meta })
    } catch (error) {
      const code = (error as { code?: unknown }).code ? String((error as { code: unknown }).code) : 'internal_error'
      sendJSON({ id, ok: false, error: { code, message: (error as Error).message }, _meta: meta })
    }
  }
}

function parseJSON(bytes: Buffer): Record<string, any> | null {
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

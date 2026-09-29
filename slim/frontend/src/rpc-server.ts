import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, unlink } from 'node:fs/promises'

export class RpcError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** Who is calling: the owner over the local socket, or a paired device over the WebSocket. */
export type CallContext = {
  connectionId: string
  scope: 'local' | 'runtime' | 'mobile'
  /** Runs when the caller's connection closes. */
  onClose(handler: () => void): void
}

export type Handler = (params: Record<string, any>, context: CallContext) => Promise<unknown> | unknown
export type Handlers = Record<string, Handler>

const MAX_LINE = 1 << 20

/**
 * Orca-compatible local RPC: newline-delimited JSON requests `{id, authToken, method, params}` answered
 * with `{id, ok, result | error{code, message}, _meta{runtimeId}}`. A connection may carry many requests.
 */
export class UnixRpcServer {
  private readonly server: Server
  private readonly path: string
  private readonly token: Buffer
  private readonly runtimeId: string
  private readonly handlers: Handlers

  constructor(path: string, authToken: string, runtimeId: string, handlers: Handlers) {
    this.path = path
    this.token = Buffer.from(authToken)
    this.runtimeId = runtimeId
    this.handlers = handlers
    this.server = createServer((socket) => this.accept(socket))
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.path, () => {
        this.server.off('error', reject)
        chmod(this.path, 0o600).then(() => resolve(), reject)
      })
    })
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    await unlink(this.path).catch(() => {})
  }

  private accept(socket: Socket): void {
    const closeHandlers: (() => void)[] = []
    socket.on('close', () => { for (const handler of closeHandlers.splice(0)) handler() })
    const context: CallContext = { connectionId: `local-${randomUUID()}`, scope: 'local', onClose: (handler) => closeHandlers.push(handler) }
    let buffered = ''
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', (chunk: string) => {
      buffered += chunk
      if (buffered.length > MAX_LINE && !buffered.includes('\n')) {
        socket.destroy()
        return
      }
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (line.trim()) void this.handle(line, socket, context)
      }
    })
  }

  private async handle(line: string, socket: Socket, context: CallContext): Promise<void> {
    let id: unknown = null
    const reply = (body: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(JSON.stringify({ id, ...body, _meta: { runtimeId: this.runtimeId } }) + '\n')
    }
    try {
      const request = JSON.parse(line) as { id?: unknown; authToken?: unknown; method?: unknown; params?: unknown }
      id = request.id ?? null
      const token = Buffer.from(typeof request.authToken === 'string' ? request.authToken : '')
      if (token.length !== this.token.length || !timingSafeEqual(token, this.token)) throw new RpcError('unauthorized', 'invalid auth token')
      const handler = typeof request.method === 'string' ? this.handlers[request.method] : undefined
      if (!handler) throw new RpcError('method_not_found', `Unknown method: ${String(request.method)}`)
      const result = await handler((request.params ?? {}) as Record<string, any>, context)
      reply({ ok: true, result: result ?? {} })
    } catch (error) {
      const code = error instanceof RpcError || (error as { code?: unknown }).code ? String((error as { code: unknown }).code) : 'internal_error'
      reply({ ok: false, error: { code, message: (error as Error).message } })
    }
  }
}

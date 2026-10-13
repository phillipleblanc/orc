import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createConnection } from 'node:net'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { splitLines } from '../lines.ts'

const CHAT_DIR = fileURLToPath(new URL('../chat/', import.meta.url))
// ES module builds of the libraries the views import from `/chat/vendor/`.
const VENDOR: Record<string, string> = {
  'marked.js': fileURLToPath(import.meta.resolve('marked')),
  'purify.js': fileURLToPath(import.meta.resolve('dompurify'))
}
// The libraries bundled by scripts/build-chat-vendor.mjs, served under `/chat/vendor/diffs/`. The Workbench does
// without them when they are not built.
const BUNDLE_DIR = fileURLToPath(new URL('../../build/chat-vendor/', import.meta.url))
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf'
}

/**
 * The Workbench, the chat view of durable agents, for Orc's web views and a browser on this computer. Serves
 * it under `/chat/` on 127.0.0.1, and relays `/chat/socket?session=NAME&token=TOKEN` WebSockets to the
 * named agent's worker socket, one JSON message per frame. The token changes with every frontend and
 * is handed out over the owner-only RPC socket.
 */
export class ChatServer {
  readonly token = randomBytes(24).toString('hex')
  private readonly socketFor: (name: string) => string | null
  private readonly http: Server
  private readonly sockets = new WebSocketServer({ noServer: true })
  port = 0

  constructor(socketFor: (name: string) => string | null) {
    this.socketFor = socketFor
    this.http = createServer((request, response) => void this.serve(request, response))
    this.http.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const target = url.pathname === '/chat/socket' && this.authorized(url.searchParams.get('token'))
        ? this.socketFor(url.searchParams.get('session') ?? '') : null
      if (!target) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      this.sockets.handleUpgrade(request, socket, head, (client) => relay(client, target))
    })
  }

  /**
   * Listens on `port` when it is free, so the Workbench keeps its origin, and with it the transcripts it keeps in
   * the browser; otherwise on any free port.
   */
  async listen(port = 0): Promise<void> {
    try {
      await this.bind(port)
    } catch (error) {
      if (!port || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      await this.bind(0)
    }
  }

  private bind(port: number): Promise<void> {
    return new Promise((resolveListen, reject) => {
      this.http.once('error', reject)
      this.http.listen(port, '127.0.0.1', () => {
        this.http.off('error', reject)
        this.port = (this.http.address() as { port: number }).port
        resolveListen()
      })
    })
  }

  close(): Promise<void> {
    for (const client of this.sockets.clients) client.terminate()
    return new Promise((resolveClose) => this.http.close(() => resolveClose()))
  }

  /** The Workbench's address for a durable agent session. */
  url(session: string): string {
    return `http://127.0.0.1:${this.port}/chat/workbench/?session=${encodeURIComponent(session)}&token=${this.token}`
  }

  private authorized(token: string | null): boolean {
    const given = Buffer.from(token ?? '')
    const expected = Buffer.from(this.token)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.method !== 'GET' || !url.pathname.startsWith('/chat/')) return end(response, 404)
    const relative = decodeURIComponent(url.pathname.slice('/chat/'.length))
    const within = (dir: string, path: string) => path.startsWith(dir.endsWith(sep) ? dir : dir + sep)
    const bundled = relative.startsWith('vendor/diffs/') ? resolve(BUNDLE_DIR, relative.slice('vendor/diffs/'.length)) : null
    const file = bundled ?? (relative.startsWith('vendor/') ? VENDOR[relative.slice('vendor/'.length)]
      : resolve(CHAT_DIR, relative.endsWith('/') || relative === '' ? `${relative}index.html` : relative))
    if (!file || (bundled ? !within(BUNDLE_DIR, file) : !relative.startsWith('vendor/') && !within(CHAT_DIR, file))) return end(response, 404)
    try {
      const body = await readFile(file)
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      response.end(body)
    } catch {
      end(response, 404)
    }
  }
}

function end(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'content-type': 'text/plain' })
  response.end(status === 404 ? 'Not found' : '')
}

/** Joins a view's WebSocket to the worker's socket: frames become lines and lines become frames. */
function relay(client: WebSocket, path: string): void {
  const worker = createConnection(path)
  worker.setEncoding('utf8')
  worker.on('data', splitLines((line) => {
    if (line) client.send(line)
  }))
  worker.on('error', () => client.close(1011, 'the durable agent is not running'))
  worker.on('close', () => client.close(1011, 'the durable agent stopped'))
  client.on('message', (data) => {
    const text = data.toString()
    if (!text.includes('\n')) worker.write(text + '\n')
  })
  client.on('close', () => worker.destroy())
  client.on('error', () => worker.destroy())
}

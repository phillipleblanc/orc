/**
 * The Orca phone app's bridge, as a page it runs sees it: JSON frames through the `orcaBridge` global, version 1
 * (Orca's mobile/src/mobile-web-shell/bridge). The app holds the connection to the runtime and the device's grant,
 * forwards each request and subscription to the runtime as the phone's, and replaces the page's client id with the
 * device's own.
 */

export type Insets = { top: number; right: number; bottom: number; left: number }

export type Init = {
  sessionId: string
  route?: { pathname: string; params?: Record<string, string> }
  host?: { id: string; name?: string }
  grants: { native: string[] }
  connection: { state: string }
  safeAreaInsets?: Insets
  keyboardInset?: number
  /** The page draws the wide layout's sidebar. */
  ownsHostArea?: boolean
}

/** The client a request names; the app swaps in the device's own id. */
export const CLIENT = { id: 'orca-page-client', type: 'mobile' }

type Channel = { postMessage(data: string): void; onmessage: ((event: { data: string }) => void) | null }
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; parts?: (string | undefined)[] }
type Subscription = { onEvent: (event: any) => void; acked: number; bytes: number }

// The app's window is 256 events or 4 MiB; acking well inside it keeps streams flowing.
const ACK_EVENTS = 32
const ACK_BYTES = 512 * 1024

export class BridgeError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export class Bridge {
  init: Init | null = null
  onInit: (init: Init, fresh: boolean) => void = () => {}
  onBack: () => void = () => {}
  onConnection: (state: string) => void = () => {}
  private readonly channel: Channel
  private readonly pending = new Map<string, Pending>()
  private readonly subscriptions = new Map<string, Subscription>()
  private readyTimer = 0

  constructor(channel: Channel) {
    this.channel = channel
  }

  /** The app's bridge, or null when the page runs anywhere else. */
  static find(): Bridge | null {
    const channel = (globalThis as { orcaBridge?: Channel }).orcaBridge
    return channel && typeof channel.postMessage === 'function' ? new Bridge(channel) : null
  }

  /** Says the page is ready until the app answers with `init`, as the app requires within 10 s of loading. */
  start(): void {
    this.channel.onmessage = (event) => this.receive(event.data)
    let delay = 50
    const ready = () => {
      if (this.init) return
      this.post({ type: 'ready' })
      this.readyTimer = window.setTimeout(ready, delay)
      delay = Math.min(delay * 2, 2000)
    }
    ready()
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    const id = newId()
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.post({ type: 'request', id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  /** Delivers each event of a streaming method until cancelled, then `{type: 'end'}` if the stream ends first. */
  subscribe(method: string, params: unknown, onEvent: (event: any) => void): () => void {
    const id = newId()
    this.subscriptions.set(id, { onEvent, acked: 0, bytes: 0 })
    this.post({ type: 'subscribe', id, method, params })
    return () => {
      if (this.subscriptions.delete(id)) this.post({ type: 'cancel', id, target: 'subscription' })
    }
  }

  notify(name: string, fields: Record<string, unknown> = {}): void {
    this.post({ type: 'notify', name, ...fields })
  }

  can(grant: string): boolean {
    return this.init?.grants.native.includes(grant) ?? false
  }

  private post(frame: Record<string, unknown>): void {
    this.channel.postMessage(JSON.stringify({ v: 1, ...frame }))
  }

  private receive(data: string): void {
    let frame: any
    try { frame = JSON.parse(data) } catch { return }
    switch (frame?.type) {
      case 'init': {
        // Another session id is a new app session: what the old one had in flight is gone.
        const fresh = this.init?.sessionId !== frame.sessionId
        if (fresh && this.init) this.dropAll()
        this.init = frame
        window.clearTimeout(this.readyTimer)
        this.onInit(frame, fresh)
        break
      }
      case 'reply': {
        const pending = this.pending.get(frame.id)
        if (!pending) return
        if (!frame.part) return this.settle(frame.id, frame.payload)
        pending.parts ??= new Array(frame.part.of).fill(undefined)
        pending.parts[frame.part.i] = frame.chunk
        if (pending.parts.some((part) => part === undefined)) return
        let payload: unknown
        try { payload = JSON.parse(pending.parts.join('')) } catch { payload = null }
        this.settle(frame.id, payload)
        break
      }
      case 'error': {
        const error = new BridgeError(frame.error?.code ?? frame.error?.category ?? 'bridge', frame.error?.message ?? 'The Orca app could not deliver this')
        const pending = this.pending.get(frame.id)
        if (pending) {
          this.pending.delete(frame.id)
          pending.reject(error)
        }
        const subscription = this.subscriptions.get(frame.id)
        if (subscription) {
          this.subscriptions.delete(frame.id)
          subscription.onEvent({ type: 'end', reason: error.message })
        }
        break
      }
      case 'event': {
        const subscription = this.subscriptions.get(frame.id)
        if (!subscription) return
        subscription.bytes += data.length
        subscription.onEvent(frame.payload)
        if (frame.seq - subscription.acked >= ACK_EVENTS || subscription.bytes >= ACK_BYTES) {
          subscription.acked = frame.seq
          subscription.bytes = 0
          this.post({ type: 'ack', id: frame.id, seq: frame.seq })
        }
        break
      }
      case 'end': {
        const subscription = this.subscriptions.get(frame.id)
        if (!subscription) return
        this.subscriptions.delete(frame.id)
        subscription.onEvent({ type: 'end', reason: frame.reason })
        break
      }
      case 'state':
        this.onConnection(frame.connection?.state)
        break
      case 'back':
        this.onBack()
        break
    }
  }

  private settle(id: string, payload: any): void {
    const pending = this.pending.get(id)!
    this.pending.delete(id)
    if (payload?.ok === true) pending.resolve(payload.result)
    else pending.reject(new BridgeError(payload?.error?.code ?? 'unknown', payload?.error?.message ?? 'The computer did not answer'))
  }

  private dropAll(): void {
    for (const pending of this.pending.values()) pending.reject(new BridgeError('restarted', 'The Orca app restarted the page'))
    this.pending.clear()
    for (const subscription of this.subscriptions.values()) subscription.onEvent({ type: 'end', reason: 'restarted' })
    this.subscriptions.clear()
  }
}

/**
 * 128 random bits in base64url: the app's 22-character id. The page is not a secure context under the app's custom
 * scheme, so it has `crypto.getRandomValues` but not `crypto.randomUUID`.
 */
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

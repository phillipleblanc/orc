import { StringDecoder } from 'node:string_decoder'
import { RpcError, type Handlers } from './rpc-server.ts'
import type { SessionStore } from './session-store.ts'
import { holdStream, type ConnectionSubscriptions } from './subscriptions.ts'
import { encodeFrame, jsonPayload, Opcode, textPayloads } from './terminal-frames.ts'
import type { Subscriber, TerminalSession } from './terminal-session.ts'
import type { StreamingHandler } from './websocket-server.ts'

// Phones decode each frame on its own, so frames end on character boundaries and stay small.
const FRAME_TEXT_LIMIT = 48 * 1024
const PHONE_SCROLLBACK_ROWS = 1000
// First stream id handed out per connection; `terminal.multiplex` clients choose small ids themselves.
const FIRST_STREAM_ID = 1000
// A PTY keeps a phone's size this long after the last phone stops viewing it, so switching tabs or
// resubscribing to refit does not bounce the desktop's layout.
const RESTORE_DELAY_MS = 300

type Size = { cols: number; rows: number }

/** A phone's viewport, clamped to the sizes a PTY can usefully take. */
export function phoneViewport(viewport: unknown): { cols: number; rows: number } | null {
  const value = viewport as { cols?: unknown; rows?: unknown } | null
  const cols = Number(value?.cols)
  const rows = Number(value?.rows)
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null
  return { cols: Math.min(240, Math.max(20, Math.round(cols))), rows: Math.min(120, Math.max(8, Math.round(rows))) }
}

/**
 * Sizes a session's PTY to the phone that most recently asked. When that phone leaves, the next most
 * recent one's size applies; when the last one leaves, the size from before the first phone returns.
 * A resize from elsewhere in the meantime stands.
 */
class PhoneFits {
  private readonly fits = new Map<TerminalSession, { baseline: Size; applied: Size; viewers: Map<string, Size>; timer?: NodeJS.Timeout }>()

  fit(session: TerminalSession, viewer: string, size: Size): Promise<void> {
    let fit = this.fits.get(session)
    if (!fit) this.fits.set(session, (fit = { baseline: { cols: session.cols, rows: session.rows }, applied: size, viewers: new Map() }))
    clearTimeout(fit.timer)
    fit.viewers.delete(viewer)
    fit.viewers.set(viewer, size)
    fit.applied = size
    return session.resize(size.cols, size.rows)
  }

  viewing(session: TerminalSession, viewer: string): boolean {
    return this.fits.get(session)?.viewers.has(viewer) ?? false
  }

  leave(session: TerminalSession, viewer: string): void {
    const fit = this.fits.get(session)
    if (!fit?.viewers.delete(viewer)) return
    const unchanged = () => session.connected && session.cols === fit.applied.cols && session.rows === fit.applied.rows
    const latest = [...fit.viewers.values()].at(-1)
    if (latest) {
      if (!unchanged()) return
      fit.applied = latest
      void session.resize(latest.cols, latest.rows).catch(() => {})
      return
    }
    fit.timer = setTimeout(() => {
      this.fits.delete(session)
      if (unchanged()) void session.resize(fit.baseline.cols, fit.baseline.rows).catch(() => {})
    }, RESTORE_DELAY_MS)
    fit.timer.unref()
  }
}

/**
 * `terminal.subscribe`, the per-terminal stream the Orca mobile app uses: `subscribed`, a binary
 * snapshot, then binary output. A phone's viewport resizes the PTY to fit it. A subscription with
 * `mobileInputLeaseOnly` carries no output; it only holds the chat composer's input lease open.
 */
export function mobileTerminalMethods(store: SessionStore, subscriptions: ConnectionSubscriptions): { handlers: Handlers; streaming: Record<string, StreamingHandler> } {
  const nextStreamId = new Map<string, number>()
  const phoneFits = new PhoneFits()
  const viewerOf = (connectionId: string, terminal: string, clientId: string) => `${connectionId}|${terminal}:${clientId}`
  return {
    handlers: {
      'terminal.unsubscribe': (params, context) => {
        const unsubscribed = typeof params.subscriptionId === 'string' && subscriptions.cancel(context.connectionId, `terminal:${params.subscriptionId}`)
        return { unsubscribed }
      },
      'terminal.updateViewport': async (params, context) => {
        const session = typeof params.terminal === 'string' ? store.get(params.terminal) : undefined
        if (!session) throw new RpcError('not_found', `no terminal ${String(params.terminal)}`)
        const viewport = phoneViewport(params.viewport)
        if (!viewport) throw new RpcError('invalid_argument', 'viewport is required')
        // Only a phone already viewing the terminal refits it; others resubscribe with their viewport.
        const viewer = viewerOf(context.connectionId, session.handle, String(params.client?.id ?? context.connectionId))
        if (!phoneFits.viewing(session, viewer)) return { updated: false, applied: false, seq: session.appliedOffset }
        await phoneFits.fit(session, viewer, viewport)
        return { updated: true, applied: true, seq: session.appliedOffset }
      }
    },
    streaming: {
      'terminal.subscribe': (params, context, emit) => {
        const terminal = String(params.terminal ?? '')
        const clientId = String(params.client?.id ?? context.connectionId)
        const key = `terminal:${terminal}:${clientId}`
        const session = store.get(terminal)
        if (!session || !session.connected) {
          emit({ type: 'subscribed', streamId: null, lines: [], truncated: false })
          return Promise.resolve()
        }
        if (params.capabilities?.mobileInputLeaseOnly === 1) {
          return holdStream(subscriptions, context, key, (finish) => {
            emit({ type: 'subscribed', streamId: null, lines: [], truncated: false })
            session.once('exit', finish)
            return () => session.off('exit', finish)
          })
        }
        const viewer = viewerOf(context.connectionId, session.handle, clientId)
        const streamId = nextStreamId.get(context.connectionId) ?? FIRST_STREAM_ID
        nextStreamId.set(context.connectionId, streamId + 1)
        context.onClose(() => nextStreamId.delete(context.connectionId))
        const send = (opcode: number, seq: number, payload?: Uint8Array) => context.sendBinary(encodeFrame(opcode, streamId, seq, payload))
        const viewport = params.client?.type === 'mobile' ? phoneViewport(params.viewport) : null
        return holdStream(subscriptions, context, key, (finish) => {
          const decoder = new StringDecoder('utf8')
          let subscribed = false
          let active = true
          const subscriber: Subscriber = {
            snapshot: (screen) => {
              if (!subscribed) {
                subscribed = true
                emit({ type: 'subscribed', streamId, lines: [], truncated: false, cols: screen.cols, rows: screen.rows, displayMode: 'auto', seq: screen.offset })
              }
              send(Opcode.SnapshotStart, screen.offset, jsonPayload({
                kind: 'scrollback', cols: screen.cols, rows: screen.rows, displayMode: 'auto', seq: screen.offset, truncated: false, truncatedByByteBudget: false
              }))
              for (const chunk of textPayloads(screen.data, FRAME_TEXT_LIMIT)) send(Opcode.SnapshotChunk, screen.offset, chunk)
              send(Opcode.SnapshotEnd, screen.offset)
            },
            output: (bytes, offset) => {
              const text = decoder.write(bytes)
              if (text) for (const chunk of textPayloads(text, FRAME_TEXT_LIMIT)) send(Opcode.Output, offset, chunk)
            },
            resized: (cols, rows) => send(Opcode.Resized, session.appliedOffset,
              jsonPayload({ cols, rows, displayMode: 'auto', reason: 'resize', seq: session.appliedOffset })),
            exited: () => finish()
          }
          void (async () => {
            if (viewport) {
              await phoneFits.fit(session, viewer, viewport).catch(() => {})
              if (!active) return
            }
            if (active) await session.subscribe(subscriber, PHONE_SCROLLBACK_ROWS)
          })()
          return () => {
            active = false
            session.unsubscribe(subscriber)
            phoneFits.leave(session, viewer)
          }
        })
      }
    }
  }
}

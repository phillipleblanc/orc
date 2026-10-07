import { StringDecoder } from 'node:string_decoder'
import { RpcError, type Handlers } from './rpc-server.ts'
import type { SessionStore } from './session-store.ts'
import { holdStream, type ConnectionSubscriptions } from './subscriptions.ts'
import { encodeFrame, jsonPayload, Opcode, textPayloads } from './terminal-frames.ts'
import type { TerminalSizes } from './terminal-sizes.ts'
import type { Subscriber } from './terminal-session.ts'
import type { StreamingHandler } from './websocket-server.ts'

// Phones decode each frame on its own, so frames end on character boundaries and stay small.
const FRAME_TEXT_LIMIT = 48 * 1024
const PHONE_SCROLLBACK_ROWS = 1000
// First stream id handed out per connection; `terminal.multiplex` clients choose small ids themselves.
const FIRST_STREAM_ID = 1000
/** A phone's viewport, clamped to the sizes a PTY can usefully take. */
export function phoneViewport(viewport: unknown): { cols: number; rows: number } | null {
  const value = viewport as { cols?: unknown; rows?: unknown } | null
  const cols = Number(value?.cols)
  const rows = Number(value?.rows)
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null
  return { cols: Math.min(240, Math.max(20, Math.round(cols))), rows: Math.min(120, Math.max(8, Math.round(rows))) }
}

/**
 * `terminal.subscribe`, the per-terminal stream the Orca mobile app uses: `subscribed`, a binary
 * snapshot, then binary output. A phone's viewport resizes the PTY to fit it, ahead of any desktop (see `TerminalSizes`). A subscription with
 * `mobileInputLeaseOnly` carries no output; it only holds the chat composer's input lease open.
 */
export function mobileTerminalMethods(store: SessionStore, subscriptions: ConnectionSubscriptions, sizes: TerminalSizes): { handlers: Handlers; streaming: Record<string, StreamingHandler> } {
  const nextStreamId = new Map<string, number>()
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
        if (!sizes.viewing(session, viewer)) return { updated: false, applied: false, seq: session.appliedOffset }
        await sizes.phoneFit(session, viewer, viewport)
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
              await sizes.phoneFit(session, viewer, viewport).catch(() => {})
              if (!active) return
            }
            if (active) await session.subscribe(subscriber, PHONE_SCROLLBACK_ROWS)
          })()
          return () => {
            active = false
            session.unsubscribe(subscriber)
            sizes.phoneLeft(session, viewer)
          }
        })
      }
    }
  }
}

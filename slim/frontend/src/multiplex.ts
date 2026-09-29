import type { SessionStore } from './session-store.ts'
import type { Subscriber, TerminalSession } from './terminal-session.ts'
import type { StreamingHandler } from './websocket-server.ts'
import { encodeFrame, jsonPayload, Opcode, textPayloads, type TerminalFrame } from './terminal-frames.ts'

const MAX_SCROLLBACK_ROWS = 5000

type Stream = { session: TerminalSession; subscriber: Subscriber; stopFrames: () => void }

/**
 * `terminal.multiplex`: many terminal subscriptions over one connection. The client subscribes with a
 * binary Subscribe frame on stream 0; each subscription then receives a snapshot followed by its
 * output, and can claim the PTY size, request a snapshot with scrollback, send input, or unsubscribe.
 */
export function terminalMultiplex(store: SessionStore): StreamingHandler {
  return (_params, context, emit) => new Promise<void>((resolve) => {
    const streams = new Map<number, Stream>()
    const send = (opcode: number, streamId: number, seq: number, payload?: Uint8Array) => context.sendBinary(encodeFrame(opcode, streamId, seq, payload))

    const stop = (streamId: number) => {
      const stream = streams.get(streamId)
      if (!stream) return
      streams.delete(streamId)
      stream.session.unsubscribe(stream.subscriber)
      stream.stopFrames()
    }

    const subscribe = async (frame: TerminalFrame) => {
      let request: { streamId?: number; terminal?: string; client?: { type?: string } }
      try { request = JSON.parse(frame.payload.toString('utf8')) } catch { return }
      const streamId = Number(request.streamId)
      if (!Number.isInteger(streamId) || streamId <= 0 || streams.has(streamId)) return
      const session = typeof request.terminal === 'string' ? store.get(request.terminal) : undefined
      if (!session || !session.connected) {
        send(Opcode.Error, streamId, 0, jsonPayload({ code: 'terminal_not_found', message: `no running terminal ${request.terminal}` }))
        return
      }
      let subscribed = false
      const subscriber: Subscriber = {
        snapshot: (screen) => {
          if (!subscribed) {
            subscribed = true
            emit({ type: 'subscribed', streamId, terminal: session.handle, cols: screen.cols, rows: screen.rows, seq: screen.offset })
          }
          send(Opcode.SnapshotStart, streamId, screen.offset, jsonPayload({
            kind: 'scrollback', cols: screen.cols, rows: screen.rows, seq: screen.offset,
            kittyKeyboardFlags: screen.kittyKeyboardFlags, alternateScreen: screen.alternateScreen
          }))
          for (const chunk of textPayloads(screen.data)) send(Opcode.SnapshotChunk, streamId, screen.offset, chunk)
          send(Opcode.SnapshotEnd, streamId, screen.offset)
        },
        output: (bytes, offset) => send(Opcode.Output, streamId, offset, bytes),
        resized: (cols, rows) => send(Opcode.Resized, streamId, 0, jsonPayload({ cols, rows })),
        exited: () => {
          emit({ type: 'end', streamId, terminal: session.handle })
          stop(streamId)
        }
      }
      const stopFrames = context.onFrames(streamId, (slot) => {
        const stream = streams.get(streamId)
        if (!stream) return
        switch (slot.opcode) {
          case Opcode.Input:
            stream.session.input(Buffer.from(slot.payload))
            break
          case Opcode.ClaimViewport: {
            const size = parseSize(slot.payload)
            if (size) void stream.session.resize(size.cols, size.rows).catch(() => {})
            break
          }
          case Opcode.SnapshotRequest: {
            const rows = Math.min(MAX_SCROLLBACK_ROWS, Math.max(0, Number(parseObject(slot.payload).scrollbackRows ?? MAX_SCROLLBACK_ROWS) || 0))
            void stream.session.resnapshot(stream.subscriber, rows)
            break
          }
          case Opcode.Unsubscribe:
            stop(streamId)
            break
        }
      })
      streams.set(streamId, { session, subscriber, stopFrames })
      // Desktop clients receive the viewport first and ask for scrollback once it is on screen.
      await session.subscribe(subscriber, 0)
    }

    const stopControl = context.onFrames(0, (frame) => {
      if (frame.opcode === Opcode.Subscribe) void subscribe(frame)
    })
    context.onClose(() => {
      stopControl()
      for (const streamId of [...streams.keys()]) stop(streamId)
      resolve()
    })
    emit({ type: 'ready' })
  })
}

function parseObject(payload: Buffer): Record<string, unknown> {
  try {
    const value = JSON.parse(payload.toString('utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function parseSize(payload: Buffer): { cols: number; rows: number } | null {
  const value = parseObject(payload)
  const cols = Number(value.cols)
  const rows = Number(value.rows)
  return Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && cols <= 1000 && rows >= 1 && rows <= 500 ? { cols, rows } : null
}

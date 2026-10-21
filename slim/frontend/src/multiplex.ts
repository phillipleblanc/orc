import type { AgentDirectory } from './agents.ts'
import { viewedRecords } from './program-status.ts'
import type { SessionStore } from './session-store.ts'
import type { Subscriber, TerminalSession } from './terminal-session.ts'
import type { Size, TerminalSizes } from './terminal-sizes.ts'
import type { StreamingHandler } from './websocket-server.ts'
import { encodeFrame, jsonPayload, Opcode, textPayloads, type TerminalFrame } from './terminal-frames.ts'

const MAX_SCROLLBACK_ROWS = 5000
/** How viewers name a desktop that connected over the local socket, which has no device grant. */
export const LOCAL_DEVICE = 'this host'

type Stream = {
  session: TerminalSession; subscriber: Subscriber; stopFrames: () => void; viewer: string; followsOwnership: boolean
  /** For a subscription that asked for program status: when it attached, and the last status it was sent. */
  status: { since: number; sent: string } | null
  programStatusChanged: () => void
}

/**
 * `terminal.multiplex`: many terminal subscriptions over one connection. The client subscribes with a
 * binary Subscribe frame on stream 0; each subscription then receives a snapshot followed by its
 * output, and can claim the PTY size, request a snapshot with scrollback, send input, or unsubscribe.
 * A subscription is a desktop viewer of its session (see `TerminalSizes`), named by its client id. One
 * that opts into viewport ownership reports its size with ClaimViewport, and its Resized frames say
 * whether it owns the session and which device does. One that asks for program status receives ProgramStatus
frames with the records a terminal attached to the session shows (`viewedRecords`), whole, when it subscribes and
whenever they change.
 */
export function terminalMultiplex(store: SessionStore, sizes: TerminalSizes, agents: AgentDirectory): StreamingHandler {
  return (_params, context, emit) => new Promise<void>((resolve) => {
    const streams = new Map<number, Stream>()
    const send = (opcode: number, streamId: number, seq: number, payload?: Uint8Array) => context.sendBinary(encodeFrame(opcode, streamId, seq, payload))
    const device = context.device.name
    const resized = (streamId: number, stream: Pick<Stream, 'session' | 'viewer' | 'followsOwnership'>, cols: number, rows: number) => {
      const owner = stream.followsOwnership ? sizes.owner(stream.session) : undefined
      send(Opcode.Resized, streamId, 0, jsonPayload(owner === undefined ? { cols, rows }
        : { cols, rows, owner: owner?.clientId === stream.viewer, ...(owner ? { ownerDevice: owner.device ?? LOCAL_DEVICE } : {}) }))
    }
    // Opted-in viewers learn of a new owner even when the PTY keeps its size.
    const ownerChanged = (session: TerminalSession) => {
      for (const [streamId, stream] of streams) {
        if (stream.session === session && stream.followsOwnership) resized(streamId, stream, session.cols, session.rows)
      }
    }
    sizes.on('owner', ownerChanged)
    const sendStatus = (streamId: number, stream: Stream) => {
      if (!stream.status) return
      const monitor = agents.monitor(stream.session)
      const agent = monitor && { kind: monitor.kind, state: monitor.effectiveState, lastIdleAt: monitor.lastIdleAt, dialog: monitor.dialog }
      const payload = JSON.stringify({ records: viewedRecords(stream.session.programStatus.list(), agent, stream.status.since) })
      if (payload === stream.status.sent) return
      stream.status.sent = payload
      send(Opcode.ProgramStatus, streamId, 0, Buffer.from(payload))
    }
    const statusChanged = (session: TerminalSession) => {
      for (const [streamId, stream] of streams) if (stream.session === session) sendStatus(streamId, stream)
    }
    agents.on('change', statusChanged)

    const stop = (streamId: number) => {
      const stream = streams.get(streamId)
      if (!stream) return
      streams.delete(streamId)
      stream.session.unsubscribe(stream.subscriber)
      stream.session.off('program-status', stream.programStatusChanged)
      stream.stopFrames()
      void sizes.desktopUnsubscribed(stream.session, stream.viewer).catch(() => {})
    }

    const subscribe = async (frame: TerminalFrame) => {
      let request: { streamId?: number; terminal?: string; client?: { id?: unknown; type?: string }; viewport?: unknown
        capabilities?: { viewportOwnership?: unknown; programStatus?: unknown } }
      try { request = JSON.parse(frame.payload.toString('utf8')) } catch { return }
      const streamId = Number(request.streamId)
      if (!Number.isInteger(streamId) || streamId <= 0 || streams.has(streamId)) return
      const session = typeof request.terminal === 'string' ? store.get(request.terminal) : undefined
      if (!session || !session.connected) {
        send(Opcode.Error, streamId, 0, jsonPayload({ code: 'terminal_not_found', message: `no running terminal ${request.terminal}` }))
        return
      }
      const clientId = typeof request.client?.id === 'string' && request.client.id ? request.client.id : null
      const followsOwnership = clientId !== null && request.capabilities?.viewportOwnership === 1
      const viewer = clientId ?? `${context.connectionId}:${streamId}`
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
        resized: (cols, rows) => resized(streamId, { session, viewer, followsOwnership }, cols, rows),
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
            if (size) void (stream.followsOwnership ? sizes.desktopSize(stream.session, stream.viewer, size) : sizes.legacyClaim(stream.session, stream.viewer, size, device)).catch(() => {})
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
      const status = request.capabilities?.programStatus === 1 ? { since: Date.now(), sent: '' } : null
      const stream: Stream = { session, subscriber, stopFrames, viewer, followsOwnership, status, programStatusChanged: () => sendStatus(streamId, stream) }
      streams.set(streamId, stream)
      if (status) session.on('program-status', stream.programStatusChanged)
      void sizes.desktopSubscribed(session, viewer, { legacy: !followsOwnership, device, size: viewportSize(request.viewport) }).catch(() => {})
      // Desktop clients receive the viewport first and ask for scrollback once it is on screen.
      await session.subscribe(subscriber, 0)
      if (streams.get(streamId) === stream) sendStatus(streamId, stream)
    }

    const stopControl = context.onFrames(0, (frame) => {
      if (frame.opcode === Opcode.Subscribe) void subscribe(frame)
    })
    context.onClose(() => {
      stopControl()
      sizes.off('owner', ownerChanged)
      agents.off('change', statusChanged)
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

function parseSize(payload: Buffer): Size | null {
  return viewportSize(parseObject(payload))
}

/** A desktop viewport, or null unless it is a size a PTY can take. */
export function viewportSize(viewport: unknown): Size | null {
  const value = (viewport && typeof viewport === 'object' ? viewport : {}) as Record<string, unknown>
  const cols = Number(value.cols)
  const rows = Number(value.rows)
  return Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && cols <= 1000 && rows >= 1 && rows <= 500 ? { cols, rows } : null
}

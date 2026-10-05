import { RpcError, type Handlers } from '../rpc-server.ts'
import { holdStream, type ConnectionSubscriptions } from '../subscriptions.ts'
import type { StreamingHandler } from '../websocket-server.ts'
import type { NativeChatBlock, NativeChatMessage } from './decoders.ts'
import { DurableFollower, readDurableWindow } from './durable.ts'
import { readWindow, resolveTranscript, transcriptFormat, TranscriptFollower, type TranscriptWindow } from './transcripts.ts'

const DEFAULT_WINDOW = 40
const MAX_WINDOW = 2000
// The app renders a bounded amount of each block.
const TEXT_CAP = 64_000
const BLOCK_CAP = 4000
const TRUNCATED = '\n… (truncated)'

function clip(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) + TRUNCATED : text
}

function clipped(messages: NativeChatMessage[]): NativeChatMessage[] {
  return messages.map((message) => ({
    ...message,
    blocks: message.blocks.map((block): NativeChatBlock => {
      if (block.type === 'text') return { ...block, text: clip(block.text, TEXT_CAP) }
      if (block.type === 'tool-result') return { ...block, output: clip(block.output, BLOCK_CAP) }
      if (block.type === 'tool-call') {
        const input = typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? null)
        return input.length > BLOCK_CAP ? { ...block, input: clip(input, BLOCK_CAP) } : block
      }
      return block
    })
  }))
}

function windowFor(window: TranscriptWindow) {
  return { messages: clipped(window.messages), hasMore: window.hasMore, beforeOffset: window.beforeOffset }
}

function sessionParams(params: Record<string, any>) {
  const format = transcriptFormat(String(params.agent ?? ''))
  if (!format) throw new RpcError('invalid_argument', `native chat does not support ${params.agent}`)
  if (typeof params.sessionId !== 'string' || !params.sessionId) throw new RpcError('invalid_argument', 'sessionId is required')
  const limit = Math.min(MAX_WINDOW, Math.max(1, Number(params.limit ?? DEFAULT_WINDOW) || DEFAULT_WINDOW))
  const transcriptPath = typeof params.transcriptPath === 'string' ? params.transcriptPath : undefined
  return { format, sessionId: params.sessionId as string, limit, transcriptPath }
}

/** The socket of the running durable agent whose conversation this is, or null. */
export type DurableChatResolver = (sessionId: string, transcriptPath: string | undefined) => string | null

/**
 * `nativeChat.*`, the Orca mobile app's chat view: an agent's conversation, decoded from its
 * transcript file, or served by a durable agent's worker.
 */
export function nativeChatMethods(subscriptions: ConnectionSubscriptions, durableSocket: DurableChatResolver = () => null): { handlers: Handlers; streaming: Record<string, StreamingHandler> } {
  return {
    handlers: {
      'nativeChat.readSession': async (params) => {
        const { format, sessionId, limit, transcriptPath } = sessionParams(params)
        const beforeOffset = typeof params.beforeOffset === 'number' ? params.beforeOffset : undefined
        const durable = durableSocket(sessionId, transcriptPath)
        if (durable) return windowFor(await readDurableWindow(durable, limit, beforeOffset))
        const path = await resolveTranscript(format, sessionId, transcriptPath)
        if (!path) return { messages: [], hasMore: false, beforeOffset: 0, error: 'Transcript unavailable', notFound: true }
        return windowFor(await readWindow(path, format, limit, beforeOffset))
      },
      'nativeChat.unsubscribe': (params, context) => {
        if (typeof params.subscriptionId === 'string') subscriptions.cancel(context.connectionId, `nativeChat:${params.subscriptionId}`)
        else subscriptions.cancelPrefix(context.connectionId, 'nativeChat:')
        return { unsubscribed: true }
      }
    },
    streaming: {
      'nativeChat.subscribe': (params, context, emit) => {
        const { format, sessionId, limit, transcriptPath } = sessionParams(params)
        const key = `nativeChat:${typeof params.subscriptionId === 'string' ? params.subscriptionId : `${params.agent}:${sessionId}`}`
        const announcePending = params.capabilities?.transcriptPending === 1
        return holdStream(subscriptions, context, key, () => {
          const listener = {
            pending: () => { if (announcePending) emit({ type: 'snapshot', messages: [], hasMore: false, pending: true }) },
            snapshot: (window: TranscriptWindow) => emit({ type: 'snapshot', ...windowFor(window) }),
            replacement: (window: TranscriptWindow) => emit({ type: 'replacement', ...windowFor(window) }),
            appended: (messages: NativeChatMessage[]) => emit({ type: 'appended', messages: clipped(messages) }),
            error: (message: string) => emit({ type: 'error', message })
          }
          const durable = durableSocket(sessionId, transcriptPath)
          if (durable) {
            const follower = new DurableFollower(durable, limit, listener)
            follower.start()
            return () => follower.stop()
          }
          const follower = new TranscriptFollower(format, sessionId, transcriptPath, limit, listener)
          void follower.start().catch((error: Error) => emit({ type: 'snapshot', messages: [], hasMore: false, error: error.message }))
          return () => follower.stop()
        })
      }
    }
  }
}

import { RpcError, type CallContext, type Handlers } from '../rpc-server.ts'
import { holdStream, type ConnectionSubscriptions } from '../subscriptions.ts'
import type { StreamingHandler } from '../websocket-server.ts'
import type { NativeChatBlock, NativeChatMessage } from './decoders.ts'
import { readWindow, resolveTranscript, transcriptFormat, TranscriptFollower, type TranscriptWindow } from './transcripts.ts'

const DEFAULT_WINDOW = 40
const MAX_WINDOW = 2000
// Phones render a bounded amount of each block.
const MOBILE_TEXT_CAP = 64_000
const MOBILE_BLOCK_CAP = 4000
const TRUNCATED = '\n… (truncated)'

function clip(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) + TRUNCATED : text
}

function forClient(messages: NativeChatMessage[], scope: CallContext['scope']): NativeChatMessage[] {
  if (scope !== 'mobile') return messages
  return messages.map((message) => ({
    ...message,
    blocks: message.blocks.map((block): NativeChatBlock => {
      if (block.type === 'text') return { ...block, text: clip(block.text, MOBILE_TEXT_CAP) }
      if (block.type === 'tool-result') return { ...block, output: clip(block.output, MOBILE_BLOCK_CAP) }
      if (block.type === 'tool-call') {
        const input = typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? null)
        return input.length > MOBILE_BLOCK_CAP ? { ...block, input: clip(input, MOBILE_BLOCK_CAP) } : block
      }
      return block
    })
  }))
}

function windowFor(window: TranscriptWindow, scope: CallContext['scope']) {
  return { messages: forClient(window.messages, scope), hasMore: window.hasMore, beforeOffset: window.beforeOffset }
}

function sessionParams(params: Record<string, any>) {
  const format = transcriptFormat(String(params.agent ?? ''))
  if (!format) throw new RpcError('invalid_argument', `native chat does not support ${params.agent}`)
  if (typeof params.sessionId !== 'string' || !params.sessionId) throw new RpcError('invalid_argument', 'sessionId is required')
  const limit = Math.min(MAX_WINDOW, Math.max(1, Number(params.limit ?? DEFAULT_WINDOW) || DEFAULT_WINDOW))
  const transcriptPath = typeof params.transcriptPath === 'string' ? params.transcriptPath : undefined
  return { format, sessionId: params.sessionId as string, limit, transcriptPath }
}

/** `nativeChat.*`: an agent's conversation, decoded from its transcript file. */
export function nativeChatMethods(subscriptions: ConnectionSubscriptions): { handlers: Handlers; streaming: Record<string, StreamingHandler> } {
  return {
    handlers: {
      'nativeChat.readSession': async (params, context) => {
        const { format, sessionId, limit, transcriptPath } = sessionParams(params)
        const path = await resolveTranscript(format, sessionId, transcriptPath)
        if (!path) return { messages: [], hasMore: false, beforeOffset: 0, error: 'Transcript unavailable', notFound: true }
        const beforeOffset = typeof params.beforeOffset === 'number' ? params.beforeOffset : undefined
        return windowFor(await readWindow(path, format, limit, beforeOffset), context.scope)
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
          const follower = new TranscriptFollower(format, sessionId, transcriptPath, limit, {
            pending: () => { if (announcePending) emit({ type: 'snapshot', messages: [], hasMore: false, pending: true }) },
            snapshot: (window) => emit({ type: 'snapshot', ...windowFor(window, context.scope) }),
            replacement: (window) => emit({ type: 'replacement', ...windowFor(window, context.scope) }),
            appended: (messages) => emit({ type: 'appended', messages: forClient(messages, context.scope) }),
            error: (message) => emit({ type: 'error', message })
          })
          void follower.start().catch((error: Error) => emit({ type: 'snapshot', messages: [], hasMore: false, error: error.message }))
          return () => follower.stop()
        })
      }
    }
  }
}

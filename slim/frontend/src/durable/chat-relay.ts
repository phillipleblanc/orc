import { createConnection } from 'node:net'
import { splitLines } from '../lines.ts'
import { RpcError, type Handlers } from '../rpc-server.ts'
import { holdStream, type ConnectionSubscriptions } from '../subscriptions.ts'
import type { StreamingHandler } from '../websocket-server.ts'
import { durableRequest } from './connection.ts'

// The worker requests a chat view over the WebSocket may make; `upgrade` restarts the worker and stays Orc's.
const REQUESTS = new Set(['history', 'submit', 'abort', 'withdraw', 'compact', 'reset', 'configure', 'info', 'models'])
/**
 * A stream ends once its lease has not been renewed for this long. The phone app drops a page's streams without
 * telling the runtime, so a page renews its lease while it shows the chat.
 */
export const LEASE_MS = 30_000
// The phone app ends a stream whose event is over 640 KiB. A worker message longer than this many UTF-16 units goes in
// parts; each unit of JSON text is at most three bytes of UTF-8 when sent again inside a string.
export const PART_UNITS = 160 * 1024

/**
 * A durable agent's conversation for chat views that reach the runtime over its WebSocket, as the phone page does:
 * `durable.subscribe` relays the worker's subscription (see worker.ts) under a lease the view names, and
 * `durable.request` makes one request of the worker.
 */
export function durableChatMethods(socketFor: (session: string) => string | null, subscriptions: ConnectionSubscriptions, leaseMs = LEASE_MS): {
  handlers: Handlers
  streaming: Record<string, StreamingHandler>
} {
  const renewals = new Map<string, number>()
  const workerSocket = (session: unknown) => {
    const path = socketFor(String(session ?? ''))
    if (!path) throw new RpcError('not_found', `${String(session ?? '')} is not a durable agent session`)
    return path
  }
  const leaseOf = (params: Record<string, any>) => {
    if (typeof params.lease !== 'string' || !params.lease) throw new RpcError('invalid_argument', 'lease is required')
    return params.lease
  }
  return {
    handlers: {
      'durable.request': (params) => {
        const method = String(params.method ?? '')
        if (!REQUESTS.has(method)) throw new RpcError('forbidden', `${method} is not available to chat views`)
        const path = workerSocket(params.session)
        const request = params.params && typeof params.params === 'object' ? params.params : {}
        return durableRequest(path, method, request, method === 'history' ? 30_000 : 10_000).catch((error: Error) => {
          throw new RpcError('agent_error', error.message)
        })
      },
      'durable.renew': (params, context) => {
        const key = `${context.connectionId}:${leaseOf(params)}`
        const renewed = renewals.has(key)
        if (renewed) renewals.set(key, Date.now())
        return { renewed }
      },
      'durable.unsubscribe': (params, context) => ({ unsubscribed: subscriptions.cancel(context.connectionId, `durable:${leaseOf(params)}`) })
    },
    streaming: {
      'durable.subscribe': async (params, context, emit) => {
        const path = workerSocket(params.session)
        const lease = leaseOf(params)
        const key = `${context.connectionId}:${lease}`
        const subscribe = { pages: true, ...(params.after === undefined ? {} : { after: params.after, conversation: params.conversation }) }
        await holdStream(subscriptions, context, `durable:${lease}`, (finish) => {
          renewals.set(key, Date.now())
          const expiry = setInterval(() => {
            if (Date.now() - (renewals.get(key) ?? 0) > leaseMs) finish()
          }, leaseMs / 6)
          const worker = createConnection(path)
          worker.setEncoding('utf8')
          worker.on('connect', () => worker.write(JSON.stringify({ id: 1, method: 'subscribe', params: subscribe }) + '\n'))
          worker.on('data', splitLines((line) => {
            if (!line) return
            if (line.length <= PART_UNITS) return emit(JSON.parse(line))
            const count = Math.ceil(line.length / PART_UNITS)
            for (let index = 0; index < count; index++) emit({ type: 'part', index, count, text: line.slice(index * PART_UNITS, (index + 1) * PART_UNITS) })
          }))
          worker.on('error', finish)
          worker.on('close', finish)
          return () => {
            clearInterval(expiry)
            renewals.delete(key)
            worker.destroy()
          }
        })
      }
    }
  }
}

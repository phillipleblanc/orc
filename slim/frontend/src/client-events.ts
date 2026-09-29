import { randomUUID } from 'node:crypto'
import type { Catalog } from './catalog.ts'
import type { Handlers } from './rpc-server.ts'
import { holdStream, type ConnectionSubscriptions } from './subscriptions.ts'
import type { StreamingHandler } from './websocket-server.ts'

/** `runtime.clientEvents.*`: tells clients to refetch workspaces or repositories after a change. */
export function clientEventMethods(catalog: Catalog, subscriptions: ConnectionSubscriptions): { handlers: Handlers; streaming: Record<string, StreamingHandler> } {
  return {
    handlers: {
      'runtime.clientEvents.unsubscribe': (params, context) => {
        const cancelled = typeof params.subscriptionId === 'string'
          ? subscriptions.cancel(context.connectionId, `clientEvents:${params.subscriptionId}`)
          : subscriptions.cancelPrefix(context.connectionId, 'clientEvents:') > 0
        return { unsubscribed: cancelled }
      }
    },
    streaming: {
      'runtime.clientEvents.subscribe': (_params, context, emit) => {
        const subscriptionId = randomUUID()
        return holdStream(subscriptions, context, `clientEvents:${subscriptionId}`, () => {
          let repos = JSON.stringify(catalog.repoRows())
          const changed = () => {
            const next = JSON.stringify(catalog.repoRows())
            emit({ type: next === repos ? 'worktreesChanged' : 'reposChanged' })
            repos = next
          }
          catalog.on('changed', changed)
          emit({ type: 'ready', subscriptionId, snapshot: { sshStates: [] } })
          return () => catalog.off('changed', changed)
        })
      }
    }
  }
}

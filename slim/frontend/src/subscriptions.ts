/**
 * Streams each connection holds, by a key the client can name in an unsubscribe request. A new stream
 * with the same key on the same connection replaces the old one.
 */
export class ConnectionSubscriptions {
  private readonly byConnection = new Map<string, Map<string, () => void>>()

  add(connectionId: string, key: string, cancel: () => void): void {
    let streams = this.byConnection.get(connectionId)
    if (!streams) this.byConnection.set(connectionId, (streams = new Map()))
    const previous = streams.get(key)
    streams.set(key, cancel)
    previous?.()
  }

  /** Forgets a stream that ended by itself, unless it was already replaced. */
  release(connectionId: string, key: string, cancel: () => void): void {
    const streams = this.byConnection.get(connectionId)
    if (streams?.get(key) === cancel) streams.delete(key)
    if (streams?.size === 0) this.byConnection.delete(connectionId)
  }

  cancel(connectionId: string, key: string): boolean {
    const cancel = this.byConnection.get(connectionId)?.get(key)
    cancel?.()
    return Boolean(cancel)
  }

  cancelPrefix(connectionId: string, prefix: string): number {
    const streams = [...(this.byConnection.get(connectionId) ?? new Map<string, () => void>()).entries()].filter(([key]) => key.startsWith(prefix))
    for (const [, cancel] of streams) cancel()
    return streams.length
  }
}

/** Runs a stream until it is cancelled, replaced or its connection closes, then cleans it up. */
export function holdStream(subscriptions: ConnectionSubscriptions, context: { connectionId: string; onClose(handler: () => void): void }, key: string,
  start: (finish: () => void) => (() => void) | void): Promise<void> {
  return new Promise((resolve) => {
    let finished = false
    let cleanup: (() => void) | void = undefined
    const finish = () => {
      if (finished) return
      finished = true
      subscriptions.release(context.connectionId, key, finish)
      try { cleanup?.() } finally { resolve() }
    }
    subscriptions.add(context.connectionId, key, finish)
    context.onClose(finish)
    cleanup = start(finish)
    if (finished) cleanup?.()
  })
}

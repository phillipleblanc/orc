// The connection DurableAgent expects of its WebSocket to the worker, carried by a client that reaches the runtime with
// requests and subscriptions, as the phone page's bridge and Orc.app's relay for another Mac's agents do: the
// subscription as `durable.subscribe` under a lease this socket renews, and each other request as `durable.request`.
// `relay` is `{ request(method, params) → Promise, subscribe(method, params, onEvent) → cancel }`; a subscription's last
// event is `{ type: "end" }`.

// The runtime ends a stream whose lease is not renewed for 30 s.
const RENEW_MS = 10_000

export class RelaySocket {
  constructor(relay, session) {
    this.relay = relay
    this.session = session
    this.readyState = 0
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.lease = leaseId()
    this.cancel = null
    this.renewal = 0
    this.parts = []
    setTimeout(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.()
    })
  }

  send(text) {
    const message = JSON.parse(text)
    if (message.method === 'subscribe') return this.subscribe(message.id, message.params)
    this.relay.request('durable.request', { session: this.session, method: message.method, params: message.params ?? {} }).then(
      (result) => this.deliver({ id: message.id, result }),
      (error) => this.deliver({ id: message.id, error: error.message }))
  }

  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    clearInterval(this.renewal)
    if (this.cancel) {
      this.cancel()
      this.cancel = null
      this.relay.request('durable.unsubscribe', { lease: this.lease }).catch(() => {})
    }
    this.onclose?.()
  }

  subscribe(id, params) {
    this.cancel = this.relay.subscribe('durable.subscribe', { session: this.session, lease: this.lease, ...params }, (event) => {
      if (event?.type === 'end') return this.close()
      // A worker message too long for one event arrives in parts.
      if (event?.type === 'part') {
        this.parts[event.index] = event.text
        if (event.index === event.count - 1) {
          const whole = JSON.parse(this.parts.join(''))
          this.parts = []
          this.deliver(whole)
        }
        return
      }
      // The worker's answer to the subscription itself, under the id the agent asked with.
      if (event?.id !== undefined) return this.deliver(event.error ? { id, error: event.error } : { id, result: event.result })
      this.deliver(event)
    })
    this.renewal = setInterval(() => {
      this.relay.request('durable.renew', { lease: this.lease }).then(({ renewed }) => { if (!renewed) this.close() }, () => {})
    }, RENEW_MS)
  }

  deliver(message) {
    if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(message) })
  }
}

// Not crypto.randomUUID, which a page outside a secure context, as the phone app's is, does not have.
function leaseId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

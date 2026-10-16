import { randomUUID } from 'node:crypto'
import { RpcError } from './rpc-server.ts'

/** A message a session asked Orc to show as a notification (`orc notify`). */
export type SessionNotification = {
  id: string
  /** Its place in the order of notifications since the frontend started, for clients' cursors. */
  seq: number
  /** The name the session gave, or null when `orc notify` ran outside a session. */
  session: string | null
  /** The session's handle, when a session has that name. */
  handle: string | null
  message: string
  at: number
}

export const MAX_MESSAGE = 1000
const MAX_KEPT = 50
// A client without a cursor, or with one older than what is kept, gets the newest few: what arrived while it was away.
const MAX_CATCH_UP = 20
// Orc.app asks for notifications on every refresh, every 2 seconds while it runs.
const DESKTOP_SEEN_MS = 10_000

/**
 * Notifications for desktops, each of which keeps its own cursor (`since`) and shows each as it is, whether or not
 * the session's turn-end notifications are muted. `take` serves clients without a cursor, with one of its own. They
 * are kept in memory, so a frontend restart drops them.
 */
export class NotificationQueue {
  private kept: SessionNotification[] = []
  private seq = 0
  private taken = 0
  private askedAt = 0

  post(session: { name: string; handle: string | null } | null, text: unknown, now = Date.now()): { notification: SessionNotification; appOpen: boolean } {
    if (typeof text !== 'string') throw new RpcError('invalid_argument', 'message must be a string')
    // Line breaks stay; other control characters would show as junk.
    const message = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '').trim()
    if (!message) throw new RpcError('invalid_argument', 'message is empty')
    if (message.length > MAX_MESSAGE) throw new RpcError('invalid_argument', `message is longer than ${MAX_MESSAGE} characters`)
    const notification = { id: randomUUID(), seq: ++this.seq, session: session?.name ?? null, handle: session?.handle ?? null, message, at: now }
    this.kept.push(notification)
    if (this.kept.length > MAX_KEPT) this.kept.splice(0, this.kept.length - MAX_KEPT)
    // Whether a desktop is open to show it.
    return { notification, appOpen: now - this.askedAt < DESKTOP_SEEN_MS }
  }

  /**
   * The notifications after `after`, a cursor from the `latest` of an earlier reply. Without one, or with one from
   * before what is kept or from an earlier frontend, the newest few.
   */
  since(after: number | undefined, now = Date.now()): { notifications: SessionNotification[]; latest: number } {
    this.askedAt = now
    const oldest = this.kept[0]?.seq ?? this.seq + 1
    const known = after !== undefined && after >= oldest - 1 && after <= this.seq
    const notifications = known ? this.kept.filter((notification) => notification.seq > after) : this.kept.slice(-MAX_CATCH_UP)
    return { notifications, latest: this.seq }
  }

  /** The notifications no earlier `take` returned, for clients without a cursor of their own. */
  take(now = Date.now()): SessionNotification[] {
    const { notifications } = this.since(this.taken, now)
    this.taken = this.seq
    return notifications.slice(-MAX_CATCH_UP)
  }
}

import { randomUUID } from 'node:crypto'
import { RpcError } from './rpc-server.ts'

/** A message a session asked Orc.app to show as a notification (`orc notify`). */
export type SessionNotification = {
  id: string
  /** The name the session gave, or null when `orc notify` ran outside a session. */
  session: string | null
  /** The session's handle, when a session has that name. */
  handle: string | null
  message: string
  at: number
}

export const MAX_MESSAGE = 1000
// Kept while Orc.app is closed; it shows them when it opens, so the newest few are enough.
const MAX_PENDING = 20
// Orc.app takes notifications on every refresh, every 2 seconds while it runs.
const APP_SEEN_MS = 10_000

/**
 * Notifications waiting for Orc.app, which takes them all at once and shows each as it is, whether or not
 * the session's turn-end notifications are muted. They are kept in memory, so a frontend restart drops any
 * the app has not taken.
 */
export class NotificationQueue {
  private pending: SessionNotification[] = []
  private takenAt = 0

  post(session: { name: string; handle: string | null } | null, text: unknown, now = Date.now()): { notification: SessionNotification; appOpen: boolean } {
    if (typeof text !== 'string') throw new RpcError('invalid_argument', 'message must be a string')
    // Line breaks stay; other control characters would show as junk.
    const message = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '').trim()
    if (!message) throw new RpcError('invalid_argument', 'message is empty')
    if (message.length > MAX_MESSAGE) throw new RpcError('invalid_argument', `message is longer than ${MAX_MESSAGE} characters`)
    const notification = { id: randomUUID(), session: session?.name ?? null, handle: session?.handle ?? null, message, at: now }
    this.pending.push(notification)
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING)
    return { notification, appOpen: now - this.takenAt < APP_SEEN_MS }
  }

  /** Orc.app takes every waiting notification. */
  take(now = Date.now()): SessionNotification[] {
    this.takenAt = now
    const taken = this.pending
    this.pending = []
    return taken
  }
}

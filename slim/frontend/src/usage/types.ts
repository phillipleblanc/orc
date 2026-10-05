/** A rate-limit window: how much of it is used and when it starts over. */
export type UsageWindow = {
  /** `session` (five hours), `weekly`, or `model` for a weekly limit on one model. */
  kind: 'session' | 'weekly' | 'model'
  label: string
  /** 0 to 100. */
  usedPercent: number
  /** When the window resets, in Unix milliseconds. */
  resetsAt: number | null
  windowMinutes: number | null
}

export type UsageProvider = 'claude' | 'codex'

export type ProviderUsage = {
  provider: UsageProvider
  name: string
  /** The subscription, such as "Max 5x" or "Pro". */
  plan: string | null
  windows: UsageWindow[]
  /** Codex's free rate-limit resets that can be redeemed. */
  resetCredits?: number
  /**
   * `ok`; `error` when the latest fetch failed, with the windows of an earlier one while they are recent;
   * `unavailable` when the agent is not installed or not signed in, which views hide.
   */
  status: 'ok' | 'error' | 'unavailable'
  error: string | null
  /** When the windows were fetched, in Unix milliseconds. */
  updatedAt: number | null
}

/** A failed fetch. `retryAt` is the earliest the provider asked to be asked again, from Retry-After. */
export class UsageError extends Error {
  readonly retryAt: number | null
  readonly rateLimited: boolean
  constructor(message: string, { retryAt = null, rateLimited = false }: { retryAt?: number | null; rateLimited?: boolean } = {}) {
    super(message)
    this.retryAt = retryAt
    this.rateLimited = rateLimited
  }
}

/** A provider the user has not set up: its usage is not shown. */
export class UsageUnavailable extends Error {}

export function clampPercent(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : null
}

/** A reset time given as Unix seconds or milliseconds, a numeric string, or an ISO date, in milliseconds. */
export function resetTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value <= 1e10 ? value * 1000 : value
  if (typeof value !== 'string' || !value.trim()) return null
  if (/^\d+(\.\d+)?$/.test(value.trim())) return resetTime(Number(value))
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/** Seconds or an HTTP date in a Retry-After header, as the time to ask again; at most a day away. */
export function retryAfter(header: string | null, now: number): number | null {
  if (!header) return null
  const seconds = Number(header)
  const at = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(header)
  return Number.isNaN(at) ? null : Math.min(at, now + 24 * 60 * 60 * 1000)
}

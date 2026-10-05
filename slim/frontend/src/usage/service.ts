import { UsageError, UsageUnavailable, type ProviderUsage, type UsageProvider } from './types.ts'

/** Usage younger than this is not fetched again unless asked to. */
export const REFETCH_MS = 5 * 60_000
/** After a failure, the next attempt waits this long, doubling with each failure in a row up to MAX_RETRY_MS. */
const FIRST_RETRY_MS = 30_000
const MAX_RETRY_MS = 15 * 60_000
/** A failed fetch keeps showing earlier windows this long, or a day when the provider rate limited the request. */
const KEEP_MS = 30 * 60_000
const KEEP_RATE_LIMITED_MS = 24 * 60 * 60_000

const PROVIDERS: UsageProvider[] = ['claude', 'codex']
const NAMES: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex' }

/** `none` returns what is known; `stale` fetches what is old or due a retry; `force` fetches everything now. */
export type UsageRefresh = 'none' | 'stale' | 'force'

type State = { usage: ProviderUsage | null; checkedAt: number; failures: number; retryAt: number; fetching: Promise<void> | null }

/**
 * The agents' subscription usage, fetched when asked and kept. Fetches are rare: the usage endpoints rate limit
 * clients, so usage is refetched only once it is minutes old, failures back off, and a provider's Retry-After is
 * honored except when a fetch is forced.
 */
export class UsageService {
  private readonly fetchers: Record<UsageProvider, () => Promise<ProviderUsage>>
  private readonly now: () => number
  private readonly states = Object.fromEntries(PROVIDERS.map((provider) => [provider, { usage: null, checkedAt: 0, failures: 0, retryAt: 0, fetching: null }])) as Record<UsageProvider, State>

  constructor(fetchers: Record<UsageProvider, () => Promise<ProviderUsage>>, now: () => number = Date.now) {
    this.fetchers = fetchers
    this.now = now
  }

  /** Each provider's usage once the fetches `refresh` calls for have settled; providers never fetched are left out. */
  async read(refresh: UsageRefresh = 'stale'): Promise<ProviderUsage[]> {
    await Promise.all(PROVIDERS.map((provider) => this.due(provider, refresh) ? this.fetch(provider) : this.states[provider].fetching))
    return PROVIDERS.flatMap((provider) => this.states[provider].usage ?? [])
  }

  private due(provider: UsageProvider, refresh: UsageRefresh): boolean {
    const state = this.states[provider]
    if (refresh === 'force') return true
    if (refresh === 'none' || this.now() < state.retryAt) return false
    return state.usage === null || state.usage.status === 'error' || this.now() - state.checkedAt >= REFETCH_MS
  }

  private fetch(provider: UsageProvider): Promise<void> {
    const state = this.states[provider]
    state.fetching ??= (async () => {
      try {
        state.usage = await this.fetchers[provider]()
        state.failures = 0
        state.retryAt = 0
      } catch (error) {
        state.usage = error instanceof UsageUnavailable ? this.unavailable(provider, error.message) : this.failed(provider, state, error as Error)
      } finally {
        state.checkedAt = this.now()
        state.fetching = null
      }
    })()
    return state.fetching
  }

  private unavailable(provider: UsageProvider, message: string): ProviderUsage {
    const state = this.states[provider]
    state.failures = 0
    state.retryAt = 0
    return { provider, name: NAMES[provider], plan: null, windows: [], status: 'unavailable', error: message, updatedAt: null }
  }

  /** The error, with the previous windows while they are recent enough to still be useful. */
  private failed(provider: UsageProvider, state: State, error: Error): ProviderUsage {
    const now = this.now()
    const rateLimited = error instanceof UsageError && error.rateLimited
    state.failures++
    state.retryAt = Math.max(now + Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (state.failures - 1)), error instanceof UsageError ? error.retryAt ?? 0 : 0)
    const previous = state.usage?.updatedAt ? state.usage : null
    const keep = previous !== null && now - previous.updatedAt! < (rateLimited ? KEEP_RATE_LIMITED_MS : KEEP_MS)
    return {
      provider,
      name: NAMES[provider],
      plan: previous?.plan ?? null,
      windows: keep ? previous.windows : [],
      ...(keep && previous.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
      status: 'error',
      error: error.message,
      updatedAt: keep ? previous.updatedAt : null
    }
  }
}

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { clampPercent, resetTime, retryAfter, UsageError, UsageUnavailable, type ProviderUsage, type UsageWindow } from './types.ts'

// Claude Code's subscription usage: the endpoint its /usage reads, with the OAuth sign-in it keeps in the
// macOS Keychain (or `.credentials.json` in its config directory). The sign-in is only read; Claude Code
// refreshes it when it runs.

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const KEYCHAIN_TIMEOUT_MS = 3000
const REQUEST_TIMEOUT_MS = 10_000

export type ClaudeCredentials = { accessToken: string; subscriptionType: string | null; rateLimitTier: string | null }

/** Claude Code's configuration directory: `$CLAUDE_CONFIG_DIR`, or `~/.claude`. */
export function claudeConfigDir(env: Record<string, string | undefined>): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** The Keychain services Claude Code may keep a sign-in under: one per custom config directory, then the default. */
export function keychainServices(env: Record<string, string | undefined>): string[] {
  if (!env.CLAUDE_CONFIG_DIR) return [KEYCHAIN_SERVICE]
  const scoped = createHash('sha256').update(env.CLAUDE_CONFIG_DIR.normalize('NFC')).digest('hex').slice(0, 8)
  return [`${KEYCHAIN_SERVICE}-${scoped}`, KEYCHAIN_SERVICE]
}

function keychainSecret(service: string, account?: string): Promise<string | null> {
  const args = ['find-generic-password', '-s', service, ...(account ? ['-a', account] : []), '-w']
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', args, { timeout: KEYCHAIN_TIMEOUT_MS }, (error, stdout) => {
      // 44: no such item.
      if (error) (error as { code?: unknown }).code === 44 ? resolve(null) : reject(new UsageError('Could not read Claude’s sign-in from the Keychain'))
      else resolve(stdout.trim())
    })
  })
}

function credentialsFrom(text: string | null): ClaudeCredentials | null {
  if (!text) return null
  try {
    const oauth = JSON.parse(text)?.claudeAiOauth
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) return null
    return {
      accessToken: oauth.accessToken,
      subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
      rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : null
    }
  } catch {
    return null
  }
}

/** Claude Code's OAuth sign-in, or null when it has none (an API key, or not signed in). */
export async function readClaudeCredentials(env: Record<string, string | undefined>, { keychain = process.platform === 'darwin' } = {}): Promise<ClaudeCredentials | null> {
  if (keychain) {
    for (const service of keychainServices(env)) {
      for (const account of [userInfo().username, undefined]) {
        const found = credentialsFrom(await keychainSecret(service, account))
        if (found) return found
      }
    }
  }
  return credentialsFrom(await readFile(join(claudeConfigDir(env), '.credentials.json'), 'utf8').catch(() => null))
}

/** "Max 5x" from `max` and `default_claude_max_5x`; "Pro" from `pro`. */
export function claudePlan(credentials: Pick<ClaudeCredentials, 'subscriptionType' | 'rateLimitTier'>): string | null {
  const type = credentials.subscriptionType?.trim()
  if (!type) return null
  const name = type.charAt(0).toUpperCase() + type.slice(1)
  const multiplier = /_(\d+x)$/.exec(credentials.rateLimitTier ?? '')?.[1]
  return multiplier ? `${name} ${multiplier}` : name
}

type LimitEntry = { kind?: unknown; percent?: unknown; resets_at?: unknown; scope?: { model?: { display_name?: unknown } | null } | null }
type LegacyWindow = { utilization?: unknown; used_percentage?: unknown; resets_at?: unknown }

function window(kind: UsageWindow['kind'], label: string, percent: unknown, resets: unknown, windowMinutes: number): UsageWindow | null {
  const usedPercent = clampPercent(percent)
  return usedPercent === null ? null : { kind, label, usedPercent, resetsAt: resetTime(resets), windowMinutes }
}

/**
 * The windows in a usage response: from `limits` (the session, the weekly limit on all models, and weekly
 * limits on one model, labeled with its name), else from `five_hour` and `seven_day`.
 */
export function parseClaudeUsage(body: any): UsageWindow[] {
  const limits: LimitEntry[] = Array.isArray(body?.limits) ? body.limits : []
  if (limits.length > 0) {
    const windows = limits.map((limit) => {
      if (limit.kind === 'session') return window('session', 'Session', limit.percent, limit.resets_at, 300)
      if (limit.kind === 'weekly_all') return window('weekly', 'Weekly', limit.percent, limit.resets_at, 10080)
      const model = limit.scope?.model?.display_name
      if (limit.kind === 'weekly_scoped' && typeof model === 'string' && model) return window('model', model, limit.percent, limit.resets_at, 10080)
      return null
    }).filter((entry): entry is UsageWindow => entry !== null)
    const order = { session: 0, weekly: 1, model: 2 }
    if (windows.length > 0) return windows.sort((left, right) => order[left.kind] - order[right.kind])
  }
  const legacy = (value: LegacyWindow | undefined, kind: 'session' | 'weekly', label: string, minutes: number) =>
    value ? window(kind, label, value.utilization ?? value.used_percentage, value.resets_at, minutes) : null
  return [legacy(body?.five_hour, 'session', 'Session', 300), legacy(body?.seven_day, 'weekly', 'Weekly', 10080)]
    .filter((entry): entry is UsageWindow => entry !== null)
}

export async function fetchClaudeUsage(env: Record<string, string | undefined>, { url = CLAUDE_USAGE_URL, now = Date.now, credentials: read = readClaudeCredentials } = {}): Promise<ProviderUsage> {
  const credentials = await read(env)
  if (!credentials) throw new UsageUnavailable('Claude Code is not signed in to a subscription')
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${credentials.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    throw new UsageError(`Could not reach Claude: ${(error as Error).message}`)
  }
  if (response.status === 429) {
    throw new UsageError('Claude’s usage is rate limited right now', { rateLimited: true, retryAt: retryAfter(response.headers.get('retry-after'), now()) })
  }
  if (response.status === 401) throw new UsageError('Claude’s sign-in has expired; running claude refreshes it')
  if (response.status === 403) throw new UsageError('Claude’s sign-in cannot read usage; sign in again with claude /login')
  if (!response.ok) throw new UsageError(`Claude’s usage request failed (${response.status})`)
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new UsageError('Claude’s usage response could not be read')
  }
  return { provider: 'claude', name: 'Claude', plan: claudePlan(credentials), windows: parseClaudeUsage(body), status: 'ok', error: null, updatedAt: now() }
}

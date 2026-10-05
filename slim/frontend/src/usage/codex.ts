import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { clampPercent, resetTime, UsageError, UsageUnavailable, type ProviderUsage, type UsageWindow } from './types.ts'

// Codex's subscription usage, as `codex app-server` reports it (which refreshes Codex's sign-in as needed),
// else from the ChatGPT endpoint Codex reads it from, with the sign-in in `$CODEX_HOME/auth.json`.

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const APP_SERVER_ARGS = ['-c', 'approval_policy=never', '-c', 'features.plugins=false', '-s', 'read-only', '-a', 'never', 'app-server']
const APP_SERVER_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 10_000
const AUTH_FAILURE = /sign in again|log ?in again|not logged in|unauthori[sz]ed|refresh token|token (is )?(expired|invalid)|401/i

export function codexHome(env: Record<string, string | undefined>): string {
  return env.CODEX_HOME || join(homedir(), '.codex')
}

/** "Pro" from `pro`, "ChatGPT Business" from `chatgpt_business`. */
export function codexPlan(planType: unknown): string | null {
  if (typeof planType !== 'string' || !planType.trim()) return null
  return planType.trim().split(/[_\s-]+/).map((word) => word.toLowerCase() === 'chatgpt' ? 'ChatGPT' : word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/** A window by its length: five hours is the session, a week is weekly; other lengths are named by them. */
function codexWindow(percent: unknown, minutes: number | null, resets: unknown, fallback: 'session' | 'weekly'): UsageWindow | null {
  const usedPercent = clampPercent(percent)
  if (usedPercent === null) return null
  const kind = minutes === null ? fallback : minutes < 24 * 60 ? 'session' : 'weekly'
  const label = minutes !== null && Math.abs(minutes - 300) > 1 && Math.abs(minutes - 10080) > 1
    ? (minutes < 24 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`)
    : kind === 'session' ? 'Session' : 'Weekly'
  return { kind, label, usedPercent, resetsAt: resetTime(resets), windowMinutes: minutes }
}

function sorted(windows: (UsageWindow | null)[]): UsageWindow[] {
  return windows.filter((entry): entry is UsageWindow => entry !== null).sort((left, right) => (left.windowMinutes ?? 0) - (right.windowMinutes ?? 0))
}

/** Usage from the app server's `account/rateLimits/read` result. */
export function parseCodexRateLimits(result: any): Pick<ProviderUsage, 'plan' | 'windows' | 'resetCredits'> {
  const limits = result?.rateLimits ?? result?.rateLimitsByLimitId?.codex
  const minutes = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
  const windows = sorted([
    limits?.primary ? codexWindow(limits.primary.usedPercent, minutes(limits.primary.windowDurationMins), limits.primary.resetsAt, 'session') : null,
    limits?.secondary ? codexWindow(limits.secondary.usedPercent, minutes(limits.secondary.windowDurationMins), limits.secondary.resetsAt, 'weekly') : null
  ])
  const credits = result?.rateLimitResetCredits?.availableCount
  return { plan: codexPlan(limits?.planType), windows, ...(typeof credits === 'number' ? { resetCredits: credits } : {}) }
}

/** Usage from the ChatGPT endpoint's response. */
export function parseCodexBackendUsage(body: any): Pick<ProviderUsage, 'plan' | 'windows' | 'resetCredits'> {
  const minutes = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.ceil(value / 60) : null
  const limits = body?.rate_limit
  const windows = sorted([
    limits?.primary_window ? codexWindow(limits.primary_window.used_percent, minutes(limits.primary_window.limit_window_seconds), limits.primary_window.reset_at, 'session') : null,
    limits?.secondary_window ? codexWindow(limits.secondary_window.used_percent, minutes(limits.secondary_window.limit_window_seconds), limits.secondary_window.reset_at, 'weekly') : null
  ])
  const credits = body?.rate_limit_reset_credits?.available_count
  return { plan: codexPlan(body?.plan_type), windows, ...(typeof credits === 'number' ? { resetCredits: credits } : {}) }
}

/** Asks `codex app-server` for the rate limits over JSON-RPC on stdio. */
export function readCodexRateLimits(executable: string, env: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, APP_SERVER_ARGS, { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] })
    let buffered = ''
    let stderr = ''
    let settled = false
    const finish = (error: Error | null, result?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      error ? reject(error) : resolve(result)
    }
    const timer = setTimeout(() => finish(new UsageError('Codex did not report its usage in time')), APP_SERVER_TIMEOUT_MS)
    const send = (message: Record<string, unknown>) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
    child.on('error', (error) => finish(new UsageError(`Could not start Codex: ${error.message}`)))
    // `close` comes after the output is read, so a result written just before exiting still counts.
    child.on('close', () => finish(new UsageError(stderr.trim().split('\n').at(-1) || 'Codex exited before reporting its usage')))
    child.stdin.on('error', () => {})
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000) })
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buffered += chunk
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        let message: any
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id === 1) {
          if (message.error) return finish(new UsageError(message.error.message ?? 'Codex refused to start'))
          send({ method: 'initialized' })
          send({ id: 2, method: 'account/rateLimits/read', params: {} })
        } else if (message.id === 2) {
          finish(message.error ? new UsageError(message.error.message ?? 'Codex could not read its usage') : null, message.result)
        }
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'orc', version: '1.0.0' } } })
  })
}

async function fetchBackendUsage(home: string, url: string): Promise<any> {
  let auth: any
  try {
    auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))
  } catch {
    throw new UsageError('Could not read Codex’s sign-in')
  }
  const token = auth?.tokens?.access_token
  if (typeof token !== 'string' || !token) throw new UsageUnavailable('Codex is signed in with an API key')
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'User-Agent': 'codex-cli', 'OpenAI-Beta': 'codex-1', originator: 'Codex Desktop' }
  if (typeof auth.tokens.account_id === 'string') headers['ChatGPT-Account-Id'] = auth.tokens.account_id
  let response: Response
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) {
    throw new UsageError(`Could not reach ChatGPT: ${(error as Error).message}`)
  }
  if (response.status === 401 || response.status === 403) throw new UsageError('Codex’s sign-in has expired; running codex refreshes it')
  if (!response.ok) throw new UsageError(`Codex’s usage request failed (${response.status})`)
  try {
    return await response.json()
  } catch {
    throw new UsageError('Codex’s usage response could not be read')
  }
}

export async function fetchCodexUsage(env: Record<string, string>, executable: string | null, { url = CODEX_USAGE_URL, now = Date.now } = {}): Promise<ProviderUsage> {
  const home = codexHome(env)
  try {
    await access(join(home, 'auth.json'))
  } catch {
    throw new UsageUnavailable('Codex is not signed in')
  }
  const done = (usage: Pick<ProviderUsage, 'plan' | 'windows' | 'resetCredits'>): ProviderUsage =>
    ({ provider: 'codex', name: 'Codex', ...usage, status: 'ok', error: null, updatedAt: now() })
  if (executable) {
    try {
      return done(parseCodexRateLimits(await readCodexRateLimits(executable, env)))
    } catch (error) {
      // A sign-in Codex itself cannot refresh fails over HTTP too.
      if (AUTH_FAILURE.test((error as Error).message)) throw new UsageError('Codex’s sign-in could not be refreshed; sign in again with codex login')
    }
  }
  return done(parseCodexBackendUsage(await fetchBackendUsage(home, url)))
}

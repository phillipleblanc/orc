import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudePlan, fetchClaudeUsage, keychainServices, parseClaudeUsage, readClaudeCredentials } from '../src/usage/claude.ts'
import { codexPlan, fetchCodexUsage, parseCodexBackendUsage, parseCodexRateLimits } from '../src/usage/codex.ts'
import { UsageService } from '../src/usage/service.ts'
import { UsageError, UsageUnavailable, type ProviderUsage } from '../src/usage/types.ts'

// No request leaves the machine: endpoints are local servers, sign-ins are written to temporary
// directories, the Keychain is not read, and Codex is a script that speaks its app server's protocol.

async function temporary(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orc-usage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function server(t: { after: (fn: () => void) => void }, handle: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ url: string; requests: IncomingMessage[] }> {
  const requests: IncomingMessage[] = []
  const http = createServer((request, response) => { requests.push(request); handle(request, response) })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  t.after(() => http.close())
  const address = http.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}/usage`, requests }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => (_: IncomingMessage, response: ServerResponse) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(body))
}

// The shape of Claude's response, trimmed.
const CLAUDE_BODY = {
  five_hour: { utilization: 34, resets_at: '2026-10-05T08:40:00.037078+00:00' },
  seven_day: { utilization: 15, resets_at: '2026-10-06T00:00:00.037097+00:00' },
  limits: [
    { kind: 'session', group: 'session', percent: 34, severity: 'normal', resets_at: '2026-10-05T08:40:00.037078+00:00', scope: null, is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: '2026-10-06T00:00:00+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 15, resets_at: '2026-10-06T00:00:00.035852+00:00', scope: null, is_active: false },
    { kind: 'something_new', percent: 50 }
  ]
}

test('Claude usage comes from its limits, ordered session, weekly, then each model; older responses still read', () => {
  assert.deepEqual(parseClaudeUsage(CLAUDE_BODY), [
    { kind: 'session', label: 'Session', usedPercent: 34, resetsAt: Date.parse('2026-10-05T08:40:00.037Z'), windowMinutes: 300 },
    { kind: 'weekly', label: 'Weekly', usedPercent: 15, resetsAt: Date.parse('2026-10-06T00:00:00.035Z'), windowMinutes: 10080 },
    { kind: 'model', label: 'Fable', usedPercent: 0, resetsAt: Date.parse('2026-10-06T00:00:00Z'), windowMinutes: 10080 }
  ])
  // Without limits: the five-hour and seven-day windows, with percentages as utilization or used_percentage
  // and resets as dates or Unix seconds; out-of-range percentages are clamped.
  assert.deepEqual(parseClaudeUsage({ five_hour: { used_percentage: 23.5, resets_at: 1770000000 }, seven_day: { utilization: 140 } }), [
    { kind: 'session', label: 'Session', usedPercent: 23.5, resetsAt: 1770000000_000, windowMinutes: 300 },
    { kind: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: null, windowMinutes: 10080 }
  ])
  assert.deepEqual(parseClaudeUsage({}), [])
})

test('Claude’s plan is named from its subscription and rate tier', () => {
  assert.equal(claudePlan({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' }), 'Max 5x')
  assert.equal(claudePlan({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }), 'Max 20x')
  assert.equal(claudePlan({ subscriptionType: 'pro', rateLimitTier: 'default_claude_pro' }), 'Pro')
  assert.equal(claudePlan({ subscriptionType: null, rateLimitTier: null }), null)
})

test('Claude’s sign-in is read from its Keychain item, scoped to a custom config directory, or its credentials file', async (t) => {
  assert.deepEqual(keychainServices({}), ['Claude Code-credentials'])
  const scoped = createHash('sha256').update('/custom/claude').digest('hex').slice(0, 8)
  assert.deepEqual(keychainServices({ CLAUDE_CONFIG_DIR: '/custom/claude' }), [`Claude Code-credentials-${scoped}`, 'Claude Code-credentials'])

  const config = await temporary(t)
  assert.equal(await readClaudeCredentials({ CLAUDE_CONFIG_DIR: config }, { keychain: false }), null)
  await writeFile(join(config, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'token', refreshToken: 'refresh', expiresAt: 1, subscriptionType: 'pro' } }))
  assert.deepEqual(await readClaudeCredentials({ CLAUDE_CONFIG_DIR: config }, { keychain: false }), { accessToken: 'token', subscriptionType: 'pro', rateLimitTier: null })
})

test('Claude usage is requested with its sign-in; rate limits, expired sign-ins and API keys are told apart', async (t) => {
  const credentials = async () => ({ accessToken: 'secret', subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' })
  const ok = await server(t, json(200, CLAUDE_BODY))
  const usage = await fetchClaudeUsage({}, { url: ok.url, now: () => 1000, credentials })
  assert.equal(ok.requests[0].headers.authorization, 'Bearer secret')
  assert.equal(ok.requests[0].headers['anthropic-beta'], 'oauth-2025-04-20')
  assert.deepEqual({ ...usage, windows: usage.windows.map((window) => window.label) },
    { provider: 'claude', name: 'Claude', plan: 'Max 5x', windows: ['Session', 'Weekly', 'Fable'], status: 'ok', error: null, updatedAt: 1000 })

  const limited = await server(t, json(429, { error: { message: 'slow down' } }, { 'retry-after': '120' }))
  const rateLimited = await fetchClaudeUsage({}, { url: limited.url, now: () => 1000, credentials }).catch((error) => error)
  assert.ok(rateLimited instanceof UsageError)
  assert.equal(rateLimited.rateLimited, true)
  assert.equal(rateLimited.retryAt, 121_000)

  const expired = await server(t, json(401, {}))
  assert.match((await fetchClaudeUsage({}, { url: expired.url, credentials }).catch((error) => error)).message, /expired/)
  assert.ok(await fetchClaudeUsage({}, { url: ok.url, credentials: async () => null }).catch((error) => error) instanceof UsageUnavailable)
})

test('Codex usage reads its app server’s rate limits and the ChatGPT endpoint’s response, windows ordered by length', () => {
  // The shape `account/rateLimits/read` returns, trimmed: a plan with only a weekly window.
  assert.deepEqual(parseCodexRateLimits({
    rateLimits: { limitId: 'codex', primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1791770623 }, secondary: null, planType: 'pro' },
    rateLimitResetCredits: { availableCount: 2, credits: [] }
  }), { plan: 'Pro', windows: [{ kind: 'weekly', label: 'Weekly', usedPercent: 4, resetsAt: 1791770623_000, windowMinutes: 10080 }], resetCredits: 2 })
  assert.deepEqual(parseCodexRateLimits({
    rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1791000000 }, secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1791500000 }, planType: 'plus' }
  }).windows.map((window) => [window.kind, window.label, window.usedPercent]), [['session', 'Session', 12], ['weekly', 'Weekly', 30]])
  // A window of another length is named by it.
  assert.equal(parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 60, resetsAt: null } } }).windows[0].label, '1h')

  assert.deepEqual(parseCodexBackendUsage({
    plan_type: 'pro',
    rate_limit: { allowed: true, primary_window: { used_percent: 4, limit_window_seconds: 604800, reset_after_seconds: 587006, reset_at: 1791770623 }, secondary_window: null },
    rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 }
  }), { plan: 'Pro', windows: [{ kind: 'weekly', label: 'Weekly', usedPercent: 4, resetsAt: 1791770623_000, windowMinutes: 10080 }], resetCredits: 2 })
  assert.equal(codexPlan('chatgpt_business'), 'ChatGPT Business')
  assert.equal(codexPlan(undefined), null)
})

/** A stand-in for `codex app-server`: answers initialize and account/rateLimits/read, or fails as `mode` says. */
async function fakeCodex(directory: string, mode: 'ok' | 'crash' | 'signed-out'): Promise<string> {
  const path = join(directory, `codex-${mode}`)
  await writeFile(path, `#!${process.execPath}
const mode = ${JSON.stringify(mode)}
if (process.argv.at(-1) !== 'app-server') process.exit(2)
if (mode === 'crash') { console.error('panic: something broke'); process.exit(1) }
let buffered = ''
process.stdin.setEncoding('utf8').on('data', (chunk) => {
  buffered += chunk
  for (const line of buffered.split('\\n').slice(0, -1)) {
    const message = JSON.parse(line)
    if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: 'codex' } }) + '\\n')
    if (message.id === 2 && mode === 'signed-out') process.stdout.write(JSON.stringify({ id: 2, error: { code: -32000, message: 'Your access token could not be refreshed. Please log in again.' } }) + '\\n')
    if (message.id === 2 && mode === 'ok') process.stdout.write(JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1791000000 }, secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1791500000 }, planType: 'plus' } } }) + '\\n')
  }
  buffered = buffered.slice(buffered.lastIndexOf('\\n') + 1)
})
`)
  await chmod(path, 0o755)
  return path
}

test('Codex usage comes from its app server, else the ChatGPT endpoint, unless Codex is signed out or not signed in', async (t) => {
  const home = await temporary(t)
  const env = { ...process.env, CODEX_HOME: home } as Record<string, string>
  const backend = await server(t, json(200, { plan_type: 'pro', rate_limit: { primary_window: { used_percent: 4, limit_window_seconds: 604800, reset_at: 1791770623 } } }))

  assert.ok(await fetchCodexUsage(env, await fakeCodex(home, 'ok'), { url: backend.url }).catch((error) => error) instanceof UsageUnavailable)
  await writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'secret', account_id: 'account' } }))

  const served = await fetchCodexUsage(env, await fakeCodex(home, 'ok'), { url: backend.url, now: () => 5 })
  assert.deepEqual([served.plan, served.windows.map((window) => `${window.label} ${window.usedPercent}`), served.updatedAt], ['Plus', ['Session 12', 'Weekly 30'], 5])
  assert.equal(backend.requests.length, 0)

  const fallback = await fetchCodexUsage(env, await fakeCodex(home, 'crash'), { url: backend.url })
  assert.deepEqual([fallback.plan, fallback.windows.map((window) => window.label)], ['Pro', ['Weekly']])
  assert.equal(backend.requests[0].headers.authorization, 'Bearer secret')
  assert.equal(backend.requests[0].headers['chatgpt-account-id'], 'account')
  assert.deepEqual((await fetchCodexUsage(env, null, { url: backend.url })).windows.map((window) => window.label), ['Weekly'])

  const signedOut = await fetchCodexUsage(env, await fakeCodex(home, 'signed-out'), { url: backend.url }).catch((error) => error)
  assert.match(signedOut.message, /sign in again with codex login/)
  assert.equal(backend.requests.length, 2)
})

test('usage is refetched once it is minutes old, backs off after failures, honors Retry-After unless forced, and keeps recent windows through failures', async () => {
  let now = 0
  let calls = 0
  let next: () => Promise<ProviderUsage>
  const ok = (percent: number): ProviderUsage => ({ provider: 'claude', name: 'Claude', plan: 'Max 5x', windows: [{ kind: 'session', label: 'Session', usedPercent: percent, resetsAt: null, windowMinutes: 300 }], status: 'ok', error: null, updatedAt: now })
  const service = new UsageService({
    claude: () => { calls++; return next() },
    codex: async () => { throw new UsageUnavailable('Codex is not signed in') }
  }, () => now)
  const claude = async (refresh?: 'none' | 'stale' | 'force') => (await service.read(refresh)).find((usage) => usage.provider === 'claude')!

  assert.deepEqual(await service.read('none'), [])
  next = async () => ok(10)
  assert.equal((await claude()).windows[0].usedPercent, 10)
  assert.equal((await service.read()).find((usage) => usage.provider === 'codex')?.status, 'unavailable')
  now = 4 * 60_000
  await claude()
  assert.equal(calls, 1)
  now = 5 * 60_000
  next = async () => ok(20)
  assert.equal((await claude()).windows[0].usedPercent, 20)
  assert.equal(calls, 2)

  // A failure keeps the earlier windows with the error, and the next attempt waits 30 seconds, then a minute.
  now += 5 * 60_000
  next = async () => { throw new UsageError('Could not reach Claude: offline') }
  const failed = await claude()
  assert.deepEqual([failed.status, failed.error, failed.windows[0].usedPercent, failed.updatedAt], ['error', 'Could not reach Claude: offline', 20, 5 * 60_000])
  now += 29_000
  await claude()
  assert.equal(calls, 3)
  now += 1000
  await claude()
  assert.equal(calls, 4)
  now += 59_000
  await claude()
  assert.equal(calls, 4)

  // Once the windows are half an hour old, a failure no longer shows them.
  now = 5 * 60_000 + 30 * 60_000
  assert.deepEqual((await claude('force')).windows, [])

  // A rate limit's Retry-After holds off automatic fetches, not forced ones, and keeps windows for a day.
  next = async () => ok(30)
  await claude('force')
  next = async () => { throw new UsageError('Claude’s usage is rate limited right now', { rateLimited: true, retryAt: now + 60 * 60_000 }) }
  now += 5 * 60_000
  const limited = await claude()
  assert.equal(limited.windows[0].usedPercent, 30)
  const before = calls
  now += 50 * 60_000
  assert.equal((await claude()).windows[0].usedPercent, 30)
  assert.equal(calls, before)
  next = async () => ok(40)
  assert.equal((await claude('force')).windows[0].usedPercent, 40)

  // Reads that overlap share one fetch.
  let release!: () => void
  next = () => new Promise((resolve) => { release = () => resolve(ok(50)) })
  const first = claude('force')
  const second = claude('stale')
  await new Promise((resolve) => setImmediate(resolve))
  release()
  assert.deepEqual([(await first).windows[0].usedPercent, (await second).windows[0].usedPercent], [50, 50])
  assert.equal(calls, before + 2)
})

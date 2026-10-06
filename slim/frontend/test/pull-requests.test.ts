import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { writeBrief } from '../src/brief/writer.ts'
import { fetchPullRequests, parsePullRequest, refKey, type Check, type FetchResult, type PullRequestRef, type PullRequestSnapshot } from '../src/pull-requests/github.ts'
import { COPILOT, emptyState, evaluate, reportMessage, SETTLE_MS, type WatchState } from '../src/pull-requests/rules.ts'
import { IDLE_MS, POLL_MS, PullRequestWatch, type AgentStatus, type WatchAgent } from '../src/pull-requests/watch.ts'

async function temporary(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orc-pr-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

const check = (name: string, status: Check['status']): Check => ({ name, status, url: `https://ci/${name}` })

function snapshot(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    repo: 'spiceai/spiceai', number: 14785, title: 'Add a cold-start test', url: 'https://github.com/spiceai/spiceai/pull/14785',
    state: 'OPEN', author: 'phillipleblanc', headSha: 'aaaaaaa1', mergeable: 'MERGEABLE',
    checks: [check('Attestation', 'failure'), check('Rust Lint', 'success')], threads: [], ...overrides
  }
}

const IGNORE = ['Attestation']
const ready = { ignore: IGNORE, now: 1_000_000, ready: true }

test('a pull request link or owner/name#number is read, and nothing else', () => {
  assert.deepEqual(parsePullRequest('https://github.com/spiceai/spiceai/pull/14785/files'), { repo: 'spiceai/spiceai', number: 14785, url: 'https://github.com/spiceai/spiceai/pull/14785' })
  assert.deepEqual(parsePullRequest('spicehq/spiceai#1673'), { repo: 'spicehq/spiceai', number: 1673, url: 'https://github.com/spicehq/spiceai/pull/1673' })
  assert.equal(parsePullRequest('https://github.com/spiceai/spiceai/issues/1'), null)
  assert.equal(parsePullRequest('#1673'), null)
})

test('a check that ran again on the same commit counts by its latest run', async () => {
  const run = (name: string, conclusion: string | null, startedAt: string | null, databaseId: number) =>
    ({ __typename: 'CheckRun', name, status: conclusion ? 'COMPLETED' : 'QUEUED', conclusion, detailsUrl: null, startedAt, databaseId })
  const graphql = async () => ({
    viewer: { login: 'phillipleblanc' },
    p0: { pullRequest: {
      number: 14784, title: 'Write an append as one load', url: 'https://github.com/spiceai/spiceai/pull/14784', state: 'OPEN', mergeable: 'MERGEABLE',
      headRefOid: 'abc', author: { login: 'phillipleblanc' }, reviewThreads: { nodes: [] },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [
        run('enforce-pull-with-spice', 'FAILURE', '2026-10-06T03:51:58Z', 1),
        run('Rust Lint', 'SUCCESS', '2026-10-06T03:52:00Z', 2),
        run('enforce-pull-with-spice', 'SUCCESS', '2026-10-06T03:54:26Z', 3),
        run('Rust Lint', null, null, 4),
        { __typename: 'StatusContext', context: 'ci/legacy', state: 'FAILURE', targetUrl: null, createdAt: '2026-10-06T03:50:00Z' }
      ] } } } }] }
    } }
  })
  const { pullRequests } = await fetchPullRequests([{ repo: 'spiceai/spiceai', number: 14784 }], graphql)
  assert.deepEqual(pullRequests.get('spiceai/spiceai#14784')?.checks.map((found) => [found.name, found.status]), [
    ['enforce-pull-with-spice', 'success'], ['Rust Lint', 'pending'], ['ci/legacy', 'failure']
  ])
})

test('an ignored check that fails on every commit is never reported, and a failing check once per commit', () => {
  const quiet = evaluate(snapshot(), emptyState(), ready)
  assert.equal(quiet.report, null)
  assert.equal(evaluate(snapshot({ headSha: 'bbbbbbb2' }), quiet.state, ready).report, null)

  const red = snapshot({ checks: [check('Attestation', 'failure'), check('enforce-pull-with-spice', 'failure'), check('Cold start', 'success')] })
  const first = evaluate(red, emptyState(), ready)
  assert.deepEqual(first.report?.failures.map((failure) => failure.name), ['enforce-pull-with-spice'])
  assert.equal(evaluate(red, first.state, ready).report, null)
  // An agent that is not ready is told nothing and nothing is marked told.
  const busy = evaluate(red, emptyState(), { ...ready, ready: false })
  assert.equal(busy.report, null)
  assert.deepEqual(busy.state.told, [])
})

test('a failing check waits for the commit’s other checks, or until it has failed a while', () => {
  const running = snapshot({ checks: [check('Rust Lint', 'failure'), check('Integration Tests', 'pending')] })
  const waiting = evaluate(running, emptyState(), { ...ready, ready: false })
  assert.equal(waiting.state.firstFailed['aaaaaaa1 Rust Lint'], ready.now)
  assert.equal(evaluate(running, waiting.state, { ...ready, now: ready.now + SETTLE_MS - 1 }).report, null)
  assert.deepEqual(evaluate(running, waiting.state, { ...ready, now: ready.now + SETTLE_MS }).report?.failures.map((failure) => failure.name), ['Rust Lint'])
  const finished = snapshot({ checks: [check('Rust Lint', 'failure'), check('Integration Tests', 'success')] })
  assert.deepEqual(evaluate(finished, waiting.state, ready).report?.failures.map((failure) => failure.name), ['Rust Lint'])
})

test('a check reported failing on two commits in a row goes to its person on the third, unless kept or fixed', () => {
  let state: WatchState = emptyState()
  const told: string[] = []
  for (const sha of ['a1', 'b2', 'c3']) {
    const evaluation = evaluate(snapshot({ headSha: sha, checks: [check('Rust Lint', 'failure')] }), state, ready)
    if (evaluation.report) told.push(sha)
    state = evaluation.state
    if (sha === 'c3') assert.deepEqual(evaluation.handOver, ['Rust Lint'])
  }
  assert.deepEqual(told, ['a1', 'b2'])
  assert.deepEqual(state.handedOver, { 'Rust Lint': 'c3' })
  assert.equal(evaluate(snapshot({ headSha: 'd4', checks: [check('Rust Lint', 'failure')] }), state, ready).report, null)

  // Its person keeps it reported: the agent is told again, and the count starts over.
  const kept: WatchState = { ...state, handedOver: {}, keep: ['Rust Lint'], failures: {} }
  assert.ok(evaluate(snapshot({ headSha: 'd4', checks: [check('Rust Lint', 'failure')] }), kept, ready).report)

  // A pass in between starts the count over.
  let passing: WatchState = emptyState()
  for (const [sha, status] of [['a1', 'failure'], ['b2', 'success'], ['c3', 'failure'], ['d4', 'failure']] as const) {
    const evaluation = evaluate(snapshot({ headSha: sha, checks: [check('Rust Lint', status)] }), passing, ready)
    assert.deepEqual(evaluation.handOver, [])
    passing = evaluation.state
  }
})

test('unresolved Copilot threads are reported once, and a merge conflict once per commit', () => {
  const thread = (id: string, author: string, resolved = false) => ({ id, resolved, author, path: 'src/lib.rs', line: 42, body: 'Possible  off-by-one', url: `https://github.com/t/${id}` })
  const pr = snapshot({ mergeable: 'CONFLICTING', threads: [thread('t1', COPILOT), thread('t2', 'teammate'), thread('t3', COPILOT, true)] })
  const first = evaluate(pr, emptyState(), ready)
  assert.deepEqual(first.report?.threads.map((reported) => reported.id), ['t1'])
  assert.equal(first.report?.conflict, true)
  assert.equal(evaluate(pr, first.state, ready).report, null)
  const pushed = evaluate({ ...pr, headSha: 'bbbbbbb2', threads: [...pr.threads, thread('t4', COPILOT)] }, first.state, ready)
  assert.deepEqual([pushed.report?.conflict, pushed.report?.threads.map((reported) => reported.id)], [true, ['t4']])

  const message = reportMessage(pr, first.report!)
  assert.match(message, /^Pull request spiceai\/spiceai#14785 \(Add a cold-start test\) at aaaaaaa:/)
  assert.match(message, /- It has merge conflicts with its base branch\./)
  assert.match(message, /- Unresolved Copilot comment: src\/lib\.rs:42: "Possible off-by-one" https:\/\/github\.com\/t\/t1/)
  assert.match(message, /resolve the conflicts, address each Copilot comment, reply, and resolve its thread\./)
})

/** A GitHub that answers from a table of pull requests, counting its questions. */
function fakeGitHub(pullRequests: Map<string, PullRequestSnapshot>) {
  const asked: PullRequestRef[][] = []
  const fetch = async (refs: PullRequestRef[]): Promise<FetchResult> => {
    asked.push(refs)
    return { viewer: 'phillipleblanc', pullRequests: new Map(refs.map((ref) => [refKey(ref), pullRequests.get(refKey(ref)) ?? null])) }
  }
  return { asked, fetch }
}

test('the watch links an agent’s pull requests, tells it once it is idle, and drops merged ones', async (t) => {
  const profile = await temporary(t)
  const agents: WatchAgent[] = [{ name: 'coord', dir: join(profile, 'coord') }, { name: 'coord/worker', dir: join(profile, 'worker'), parent: 'coord' }]
  for (const agent of agents) await mkdir(agent.dir)
  const statuses = new Map<string, AgentStatus>(agents.map((agent) => [agent.name, { state: 'working', since: 0, queued: 0, delivering: false }]))
  const prs = new Map<string, PullRequestSnapshot>([
    ['spiceai/spiceai#14785', snapshot({ checks: [check('Attestation', 'failure'), check('Rust Lint', 'failure')] })],
    ['spiceai/spiceai#14788', snapshot({ number: 14788, author: 'teammate' })],
    ['spiceai/spiceai#14790', snapshot({ number: 14790, state: 'MERGED' })],
    ['spiceai/spiceai#14791', snapshot({ number: 14791 })]
  ])
  const github = fakeGitHub(prs)
  const sent: { name: string; text: string }[] = []
  let now = 10 * IDLE_MS
  const options = {
    profile, agents: () => agents, status: (name: string) => statuses.get(name) ?? null, fetch: github.fetch, now: () => now,
    send: async (name: string, text: string) => { sent.push({ name, text }) }
  }
  const watch = new PullRequestWatch(options)
  await watch.start()
  t.after(() => watch.stop())
  assert.deepEqual(watch.settings, { ignoredChecks: ['Attestation'] })

  const log = 'TOOL RESULT: https://github.com/spiceai/spiceai/pull/14785\nReviewed spiceai PR #14788 and #14790, opened spiceai/spiceai#14791'
  assert.match(await watch.claim('coord/worker', 'https://github.com/spiceai/spiceai/pull/14799', log), /^Not recorded: .* does not appear/)
  assert.match(await watch.claim('coord/worker', 'https://github.com/spiceai/spiceai/pull/14788', log), /^Not recorded: .* opened by teammate, not phillipleblanc/)
  assert.match(await watch.claim('coord/worker', 'https://github.com/spiceai/spiceai/pull/14790', log), /^Not recorded: .* is merged/)
  assert.match(await watch.claim('coord/worker', 'https://github.com/spiceai/spiceai/pull/14785', log), /^Recorded/)
  assert.match(await watch.claim('coord/worker', 'spiceai/spiceai#14785', log), /^Already watched/)
  // The worker's pull request stays with it when the coordinator that started it reports it too.
  assert.match(await watch.claim('coord', 'https://github.com/spiceai/spiceai/pull/14785', log), /watched for coord\/worker, which this agent started/)
  // A pull request the coordinator reported goes to the worker it started when the worker reports it.
  assert.match(await watch.claim('coord', 'https://github.com/spiceai/spiceai/pull/14791', log), /^Recorded/)
  assert.match(await watch.claim('coord/worker', 'https://github.com/spiceai/spiceai/pull/14791', log), /^Recorded: .* instead of coord\.$/)
  assert.deepEqual([await watch.linked('coord'), await watch.linked('coord/worker')], [[], ['spiceai/spiceai#14785', 'spiceai/spiceai#14791']])
  await watch.unwatch('coord/worker', 'spiceai/spiceai#14791')
  assert.deepEqual(await watch.linked('coord/worker'), ['spiceai/spiceai#14785'])

  // A working agent is not told; once idle a while with nothing queued, it is told once.
  github.asked.length = 0
  now += POLL_MS
  await watch.tick()
  assert.equal(github.asked.length, 1)
  assert.equal(sent.length, 0)
  statuses.set('coord/worker', { state: 'idle', since: now, queued: 0, delivering: false })
  now += IDLE_MS - 1
  await watch.tick()
  assert.equal(sent.length, 0)
  now += 1
  await watch.tick()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].name, 'coord/worker')
  assert.match(sent[0].text, /- Check failed: Rust Lint https:\/\/ci\/Rust Lint/)
  assert.doesNotMatch(sent[0].text, /Attestation/)
  now += POLL_MS
  await watch.tick()
  assert.equal(sent.length, 1)

  const [summary] = (await watch.list('coord/worker'))['coord/worker']
  assert.deepEqual([summary.failing, summary.ignoredFailing, summary.handedOver, summary.toldAt !== null], [['Rust Lint'], ['Attestation'], [], true])

  // Kept with the session, and dropped once merged.
  const saved = JSON.parse(await readFile(join(agents[1].dir, 'pull-requests.json'), 'utf8'))
  assert.deepEqual(saved.pullRequests.map((pr: { number: number }) => pr.number), [14785])
  const again = new PullRequestWatch(options)
  assert.deepEqual(await again.linked('coord/worker'), ['spiceai/spiceai#14785'])
  prs.set('spiceai/spiceai#14785', snapshot({ state: 'MERGED' }))
  now += POLL_MS
  await watch.tick()
  assert.deepEqual(await watch.linked('coord/worker'), [])
})

test('a check handed to its person can be ignored from then on', async (t) => {
  const profile = await temporary(t)
  const agent: WatchAgent = { name: 'fixer', dir: join(profile, 'fixer') }
  await mkdir(agent.dir)
  const prs = new Map([['spiceai/spiceai#14785', snapshot({ headSha: 'a1', checks: [check('Flaky', 'failure')] })]])
  const github = fakeGitHub(prs)
  const sent: string[] = []
  let now = 10 * IDLE_MS
  const watch = new PullRequestWatch({
    profile, agents: () => [agent], status: () => ({ state: 'idle', since: 0, queued: 0, delivering: false }), fetch: github.fetch,
    now: () => now, send: async (_, text) => { sent.push(text) }
  })
  await watch.start()
  t.after(() => watch.stop())
  await watch.watch('fixer', 'spiceai/spiceai#14785')
  for (const sha of ['a1', 'b2', 'c3']) {
    prs.set('spiceai/spiceai#14785', snapshot({ headSha: sha, checks: [check('Flaky', 'failure')] }))
    now += POLL_MS
    await watch.tick()
  }
  assert.equal(sent.length, 2)
  assert.deepEqual((await watch.list('fixer')).fixer[0].handedOver, ['Flaky'])
  await watch.resolve('fixer', 'spiceai/spiceai#14785', 'Flaky', 'ignore')
  assert.deepEqual(watch.settings.ignoredChecks, ['Attestation', 'Flaky'])
  assert.deepEqual(JSON.parse(await readFile(join(profile, 'pull-request-settings.json'), 'utf8')), { ignoredChecks: ['Attestation', 'Flaky'] })
  assert.deepEqual((await watch.list('fixer')).fixer[0].handedOver, [])
  await assert.rejects(watch.watch('fixer', 'not a link'), /not a GitHub pull request/)
})

test('the brief’s model links pull requests through a tool and is told what came of each before it writes the brief', async () => {
  const faux = fauxProvider({ provider: 'lab', models: [{ id: 'qwen', name: 'Qwen' }] })
  const models = createModels()
  models.setProvider(faux.provider)
  const prompts: string[] = []
  const results: string[] = []
  faux.setResponses([
    (context) => {
      prompts.push(JSON.stringify(context.messages))
      return fauxAssistantMessage([fauxToolCall('report_pull_request', { url: 'https://github.com/spiceai/spiceai/pull/14785' }), fauxToolCall('report_pull_request', { url: 'https://github.com/spiceai/spiceai/pull/1' })], { stopReason: 'toolUse' })
    },
    (context) => {
      for (const message of context.messages as any[]) if (message.role === 'toolResult') results.push(`${message.isError ? 'error' : 'ok'}: ${message.content[0].text}`)
      return fauxAssistantMessage(fauxText('{"headline": "Fixing lint", "goal": "Ship it", "progress": ["PR open"], "now": "Fixing", "next": ["a", "b", "c"], "needsYou": null}'))
    }
  ])
  const reported: string[] = []
  const brief = await writeBrief({
    digest: { items: [{ role: 'result', text: 'https://github.com/spiceai/spiceai/pull/14785' }], truncated: false },
    about: { name: 'fixer', agent: 'pi', state: 'idle' }, model: 'lab/qwen',
    pullRequests: { linked: ['spicehq/spiceai#1673'], report: async (url) => { reported.push(url); return url.endsWith('/1') ? 'Not recorded: it does not appear in the log or summary.' : 'Recorded: Orc watches it.' } }
  }, models)
  assert.equal(brief.headline, 'Fixing lint')
  assert.deepEqual(reported, ['https://github.com/spiceai/spiceai/pull/14785', 'https://github.com/spiceai/spiceai/pull/1'])
  assert.deepEqual(results, ['ok: Recorded: Orc watches it.', 'error: Not recorded: it does not appear in the log or summary.'])
  assert.match(prompts[0], /Orc already watches these pull requests for this agent: https:\/\/github\.com\/spicehq\/spiceai\/pull\/1673\. Call report_pull_request only/)
})

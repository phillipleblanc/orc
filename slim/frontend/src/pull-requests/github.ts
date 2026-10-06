import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loginEnvironment, resolveExecutable } from '../login-environment.ts'

const run = promisify(execFile)
const TIMEOUT_MS = 60_000
const PAGE = 100

/** A pull request by its repository, `owner/name`, and number. */
export type PullRequestRef = { repo: string; number: number }

export type CheckStatus = 'pending' | 'success' | 'failure' | 'neutral'
export type Check = { name: string; status: CheckStatus; url: string | null }
/** A review thread, by its first comment. */
export type ReviewThread = { id: string; resolved: boolean; author: string | null; path: string | null; line: number | null; body: string; url: string | null }

/** A pull request as GitHub reports it now: its state, its latest commit's checks and its review threads. */
export type PullRequestSnapshot = {
  repo: string
  number: number
  title: string
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  author: string | null
  headSha: string
  /** Whether it merges into its base cleanly; GitHub reports UNKNOWN until it has computed it. */
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  checks: Check[]
  threads: ReviewThread[]
}

/** What GitHub returned for each pull request asked about: its snapshot, or null when there is no such pull request. */
export type FetchResult = { viewer: string; pullRequests: Map<string, PullRequestSnapshot | null> }

/** Runs a GraphQL query with `gh`, which signs in as its person. */
export type GraphQL = (query: string, variables?: Record<string, string | number>) => Promise<any>

export function refKey(ref: PullRequestRef): string {
  return `${ref.repo}#${ref.number}`
}

/** A pull request named by its GitHub link, or as `owner/name#number`. */
export function parsePullRequest(text: string): (PullRequestRef & { url: string }) | null {
  const trimmed = text.trim()
  const match = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(trimmed) ?? /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(trimmed)
  if (!match) return null
  const repo = `${match[1]}/${match[2]}`
  const number = Number(match[3])
  return { repo, number, url: `https://github.com/${repo}/pull/${number}` }
}

const CONTEXTS = `pageInfo { hasNextPage endCursor }
  nodes {
    __typename
    ... on CheckRun { name status conclusion detailsUrl startedAt databaseId }
    ... on StatusContext { context state targetUrl createdAt }
  }`

const PULL_REQUEST = `number title url state mergeable headRefOid author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: ${PAGE}) { ${CONTEXTS} } } } } }
  reviewThreads(first: ${PAGE}) { nodes { id isResolved path line originalLine comments(first: 1) { nodes { author { login } body url } } } }`

const MORE_CONTEXTS = `query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: ${PAGE}, after: $after) { ${CONTEXTS} } } } } }
  } }
}`

/** The pull requests in one query, with every check of each latest commit. */
export async function fetchPullRequests(refs: PullRequestRef[], graphql: GraphQL = ghGraphQL): Promise<FetchResult> {
  const aliases = refs.map((ref, index) => {
    const [owner, name] = ref.repo.split('/')
    return `p${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${ref.number}) { ${PULL_REQUEST} } }`
  })
  const data = await graphql(`query { viewer { login } ${aliases.join('\n')} }`)
  const pullRequests = new Map<string, PullRequestSnapshot | null>()
  for (const [index, ref] of refs.entries()) {
    const node = data?.[`p${index}`]?.pullRequest
    if (!node) {
      pullRequests.set(refKey(ref), null)
      continue
    }
    let page = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts
    const contexts: any[] = [...(page?.nodes ?? [])]
    while (page?.pageInfo?.hasNextPage) {
      const [owner, name] = ref.repo.split('/')
      const more = await graphql(MORE_CONTEXTS, { owner, name, number: ref.number, after: page.pageInfo.endCursor })
      page = more?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts
      contexts.push(...(page?.nodes ?? []))
    }
    pullRequests.set(refKey(ref), {
      repo: ref.repo,
      number: ref.number,
      title: String(node.title ?? ''),
      url: String(node.url ?? `https://github.com/${ref.repo}/pull/${ref.number}`),
      state: node.state === 'MERGED' || node.state === 'CLOSED' ? node.state : 'OPEN',
      author: node.author?.login ?? null,
      headSha: String(node.headRefOid ?? ''),
      mergeable: node.mergeable === 'CONFLICTING' || node.mergeable === 'MERGEABLE' ? node.mergeable : 'UNKNOWN',
      checks: latest(contexts),
      threads: (node.reviewThreads?.nodes ?? []).map((thread: any): ReviewThread => {
        const first = thread.comments?.nodes?.[0]
        return {
          id: String(thread.id), resolved: thread.isResolved === true, author: first?.author?.login ?? null,
          path: thread.path ?? null, line: thread.line ?? thread.originalLine ?? null, body: String(first?.body ?? ''), url: first?.url ?? null
        }
      })
    })
  }
  return { viewer: String(data?.viewer?.login ?? ''), pullRequests }
}

/**
 * The latest run of each check: a check that runs again on the same commit, such as one triggered again by a label,
 * is listed once for each run. A run not yet started is the latest.
 */
function latest(contexts: any[]): Check[] {
  const runs = new Map<string, { check: Check; at: number; id: number }>()
  for (const node of contexts) {
    for (const found of check(node)) {
      const started = node.startedAt ?? node.createdAt
      const run = { check: found, at: started ? Date.parse(started) : Infinity, id: Number(node.databaseId ?? 0) }
      const previous = runs.get(found.name)
      if (!previous || run.at > previous.at || (run.at === previous.at && run.id > previous.id)) runs.set(found.name, run)
    }
  }
  return [...runs.values()].map((run) => run.check)
}

/** A check run or commit status as a check. Cancelled, skipped and stale runs are neutral. */
function check(node: any): Check[] {
  if (node?.__typename === 'CheckRun') {
    const status: CheckStatus = node.status !== 'COMPLETED' ? 'pending'
      : node.conclusion === 'SUCCESS' ? 'success'
      : ['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(node.conclusion) ? 'failure' : 'neutral'
    return [{ name: String(node.name), status, url: node.detailsUrl ?? null }]
  }
  if (node?.__typename === 'StatusContext') {
    const status: CheckStatus = node.state === 'SUCCESS' ? 'success' : node.state === 'FAILURE' || node.state === 'ERROR' ? 'failure' : 'pending'
    return [{ name: String(node.context), status, url: node.targetUrl ?? null }]
  }
  return []
}

/** `gh api graphql` with the login shell's environment, where `gh` finds its sign-in. */
export async function ghGraphQL(query: string, variables: Record<string, string | number> = {}): Promise<any> {
  const env = await loginEnvironment()
  const gh = resolveExecutable('gh', env)
  if (!gh) throw new Error('gh is not on the login shell’s PATH')
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [key, value] of Object.entries(variables)) args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`)
  try {
    const { stdout } = await run(gh, args, { env, timeout: TIMEOUT_MS, maxBuffer: 32 << 20 })
    return JSON.parse(stdout).data
  } catch (error) {
    // A partial answer, such as one pull request that no longer exists, still carries the others.
    const stdout = (error as { stdout?: string }).stdout
    const data = stdout ? (() => { try { return JSON.parse(stdout).data } catch { return null } })() : null
    if (data) return data
    const stderr = String((error as { stderr?: string }).stderr ?? '').trim()
    throw new Error(stderr || (error as Error).message)
  }
}

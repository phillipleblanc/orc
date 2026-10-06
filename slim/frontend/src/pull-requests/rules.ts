import type { Check, PullRequestSnapshot, ReviewThread } from './github.ts'

/** Copilot's review comments come from this account. */
export const COPILOT = 'copilot-pull-request-reviewer'
/** A failing check is reported before the latest commit's other checks finish once it has failed this long. */
export const SETTLE_MS = 15 * 60_000
/** A check that fails on this many commits in a row, each reported to the agent, goes to its person instead. */
export const REPEATS = 2

/** What Orc remembers of a watched pull request between looks. */
export type WatchState = {
  /** Findings the agent was told about: `check SHA NAME`, `thread ID` and `conflict SHA`. */
  told: string[]
  /** The commits each check was reported failing on, in a row: a pass clears it. */
  failures: Record<string, string[]>
  /** Checks no longer reported to the agent, waiting on its person: by name, the commit it failed on again. */
  handedOver: Record<string, string>
  /** Checks its person chose to keep reporting to the agent however often they fail. */
  keep: string[]
  /** When each failing check of the latest commit was first seen failing, by `SHA NAME`. */
  firstFailed: Record<string, number>
}

export const emptyState = (): WatchState => ({ told: [], failures: {}, handedOver: {}, keep: [], firstFailed: {} })

/** What to tell the agent about a pull request: new failing checks and Copilot comments, and a merge conflict. */
export type Report = { sha: string; conflict: boolean; failures: Check[]; threads: ReviewThread[] }

export type Evaluation = {
  /** What to tell the agent now, if anything. */
  report: Report | null
  /** Checks that failed again after being reported REPEATS times, now for its person. */
  handOver: string[]
  /** The state after reporting and handing over. */
  state: WatchState
}

/** Whether a check's name matches one of the patterns, where `*` matches anything; case is ignored. */
export function ignored(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new RegExp(`^${pattern.trim().split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(name))
}

/**
 * What is new on a pull request since the agent was last told: failing checks of its latest commit, unresolved
 * Copilot threads, and a merge conflict, each at most once (a check once per commit). A failing check waits until the
 * commit's other checks finish, or SETTLE_MS. Ignored checks are never reported, and a check reported failing on
 * REPEATS commits in a row is handed to its person rather than reported again. Only an agent that is `ready` is told
 * or has checks handed over; otherwise only what has been seen is kept.
 */
export function evaluate(pr: PullRequestSnapshot, previous: WatchState, options: { ignore: string[]; now: number; ready: boolean }): Evaluation {
  const sha = pr.headSha
  const state: WatchState = {
    // Findings of earlier commits no longer matter, except threads, which outlive commits.
    told: previous.told.filter((key) => key.startsWith('thread ') || key.split(' ')[1] === sha),
    failures: { ...previous.failures },
    handedOver: { ...previous.handedOver },
    keep: [...previous.keep],
    firstFailed: Object.fromEntries(Object.entries(previous.firstFailed).filter(([key]) => key.startsWith(`${sha} `)))
  }
  if (pr.state !== 'OPEN') return { report: null, handOver: [], state }
  const told = new Set(state.told)
  const checks = pr.checks.filter((check) => !ignored(check.name, options.ignore))
  for (const check of checks) {
    if (check.status === 'success') {
      delete state.failures[check.name]
      delete state.handedOver[check.name]
    }
    if (check.status === 'failure') state.firstFailed[`${sha} ${check.name}`] ??= options.now
  }
  if (!options.ready) return { report: null, handOver: [], state }
  const failing = checks.filter((check) => check.status === 'failure' && !told.has(`check ${sha} ${check.name}`) && !state.handedOver[check.name])
  const settled = !checks.some((check) => check.status === 'pending')
    || failing.some((check) => options.now - state.firstFailed[`${sha} ${check.name}`] >= SETTLE_MS)
  const handOver = failing.filter((check) => !state.keep.includes(check.name) && (state.failures[check.name] ?? []).length >= REPEATS).map((check) => check.name)
  for (const name of handOver) state.handedOver[name] = sha
  const failures = settled ? failing.filter((check) => !handOver.includes(check.name)) : []
  const threads = pr.threads.filter((thread) => thread.author === COPILOT && !thread.resolved && !told.has(`thread ${thread.id}`))
  const conflict = pr.mergeable === 'CONFLICTING' && !told.has(`conflict ${sha}`)
  if (!conflict && failures.length === 0 && threads.length === 0) return { report: null, handOver, state }
  for (const check of failures) {
    state.told.push(`check ${sha} ${check.name}`)
    state.failures[check.name] = [...(state.failures[check.name] ?? []).filter((commit) => commit !== sha), sha]
  }
  for (const thread of threads) state.told.push(`thread ${thread.id}`)
  if (conflict) state.told.push(`conflict ${sha}`)
  return { report: { sha, conflict, failures, threads }, handOver, state }
}

/** The message that tells the agent. */
export function reportMessage(pr: PullRequestSnapshot, report: Report): string {
  const lines = [`Pull request ${pr.repo}#${pr.number} (${pr.title}) at ${report.sha.slice(0, 7)}:`]
  if (report.conflict) lines.push('- It has merge conflicts with its base branch.')
  for (const check of report.failures) lines.push(`- Check failed: ${check.name}${check.url ? ` ${check.url}` : ''}`)
  for (const thread of report.threads) {
    const where = thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ''}: ` : ''
    const body = thread.body.replace(/\s+/g, ' ').trim()
    lines.push(`- Unresolved Copilot comment: ${where}"${body.length > 200 ? `${body.slice(0, 200)}…` : body}"${thread.url ? ` ${thread.url}` : ''}`)
  }
  const asks = [
    report.conflict ? 'resolve the conflicts' : '',
    report.failures.length ? 'fix the failures this pull request caused' : '',
    report.threads.length ? 'address each Copilot comment, reply, and resolve its thread' : ''
  ].filter(Boolean)
  lines.push('', `Please ${asks.join(', ')}. Orc reports each of these once, and a check once per commit.`)
  return lines.join('\n')
}

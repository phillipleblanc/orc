import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonFile } from '../json-file.ts'
import { fetchPullRequests, parsePullRequest, refKey, type FetchResult, type PullRequestRef, type PullRequestSnapshot } from './github.ts'
import { COPILOT, emptyState, evaluate, ignored, reportMessage, type WatchState } from './rules.ts'

/** How often a watched pull request is looked at, unless the agent is about to be told about it. */
export const POLL_MS = 3 * 60_000
/** An agent is told only once it has been idle this long, with nothing queued for it. */
export const IDLE_MS = 30_000
const TICK_MS = 60_000
/** Checks expected to fail, never reported, until its person changes them. */
export const DEFAULT_IGNORED = ['Attestation']

/** A running agent session that can have pull requests. */
export type WatchAgent = { name: string; dir: string; parent?: string }
export type AgentStatus = { state: string; since: number; queued: number; delivering: boolean }

type Watched = {
  repo: string
  number: number
  url: string
  addedAt: number
  /** Who linked it to the agent: the status brief's model, or its person. */
  addedBy: 'brief' | 'person'
  snapshot: PullRequestSnapshot | null
  checkedAt: number | null
  /** Why the latest look failed. */
  error: string | null
  state: WatchState
  /** When the agent was last told about it. */
  toldAt: number | null
}

export type PullRequestSummary = {
  repo: string
  number: number
  url: string
  title: string | null
  addedBy: 'brief' | 'person'
  checkedAt: number | null
  error: string | null
  toldAt: number | null
  conflict: boolean
  /** Failing checks of the latest commit that are not ignored. */
  failing: string[]
  /** Failing checks of the latest commit that are ignored. */
  ignoredFailing: string[]
  pending: number
  /** Unresolved Copilot review threads. */
  copilot: number
  /** Checks that failed again after the agent was told, waiting on its person. */
  handedOver: string[]
}

/**
 * Pull requests linked to agent sessions, watched on GitHub without a model: an agent that has been idle a while is
 * told about failing checks, unresolved Copilot comments and merge conflicts on its pull requests, by the rules in
 * `rules.ts`. A pull request is linked by the status brief's model, which reports the ones an agent is responsible
 * for, or by its person; it is dropped once merged or closed. Kept in each session's `pull-requests.json`, and the
 * ignored checks in `<profile>/pull-request-settings.json`.
 */
export class PullRequestWatch {
  private readonly settingsPath: string
  private readonly agents: () => WatchAgent[]
  private readonly status: (name: string) => AgentStatus | null
  private readonly send: (name: string, text: string) => Promise<unknown>
  private readonly fetch: (refs: PullRequestRef[]) => Promise<FetchResult>
  private readonly now: () => number
  private readonly lists = new Map<string, Promise<Watched[]>>()
  private ignore: string[] = DEFAULT_IGNORED
  private timer: NodeJS.Timeout | null = null
  private ticking: Promise<void> | null = null

  constructor(options: {
    profile: string
    agents: () => WatchAgent[]
    status: (name: string) => AgentStatus | null
    send: (name: string, text: string) => Promise<unknown>
    fetch?: (refs: PullRequestRef[]) => Promise<FetchResult>
    now?: () => number
  }) {
    this.settingsPath = join(options.profile, 'pull-request-settings.json')
    this.agents = options.agents
    this.status = options.status
    this.send = options.send
    this.fetch = options.fetch ?? ((refs) => fetchPullRequests(refs))
    this.now = options.now ?? Date.now
  }

  async start(): Promise<void> {
    try {
      const settings = JSON.parse(await readFile(this.settingsPath, 'utf8'))
      if (Array.isArray(settings.ignoredChecks)) this.ignore = settings.ignoredChecks.filter((name: unknown): name is string => typeof name === 'string')
    } catch {}
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  get settings(): { ignoredChecks: string[] } {
    return { ignoredChecks: [...this.ignore] }
  }

  /** Sets the checks never reported: names, where `*` matches anything. */
  async configure(ignoredChecks: string[]): Promise<void> {
    this.ignore = [...new Set(ignoredChecks.map((name) => name.trim()).filter(Boolean))]
    await writeJsonFile(this.settingsPath, { ignoredChecks: this.ignore })
  }

  /** The pull requests linked to an agent, as `owner/name#number`. */
  async linked(name: string): Promise<string[]> {
    const agent = this.agent(name)
    return agent ? (await this.loaded(agent)).map(refKey) : []
  }

  /**
   * Links a pull request the status brief's model says the agent is responsible for, and answers the model. It is
   * linked only if `shown`, what the model was given, names it, and it is open and opened by `gh`'s user.
   */
  async claim(name: string, url: string, shown: string): Promise<string> {
    const ref = parsePullRequest(url)
    if (!ref) return 'Not recorded: that is not a GitHub pull request link.'
    if (!mentioned(ref, shown)) return `Not recorded: ${refKey(ref)} does not appear in the log or summary.`
    const linked = await this.link(name, ref, 'brief')
    if ('reason' in linked) return `Not recorded: ${linked.reason}.`
    if (linked.already) return `Already watched for this agent: ${refKey(ref)}.`
    return `Recorded: Orc watches ${refKey(ref)} for this agent${linked.from ? ` instead of ${linked.from}` : ''}.`
  }

  /** Links a pull request to an agent at its person's request, from another agent if need be. */
  async watch(name: string, url: string): Promise<string> {
    const ref = parsePullRequest(url)
    if (!ref) throw new Error(`${url} is not a GitHub pull request link or owner/name#number`)
    if (!this.agent(name)) throw new Error(`${name} is not a running agent session`)
    const linked = await this.link(name, ref, 'person')
    if ('reason' in linked) throw new Error(linked.reason)
    if (linked.already) return `${name} already watches ${refKey(ref)}.`
    return `${name} watches ${refKey(ref)}${linked.from ? ` instead of ${linked.from}` : ''}.`
  }

  async unwatch(name: string, url: string): Promise<boolean> {
    const ref = parsePullRequest(url)
    const agent = this.agent(name)
    if (!ref || !agent) return false
    const list = await this.loaded(agent)
    const index = list.findIndex((pr) => refKey(pr) === refKey(ref))
    if (index < 0) return false
    list.splice(index, 1)
    await this.save(agent, list)
    return true
  }

  /** Answers a check handed over to the agent's person: ignore it from now on, or keep reporting it to the agent. */
  async resolve(name: string, url: string, check: string, choice: 'ignore' | 'keep'): Promise<void> {
    const ref = parsePullRequest(url)
    const agent = this.agent(name)
    const pr = ref && agent ? (await this.loaded(agent)).find((candidate) => refKey(candidate) === refKey(ref)) : undefined
    if (!agent || !pr) throw new Error(`${name} does not watch ${url}`)
    delete pr.state.handedOver[check]
    if (choice === 'ignore') {
      if (!ignored(check, this.ignore)) await this.configure([...this.ignore, check])
    } else {
      if (!pr.state.keep.includes(check)) pr.state.keep.push(check)
      delete pr.state.failures[check]
    }
    await this.save(agent, await this.loaded(agent))
  }

  /** The pull requests of an agent, or of every agent, by agent name. */
  async list(name?: string): Promise<Record<string, PullRequestSummary[]>> {
    const result: Record<string, PullRequestSummary[]> = {}
    for (const agent of this.agents()) {
      if (name !== undefined && agent.name !== name) continue
      result[agent.name] = (await this.loaded(agent)).map((pr) => this.summary(pr))
    }
    return result
  }

  /** Looks at the pull requests that are due, and tells agents that are ready what is new. */
  tick(): Promise<void> {
    this.ticking ??= this.look().finally(() => { this.ticking = null })
    return this.ticking
  }

  private async look(): Promise<void> {
    const agents = this.agents()
    for (const dir of this.lists.keys()) if (!agents.some((agent) => agent.dir === dir)) this.lists.delete(dir)
    const now = this.now()
    const due: { agent: WatchAgent; pr: Watched }[] = []
    for (const agent of agents) {
      const ready = this.ready(agent.name, now)
      for (const pr of await this.loaded(agent)) {
        // A pull request with news for a ready agent is looked at again just before the agent is told.
        const news = ready && pr.snapshot && evaluate(pr.snapshot, pr.state, { ignore: this.ignore, now, ready: true })
        if (!pr.checkedAt || now - pr.checkedAt >= POLL_MS || (news && (news.report || news.handOver.length > 0))) due.push({ agent, pr })
      }
    }
    if (due.length === 0) return
    let result: FetchResult
    try {
      result = await this.fetch(due.map(({ pr }) => ({ repo: pr.repo, number: pr.number })))
    } catch (error) {
      for (const { agent, pr } of due) {
        pr.error = (error as Error).message
        pr.checkedAt = now
        await this.save(agent, await this.loaded(agent))
      }
      return
    }
    for (const { agent, pr } of due) {
      const list = await this.loaded(agent)
      if (!list.includes(pr)) continue
      const snapshot = result.pullRequests.get(refKey(pr))
      pr.checkedAt = this.now()
      if (!snapshot) {
        pr.error = 'GitHub has no such pull request, or gh cannot see it'
        await this.save(agent, list)
        continue
      }
      pr.snapshot = snapshot
      pr.error = null
      if (snapshot.state !== 'OPEN') {
        list.splice(list.indexOf(pr), 1)
        await this.save(agent, list)
        continue
      }
      const evaluation = evaluate(snapshot, pr.state, { ignore: this.ignore, now: this.now(), ready: this.ready(agent.name, this.now()) })
      if (evaluation.report) {
        try {
          await this.send(agent.name, reportMessage(snapshot, evaluation.report))
        } catch (error) {
          pr.error = `Could not tell the agent: ${(error as Error).message}`
          await this.save(agent, list)
          continue
        }
        pr.toldAt = this.now()
      }
      pr.state = evaluation.state
      await this.save(agent, list)
    }
  }

  /** Links a pull request to an agent, from the agent that had it if need be, or says why not. */
  private async link(name: string, ref: PullRequestRef, by: 'brief' | 'person'): Promise<{ already?: boolean; from?: string } | { reason: string }> {
    const agent = this.agent(name)
    if (!agent) return { reason: `${name} is not a running agent session` }
    const key = refKey(ref)
    const list = await this.loaded(agent)
    if (list.some((pr) => refKey(pr) === key)) return { already: true }
    let previous: { owner: WatchAgent; list: Watched[]; pr: Watched } | null = null
    for (const other of this.agents()) {
      if (other.dir === agent.dir) continue
      const theirs = await this.loaded(other)
      const pr = theirs.find((candidate) => refKey(candidate) === key)
      if (pr) previous = { owner: other, list: theirs, pr }
    }
    // An agent's own pull request stays with it rather than going to the agent that started it.
    if (previous && by === 'brief' && !this.descends(agent, previous.owner)) {
      return { reason: `${key} is watched for ${previous.owner.name}${this.descends(previous.owner, agent) ? ', which this agent started' : ''}` }
    }
    let result: FetchResult
    try {
      result = await this.fetch([ref])
    } catch (error) {
      return { reason: `GitHub could not be asked about ${key}: ${(error as Error).message}` }
    }
    const snapshot = result.pullRequests.get(key)
    if (!snapshot) return { reason: `GitHub has no pull request ${key}` }
    if (snapshot.state !== 'OPEN') return { reason: `${key} is ${snapshot.state.toLowerCase()}` }
    if (by === 'brief' && snapshot.author !== result.viewer) return { reason: `${key} was opened by ${snapshot.author ?? 'someone else'}, not ${result.viewer}` }
    if (previous) {
      previous.list.splice(previous.list.indexOf(previous.pr), 1)
      await this.save(previous.owner, previous.list)
    }
    list.push({
      repo: snapshot.repo, number: snapshot.number, url: snapshot.url, addedAt: this.now(), addedBy: by,
      snapshot, checkedAt: this.now(), error: null, state: previous?.pr.state ?? emptyState(), toldAt: previous?.pr.toldAt ?? null
    })
    await this.save(agent, list)
    return previous ? { from: previous.owner.name } : {}
  }

  /** Whether `agent` was started, directly or not, by `ancestor`. */
  private descends(agent: WatchAgent, ancestor: WatchAgent): boolean {
    const byName = new Map(this.agents().map((candidate) => [candidate.name, candidate]))
    const seen = new Set<string>()
    for (let current = agent.parent; current && !seen.has(current); current = byName.get(current)?.parent) {
      if (current === ancestor.name) return true
      seen.add(current)
    }
    return false
  }

  private ready(name: string, now: number): boolean {
    const status = this.status(name)
    return Boolean(status) && status!.state === 'idle' && status!.queued === 0 && !status!.delivering && now - status!.since >= IDLE_MS
  }

  private summary(pr: Watched): PullRequestSummary {
    const checks = pr.snapshot?.checks ?? []
    const counted = checks.filter((check) => !ignored(check.name, this.ignore))
    return {
      repo: pr.repo, number: pr.number, url: pr.url, title: pr.snapshot?.title ?? null, addedBy: pr.addedBy,
      checkedAt: pr.checkedAt, error: pr.error, toldAt: pr.toldAt,
      conflict: pr.snapshot?.mergeable === 'CONFLICTING',
      failing: counted.filter((check) => check.status === 'failure').map((check) => check.name),
      ignoredFailing: checks.filter((check) => check.status === 'failure' && ignored(check.name, this.ignore)).map((check) => check.name),
      pending: counted.filter((check) => check.status === 'pending').length,
      copilot: (pr.snapshot?.threads ?? []).filter((thread) => thread.author === COPILOT && !thread.resolved).length,
      handedOver: Object.keys(pr.state.handedOver)
    }
  }

  private agent(name: string): WatchAgent | undefined {
    return this.agents().find((agent) => agent.name === name)
  }

  private loaded(agent: WatchAgent): Promise<Watched[]> {
    let list = this.lists.get(agent.dir)
    if (!list) {
      list = readFile(join(agent.dir, 'pull-requests.json'), 'utf8').then((text) => {
        const saved = JSON.parse(text)?.pullRequests
        return Array.isArray(saved) ? saved.map((pr: Watched) => ({ ...pr, state: { ...emptyState(), ...pr.state } })) : []
      }, () => [])
      this.lists.set(agent.dir, list)
    }
    return list
  }

  private save(agent: WatchAgent, list: Watched[]): Promise<void> {
    return writeJsonFile(join(agent.dir, 'pull-requests.json'), { pullRequests: list }).catch(() => {})
  }
}

/** Whether the text names the pull request: by its link, as `owner/name#number`, or by number beside its repository's name. */
function mentioned(ref: PullRequestRef, shown: string): boolean {
  const text = shown.toLowerCase()
  const repo = ref.repo.toLowerCase()
  if (text.includes(`${repo}/pull/${ref.number}`) || text.includes(`${repo}#${ref.number}`)) return true
  return new RegExp(`(#|pull/|\\bpr\\s*#?)${ref.number}\\b`, 'i').test(shown) && text.includes(repo.split('/')[1])
}

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonFile } from '../json-file.ts'
import { shownText, type Brief } from './prompt.ts'
import type { Digest } from './transcript.ts'

/** An agent session a brief can be written for. */
export type BriefSource = {
  name: string
  agent: string
  /** The agent's state: `working`, `idle`, `permission`, … */
  state: string
  /** The transcript's digest and a mark that changes when the transcript does; null when there is no transcript yet. */
  transcript(): Promise<{ digest: Digest; mark: string } | null>
  /** A mark of the transcript, cheaper than its digest. */
  mark(): Promise<string | null>
}

export type BriefRequest = {
  digest: Digest
  about: { name: string; agent: string; state: string }
  model: string
  /** The pull requests already linked to the agent, and how to link another, answered for the model. */
  pullRequests?: { linked: string[]; report: (url: string) => Promise<string> }
}

/** Pull requests linked to agents, which a brief's model can add to. */
export type BriefPullRequests = {
  linked(name: string): Promise<string[]>
  /** Links a pull request the model reported, if `shown`, what it was given, names it; the answer is for the model. */
  claim(name: string, url: string, shown: string): Promise<string>
}

/** A session's brief, as stored and reported. */
export type BriefRecord = {
  name: string
  brief: Brief | null
  /** When `brief` was written, in Unix milliseconds. */
  generatedAt: number | null
  /** The model that wrote it, as `provider/id`. */
  model: string | null
  /** Why the latest attempt failed. */
  error: string | null
  /** The transcript's mark when `brief` was written. */
  mark: string | null
  /** Failed attempts since the last brief; the next automatic attempt waits until `retryAt`. */
  failures?: number
  retryAt?: number | null
  generating: boolean
}

/** Briefs follow an agent's turn after this long, so a queued follow-up can start first. */
export const SETTLE_MS = 20_000
/** Automatic briefs for one session are at least this far apart. */
export const MIN_INTERVAL_MS = 5 * 60_000
/** A working agent gets a new brief this often while its transcript grows. */
export const WORKING_INTERVAL_MS = 15 * 60_000
const CHECK_MS = 60_000
/** After a failed attempt, automatic ones wait this long, doubling with each failure in a row up to MAX_RETRY_MS. */
export const FIRST_RETRY_MS = 5 * 60_000
const MAX_RETRY_MS = 60 * 60_000

/**
 * Status briefs of agent sessions: where each agent's work stands, written by a model from its transcript so the
 * agent is never asked. A brief is written when an agent finishes a turn or stops for permission, every
 * WORKING_INTERVAL_MS while it works, and when asked; only when its transcript changed since the last one, and
 * automatically at most every MIN_INTERVAL_MS. One brief is written at a time. Writing one, the model can link the
 * pull requests the agent is responsible for to it, for Orc to watch. Briefs are kept in `<profile>/briefs/NAME.json`,
 * and the model in `<profile>/brief-settings.json`.
 */
export class BriefService {
  private readonly directory: string
  private readonly settingsPath: string
  private readonly sessions: () => BriefSource[]
  private readonly write: (request: BriefRequest) => Promise<Brief>
  private readonly pullRequests: BriefPullRequests | null
  private readonly now: () => number
  private readonly records = new Map<string, BriefRecord>()
  private readonly states = new Map<string, string>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly queue: { name: string; forced: boolean }[] = []
  private readonly waiters = new Map<string, (() => void)[]>()
  private running: string | null = null
  private model: string | null = null
  private check: NodeJS.Timeout | null = null

  constructor(options: {
    profile: string
    sessions: () => BriefSource[]
    write: (request: BriefRequest) => Promise<Brief>
    pullRequests?: BriefPullRequests
    now?: () => number
  }) {
    this.directory = join(options.profile, 'briefs')
    this.settingsPath = join(options.profile, 'brief-settings.json')
    this.sessions = options.sessions
    this.write = options.write
    this.pullRequests = options.pullRequests ?? null
    this.now = options.now ?? Date.now
  }

  async start(): Promise<void> {
    try {
      const settings = JSON.parse(await readFile(this.settingsPath, 'utf8'))
      this.model = typeof settings.model === 'string' && settings.model ? settings.model : null
    } catch {}
    for (const source of this.sessions()) await this.load(source.name)
    this.check = setInterval(() => void this.checkAll(), CHECK_MS)
    this.check.unref()
    void this.checkAll()
  }

  stop(): void {
    if (this.check) clearInterval(this.check)
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** The model briefs are written with, as `provider/id`; null turns briefs off. */
  get settings(): { model: string | null } {
    return { model: this.model }
  }

  async configure(model: string | null): Promise<void> {
    this.model = model
    await writeJsonFile(this.settingsPath, { model })
    if (model) void this.checkAll()
  }

  /** The briefs of the running agent sessions. */
  list(): BriefRecord[] {
    return this.sessions().map((source) => this.record(source.name))
  }

  get(name: string): BriefRecord {
    return this.record(name)
  }

  /** Writes a brief now, ahead of automatic ones, even if the transcript has not changed; `wait` resolves once it is written. */
  async refresh(name: string, { wait = false } = {}): Promise<BriefRecord> {
    if (!this.model) throw new Error('No status model is chosen. Choose one in Orc’s Settings.')
    if (!this.sessions().some((source) => source.name === name)) throw new Error(`${name} is not a running agent session`)
    const done = wait ? new Promise<void>((resolve) => this.waiters.set(name, [...(this.waiters.get(name) ?? []), resolve])) : null
    this.enqueue(name, true)
    await done
    return this.record(name)
  }

  /** Called when an agent's state changes: a finished turn, or a stop for permission, schedules a brief. */
  observe(name: string): void {
    const source = this.sessions().find((candidate) => candidate.name === name)
    if (!source) return
    const previous = this.states.get(name)
    this.states.set(name, source.state)
    if (previous === 'working' && (source.state === 'idle' || source.state === 'permission')) this.schedule(name, SETTLE_MS)
  }

  private record(name: string): BriefRecord {
    const record = this.records.get(name) ?? { name, brief: null, generatedAt: null, model: null, error: null, mark: null, generating: false }
    return { ...record, generating: this.running === name || this.queue.some((entry) => entry.name === name && entry.forced) }
  }

  private async load(name: string): Promise<void> {
    if (this.records.has(name)) return
    try {
      const stored = JSON.parse(await readFile(join(this.directory, `${name}.json`), 'utf8'))
      if (stored?.name === name) this.records.set(name, { ...stored, generating: false })
    } catch {}
  }

  private schedule(name: string, delay: number): void {
    clearTimeout(this.timers.get(name))
    const timer = setTimeout(() => {
      this.timers.delete(name)
      void this.consider(name)
    }, delay)
    timer.unref()
    this.timers.set(name, timer)
  }

  /**
   * Queues an automatic brief when the transcript changed since the last, no sooner than MIN_INTERVAL_MS after it, and
   * after a failed attempt no sooner than its retry time.
   */
  private async consider(name: string): Promise<void> {
    const source = this.sessions().find((candidate) => candidate.name === name)
    if (!source || !this.model) return
    await this.load(name)
    const record = this.records.get(name)
    const mark = await source.mark()
    if (!mark || mark === record?.mark) return
    const wait = Math.max((record?.generatedAt ?? 0) + MIN_INTERVAL_MS, record?.retryAt ?? 0) - this.now()
    if (wait > 0) return this.schedule(name, wait)
    this.enqueue(name, false)
  }

  /** Briefs for agents without one or with a changed transcript, and for agents that have worked a while since theirs. */
  private async checkAll(): Promise<void> {
    if (!this.model) return
    for (const source of this.sessions()) {
      this.states.set(source.name, source.state)
      if (this.timers.has(source.name)) continue
      await this.load(source.name)
      const record = this.records.get(source.name)
      const age = this.now() - (record?.generatedAt ?? 0)
      if (!record?.brief || (source.state === 'working' ? age >= WORKING_INTERVAL_MS : age >= MIN_INTERVAL_MS)) void this.consider(source.name)
    }
  }

  /** Queues a brief; forced ones go ahead of automatic ones. A brief already being written for the session counts. */
  private enqueue(name: string, forced: boolean): void {
    const index = this.queue.findIndex((entry) => entry.name === name)
    if (index >= 0 && (this.queue[index].forced || !forced)) return
    if (index >= 0) this.queue.splice(index, 1)
    if (this.running !== name) forced ? this.queue.unshift({ name, forced }) : this.queue.push({ name, forced })
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.running) return
    const next = this.queue.shift()
    if (!next) return
    this.running = next.name
    try {
      await this.generate(next.name)
    } finally {
      this.running = null
      for (const resolve of this.waiters.get(next.name) ?? []) resolve()
      this.waiters.delete(next.name)
      void this.drain()
    }
  }

  private async generate(name: string): Promise<void> {
    const source = this.sessions().find((candidate) => candidate.name === name)
    const model = this.model
    if (!source || !model) return
    await this.load(name)
    const previous = this.records.get(name) ?? { name, brief: null, generatedAt: null, model: null, error: null, mark: null, generating: false }
    let record: BriefRecord
    try {
      const transcript = await source.transcript()
      if (!transcript) throw new Error('The agent has no transcript yet')
      const pullRequests = this.pullRequests
      const shown = shownText(transcript.digest)
      const brief = await this.write({
        digest: transcript.digest, about: { name, agent: source.agent, state: source.state }, model,
        ...(pullRequests ? { pullRequests: { linked: await pullRequests.linked(name), report: (url: string) => pullRequests.claim(name, url, shown) } } : {})
      })
      record = { name, brief, generatedAt: this.now(), model, error: null, mark: transcript.mark, failures: 0, retryAt: null, generating: false }
    } catch (error) {
      // The last brief stays, with the error, and an automatic attempt follows after a backoff.
      const failures = (previous.failures ?? 0) + 1
      record = { ...previous, error: (error as Error).message, failures, retryAt: this.now() + Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (failures - 1)) }
    }
    this.records.set(name, record)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const { generating: _, ...stored } = record
    await writeJsonFile(join(this.directory, `${name}.json`), stored).catch(() => {})
  }
}

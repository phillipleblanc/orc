import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonFile } from '../json-file.ts'
import { parsePullRequest, refKey } from '../pull-requests/github.ts'
import type { Brief } from './prompt.ts'
import type { BriefRequest } from './service.ts'
import type { Digest } from './transcript.ts'

/** A brief the model is asked for, with what a model fit to write briefs must do with it. */
export type EvalCase = {
  id: string
  title: string
  digest: Digest
  about: BriefRequest['about']
  /** Pull requests already linked to the agent. */
  linked: string[]
  /** Pull requests the model must report, as `owner/name#number`; it must report no others. */
  report: string[]
  /** The question its person last marked read. */
  dismissed?: string
  /** Whether the agent waits on its person for something the brief should raise. */
  needsYou: boolean
  /** Text the brief must carry, to show it read the log: a field, or any, and a pattern. */
  mentions: [keyof Brief | 'any', RegExp][]
}

export type EvalResult = { id: string; title: string; passed: boolean; failures: string[]; ms: number }
export type EvalReport = { model: string; ranAt: number; passed: number; total: number; results: EvalResult[] }

export const EVAL_CASES: EvalCase[] = [
  {
    id: 'opened-pull-request',
    title: 'Reports the pull request the agent opened, not ones it read',
    about: { name: 'cold-start', agent: 'pi', state: 'idle' },
    linked: [],
    digest: {
      summary: 'Goal: add a cold-start time-to-ready regression test to testoperator in spiceai/spiceai. The coordinator, coord, owns https://github.com/spiceai/spiceai/pull/14788. Earlier the agent reviewed a teammate\'s pull request https://github.com/spiceai/spiceai/pull/14700 and left two comments.',
      items: [
        { role: 'user', text: 'Open the PR once the test passes locally.' },
        { role: 'tool', text: 'bash {"command":"cargo test -p testoperator cold_start"}' },
        { role: 'result', text: 'test result: ok. 4 passed; 0 failed; finished in 212.4s' },
        { role: 'tool', text: 'bash {"command":"git push -u origin cold-start-test && gh pr create --fill"}' },
        { role: 'result', text: 'https://github.com/spiceai/spiceai/pull/14785' },
        { role: 'assistant', text: 'Opened https://github.com/spiceai/spiceai/pull/14785 with the cold-start test. CI is running; I will check it when it finishes. For context I also read https://github.com/spiceai/spiceai/pull/14788, which coord owns.' }
      ],
      truncated: false
    },
    report: ['spiceai/spiceai#14785'],
    needsYou: false,
    mentions: [['any', /14785/]]
  },
  {
    id: 'pushed-to-pull-request',
    title: 'Reports a pull request the agent pushes commits to',
    about: { name: 'fix-lint', agent: 'claude', state: 'idle' },
    linked: [],
    digest: {
      firstPrompt: 'Fix the Clippy failures on spiceai/spiceai#14801 and push the fix to its branch.',
      items: [
        { role: 'tool', text: 'Bash {"command":"gh pr checkout 14801 && cargo clippy -p runtime -- -D warnings"}' },
        { role: 'error', text: 'error: this `if` has identical blocks\n  --> crates/runtime/src/dataupdate.rs:88:9\nerror: could not compile `runtime` due to 3 previous errors' },
        { role: 'tool', text: 'Edit {"file_path":"crates/runtime/src/dataupdate.rs"}' },
        { role: 'result', text: 'The file has been updated.' },
        { role: 'tool', text: 'Bash {"command":"cargo clippy -p runtime -- -D warnings && git commit -am \\"Fix Clippy\\" && git push"}' },
        { role: 'result', text: 'Finished `dev` profile in 41.2s\nTo github.com:spiceai/spiceai.git\n   3c1d2e0..9f8a7b6  fix-dataupdate -> fix-dataupdate' },
        { role: 'assistant', text: 'Fixed the three Clippy errors in dataupdate.rs and pushed to the branch of #14801. Waiting for its CI.' }
      ],
      truncated: false
    },
    report: ['spiceai/spiceai#14801'],
    needsYou: false,
    mentions: [['any', /clippy/i]]
  },
  {
    id: 'question-for-person',
    title: 'Says what the agent waits on from its person, and skips linked pull requests',
    about: { name: 'changesink', agent: 'codex', state: 'idle' },
    linked: ['spiceai/spiceai#14790', 'spiceai/spiceai#14791', 'spiceai/spiceai#14792'],
    digest: {
      summary: 'Goal: land the three-PR ChangeSink stack: PR1 https://github.com/spiceai/spiceai/pull/14790, PR2 https://github.com/spiceai/spiceai/pull/14791 and PR3 https://github.com/spiceai/spiceai/pull/14792. PR1 and PR2 merged.',
      items: [
        { role: 'tool', text: 'exec gh pr view 14792 --json mergeable' },
        { role: 'result', text: '{"mergeable":"CONFLICTING"}' },
        { role: 'assistant', text: 'PR3 (#14792) conflicts with trunk now that PR2 merged. I can rebase PR3 onto trunk and force-push, or open a new pull request from a fresh branch. Which do you prefer?' }
      ],
      truncated: false
    },
    // A question about something else, marked read earlier, does not hide this one.
    dismissed: 'Approve deleting the stale benchmark cache bucket?',
    report: [],
    needsYou: true,
    mentions: [['needsYou', /rebase|force|new (pull request|PR|branch)/i]]
  },
  {
    id: 'working-no-pull-requests',
    title: 'Describes work in progress and reports no pull requests',
    about: { name: 'flaky-refresh', agent: 'pi', state: 'working' },
    linked: [],
    digest: {
      firstPrompt: 'Fix the flaky test in crates/runtime/src/accelerated_table/refresh.rs. Do not open a pull request yet.',
      items: [
        { role: 'tool', text: 'read {"path":"crates/runtime/src/accelerated_table/refresh.rs"}' },
        { role: 'result', text: 'tokio::time::sleep(Duration::from_millis(50)).await;\nassert!(table.refreshed());' },
        { role: 'assistant', text: 'The flake comes from a 50 ms sleep racing the refresh task. I will wait on the refresh notification instead.' },
        { role: 'tool', text: 'edit {"path":"crates/runtime/src/accelerated_table/refresh.rs"}' },
        { role: 'result', text: 'Applied 1 edit.' },
        { role: 'tool', text: 'bash {"command":"cargo test -p runtime refresh -- --test-threads=1"}' }
      ],
      truncated: false
    },
    report: [],
    needsYou: false,
    mentions: [['now', /test|cargo/i]]
  },
  {
    id: 'dismissed-question',
    title: 'Does not raise again a question its person marked read',
    about: { name: 'changesink-pr3', agent: 'codex', state: 'idle' },
    linked: ['spiceai/spiceai#14790', 'spiceai/spiceai#14791', 'spiceai/spiceai#14792'],
    digest: {
      summary: 'Goal: land the three-PR ChangeSink stack: PR1 https://github.com/spiceai/spiceai/pull/14790, PR2 https://github.com/spiceai/spiceai/pull/14791 and PR3 https://github.com/spiceai/spiceai/pull/14792. PR1 and PR2 merged. PR3 conflicts with trunk; the agent asked whether to rebase it and force-push or open a new pull request.',
      items: [
        { role: 'tool', text: 'exec gh pr checks 14792' },
        { role: 'result', text: 'All checks were successful' },
        { role: 'assistant', text: 'Checks on #14792 pass, but it still conflicts with trunk. Should I rebase PR3 and force-push, or open a new pull request from a fresh branch?' }
      ],
      truncated: false
    },
    dismissed: 'Whether to rebase PR3 onto trunk and force-push, or open a new pull request.',
    report: [],
    needsYou: false,
    mentions: [['any', /14792|PR3/i]]
  },
  {
    id: 'opened-several-pull-requests',
    title: 'Reports every pull request the agent opened across repositories, not one it reviewed',
    about: { name: 'dependency-fixes', agent: 'claude', state: 'idle' },
    linked: [],
    digest: {
      firstPrompt: 'Fix the open Dependabot alerts in the cloud repositories, one pull request per repository. Review spicehq/cloud#6188 first; it touches the same lockfile.',
      items: [
        { role: 'tool', text: 'Bash {"command":"gh pr view 6188 -R spicehq/cloud --json title,files"}' },
        { role: 'result', text: '{"title":"Bump sharp","files":[{"path":"package-lock.json"}]}' },
        { role: 'assistant', text: 'spicehq/cloud#6188 only bumps sharp; it does not fix the alerts. I will open my own pull requests.' },
        ...['ai-platform#10829', 'cloud#6252', 'team#615', 'spice-cloud-deploy-action#38'].flatMap((key) => {
          const [repo, number] = key.split('#')
          return [
            { role: 'tool' as const, text: `Bash {"command":"cd ~/code/${repo} && npm audit fix && git commit -am 'Fix Dependabot alerts' && git push -u origin vuln-fixes && gh pr create --fill"}` },
            { role: 'result' as const, text: `added 3 packages, changed 12 packages\nhttps://github.com/spicehq/${repo}/pull/${number}` }
          ]
        }),
        { role: 'assistant', text: 'Opened four pull requests, one per repository. CI is running on all of them.' }
      ],
      truncated: false
    },
    report: ['spicehq/ai-platform#10829', 'spicehq/cloud#6252', 'spicehq/team#615', 'spicehq/spice-cloud-deploy-action#38'],
    needsYou: false,
    mentions: [['any', /four|10829|6252/i]]
  }
]

/** What a brief and the pull requests a model reported fall short of, for one case; empty when it passes. */
export function grade(test: EvalCase, outcome: { brief: Brief | null; error: string | null; reported: string[] }): string[] {
  const failures: string[] = []
  const { brief, reported } = outcome
  const shown = [test.digest.summary, test.digest.firstPrompt, ...test.digest.items.map((item) => item.text)].join('\n')
  for (const key of new Set(reported)) {
    const number = key.split('#')[1]
    if (!number || !shown.includes(number)) failures.push(`reported ${key}, which is not in the log`)
    else if (test.linked.includes(key)) failures.push(`reported ${key} again, though it was already linked`)
    else if (!test.report.includes(key)) failures.push(`reported ${key}, which the agent did not open or push to`)
  }
  for (const key of test.report) if (!reported.includes(key)) failures.push(`did not report ${key}, which the agent is responsible for`)
  if (!brief) return [`did not write a brief: ${outcome.error ?? 'no answer'}`, ...failures]
  const words = brief.headline.split(/\s+/).filter(Boolean).length
  if (words === 0) failures.push('wrote no headline')
  else if (words > 12) failures.push(`wrote a ${words}-word headline; it should be at most about 8`)
  if (!brief.goal) failures.push('wrote no goal')
  if (brief.next.length !== 3) failures.push(`listed ${brief.next.length} next steps instead of 3`)
  if (test.needsYou && !brief.needsYou) failures.push('missed the question the agent asked its person')
  if (!test.needsYou && brief.needsYou) {
    failures.push(test.dismissed ? `raised again the question its person marked read ("${brief.needsYou}")` : `said the agent waits on its person ("${brief.needsYou}") when it does not`)
  }
  for (const [field, pattern] of test.mentions) {
    // A missing question is already a failure.
    if (field === 'needsYou' && !brief.needsYou) continue
    const value = field === 'any' ? Object.values(brief).flat().join(' ') : brief[field]
    const text = Array.isArray(value) ? value.join(' ') : value ?? ''
    if (!pattern.test(text)) failures.push(field === 'any' ? `left ${pattern.source} out of the brief` : `left out of ${field} what the log says (${text ? `"${text}"` : 'empty'})`)
  }
  return failures
}

/** Asks the model for each case's brief, as statuses are written, and grades the answers. */
export async function evaluateBriefModel(model: string, write: (request: BriefRequest) => Promise<Brief>, now: () => number = Date.now): Promise<EvalReport> {
  const results: EvalResult[] = []
  for (const test of EVAL_CASES) {
    const started = now()
    const reported: string[] = []
    let brief: Brief | null = null
    let error: string | null = null
    try {
      brief = await write({
        digest: test.digest, about: test.about, model,
        ...(test.dismissed ? { dismissed: test.dismissed } : {}),
        pullRequests: {
          linked: test.linked,
          // Answered as the watch answers, without asking GitHub.
          report: async (url) => {
            const ref = parsePullRequest(url)
            if (!ref) return 'Not recorded: that is not a GitHub pull request link.'
            reported.push(refKey(ref))
            return test.linked.includes(refKey(ref)) ? `Already watched for this agent: ${refKey(ref)}.` : `Recorded: Orc watches ${refKey(ref)} for this agent.`
          }
        }
      })
    } catch (failure) {
      error = (failure as Error).message
    }
    const failures = grade(test, { brief, error, reported })
    results.push({ id: test.id, title: test.title, passed: failures.length === 0, failures, ms: now() - started })
  }
  return { model, ranAt: now(), passed: results.filter((result) => result.passed).length, total: results.length, results }
}

/**
 * Eval reports of status models, by model, kept in `<profile>/brief-evals.json`. One evaluation runs per model at a
 * time; asking again while one runs waits for it.
 */
export class BriefEvaluations {
  private readonly path: string
  private readonly write: (request: BriefRequest) => Promise<Brief>
  private reports: Record<string, EvalReport> | null = null
  private readonly running = new Map<string, Promise<EvalReport>>()

  constructor(options: { profile: string; write: (request: BriefRequest) => Promise<Brief> }) {
    this.path = join(options.profile, 'brief-evals.json')
    this.write = options.write
  }

  /** The latest report for the model, and whether an evaluation of it runs now. */
  async status(model: string): Promise<{ evaluation: EvalReport | null; evaluating: boolean }> {
    return { evaluation: (await this.load())[model] ?? null, evaluating: this.running.has(model) }
  }

  run(model: string): Promise<EvalReport> {
    let running = this.running.get(model)
    if (!running) {
      running = evaluateBriefModel(model, this.write).then(async (report) => {
        const reports = await this.load()
        reports[model] = report
        await writeJsonFile(this.path, reports).catch(() => {})
        return report
      }).finally(() => this.running.delete(model))
      this.running.set(model, running)
    }
    return running
  }

  private async load(): Promise<Record<string, EvalReport>> {
    if (!this.reports) {
      try {
        const saved = JSON.parse(await readFile(this.path, 'utf8'))
        this.reports = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
      } catch {
        this.reports = {}
      }
    }
    return this.reports!
  }
}

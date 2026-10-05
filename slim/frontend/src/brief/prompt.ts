import type { Digest, DigestItem } from './transcript.ts'

/** Where an agent stands, for the person who runs it: the shape Orc shows. */
export type Brief = {
  /** At most about eight words: what the agent is doing or waiting on. */
  headline: string
  goal: string
  /** Outcomes so far, oldest first. */
  progress: string[]
  /** What the agent is doing, or that it is at a checkpoint and what still runs. */
  now: string
  /** The next three steps. */
  next: string[]
  /** A decision or answer the agent waits on from the person. */
  needsYou: string | null
}

export const SYSTEM_PROMPT = `You report where a coding agent's work stands to the person who runs it, who has been away and is about to steer it again. You read the agent's own summary of its conversation and a log of what happened since, and answer only with a JSON object.`

const LABELS: Record<DigestItem['role'], string> = { user: 'USER', assistant: 'AGENT', tool: 'TOOL CALL', result: 'TOOL RESULT', error: 'TOOL ERROR' }

const INSTRUCTIONS = `Answer with only this JSON object, no Markdown:
{"headline": string, "goal": string, "progress": [string], "now": string, "next": [string, string, string], "needsYou": string or null}

- headline: at most 8 words, what the agent is doing or waiting on right now.
- goal: one sentence, the outcome the person wants.
- progress: 2 to 5 short items, outcomes so far (done, failed, unresolved), oldest first.
- now: one or two sentences on what the agent is doing at the end of the log. If it finished its turn, say it is at a checkpoint and whether anything it started (builds, tests, jobs) is still running.
- next: exactly 3 short steps the agent plans or should take next.
- needsYou: the decision or answer the agent is waiting on from the person, briefly; null when it is not waiting on them.

Go by where the log ends; it is newer than the summary. Be concrete: name PRs, files, commands and numbers from the log. Plain text in every field.`

/** The request for a brief: the agent, its state, its summary and its log since. */
export function briefPrompt(digest: Digest, about: { name: string; agent: string; state: string }): string {
  const log = digest.items.map((entry) => `${LABELS[entry.role]}: ${entry.text}`).join('\n')
  return [
    `Session "${about.name}", a ${about.agent} agent, is ${about.state} now.`,
    digest.summary ? `<summary>\n${digest.summary}\n</summary>` : digest.firstPrompt ? `<first_request>\n${digest.firstPrompt}\n</first_request>` : '',
    `<log${digest.truncated ? ' note="older entries left out"' : ''}>\n${log || '(nothing since)'}\n</log>`,
    INSTRUCTIONS
  ].filter(Boolean).join('\n\n')
}

function sentence(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/** The brief in a model's answer, which may carry reasoning or code fences around the JSON. */
export function parseBrief(text: string): Brief {
  const answer = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('the model did not answer with a brief')
  let value: any
  try {
    value = JSON.parse(answer.slice(start, end + 1))
  } catch {
    throw new Error('the model’s brief is not valid JSON')
  }
  const list = (items: unknown, limit: number) => (Array.isArray(items) ? items : []).map(sentence).filter(Boolean).slice(0, limit)
  const brief: Brief = {
    headline: sentence(value.headline),
    goal: sentence(value.goal),
    progress: list(value.progress, 6),
    now: sentence(value.now),
    next: list(value.next, 3),
    needsYou: sentence(value.needsYou) || null
  }
  if (!brief.goal && !brief.now) throw new Error('the model’s brief is empty')
  if (/^(null|none|n\/a|no)\.?$/i.test(brief.needsYou ?? '')) brief.needsYou = null
  return brief
}

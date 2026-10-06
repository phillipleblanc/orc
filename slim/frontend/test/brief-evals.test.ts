import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux'
import { BriefEvaluations, EVAL_CASES, evaluateBriefModel, grade } from '../src/brief/evals.ts'
import type { Brief } from '../src/brief/prompt.ts'
import type { BriefRequest } from '../src/brief/service.ts'
import { writeBrief } from '../src/brief/writer.ts'

const brief = (overrides: Partial<Brief> = {}): Brief => ({
  headline: 'Waiting on CI for PR 14785', goal: 'Add a cold-start test', progress: ['Opened #14785; Clippy fixed'], now: 'Running the refresh test with cargo',
  next: ['a', 'b', 'c'], needsYou: null, ...overrides
})

/** A model that does each case right: it reports what the case expects and asks what the agent asks. */
async function capable(request: BriefRequest): Promise<Brief> {
  const test = EVAL_CASES.find((candidate) => candidate.about.name === request.about.name)!
  for (const key of test.report) {
    const [repo, number] = key.split('#')
    await request.pullRequests!.report(`https://github.com/${repo}/pull/${number}`)
  }
  return brief({ needsYou: test.needsYou ? 'Rebase PR3 and force-push, or open a new pull request?' : null })
}

test('a capable model passes every eval case', async () => {
  const report = await evaluateBriefModel('lab/qwen', capable)
  assert.deepEqual(report.results.filter((result) => !result.passed).map((result) => [result.id, result.failures]), [])
  assert.deepEqual([report.model, report.passed, report.total], ['lab/qwen', EVAL_CASES.length, EVAL_CASES.length])
})

test('the grades name what a model got wrong', () => {
  const [opened, , question, working] = EVAL_CASES
  assert.deepEqual(grade(opened, { brief: brief(), error: null, reported: ['spiceai/spiceai#14785', 'spiceai/spiceai#14700', 'spiceai/spiceai#99999'] }), [
    'reported spiceai/spiceai#14700, which the agent did not open or push to',
    'reported spiceai/spiceai#99999, which is not in the log'
  ])
  assert.deepEqual(grade(opened, { brief: brief({ progress: [], headline: 'Busy' }), error: null, reported: [] }), [
    'did not report spiceai/spiceai#14785, which the agent is responsible for',
    'left 14785 out of the brief'
  ])
  assert.deepEqual(grade(question, { brief: brief({ next: ['a'] }), error: null, reported: ['spiceai/spiceai#14792'] }), [
    'reported spiceai/spiceai#14792 again, though it was already linked',
    'listed 1 next steps instead of 3',
    'missed the question the agent asked its person'
  ])
  assert.deepEqual(grade(working, { brief: brief({ needsYou: 'Approve?', headline: 'one two three four five six seven eight nine ten eleven twelve thirteen' }), error: null, reported: [] }), [
    'wrote a 13-word headline; it should be at most about 8',
    'said the agent waits on its person ("Approve?") when it does not'
  ])
  assert.deepEqual(grade(working, { brief: null, error: 'the model did not answer with a brief', reported: [] }), ['did not write a brief: the model did not answer with a brief'])
})

test('evals run through the brief writer, so a model that never calls the tool fails the pull request cases', async () => {
  const faux = fauxProvider({ provider: 'lab', models: [{ id: 'small', name: 'Small' }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(EVAL_CASES.map(() => () => fauxAssistantMessage(fauxText(JSON.stringify(brief())))))
  const report = await evaluateBriefModel('lab/small', (request) => writeBrief(request, models))
  assert.deepEqual(report.results.map((result) => [result.id, result.passed]), [
    ['opened-pull-request', false], ['pushed-to-pull-request', false], ['question-for-person', false], ['working-no-pull-requests', true]
  ])
  assert.match(report.results[1].failures.join('\n'), /did not report spiceai\/spiceai#14801/)
})

test('a model’s eval report is kept, and one evaluation runs at a time', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'orc-evals-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  let calls = 0
  const evaluations = new BriefEvaluations({ profile, write: async (request) => { calls++; return capable(request) } })
  assert.deepEqual(await evaluations.status('lab/qwen'), { evaluation: null, evaluating: false })
  const running = evaluations.run('lab/qwen')
  assert.equal(evaluations.run('lab/qwen'), running)
  assert.equal((await evaluations.status('lab/qwen')).evaluating, true)
  const report = await running
  assert.equal(calls, EVAL_CASES.length)
  assert.deepEqual(await evaluations.status('lab/qwen'), { evaluation: report, evaluating: false })
  assert.deepEqual(JSON.parse(await readFile(join(profile, 'brief-evals.json'), 'utf8'))['lab/qwen'], report)
  const again = new BriefEvaluations({ profile, write: capable })
  assert.deepEqual((await again.status('lab/qwen')).evaluation, report)
})

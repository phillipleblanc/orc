import assert from 'node:assert/strict'
import { appendFile, mkdir, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { destroyProfile, Frontend, makeProfile } from './harness.ts'

const lines = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'

async function transcript(path: string, body: string, minutesAgo: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body)
  const at = new Date(Date.now() - minutesAgo * 60_000)
  await utimes(path, at, at)
}

/** Codex, Claude and Pi histories in their own formats, under `homes`. */
async function histories(homes: string, project: string, elsewhere: string) {
  const codex = join(homes, 'codex')
  const user = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
  const reply = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })
  const meta = (id: string, source: string | null, cwd = project) => ({ type: 'session_meta', payload: { id, cwd, thread_source: source } })
  await transcript(join(codex, 'sessions/2026/09/30/rollout-a.jsonl'),
    lines(meta('cx-111111', 'user'), user('# AGENTS.md instructions for the project'), user('<environment_context>'), user('Fix the flaky cache test'), reply('Fixed in PR 12.')), 30)
  await transcript(join(codex, 'sessions/2026/09/30/rollout-b.jsonl'), lines(meta('cx-222222', 'subagent'), user('Review this'), reply('ok')), 20)
  await transcript(join(codex, 'sessions/2026/09/30/rollout-c.jsonl'), lines(meta('cx-333333', 'user')), 10)
  await transcript(join(codex, 'sessions/2026/09/30/rollout-d.jsonl'), lines(meta('cx-111999', 'user', join(homes, 'gone')), user('Old work'), reply('done')), 50)
  await writeFile(join(codex, 'session_index.jsonl'), lines({ id: 'cx-111111', thread_name: 'Fix flaky cache', updated_at: '2026-09-30T00:00:00Z' }))

  const claude = join(homes, 'claude/projects/-project/cl-1.jsonl')
  await transcript(claude, lines(
    { type: 'user', isMeta: true, cwd: project, message: { role: 'user', content: 'Caveat: meta' } },
    { type: 'user', cwd: project, message: { role: 'user', content: '<command-name>/model</command-name>' } },
    { type: 'user', cwd: project, message: { role: 'user', content: 'Review the release notes' } },
    { type: 'assistant', cwd: project, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Looks good.' }] } },
    { type: 'assistant', isSidechain: true, cwd: project, message: { role: 'assistant', content: [{ type: 'text', text: 'from a subagent' }] } },
    { type: 'ai-title', aiTitle: 'Release notes review' },
    { type: 'custom-title', customTitle: 'notes-review' }
  ), 5)

  const pi = (name: string, id: string, cwd: string, prompt: string, answer: string, filler = 0) => lines(
    { type: 'session', version: 3, id, cwd },
    { type: 'session_info', name },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: prompt }] } },
    ...Array.from({ length: filler }, (_, index) => ({ type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: `output ${index} ${'x'.repeat(1000)}` }] } })),
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } })
  await transcript(join(homes, 'pi/agent/sessions/--project--/1_pi-1.jsonl'), pi('cache-worker', 'pi-1', project, 'Benchmark the cache', 'Done: 2x faster', 1200), 1)
  await transcript(join(homes, 'pi/agent/sessions/--elsewhere--/2_pi-2.jsonl'), pi('', 'pi-2', elsewhere, 'Plan the offsite', 'Booked.'), 2)
  return { claude }
}

test('the conversation library searches the agents\' own histories', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const homes = join(profile, 'homes')
  const project = join(profile, 'project')
  const elsewhere = join(profile, 'elsewhere')
  await mkdir(project)
  await mkdir(elsewhere)
  const { claude } = await histories(homes, project, elsewhere)
  const frontend = await Frontend.start(profile, [], {
    CODEX_HOME: join(homes, 'codex'), CLAUDE_CONFIG_DIR: join(homes, 'claude'), PI_CODING_AGENT_DIR: join(homes, 'pi/agent')
  })
  t.after(() => frontend.kill('SIGKILL'))
  await frontend.rpc('repo.add', { path: project })
  const search = async (params: Record<string, unknown> = {}) => (await frontend.rpc('history.conversations', params)).conversations

  // Registered projects only, newest first; threads nobody started or prompted are left out.
  const found = await search()
  assert.deepEqual(found.map((conversation: { id: string }) => conversation.id), ['pi-1', 'cl-1', 'cx-111111'])
  const [pi, claudeConversation, codex] = found
  assert.deepEqual([codex.title, codex.firstPrompt, codex.lastMessage], ['Fix flaky cache', 'Fix the flaky cache test', 'Fixed in PR 12.'])
  assert.deepEqual([claudeConversation.title, claudeConversation.firstPrompt, claudeConversation.lastMessage], ['notes-review', 'Review the release notes', 'Looks good.'])
  // A long transcript is read only at its start and end.
  assert.deepEqual([pi.agent, pi.title, pi.firstPrompt, pi.lastMessage], ['pi', 'cache-worker', 'Benchmark the cache', 'Done: 2x faster'])
  assert.equal(typeof pi.project, 'string')
  assert.equal(pi.openIn, undefined)

  // Every word must match, in any of title, prompt, reply or folder.
  assert.deepEqual((await search({ query: 'cache' })).map((conversation: { id: string }) => conversation.id), ['pi-1', 'cx-111111'])
  assert.deepEqual((await search({ query: 'FLAKY cache' })).map((conversation: { id: string }) => conversation.id), ['cx-111111'])
  const everywhere = (await search({ allProjects: true })).map((conversation: { id: string }) => conversation.id)
  assert.deepEqual(everywhere, ['pi-1', 'pi-2', 'cl-1', 'cx-111111', 'cx-111999'])

  // The cache follows changes to a transcript.
  assert.ok(existsSync(join(profile, 'conversations.json')))
  await appendFile(claude, lines({ type: 'assistant', cwd: project, message: { role: 'assistant', content: [{ type: 'text', text: 'Shipped.' }] } }))
  assert.equal((await search({ query: 'release' }))[0].lastMessage, 'Shipped.')

  await assert.rejects(frontend.rpc('history.reopen', { conversation: 'no-such-conversation' }), /no conversation no-such-conversation/)
  await assert.rejects(frontend.rpc('history.reopen', { conversation: 'cx-111' }), /matches 2 conversations/)
  await assert.rejects(frontend.rpc('history.reopen', { conversation: 'cx-111999' }), /no longer exists/)
  await assert.rejects(frontend.rpc('history.reopen', { name: 'nobody' }), /no recently closed agent session or conversation nobody/)
})

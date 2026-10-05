import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { destroyProfile, Frontend, makeProfile, sleep, until } from './harness.ts'

// Real agents answering one-word prompts: each turn is a small model request on the developer's account.
const AGENTS = process.env.SLIM_AGENT_TESTS === '1'
// Claude asks to trust every new folder; its agent runs only in a folder the developer already trusts.
const CLAUDE_DIR = process.env.SLIM_CLAUDE_TRUSTED_DIR

const names = async (frontend: Frontend) => ((await frontend.rpc('terminal.list')).terminals as { title: string }[]).map((terminal) => terminal.title).sort()

/** Kills a session's program and holder the way a shutdown does, leaving its directory behind. */
async function killSession(profile: string, name: string): Promise<void> {
  const holder = JSON.parse(await readFile(join(profile, 'sessions', name, 'holder.json'), 'utf8'))
  for (const target of [-holder.childPid, holder.pid]) {
    try { process.kill(target, 'SIGKILL') } catch {}
  }
}

/** Stands in for a restart of the computer: the frontend's record now names another boot. */
async function simulateRestart(profile: string): Promise<void> {
  const record = JSON.parse(await readFile(join(profile, 'boot.json'), 'utf8'))
  await writeFile(join(profile, 'boot.json'), JSON.stringify({ ...record, boot: 'an earlier boot' }))
}

test('after a restart, shells that were running start again in their directories and nothing else does', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const project = join(profile, 'project')
  await mkdir(project)
  let frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const { repo } = await frontend.rpc('repo.add', { path: project })
  for (const name of ['exited', 'orphaned', 'closed']) await frontend.rpc('terminal.create', { name, cwd: project })
  await frontend.rpc('terminal.create', { name: 'server', cwd: project, command: 'sleep 600' })
  await frontend.rpc('terminal.create', { name: 'raw', cwd: project, argv: ['/bin/sleep', '600'] })

  // Closed ten minutes before the restart.
  await frontend.rpc('terminal.close', { terminal: 'closed' })
  const closed = (await readdir(join(profile, 'ended'))).find((entry) => entry.startsWith('closed.'))!
  await writeFile(join(profile, 'ended', closed, 'retired.json'), JSON.stringify({ reason: 'exited', retiredAt: new Date(Date.now() - 600_000).toISOString() }))

  // The computer goes down: one shell ends while the frontend still runs, the frontend stops, then the rest end.
  await killSession(profile, 'exited')
  await until(async () => !(await names(frontend)).includes('exited'), 10_000, 'the ended shell to be retired')
  await frontend.kill('SIGTERM')
  for (const name of ['orphaned', 'server', 'raw']) await killSession(profile, name)
  await simulateRestart(profile)

  frontend = await Frontend.start(profile)
  await until(async () => (await names(frontend)).length === 2, 20_000, 'the shells to be restored')
  await sleep(500)
  assert.deepEqual(await names(frontend), ['exited', 'orphaned'])
  for (const name of ['exited', 'orphaned']) {
    const meta = JSON.parse(await readFile(join(profile, 'sessions', name, 'meta.json'), 'utf8'))
    assert.equal(meta.cwd, project)
    assert.deepEqual(meta.argv.slice(1), ['-l'])
    assert.equal(meta.project, repo.id)
  }
  await frontend.rpc('terminal.send', { terminal: 'orphaned', text: `printf '%s\\n' "__PWD__$PWD"`, enter: true })
  await until(async () => {
    const { read } = await frontend.rpc('terminal.read', { terminal: 'orphaned' })
    return (read.lines as string[]).some((line) => line.startsWith('__PWD__') && line.trimEnd().endsWith('/project'))
  }, 20_000, 'the restored shell to run in its directory')
  await until(async () => JSON.parse(await readFile(join(profile, 'boot.json'), 'utf8')).boot !== 'an earlier boot', 5000, 'this boot to be recorded')

  // Restarting the frontend in the same boot restores nothing.
  await frontend.kill('SIGTERM')
  await killSession(profile, 'orphaned')
  frontend = await Frontend.start(profile)
  await sleep(1500)
  assert.deepEqual(await names(frontend), ['exited'])
})

test('after a restart, agents continue their conversations and keep their wakes', { skip: !AGENTS && 'set SLIM_AGENT_TESTS=1' }, async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const project = join(profile, 'project')
  await mkdir(project)
  execFileSync('git', ['init', '-q', project])
  let frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const trust = ['-c', `projects={"${realpathSync(project)}"={trust_level="trusted"}}`]
  const agents = [
    { spawn: { name: 'coder', agent: 'codex', cwd: project, effort: 'low', args: trust }, word: 'ALPHA' },
    { spawn: { name: 'helper', agent: 'pi', cwd: project, effort: 'low' }, word: 'BRAVO' },
    ...(CLAUDE_DIR ? [{ spawn: { name: 'reviewer', agent: 'claude', cwd: CLAUDE_DIR, model: 'haiku' }, word: 'CHARLIE' }] : [])
  ]
  const answered = async (name: string) => (await frontend.rpc('agent.wait', { name, timeoutMs: 180_000 })).lastAssistantMessage?.trim()
  for (const { spawn, word } of agents) assert.equal((await frontend.rpc('agent.spawn', { ...spawn, prompt: `Reply with only the word ${word}.` })).delivered, true)
  for (const { spawn, word } of agents) assert.equal(await answered(spawn.name), word)
  await frontend.rpc('wake.create', { name: 'coder', kind: 'timer', delayMs: 3_600_000, message: 'check later' })

  await frontend.kill('SIGTERM')
  for (const { spawn } of agents) await killSession(profile, spawn.name)
  await simulateRestart(profile)

  frontend = await Frontend.start(profile)
  await until(async () => (await frontend.rpc('agent.list')).agents.length === agents.length, 60_000, 'the agents to be restored')
  const coder = JSON.parse(await readFile(join(profile, 'sessions/coder/meta.json'), 'utf8'))
  assert.equal(coder.argv[1], 'resume')
  assert.ok(coder.argv.includes('model_reasoning_effort="low"'), 'the effort is kept')
  assert.deepEqual((await frontend.rpc('wake.list', { name: 'coder' })).wakes.map((wake: { message: string }) => wake.message), ['check later'])
  for (const { spawn } of agents) {
    await frontend.rpc('agent.send', { to: spawn.name, text: 'Which single word did you reply with earlier in this conversation? Reply with only that word.' })
  }
  for (const { spawn, word } of agents) assert.equal(await answered(spawn.name), word, spawn.name)
  for (const { spawn } of agents) await frontend.rpc('terminal.close', { terminal: spawn.name })
})

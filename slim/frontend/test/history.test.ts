import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { destroyProfile, FRONTEND, Frontend, HOLDER, isolatedEnvironment, makeProfile, until } from './harness.ts'

// Real agents answering one-word prompts: each turn is a small model request on the developer's account.
const AGENTS = process.env.SLIM_AGENT_TESTS === '1'
const DAY = 86_400_000
const ORC = process.env.ORC_CLI ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../.build/debug/orc')

/** Runs the `orc` CLI against the profile's runtime, as a session named `caller` would. */
async function cli(profile: string) {
  const launcher = join(profile, 'launch-frontend')
  await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${FRONTEND}" --holder "${HOLDER}" --port 0 "$@"\n`)
  await chmod(launcher, 0o755)
  const env = { ...isolatedEnvironment(), ORC_CONFIG_DIR: join(profile, 'orc-config'), ORC_RUNTIME_DIR: profile, ORC_RUNTIME_EXECUTABLE: launcher }
  return (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    execFile(ORC, args, { env }, (error, stdout, stderr) => resolveRun({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }))
  })
}

type Ended = {
  name: string
  agent?: 'codex' | 'claude' | 'pi'
  argv?: string[]
  endedAgo: number
  events?: Record<string, unknown>[]
  screen?: string
  reopened?: boolean
}

/** Writes a finished session the way the store retires one. */
async function ended(profile: string, session: Ended): Promise<{ entry: string; events?: string }> {
  const entry = `${session.name}.${new Date(Date.now() - session.endedAgo).toISOString().replace(/[:.]/g, '-')}`
  const dir = join(profile, 'ended', entry)
  await mkdir(dir, { recursive: true })
  await mkdir(join(profile, 'agent-events'), { recursive: true })
  const events = session.agent ? join(profile, 'agent-events', `${entry}.jsonl`) : undefined
  const argv = session.argv ?? (session.agent ? [`/bin/${session.agent}`] : ['/bin/zsh', '-l'])
  await writeFile(join(dir, 'meta.json'), JSON.stringify({
    id: entry, name: session.name, incarnationId: entry, createdAt: new Date(Date.now() - session.endedAgo - 60_000).toISOString(),
    cwd: profile, argv, ...(session.agent ? { agent: session.agent, events } : {})
  }))
  await writeFile(join(dir, 'retired.json'), JSON.stringify({ reason: 'exited', retiredAt: new Date(Date.now() - session.endedAgo).toISOString() }))
  if (events) await writeFile(events, (session.events ?? []).map((event) => JSON.stringify(event)).join('\n') + '\n')
  if (session.screen) await writeFile(join(dir, 'checkpoint.json'), JSON.stringify({ cols: 40, rows: 5, serialized: session.screen }))
  if (session.reopened) await writeFile(join(dir, 'reopened.json'), '{}')
  return { entry, events }
}

const reply = (id: string, text: string) => ({ event: 'Stop', payload: { session_id: id, transcript_path: `/t/${id}.jsonl`, last_assistant_message: text } })

test('recently closed lists resumable agent sessions from the last week, newest first, once per name', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  await ended(profile, { name: 'helper', agent: 'pi', endedAgo: 7200_000, events: [reply('p-1', 'first answer')] })
  await ended(profile, { name: 'helper', agent: 'pi', endedAgo: 3600_000, events: [reply('p-2', 'latest answer')], screen: 'done\r\n\r\n  ready' })
  await ended(profile, { name: 'coder', agent: 'codex', endedAgo: 600_000, argv: ['/bin/codex', 'resume', 'c-9', '--no-daemon'] })
  await ended(profile, { name: 'shell', endedAgo: 60_000 })
  await ended(profile, { name: 'fresh', agent: 'claude', endedAgo: 60_000, events: [{ event: 'SessionStart', payload: null }] })
  await ended(profile, { name: 'stale', agent: 'pi', endedAgo: 8 * DAY, events: [reply('s-1', 'old')] })
  await ended(profile, { name: 'again', agent: 'pi', endedAgo: 60_000, events: [reply('a-1', 'x')], reopened: true })
  await ended(profile, { name: 'busy', agent: 'pi', endedAgo: 60_000, events: [reply('b-1', 'x')] })
  const expired = await ended(profile, { name: 'expired', agent: 'pi', endedAgo: 31 * DAY, events: [reply('e-1', 'x')] })

  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  await frontend.rpc('terminal.create', { name: 'busy', cwd: profile, argv: ['/bin/sleep', '600'] })

  const { sessions } = await frontend.rpc('history.list')
  assert.deepEqual(sessions.map((session: { name: string }) => session.name), ['coder', 'helper'])
  const [coder, helper] = sessions
  // A resume that failed before the agent reported anything still names its conversation.
  assert.deepEqual(coder.conversation, { id: 'c-9' })
  assert.deepEqual(helper.conversation, { id: 'p-2', transcriptPath: '/t/p-2.jsonl' })
  assert.equal(helper.lastMessage, 'latest answer')
  assert.deepEqual(helper.screen, ['done', '  ready'])
  assert.equal(helper.agent, 'pi')

  // Ended sessions are deleted 30 days after they end, with their agent events.
  await until(async () => !existsSync(join(profile, 'ended', expired.entry)), 5000, 'the expired session to be deleted')
  assert.equal(existsSync(expired.events!), false)

  await assert.rejects(frontend.rpc('history.reopen', { name: 'shell' }), /no recently closed agent session/)
  await assert.rejects(frontend.rpc('history.reopen', { entry: helper.entry, as: 'busy' }), /a session named busy is running/)

  if (existsSync(ORC)) {
    const orc = await cli(profile)
    const listed = await orc(['history'])
    assert.equal(listed.code, 0, listed.stderr)
    assert.match(listed.stdout, /^SESSION\tAGENT\tCLOSED\tPROJECT\ncoder\tcodex\t10m ago\t.+\nhelper\tpi\t1h ago\t/)
    const json = await orc(['history', '--json'])
    assert.deepEqual(JSON.parse(json.stdout).map((session: { name: string }) => session.name), ['coder', 'helper'])
    const refused = await orc(['reopen', 'shell'])
    assert.notEqual(refused.code, 0)
    assert.match(refused.stderr, /no recently closed agent session shell/)
  } else {
    t.diagnostic(`skipped the CLI checks: build the orc CLI (${ORC})`)
  }
})

test('a closed agent reopens with its conversation, under its name or another', { skip: !AGENTS && 'set SLIM_AGENT_TESTS=1' }, async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const project = join(profile, 'project')
  await mkdir(project)
  const frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const answered = async (name: string) => (await frontend.rpc('agent.wait', { name, timeoutMs: 180_000 })).lastAssistantMessage?.trim()
  await frontend.rpc('agent.spawn', { agent: 'pi', name: 'helper', cwd: project, effort: 'low', prompt: 'Reply with only the word BRAVO.' })
  assert.equal(await answered('helper'), 'BRAVO')
  await frontend.rpc('agent.stop', { name: 'helper', kill: true })

  const [closed] = (await frontend.rpc('history.list')).sessions
  assert.equal(closed.name, 'helper')
  assert.equal(closed.lastMessage.trim(), 'BRAVO')
  const orc = await cli(profile)
  const reopened = await orc(['reopen', 'helper', '--name', 'helper-2', '--json'])
  assert.equal(reopened.code, 0, reopened.stderr)
  assert.equal(JSON.parse(reopened.stdout).name, 'helper-2')
  assert.deepEqual((await frontend.rpc('history.list')).sessions, [])
  await frontend.rpc('agent.send', { to: 'helper-2', text: 'Which single word did you reply with earlier in this conversation? Reply with only that word.' })
  assert.equal(await answered('helper-2'), 'BRAVO')
  await frontend.rpc('agent.stop', { name: 'helper-2', kill: true })
})

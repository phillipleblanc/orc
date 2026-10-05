import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { destroyProfile, FRONTEND, Frontend, HOLDER, isolatedEnvironment, makeProfile, until } from './harness.ts'
import { connectWithGrant, type RuntimeClient } from './runtime-client.ts'

// Real agents answering one-word prompts: each turn is a small model request on the developer's account.
const ENABLED = process.env.SLIM_AGENT_TESTS === '1'
const here = dirname(fileURLToPath(import.meta.url))
const ORC = process.env.ORC_CLI ?? resolve(here, '../../../.build/debug/orc')
// Claude asks to trust every new folder; its test runs only in a folder the developer already trusts.
const CLAUDE_DIR = process.env.SLIM_CLAUDE_TRUSTED_DIR
const run = promisify(execFile)

/** The phone's view of an agent: its session tab and the text of the last assistant message in its chat. */
async function phoneView(phone: RuntimeClient, name: string) {
  const { worktrees } = await phone.request('worktree.ps', { limit: 10000 })
  const { repos } = await phone.request('repo.list')
  for (const row of worktrees) {
    const { tabs } = await phone.request('session.tabs.list', { worktree: `id:${row.worktreeId}` })
    const tab = tabs.find((candidate: any) => candidate.title === name)
    if (!tab) continue
    const { agentType, providerSession } = tab.agentStatus
    const chat = await phone.request('nativeChat.readSession', { agent: agentType, sessionId: providerSession.id, transcriptPath: providerSession.transcriptPath, limit: 40 })
    const replies = chat.messages.filter((message: any) => message.role === 'assistant' && message.blocks[0]?.type === 'text')
    return { tab, repo: repos.find((repo: any) => repo.id === row.repoId), lastReply: replies.at(-1)?.blocks[0].text as string | undefined }
  }
  throw new Error(`no tab for ${name}`)
}

test('agents spawn, take messages by name, report status, and survive a frontend restart', { skip: (!ENABLED && 'set SLIM_AGENT_TESTS=1') || (!existsSync(ORC) && `build the orc CLI (${ORC})`) }, async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  const project = join(profile, 'project')
  await mkdir(project)
  execFileSync('git', ['init', '-q', project])
  const launcher = join(profile, 'launch-frontend')
  await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${FRONTEND}" --holder "${HOLDER}" --port 0 "$@"\n`)
  await chmod(launcher, 0o755)
  let frontend = await Frontend.start(profile)
  t.after(() => frontend.kill('SIGKILL'))
  const env = { ...isolatedEnvironment(), ORC_CONFIG_DIR: join(profile, 'orc-config'), ORC_RUNTIME_DIR: profile, ORC_RUNTIME_EXECUTABLE: launcher }
  const orc = async (args: string[], options: { caller?: string; input?: string; cwd?: string } = {}) => {
    const child = spawn(ORC, args, { env: { ...env, ...(options.caller ? { ORC_SESSION_NAME: options.caller } : {}) }, cwd: options.cwd ?? project })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdin.end(options.input ?? '')
    const code = await new Promise((resolveExit) => child.on('exit', resolveExit))
    return { code, stdout, stderr, json: () => JSON.parse(stdout) }
  }
  const trustProject = ['-c', `projects={"${realpathSync(project)}"={trust_level="trusted"}}`]
  const events = async (name: string) => {
    const agents = (await frontend.rpc('agent.list')).agents as { name: string }[]
    assert.ok(agents.some((agent) => agent.name === name))
    const meta = JSON.parse(await readFile(join(profile, 'sessions', name, 'meta.json'), 'utf8'))
    return (await readFile(meta.events, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  }
  const count = async (name: string, event: string) => (await events(name)).filter((entry) => entry.event === event).length
  // A message sent while the agent runs a command reaches the same turn once the command finishes.
  const steer = async (name: string) => {
    const [tools, stops] = [await count(name, 'PreToolUse'), await count(name, 'Stop')]
    await orc(['agent', 'send', name], { input: 'Run the shell command `sleep 10` and wait for it to finish, then reply with only the word WAITED.' })
    await until(async () => (await count(name, 'PreToolUse')) > tools, 60_000, `${name} to run the command`)
    const sent = await orc(['agent', 'send', name], { caller: 'lead', input: 'Change of plan: reply with only the word STEERED.' })
    assert.match(sent.stdout, /Message sent\.$/m)
    const done = await orc(['agent', 'wait', name, '--json'])
    assert.equal(done.json().lastAssistantMessage.trim(), 'STEERED')
    assert.equal(await count(name, 'Stop'), stops + 1)
  }

  // Spawn delivers the prompt verbatim once Codex is ready.
  const coder = await frontend.rpc('agent.spawn', { agent: 'codex', name: 'coder', cwd: project, prompt: 'Reply with only the word ALPHA.', effort: 'low', args: trustProject })
  assert.equal(coder.delivered, true)
  const first = await orc(['agent', 'wait', 'coder', '--json'])
  assert.equal(first.code, 0, first.stderr)
  assert.equal(first.json().lastAssistantMessage, 'ALPHA')
  assert.equal((await frontend.rpc('terminal.agentStatus', { terminal: 'coder' })).agentStatus.status, 'idle')

  // Another agent messages it by name; the message starts with a line naming the sender.
  const sent = await orc(['agent', 'send', 'coder', '--json'], { caller: 'lead', input: 'Reply with only the word BRAVO.\n' })
  assert.equal(sent.code, 0, sent.stderr)
  const second = await orc(['agent', 'wait', 'coder', '--json'])
  assert.equal(second.json().lastAssistantMessage, 'BRAVO')
  const prompts = (await events('coder')).filter((event) => event.event === 'UserPromptSubmit').map((event) => event.payload.prompt)
  assert.deepEqual(prompts, ['Reply with only the word ALPHA.', '[from lead]\nReply with only the word BRAVO.'])

  // Messages sent with --when-idle are delivered one turn at a time.
  await orc(['agent', 'send', 'coder', '--when-idle'], { caller: 'lead', input: 'Reply with only the word ONE.' })
  const queued = await orc(['agent', 'send', 'coder', '--when-idle'], { caller: 'lead', input: 'Reply with only the word TWO.' })
  assert.match(queued.stdout, /Message queued\.$/m)
  const third = await orc(['agent', 'wait', 'coder', '--json'])
  assert.equal(third.json().lastAssistantMessage, 'TWO')
  assert.equal(await count('coder', 'Stop'), 4)
  await steer('coder')

  // Codex acts without asking, even when its own configuration asks for approval.
  await frontend.rpc('agent.spawn', { agent: 'codex', name: 'asker', cwd: project, effort: 'low', args: [...trustProject, '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="on-request"'] })
  await orc(['agent', 'send', 'asker'], { input: 'Run the shell command `touch approval-probe` in the current directory. Do not do anything else.' })
  assert.equal((await orc(['agent', 'wait', 'asker'])).code, 0)
  assert.equal(existsSync(join(project, 'approval-probe')), true)
  assert.equal((await events('asker')).some((event) => event.event === 'PermissionRequest'), false)

  // Stop interrupts the current turn.
  await orc(['agent', 'send', 'asker'], { input: 'Run the shell command `sleep 60`, then reply with only the word LATE.' })
  await until(async () => (await frontend.rpc('agent.status', { name: 'asker' })).state === 'working', 60_000, 'asker to start working')
  const stopped = await orc(['agent', 'stop', 'asker', '--json'])
  assert.equal(stopped.json().interrupted, true)
  const interrupted = await until(async () => {
    const status = await frontend.rpc('agent.status', { name: 'asker' })
    return status.state === 'idle' && status
  }, 20_000, 'asker to stop working')
  assert.notEqual(interrupted.lastAssistantMessage, 'LATE')

  // Status comes back from the event files after a frontend restart.
  await frontend.kill('SIGKILL')
  frontend = await Frontend.start(profile)
  const listed = await orc(['agent', 'list', '--json'])
  const byName = Object.fromEntries((listed.json().agents as { name: string }[]).map((agent) => [agent.name, agent]))
  assert.equal((byName.coder as any).state, 'idle')
  assert.equal((byName.coder as any).lastAssistantMessage, 'STEERED')
  assert.ok((byName.coder as any).providerSession.transcriptPath.endsWith('.jsonl'))

  // A phone sees the agent's tab with what its chat view needs, and reads the conversation.
  const phone = await connectWithGrant(frontend.rpc.bind(frontend), 'mobile')
  t.after(() => phone.close())
  const coderView = await phoneView(phone, 'coder')
  assert.deepEqual([coderView.tab.launchAgent, coderView.tab.agentStatus.agentType, coderView.tab.agentStatus.state], ['codex', 'codex', 'done'])
  assert.equal(coderView.lastReply, 'STEERED')

  // Pi reports through its extension; the prompt comes from standard input.
  const helper = await orc(['agent', 'spawn', 'pi', 'helper', '--effort', 'low', '--json'], { caller: 'lead', input: 'Reply with only the word DELTA.' })
  assert.equal(helper.code, 0, helper.stderr + helper.stdout)
  assert.equal(helper.json().parent, 'lead')
  const helped = await orc(['agent', 'wait', 'helper', '--json'])
  assert.equal(helped.json().lastAssistantMessage.trim(), 'DELTA')
  // The Orca app renders Pi conversations as omp, which it offers only for a listed local repository.
  const helperView = await phoneView(phone, 'helper')
  assert.deepEqual([helperView.tab.launchAgent, helperView.tab.agentStatus.agentType], ['omp', 'omp'])
  assert.equal(helperView.repo?.connectionId, null)
  assert.equal(helperView.lastReply?.trim(), 'DELTA')
  await steer('helper')

  if (CLAUDE_DIR) {
    const reviewer = await orc(['agent', 'spawn', 'claude', 'reviewer', '--model', 'haiku', '--json'], { input: 'Reply with only the word ECHO.', cwd: CLAUDE_DIR })
    assert.equal(reviewer.code, 0, reviewer.stderr + reviewer.stdout)
    await orc(['agent', 'wait', 'reviewer'])
    const screen = await frontend.rpc('terminal.read', { terminal: 'reviewer' })
    assert.ok(screen.read.lines.some((line: string) => line.includes('ECHO')))
    assert.equal((await frontend.rpc('agent.status', { name: 'reviewer' })).state, 'idle')
    assert.equal((await phoneView(phone, 'reviewer')).lastReply, 'ECHO')
    // Text sent while Claude writes its last reply runs as another turn that no hook announces; wait covers it.
    await orc(['agent', 'send', 'reviewer'], { input: 'Without using any tools, write a 300-word story about a lighthouse, then end with a line containing only the word ALPHA.' })
    await until(async () => (await frontend.rpc('agent.status', { name: 'reviewer' })).state === 'working', 30_000, 'reviewer to start the story')
    const late = await orc(['agent', 'send', 'reviewer'], { caller: 'lead', input: 'After the story, also add a final line containing only the word BRAVO.' })
    assert.match(late.stdout, /Message sent\.$/m)
    const told = await orc(['agent', 'wait', 'reviewer', '--json'])
    assert.match(told.json().lastAssistantMessage, /BRAVO\W*$/)
    // Claude reports no hook for an interrupted turn; its idle title ends the turn instead.
    await orc(['agent', 'send', 'reviewer'], { input: 'Write a 600-word story about a lighthouse. Do not use any tools.' })
    await until(async () => (await frontend.rpc('agent.status', { name: 'reviewer' })).state === 'working', 30_000, 'reviewer to start working')
    await orc(['agent', 'stop', 'reviewer'])
    await until(async () => (await frontend.rpc('agent.status', { name: 'reviewer' })).state === 'idle', 15_000, 'reviewer to be idle after the interrupt')
  }

  // An agent's own wake arrives as a message from wake; a script wake adds the exit status.
  const timer = await orc(['wake', '1s', 'Reply with only the word WAKE.'], { caller: 'coder' })
  assert.equal(timer.code, 0, timer.stderr)
  assert.match(timer.stdout, /^Wake [0-9a-f]{8} {2}in 1s /)
  const woken = await until(async () => {
    const status = await frontend.rpc('agent.status', { name: 'coder' })
    return status.lastAssistantMessage?.trim() === 'WAKE' && status.state === 'idle' && status
  }, 90_000, 'coder to answer its wake')
  assert.equal(woken.queued, 0)
  await writeFile(join(project, 'probe.sh'), 'echo probe-output\nexit 4\n')
  const scripted = await orc(['wake', 'probe.sh', 'Reply with only the exit status number.', '--json'], { caller: 'coder' })
  assert.equal(scripted.json().kind, 'script')
  assert.equal((await orc(['wake', 'list', '--json'], { caller: 'coder' })).code, 0)
  await until(async () => (await frontend.rpc('agent.status', { name: 'coder' })).lastAssistantMessage?.trim() === '4', 90_000, 'coder to answer its script wake')
  const wakePrompts = (await events('coder')).filter((event) => event.event === 'UserPromptSubmit').map((event) => event.payload.prompt).slice(-2)
  assert.deepEqual(wakePrompts, ['[from wake]\nReply with only the word WAKE.', `[from wake]\nReply with only the exit status number.\n\n${project}/probe.sh exited 4\noutput:\nprobe-output`])
  const pending = await orc(['wake', '1h', '--json'], { caller: 'coder' })
  assert.equal((await orc(['wake', 'cancel', pending.json().id.slice(0, 8)], { caller: 'coder' })).code, 0)
  assert.equal((await orc(['wake', 'list'], { caller: 'coder' })).stdout.trim(), 'No wakes.')
  assert.match((await orc(['wake', '5m'], { caller: 'plain-shell' })).stderr, /no session named plain-shell/)

  // `orc new codex` starts the agent with status reporting too.
  await orc(['projects', 'add', project, '--json'])
  const created = await orc(['new', 'codex', '--name', 'plain', '--project', `path:${project}`, '--json'])
  assert.equal(created.code, 0, created.stderr)
  const listedSessions = (await orc(['list', '--json'])).json() as { title: string; agentIdentity: string | null }[]
  assert.equal(listedSessions.find((session) => session.title === 'plain')?.agentIdentity, 'codex')
  await until(async () => (await frontend.rpc('terminal.agentStatus', { terminal: 'plain' })).agentStatus.isRunningAgent, 20_000, 'plain to report an agent')

  for (const name of ['coder', 'asker', 'helper', 'plain', ...(CLAUDE_DIR ? ['reviewer'] : [])]) await orc(['agent', 'stop', name, '--kill'])
  await until(async () => (await frontend.rpc('agent.list')).agents.length === 0, 20_000, 'agents to end')
})

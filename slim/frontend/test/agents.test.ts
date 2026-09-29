import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { join } from 'node:path'
import { diffScreens } from '../src/emulator.ts'
import { destroyProfile, Frontend, GroundTruth, makeProfile, settledScreens, sleep } from './harness.ts'

// Real TUIs with the developer's own installation and configuration. Nothing is ever submitted, so
// no model requests are made: input is limited to arrows and unsent composer text.
const ENABLED = process.env.SLIM_AGENT_TESTS === '1'
const which = (command: string) => {
  try { return execFileSync('/bin/zsh', ['-lc', `command -v ${command}`], { encoding: 'utf8' }).trim() } catch { return '' }
}

const WORKLOADS = [
  { name: 'top', argv: () => ['/usr/bin/top', '-s', '1'], keys: ['o', 'cpu\r'] },
  { name: 'codex', argv: () => [which('codex'), '--no-daemon'], keys: ['\x1b[B', '\x1b[A', 'draft text'] },
  { name: 'claude', argv: () => [which('claude')], keys: ['\x1b[B', '\x1b[A', 'draft text'] },
  { name: 'pi', argv: () => [which('pi')], keys: ['draft text', '\x1b[D', '\x1b[D'] }
]

for (const workload of WORKLOADS) {
  test(`${workload.name}: screen survives frontend kills during startup, resizes and input`, { skip: !ENABLED && 'set SLIM_AGENT_TESTS=1' }, async (t) => {
    const argv = workload.argv()
    assert.ok(argv[0], `${workload.name} is installed`)
    const profile = await makeProfile()
    t.after(() => destroyProfile(profile))
    const project = join(profile, 'project')
    await mkdir(project)
    await writeFile(join(project, 'README.md'), '# fixture\n')
    execFileSync('git', ['init', '-q', project])
    let frontend = await Frontend.start(profile)
    t.after(() => frontend.kill('SIGKILL'))
    const name = `agent-${workload.name}`
    await frontend.rpc('terminal.create', { name, cwd: project, argv, cols: 110, rows: 32 })
    const truth = await GroundTruth.attach(profile, name, 110, 32)
    t.after(() => truth.client.disconnect())

    const events: string[] = []
    const sizes = [[120, 36], [90, 28], [140, 40], [100, 30]]
    for (let step = 0; step < 8; step++) {
      await sleep(step < 3 ? 250 : 700)
      await frontend.kill(step % 3 === 2 ? 'SIGTERM' : 'SIGKILL')
      await sleep(150)
      frontend = await Frontend.start(profile)
      events.push(`restart ${frontend.ready.readyMs}ms`)
      if (step % 2 === 1) {
        const [cols, rows] = sizes[(step >> 1) % sizes.length]
        await frontend.rpc('slim.resize', { terminal: name, cols, rows })
        events.push(`resize ${cols}x${rows}`)
      } else if (step >= 4) {
        const key = workload.keys[(step >> 1) % workload.keys.length]
        await frontend.rpc('terminal.send', { terminal: name, text: key, enter: false })
        events.push(`key ${JSON.stringify(key)}`)
      }
    }
    await sleep(1500)
    // Freeze the program so continuous redraws cannot race the comparison.
    await frontend.rpc('slim.signal', { terminal: name, signal: 'STOP', target: 'child' })
    if (process.env.SLIM_RECORD_DIR) {
      t.after(() => writeFile(join(process.env.SLIM_RECORD_DIR!, `${workload.name}.json`), JSON.stringify({ cols: 110, rows: 32, events: truth.recording })))
    }
    const { expected, actual, screen } = await settledScreens(frontend, truth, name)
    t.diagnostic(events.join(', '))
    t.diagnostic(`head=${screen.info.headOffset} restoredFrom=${screen.restoredFrom} deferred=${screen.checkpointsDeferred} active=${actual.active}`)
    await frontend.rpc('slim.signal', { terminal: name, signal: 'CONT', target: 'child' }).catch(() => {})
    assert.equal(screen.gapBytes, 0)
    assert.ok(screen.info.headOffset > 1000, 'the program drew its interface')
    assert.deepEqual(diffScreens(expected, actual), [])
  })
}

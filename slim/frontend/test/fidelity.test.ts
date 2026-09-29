import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { diffScreens, rowText } from '../src/emulator.ts'
import { destroyProfile, Frontend, GroundTruth, makeProfile, settledScreens, sleep } from './harness.ts'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vt-stress.py')
// Checkpoints land every few hundred milliseconds so kills hit replay and trim boundaries often.
const AGGRESSIVE = ['--checkpoint-quiet-ms', '40', '--checkpoint-max-ms', '150', '--checkpoint-max-bytes', '16384']
const SEEDS = (process.env.SLIM_STRESS_SEEDS ?? '1,2,3,4,5,6').split(',').map(Number)

function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

for (const seed of SEEDS) {
  test(`stress seed ${seed}: screen survives frontend kills, restarts and resizes`, async (t) => {
    const random = prng(seed * 7919)
    const profile = await makeProfile()
    t.after(() => destroyProfile(profile))
    let frontend = await Frontend.start(profile, AGGRESSIVE)
    t.after(() => frontend.kill('SIGKILL'))
    const name = `stress-${seed}`
    await frontend.rpc('terminal.create', { name, cwd: profile, argv: ['/usr/bin/python3', FIXTURE, String(seed), '6'], cols: 100, rows: 30 })
    const truth = await GroundTruth.attach(profile, name, 100, 30)
    t.after(() => truth.client.disconnect())

    const events: string[] = []
    const deadline = Date.now() + 6500
    while (Date.now() < deadline) {
      await sleep(100 + random() * 500)
      if (random() < 0.3) {
        const cols = 40 + Math.floor(random() * 120)
        const rows = 10 + Math.floor(random() * 40)
        await frontend.rpc('slim.resize', { terminal: name, cols, rows })
        events.push(`resize ${cols}x${rows}`)
      } else {
        const signal = random() < 0.8 ? 'SIGKILL' : 'SIGTERM'
        await frontend.kill(signal)
        await sleep(random() * 300)
        frontend = await Frontend.start(profile, AGGRESSIVE)
        events.push(`${signal} ready=${frontend.ready.readyMs}ms`)
      }
    }
    const { expected, actual, screen } = await settledScreens(frontend, truth, name)
    t.diagnostic(`${events.length} events: ${events.join(', ')}`)
    t.diagnostic(`head=${screen.info.headOffset} retained=${screen.info.retainedBytes} replayed=${screen.replayedBytes} restoredFrom=${screen.restoredFrom} deferred=${screen.checkpointsDeferred}`)
    assert.equal(screen.restoredFrom, 'state')
    assert.equal(screen.gapBytes, 0)
    assert.deepEqual(diffScreens(expected, actual), [])
    assert.ok(actual.normal.some((row: string) => rowText(row).startsWith('STRESS-DONE')) ||
      (actual.alternate ?? []).some((row: string) => rowText(row).startsWith('STRESS-DONE')))
  })
}

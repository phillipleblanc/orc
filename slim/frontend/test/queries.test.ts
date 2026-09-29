import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { destroyProfile, Frontend, makeProfile, sleep, until } from './harness.ts'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'query-counter.py')
// Rare checkpoints leave already-answered queries in the replayed output after each restart.
const LAZY = ['--checkpoint-quiet-ms', '60000', '--checkpoint-max-ms', '60000', '--checkpoint-max-bytes', '100000000']

test('terminal queries are answered once, never again when output is replayed', async (t) => {
  const profile = await makeProfile()
  t.after(() => destroyProfile(profile))
  let frontend = await Frontend.start(profile, LAZY)
  t.after(() => frontend.kill('SIGKILL'))
  const log = join(profile, 'queries.json')
  await frontend.rpc('terminal.create', { name: 'queries', cwd: profile, argv: ['/usr/bin/python3', FIXTURE, log, '4'] })
  const replayed: number[] = []
  for (const at of [1000, 1200]) {
    await sleep(at)
    await frontend.kill('SIGKILL')
    await sleep(200)
    frontend = await Frontend.start(profile, LAZY)
    const screen = await frontend.rpc('slim.screen', { terminal: 'queries' })
    replayed.push(screen.replayedBytes / 3)
  }
  const final = await until(async () => {
    const counts = JSON.parse(await readFile(log, 'utf8'))
    const screen = await frontend.rpc('slim.screen', { terminal: 'queries' })
    return screen.info.headOffset / 3 === counts.sent && counts.sent > 60 ? counts : null
  }, 15_000, 'fixture to finish')
  await sleep(1600)
  const counts = JSON.parse(await readFile(log, 'utf8'))
  t.diagnostic(`sent=${counts.sent} replies=${counts.replies} replayed queries per restart=${replayed.join(',')}`)
  assert.ok(replayed.every((count) => count > 5), 'each restart replayed queries that an earlier frontend had answered')
  assert.equal(counts.other, 0, 'no bytes other than complete replies reached the program')
  assert.ok(counts.replies <= counts.sent, 'no query was answered twice')
  // Queries sent while no frontend was running go unanswered; everything else is answered.
  assert.ok(counts.replies >= counts.sent - 20, `most queries answered (${counts.replies}/${final.sent})`)
})

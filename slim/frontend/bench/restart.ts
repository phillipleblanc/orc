/**
 * Frontend restart cost with many sessions, checkpoint cost, and memory.
 *
 * usage: node bench/restart.ts [SESSIONS] [RESTARTS]
 */
import { execFileSync } from 'node:child_process'
import { destroyProfile, Frontend, makeProfile, sleep } from '../test/harness.ts'

const sessions = Number(process.argv[2] ?? 20)
const restarts = Number(process.argv[3] ?? 30)
const quantiles = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right)
  const at = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)]
  return { n: sorted.length, p50: +at(0.5).toFixed(2), p99: +at(0.99).toFixed(2), max: +sorted.at(-1)!.toFixed(2) }
}
// Colored, wide-character scrollback; two sessions fill the whole 5000-row scrollback at 220 columns.
const writer = (lines: number, width: number) => `import sys\nfor i in range(${lines}):\n    sys.stdout.write(f"\\x1b[3{i % 7}m{i:06d} " + ("한글 🌊 alpha beta gamma " * ${width}) + "\\x1b[0m\\r\\n")\nsys.stdout.flush()\nimport time\ntime.sleep(3600)\n`

const profile = await makeProfile()
let frontend = await Frontend.start(profile)
try {
  for (let index = 0; index < sessions; index++) {
    const full = index < 2
    await frontend.rpc('terminal.create', {
      name: `bench-${index}`, cwd: profile, cols: full ? 220 : 120, rows: full ? 60 : 40,
      argv: ['/usr/bin/python3', '-c', writer(full ? 6000 : 1500, full ? 9 : 4)]
    })
  }
  // Wait for output to finish and for every session to checkpoint.
  await sleep(8000)
  const stats = (await frontend.rpc('slim.stats')).checkpoints as { captureMs: number; bytes: number }[]
  const report: Record<string, unknown> = {
    checkpointCaptureMs: quantiles(stats.map((sample) => sample.captureMs)),
    checkpointKiB: quantiles(stats.map((sample) => sample.bytes / 1024))
  }
  const wall: number[] = []
  const ready: number[] = []
  for (let attempt = 0; attempt < restarts; attempt++) {
    await frontend.kill(attempt % 5 === 4 ? 'SIGTERM' : 'SIGKILL')
    const started = performance.now()
    frontend = await Frontend.start(profile)
    wall.push(performance.now() - started)
    ready.push(frontend.ready.readyMs)
    if (frontend.ready.attached !== sessions) throw new Error(`only ${frontend.ready.attached} sessions reattached`)
  }
  report.restartToReadyWallMs = quantiles(wall)
  report.restartDiscoverAndReplayMs = quantiles(ready)
  const rows = execFileSync('ps', ['-axo', 'pid=,rss=,command='], { encoding: 'utf8' }).split('\n')
    .map((row) => row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((match): match is RegExpMatchArray => !!match && match[3].includes(profile))
  const holders = rows.filter((match) => match[3].startsWith(`${profile}/holders/`)).map((match) => Number(match[2]) / 1024)
  const frontends = rows.filter((match) => match[3].includes('src/main.ts')).map((match) => Number(match[2]) / 1024)
  report.holderRssMiB = quantiles(holders)
  report.frontendRssMiB = quantiles(frontends)
  console.log(JSON.stringify(report, null, 2))
} finally {
  await frontend.kill('SIGKILL')
  await destroyProfile(profile)
}
process.exit(0)

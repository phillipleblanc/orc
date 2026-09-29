/**
 * Keystroke echo latency through a runtime's full client path: `terminal.send` over the encrypted
 * WebSocket, the PTY's echo, and the multiplexed output stream back to the client.
 *
 * usage: node bench/latency.ts PAIRING_JSON ENDPOINT HANDLE [COUNT]
 * PAIRING_JSON holds {endpoint, deviceToken, publicKeyB64}; ENDPOINT overrides its endpoint.
 */
import { readFileSync } from 'node:fs'
import { Opcode } from '../src/terminal-frames.ts'
import { RuntimeClient } from '../test/runtime-client.ts'

const [pairingFile, endpoint, handle, countArgument] = process.argv.slice(2)
const count = Number(countArgument ?? 500)
const client = await RuntimeClient.connect(JSON.parse(readFileSync(pairingFile, 'utf8')), endpoint)
let snapshotDone: () => void
const snapshot = new Promise<void>((resolve) => { snapshotDone = resolve })
let waiting: { byte: number; resolve: () => void } | null = null
client.onFrame = (frame) => {
  if (frame.opcode === Opcode.SnapshotEnd) snapshotDone()
  if (frame.opcode === Opcode.Output && waiting && frame.payload.includes(waiting.byte)) {
    const done = waiting
    waiting = null
    done.resolve()
  }
}
client.subscribe('terminal.multiplex', {}, (event) => {
  if (event.type === 'ready') {
    client.sendFrame(Opcode.Subscribe, 0, Buffer.from(JSON.stringify({
      streamId: 1, terminal: handle, client: { id: 'bench', type: 'desktop' }, viewport: { cols: 100, rows: 30 },
      capabilities: { desktopViewportClaims: 1, writeUnavailable: 1 }
    })))
  }
})
await snapshot
const samples: number[] = []
const letters = 'abcdefghijklmnopqrstuvwxyz'
for (let index = 0; index < count + 20; index++) {
  const letter = letters[index % letters.length]
  const echoed = new Promise<void>((resolve) => { waiting = { byte: letter.charCodeAt(0), resolve } })
  const started = performance.now()
  await client.request('terminal.send', { terminal: handle, text: letter, enter: false, client: { id: 'bench', type: 'desktop' } })
  await echoed
  // The first keystrokes warm connections and JIT; they are not counted.
  if (index >= 20) samples.push(performance.now() - started)
  if (index % 60 === 59) await client.request('terminal.send', { terminal: handle, text: '\x15', enter: false, client: { id: 'bench', type: 'desktop' } })
  await new Promise((resolve) => setTimeout(resolve, 5))
}
samples.sort((left, right) => left - right)
const at = (quantile: number) => samples[Math.min(samples.length - 1, Math.ceil(quantile * samples.length) - 1)].toFixed(2)
console.log(JSON.stringify({ count: samples.length, p50: at(0.5), p99: at(0.99), p999: at(0.999), max: samples.at(-1)!.toFixed(2) }))
client.close()
process.exit(0)

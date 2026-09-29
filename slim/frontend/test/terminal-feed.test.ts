import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTerminal, diffScreens, screenState, write } from '../src/emulator.ts'
import { TerminalFeed } from '../src/terminal-feed.ts'

function frames(count: number): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let frame = 0; frame < count; frame++) {
    let text = '\x1b[?2026h'
    for (let row = 1; row <= 12; row++) text += `\x1b[${row};${(frame % 9) + 1}H\x1b[3${row % 8}mframe ${frame} row ${row} ${'•'.repeat(frame % 30)}\x1b[K`
    chunks.push(Buffer.from(text + '\x1b[?2026l\r\n'))
  }
  return chunks
}

test('resizes between queued writes keep every write and its callback', async () => {
  const chunks = frames(120)
  const fed = createTerminal(80, 24)
  const feed = new TerminalFeed(fed.term)
  let applied = 0
  const resizes = new Map([[20, [100, 30]], [21, [60, 20]], [70, [132, 40]], [71, [90, 28]]])
  for (const [index, chunk] of chunks.entries()) {
    const size = resizes.get(index)
    if (size) void feed.run(() => fed.term.resize(size[0], size[1]))
    feed.write(chunk, () => { applied++ })
  }
  const fedState = await feed.run(() => screenState(fed.term, 500))
  assert.equal(applied, chunks.length)

  const reference = createTerminal(80, 24)
  for (const [index, chunk] of chunks.entries()) {
    const size = resizes.get(index)
    if (size) reference.term.resize(size[0], size[1])
    await write(reference.term, chunk)
  }
  assert.deepEqual(diffScreens(screenState(reference.term, 500), fedState), [])
})

test('an action queued from a write callback runs after that write, outside the write loop', async () => {
  const { term } = createTerminal(80, 24)
  const feed = new TerminalFeed(term)
  const order: string[] = []
  feed.write(Buffer.from('first'), () => {
    order.push('first applied')
    void feed.run(() => { term.resize(40, 10); order.push('resized') })
  })
  feed.write(Buffer.from('second'), () => order.push('second applied'))
  feed.write(Buffer.from('third'), () => order.push('third applied'))
  await feed.run(() => undefined)
  assert.deepEqual(order, ['first applied', 'second applied', 'third applied', 'resized'])
  assert.equal(term.cols, 40)
})

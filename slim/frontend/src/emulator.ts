import headless from '@xterm/headless'
import serialize from '@xterm/addon-serialize'

export type Terminal = InstanceType<typeof headless.Terminal>
type SerializeAddon = InstanceType<typeof serialize.SerializeAddon>

export const SCROLLBACK_ROWS = 5000

/** Terminal state that SerializeAddon does not encode. */
export type TerminalExtras = {
  kitty?: { flags: number; mainFlags: number; altFlags: number; mainStack: number[]; altStack: number[] }
  mouseEncoding?: string
  cursorStyle?: string
  cursorBlink?: boolean
  colorSchemeUpdates?: boolean
  synchronizedOutput?: boolean
  savedCursor?: { x: number; y: number }
  title?: string
}

export type SerializedScreen = {
  cols: number
  rows: number
  serialized: string
  extras: TerminalExtras
}

export function createTerminal(cols: number, rows: number): { term: Terminal; serializer: SerializeAddon } {
  const term = new headless.Terminal({
    cols,
    rows,
    scrollback: SCROLLBACK_ROWS,
    allowProposedApi: true,
    vtExtensions: { kittyKeyboard: true }
  })
  const serializer = new serialize.SerializeAddon()
  term.loadAddon(serializer)
  return { term, serializer }
}

// Internal xterm state is read and restored directly: the frontend always serializes and replays
// with the same xterm build, and screenState() comparisons in tests catch drift.
function core(term: Terminal): any {
  return (term as any)._core
}

export function captureExtras(term: Terminal): TerminalExtras {
  const c = core(term)
  const modes = c.coreService.decPrivateModes
  const buffer = c._bufferService.buffer
  return {
    kitty: structuredClone(c.coreService.kittyKeyboard),
    mouseEncoding: c.mouseStateService.activeEncoding,
    cursorStyle: modes.cursorStyle,
    cursorBlink: modes.cursorBlink,
    colorSchemeUpdates: modes.colorSchemeUpdates,
    synchronizedOutput: modes.synchronizedOutput,
    savedCursor: { x: buffer.savedX ?? 0, y: buffer.savedY ?? 0 },
    title: c._inputHandler._windowTitle ?? ''
  }
}

const MOUSE_ENCODINGS: Record<string, string> = { SGR: '\x1b[?1006h', SGR_PIXELS: '\x1b[?1016h', URXVT: '\x1b[?1015h', UTF8: '\x1b[?1005h' }
const CURSOR_STYLES: Record<string, [number, number]> = { block: [1, 2], underline: [3, 4], bar: [5, 6] }

/** VT sequences that recreate `extras` after a serialized screen has been written. */
export function extrasSequence(extras: TerminalExtras, term: Terminal): string {
  let sequence = ''
  if (extras.mouseEncoding && MOUSE_ENCODINGS[extras.mouseEncoding]) sequence += MOUSE_ENCODINGS[extras.mouseEncoding]
  if (extras.cursorStyle && CURSOR_STYLES[extras.cursorStyle]) {
    const [blinking, steady] = CURSOR_STYLES[extras.cursorStyle]
    sequence += `\x1b[${extras.cursorBlink ? blinking : steady} q`
  }
  if (extras.colorSchemeUpdates) sequence += '\x1b[?2031h'
  if (extras.title) sequence += `\x1b]2;${extras.title}\x07`
  if (extras.savedCursor) {
    const buffer = term.buffer.active
    sequence += `\x1b[${extras.savedCursor.y + 1};${extras.savedCursor.x + 1}H\x1b7`
    sequence += `\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`
  }
  if (extras.synchronizedOutput) sequence += '\x1b[?2026h'
  return sequence
}

export function restoreInternals(term: Terminal, extras: TerminalExtras): void {
  if (extras.kitty) Object.assign(core(term).coreService.kittyKeyboard, structuredClone(extras.kitty))
}

export function write(term: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

export function serializeScreen(term: Terminal, serializer: SerializeAddon, scrollback = SCROLLBACK_ROWS): SerializedScreen {
  return { cols: term.cols, rows: term.rows, serialized: serializer.serialize({ scrollback }), extras: captureExtras(term) }
}

export async function restoreScreen(term: Terminal, screen: SerializedScreen): Promise<void> {
  await write(term, screen.serialized)
  await write(term, extrasSequence(screen.extras, term))
  restoreInternals(term, screen.extras)
}

/** Structured terminal state for exact comparison between emulators. */
export function screenState(term: Terminal, scrollbackRows = 200) {
  const c = core(term)
  const active = term.buffer.active
  const buffer = c._bufferService.buffer
  const cell = active.getNullCell()
  const lines = (which: 'normal' | 'alternate') => {
    const target = which === 'normal' ? term.buffer.normal : term.buffer.alternate
    const start = Math.max(0, target.length - term.rows - (which === 'normal' ? scrollbackRows : 0))
    const result: string[] = []
    for (let y = start; y < target.length; y++) {
      const line = target.getLine(y)
      if (!line) continue
      let encoded = line.isWrapped ? '+' : '|'
      for (let x = 0; x < term.cols; x++) {
        line.getCell(x, cell)
        encoded += `${cell.getChars() || ' '}\u0001${cell.getWidth()}` +
          `${cell.getFgColorMode()}.${cell.getFgColor()}.${cell.getBgColorMode()}.${cell.getBgColor()}` +
          `${+cell.isBold()}${+cell.isItalic()}${+cell.isDim()}${+cell.isUnderline()}${+cell.isBlink()}` +
          `${+cell.isInverse()}${+cell.isInvisible()}${+cell.isStrikethrough()}${+cell.isOverline()};`
      }
      result.push(encoded)
    }
    return result
  }
  const modes = c.coreService.decPrivateModes
  return {
    cols: term.cols,
    rows: term.rows,
    active: active.type,
    cursor: { x: active.cursorX, y: active.cursorY, hidden: c.coreService.isCursorHidden },
    modes: { ...term.modes },
    cursorStyle: modes.cursorStyle ?? null,
    cursorBlink: modes.cursorBlink ?? null,
    colorSchemeUpdates: modes.colorSchemeUpdates ?? false,
    kitty: structuredClone(c.coreService.kittyKeyboard),
    mouse: { encoding: c.mouseStateService.activeEncoding, protocol: c.mouseStateService.activeProtocol },
    scrollRegion: [buffer.scrollTop, buffer.scrollBottom],
    title: c._inputHandler._windowTitle ?? '',
    normal: lines('normal'),
    alternate: active.type === 'alternate' ? lines('alternate') : null
  }
}

export type ScreenState = ReturnType<typeof screenState>

/** Human-readable differences between two screen states; empty when identical. */
export function diffScreens(expected: ScreenState, actual: ScreenState, limit = 8): string[] {
  const differences: string[] = []
  for (const key of Object.keys(expected) as (keyof ScreenState)[]) {
    if (key === 'normal' || key === 'alternate') continue
    const left = JSON.stringify(expected[key])
    const right = JSON.stringify(actual[key])
    if (left !== right) differences.push(`${key}: expected ${left}, got ${right}`)
  }
  for (const which of ['normal', 'alternate'] as const) {
    const left = expected[which] ?? []
    const right = actual[which] ?? []
    if ((expected[which] === null) !== (actual[which] === null)) differences.push(`${which}: presence differs`)
    const offset = right.length - left.length
    if (offset !== 0) differences.push(`${which}: ${left.length} rows expected, ${right.length} present`)
    // Align from the bottom: scrollback depth can legitimately differ at the top.
    for (let index = 1; index <= Math.min(left.length, right.length) && differences.length < limit; index++) {
      const expectedRow = left[left.length - index]
      const actualRow = right[right.length - index]
      if (expectedRow !== actualRow) differences.push(`${which} row -${index}:\n  expected ${summarize(expectedRow)}\n  got      ${summarize(actualRow)}`)
    }
  }
  return differences.slice(0, limit)
}

/** The text of a row from screenState(), without attributes. */
export function rowText(encoded: string): string {
  return encoded.slice(1).split(';').map((cell) => cell.split('\u0001')[0]).join('').trimEnd()
}

function summarize(row: string): string {
  const text = row.slice(1).split(';').map((cell) => cell.split('\u0001')[0]).join('')
  return `${row[0]}${text.trimEnd().slice(0, 120)}`
}

import { createRequire } from 'node:module'
import { deflateRaw, deflateRawSync, inflateRawSync } from 'node:zlib'
import { promisify } from 'node:util'
import type { Terminal } from './emulator.ts'

const require = createRequire(import.meta.url)
const XTERM_VERSION: string = require('@xterm/headless/package.json').version

/**
 * Exact emulator state for the xterm build named by `format`. It is read from and written to
 * xterm's private structures, so it only loads into the same build; other builds fall back to the
 * checkpoint's serialized screen.
 */
export const STATE_FORMAT = `xterm-headless@${XTERM_VERSION}/2`
const deflateRawAsync = promisify(deflateRaw)

type Attr = [fg: number, bg: number, ext: number, urlId: number]

type BufferState = {
  x: number
  y: number
  ybase: number
  ydisp: number
  scrollTop: number
  scrollBottom: number
  tabs: number[]
  savedX: number
  savedY: number
  savedAttr: Attr
  savedCharset: Record<string, string> | null
  savedCharsets: (Record<string, string> | null)[] | null
  savedGlevel: number | null
  savedOriginMode: boolean | null
  savedWraparoundMode: boolean | null
  hasScrollback: boolean
  /** Cell count of each line, in buffer order. */
  lengths: number[]
  /** Indexes of lines that continue the previous line. */
  wrapped: number[]
  /** Combining-character strings and extended attributes, only for lines that have them. */
  combined: Record<number, Record<string, string>>
  ext: Record<number, Record<string, [number, number]>>
}

export type EmulatorState = {
  format: string
  cols: number
  rows: number
  active: 'normal' | 'alternate'
  normal: BufferState
  alternate: BufferState
  /** deflate-raw of every line's cell data, normal buffer then alternate, base64 encoded. */
  cells: string
  attr: Attr
  glevel: number
  charsets: (Record<string, string> | null)[]
  windowTitle: string
  iconName: string
  windowTitleStack: string[]
  iconNameStack: string[]
  decPrivateModes: Record<string, unknown>
  modes: Record<string, unknown>
  kittyKeyboard: Record<string, unknown>
  cursorHidden: boolean
  cursorInitialized: boolean
  mouseProtocol: string
  mouseEncoding: string
  precedingJoinState: number
}

function core(term: Terminal): any {
  return (term as any)._core
}

/** True when no escape sequence or multi-byte character is partially parsed. */
export function atSequenceBoundary(term: Terminal): boolean {
  const input = core(term)._inputHandler
  return input._parser.currentState === 0 && !input._utf8Decoder.interim.some((byte: number) => byte !== 0) &&
    !input._stringDecoder._interim
}

function readAttr(attr: any): Attr {
  return [attr.fg, attr.bg, attr.extended._ext, attr.extended._urlId]
}

function writeAttr(target: any, [fg, bg, ext, urlId]: Attr): void {
  target.fg = fg
  target.bg = bg
  const Extended = target.extended.constructor
  target.extended = new Extended(ext, urlId)
}

function clone<T>(value: T): T {
  return value === undefined ? (null as T) : structuredClone(value)
}

function dumpBuffer(buffer: any, chunks: Uint32Array[]): BufferState {
  const lengths: number[] = []
  const wrapped: number[] = []
  const combined: BufferState['combined'] = {}
  const ext: BufferState['ext'] = {}
  for (let index = 0; index < buffer.lines.length; index++) {
    const line = buffer.lines.get(index)
    for (const cell in line._combined) {
      combined[index] = { ...line._combined }
      break
    }
    for (const cell in line._extendedAttrs) {
      const attrs: Record<string, [number, number]> = {}
      for (const [key, value] of Object.entries(line._extendedAttrs as Record<string, any>)) attrs[key] = [value._ext, value._urlId]
      ext[index] = attrs
      break
    }
    chunks.push(line._data.subarray(0, line.length * 3))
    lengths.push(line.length)
    if (line.isWrapped) wrapped.push(index)
  }
  return {
    x: buffer.x,
    y: buffer.y,
    ybase: buffer.ybase,
    ydisp: buffer.ydisp,
    scrollTop: buffer.scrollTop,
    scrollBottom: buffer.scrollBottom,
    tabs: Object.keys(buffer.tabs).filter((column) => buffer.tabs[column]).map(Number),
    savedX: buffer.savedX,
    savedY: buffer.savedY,
    savedAttr: readAttr(buffer.savedCurAttrData),
    savedCharset: clone(buffer.savedCharset),
    savedCharsets: clone(buffer.savedCharsets),
    savedGlevel: buffer.savedGlevel ?? null,
    savedOriginMode: buffer.savedOriginMode ?? null,
    savedWraparoundMode: buffer.savedWraparoundMode ?? null,
    hasScrollback: buffer._hasScrollback,
    lengths,
    wrapped,
    combined,
    ext
  }
}

/** A consistent copy of the emulator state whose cell memory is not yet compressed. */
export type CapturedState = { state: Omit<EmulatorState, 'cells'>; cells: Buffer }

/** Copies the emulator state synchronously; null when the parser is mid-sequence. */
export function captureState(term: Terminal): CapturedState | null {
  if (!atSequenceBoundary(term)) return null
  const c = core(term)
  const input = c._inputHandler
  const buffers = c._bufferService.buffers
  const chunks: Uint32Array[] = []
  const normal = dumpBuffer(buffers._normal, chunks)
  const alternate = dumpBuffer(buffers._alt, chunks)
  const cells = Buffer.allocUnsafe(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    cells.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset)
    offset += chunk.byteLength
  }
  const state = {
    format: STATE_FORMAT,
    cols: term.cols,
    rows: term.rows,
    active: (buffers._activeBuffer === buffers._alt ? 'alternate' : 'normal') as EmulatorState['active'],
    normal,
    alternate,
    attr: readAttr(input._curAttrData),
    glevel: input._charsetService.glevel,
    charsets: clone(input._charsetService._charsets),
    windowTitle: input._windowTitle ?? '',
    iconName: input._iconName ?? '',
    windowTitleStack: [...(input._windowTitleStack ?? [])],
    iconNameStack: [...(input._iconNameStack ?? [])],
    decPrivateModes: clone(c.coreService.decPrivateModes),
    modes: clone(c.coreService.modes),
    kittyKeyboard: clone(c.coreService.kittyKeyboard),
    cursorHidden: c.coreService.isCursorHidden,
    cursorInitialized: c.coreService.isCursorInitialized,
    mouseProtocol: c.mouseStateService.activeProtocol,
    mouseEncoding: c.mouseStateService.activeEncoding,
    precedingJoinState: input._parser.precedingJoinState ?? 0
  }
  return { state, cells }
}

/** Compresses captured cells on zlib's thread pool. */
export async function encodeState(captured: CapturedState): Promise<EmulatorState> {
  return { ...captured.state, cells: (await deflateRawAsync(captured.cells)).toString('base64') }
}

export function dumpState(term: Terminal): EmulatorState | null {
  const captured = captureState(term)
  return captured && { ...captured.state, cells: deflateRawSync(captured.cells).toString('base64') }
}

function loadBuffer(buffer: any, state: BufferState, cells: Buffer, offset: number, Line: any, Extended: any): number {
  const list = buffer.lines
  list._array = new Array(list._maxLength)
  list._startIndex = 0
  list._length = 0
  const wrapped = new Set(state.wrapped)
  for (const [index, length] of state.lengths.entries()) {
    const line = new Line(length)
    const bytes = length * 12
    const data = new Uint32Array(length * 3)
    new Uint8Array(data.buffer).set(cells.subarray(offset, offset + bytes))
    offset += bytes
    line._data = data
    line.length = length
    line.isWrapped = wrapped.has(index)
    line._combined = { ...(state.combined[index] ?? {}) }
    line._extendedAttrs = {}
    for (const [cell, [ext, urlId]] of Object.entries(state.ext[index] ?? {})) line._extendedAttrs[cell] = new Extended(ext, urlId)
    list.push(line)
  }
  buffer.x = state.x
  buffer.y = state.y
  buffer.ybase = state.ybase
  buffer.ydisp = state.ydisp
  buffer.scrollTop = state.scrollTop
  buffer.scrollBottom = state.scrollBottom
  buffer.tabs = {}
  for (const column of state.tabs) buffer.tabs[column] = true
  buffer.savedX = state.savedX
  buffer.savedY = state.savedY
  writeAttr(buffer.savedCurAttrData, state.savedAttr)
  buffer.savedCharset = state.savedCharset ?? undefined
  buffer.savedCharsets = state.savedCharsets ?? undefined
  buffer.savedGlevel = state.savedGlevel ?? undefined
  buffer.savedOriginMode = state.savedOriginMode ?? undefined
  buffer.savedWraparoundMode = state.savedWraparoundMode ?? undefined
  buffer._hasScrollback = state.hasScrollback
  return offset
}

/** Loads a dumped state into a terminal created at the same size with the same scrollback. */
export function loadState(term: Terminal, state: EmulatorState): void {
  if (state.format !== STATE_FORMAT) throw new Error(`state format ${state.format} does not match ${STATE_FORMAT}`)
  if (state.cols !== term.cols || state.rows !== term.rows) term.resize(state.cols, state.rows)
  const c = core(term)
  const input = c._inputHandler
  const buffers = c._bufferService.buffers
  // Activation resets the buffer being activated, so it happens before the buffers are loaded.
  if (state.active === 'alternate') buffers.activateAltBuffer()
  else buffers.activateNormalBuffer()
  const cells = inflateRawSync(Buffer.from(state.cells, 'base64'))
  // The normal buffer always has lines; the alternate buffer is empty until first activated.
  const Line = buffers._normal.lines.get(0).constructor
  const Extended = input._curAttrData.extended.constructor
  const offset = loadBuffer(buffers._normal, state.normal, cells, 0, Line, Extended)
  loadBuffer(buffers._alt, state.alternate, cells, offset, Line, Extended)
  writeAttr(input._curAttrData, state.attr)
  input._charsetService.glevel = state.glevel
  input._charsetService._charsets = state.charsets.map((charset) => charset ?? undefined)
  input._windowTitle = state.windowTitle
  input._iconName = state.iconName
  input._windowTitleStack = [...state.windowTitleStack]
  input._iconNameStack = [...state.iconNameStack]
  Object.assign(c.coreService.decPrivateModes, clone(state.decPrivateModes))
  Object.assign(c.coreService.modes, clone(state.modes))
  Object.assign(c.coreService.kittyKeyboard, clone(state.kittyKeyboard))
  c.coreService.isCursorHidden = state.cursorHidden
  c.coreService.isCursorInitialized = state.cursorInitialized
  c.mouseStateService.activeProtocol = state.mouseProtocol
  c.mouseStateService.activeEncoding = state.mouseEncoding
  input._parser.precedingJoinState = state.precedingJoinState
}

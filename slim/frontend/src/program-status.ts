// OSC 7501, the Program Status Protocol (https://www.superlogical.com/rex/docs/build/program-status, revision
// 0.2): a program in a session reports what it is doing as `OSC 7501 ; key=value:… ST`, and asks whether the
// terminal understands it with `OSC 7501 ; ? ST`, which the terminal answers with the same sequence.

export type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error'
export type BlockedKind = 'permission' | 'question' | 'auth'

/** A program's status record; `id` is '' for the root record. */
export type ProgramRecord = {
  id: string
  state: ProgramState
  kind?: BlockedKind
  progress?: number
  app?: string
  title?: string
  msg?: string
}

type Report = { state: ProgramState | 'clear'; record: ProgramRecord }

export const QUERY_REPLY = '\x1b]7501;?\x1b\\'
const STATES = new Set(['idle', 'working', 'done', 'blocked', 'error', 'clear'])
const KINDS = new Set(['permission', 'question', 'auth'])
const KEY = /^[a-z]+$/
const VALUE = /^[A-Za-z0-9_.,+/=-]*$/
const NAME = /^[A-Za-z0-9_.+-]{1,32}$/
// The whole sequence is at most 4096 bytes; `ESC ] 7501 ;` and `ESC \` take 8 of them.
const MAX_DATA = 4096 - 8
const MAX_KEY = 16
const TEXT_LIMITS = { msg: { encoded: 2732, decoded: 2048 }, title: { encoded: 256, decoded: 192 } }
const MAX_ID = 128
const MAX_DEPTH = 8
/** Records kept per terminal; the protocol allows a terminal to keep between 64 and 256. */
export const MAX_RECORDS = 256
// Text that would make a record display one thing and mean another.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const DISARM = /[​-‏‪-‮⁦-⁩﻿]/g

/** A report's data (what follows `7501;`): a query, a report, or null when the report is to be discarded. */
export function parseReport(data: string): 'query' | Report | null {
  if (data === '?') return 'query'
  if (Buffer.byteLength(data) > MAX_DATA) return null
  const pairs = new Map<string, string>()
  for (const pair of data.split(':')) {
    const equals = pair.indexOf('=')
    if (equals <= 0) continue
    const key = pair.slice(0, equals)
    const value = pair.slice(equals + 1)
    if (key.length > MAX_KEY) return null
    if (!KEY.test(key) || !VALUE.test(value)) continue
    pairs.set(key, value)
  }
  const state = pairs.get('state')
  if (!state || !STATES.has(state)) return null
  const record: ProgramRecord = { id: '', state: state === 'clear' ? 'idle' : state as ProgramState }
  const id = pairs.get('id')
  if (id !== undefined) {
    const segments = id.split('/')
    if (id.length > MAX_ID || segments.length > MAX_DEPTH || segments.some((segment) => !NAME.test(segment))) return null
    record.id = id
  }
  const app = pairs.get('app')
  if (app !== undefined) {
    if (app.length > 32) return null
    if (NAME.test(app)) record.app = app
  }
  for (const key of ['title', 'msg'] as const) {
    const value = pairs.get(key)
    if (value === undefined) continue
    if (value.length > TEXT_LIMITS[key].encoded) return null
    const text = decodeText(value)
    if (text === null) continue
    if (Buffer.byteLength(text) > TEXT_LIMITS[key].decoded || CONTROL.test(text)) return null
    record[key] = text.replace(DISARM, '')
  }
  if (state === 'blocked' && KINDS.has(pairs.get('kind') ?? '')) record.kind = pairs.get('kind') as BlockedKind
  const progress = pairs.get('progress')
  if ((state === 'working' || state === 'blocked') && progress !== undefined && /^\d{1,3}$/.test(progress) && Number(progress) <= 100) record.progress = Number(progress)
  return { state: state as Report['state'], record }
}

/** Standard base64 of UTF-8, padding optional; null when it is not. */
function decodeText(value: string): string | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.replace(/=+$/, '').length % 4 === 1) return null
  const bytes = Buffer.from(value, 'base64')
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  try {
    return text.decode(bytes)
  } catch {
    return null
  }
}

/**
 * The status records of the programs in one terminal, by id. A report replaces its record whole; `clear` removes a
 * record and its children. `working` and `blocked` records last until the program exits or a shell prompt starts;
 * a full reset removes every record.
 */
export class ProgramStatus {
  private records = new Map<string, ProgramRecord>()

  /** Applies a report's data; returns whether the records changed. */
  apply(data: string): boolean {
    const report = parseReport(data)
    if (report === null || report === 'query') return false
    const { id } = report.record
    if (report.state === 'clear') {
      let removed = false
      for (const key of [...this.records.keys()]) {
        if (id === '' || key === id || key.startsWith(`${id}/`)) removed = this.records.delete(key) || removed
      }
      return removed
    }
    if (!this.records.has(id) && this.records.size >= MAX_RECORDS) return false
    this.records.delete(id)
    this.records.set(id, report.record)
    return true
  }

  /** The program exited or a shell prompt started: what was running or waiting is over. */
  ended(): boolean {
    let removed = false
    for (const [id, record] of this.records) {
      if (record.state === 'working' || record.state === 'blocked') removed = this.records.delete(id) || removed
    }
    return removed
  }

  /** A full terminal reset. */
  reset(): boolean {
    const had = this.records.size > 0
    this.records.clear()
    return had
  }

  /** The records, root first then by id, each with the app of its nearest ancestor that named one. */
  list(): ProgramRecord[] {
    return [...this.records.values()].sort((left, right) => left.id === '' ? -1 : right.id === '' ? 1 : left.id.localeCompare(right.id)).map((record) => {
      if (record.app) return record
      const segments = record.id.split('/')
      for (let depth = segments.length - 1; depth >= 0; depth--) {
        const ancestor = this.records.get(depth === 0 ? '' : segments.slice(0, depth).join('/'))
        if (ancestor?.app && ancestor.id !== record.id) return { ...record, app: ancestor.app }
      }
      return record
    })
  }

  get size(): number { return this.records.size }

  toJSON(): ProgramRecord[] { return [...this.records.values()] }

  restore(records: unknown): void {
    this.records.clear()
    if (!Array.isArray(records)) return
    for (const record of records.slice(0, MAX_RECORDS)) {
      if (record && typeof record.id === 'string' && STATES.has(record.state) && record.state !== 'clear') this.records.set(record.id, record)
    }
  }
}

const URGENCY: ProgramState[] = ['blocked', 'error', 'working', 'done', 'idle']

/** The state a terminal shows for its records: the most urgent of them. */
export function overallState(records: ProgramRecord[]): ProgramState | null {
  return URGENCY.find((state) => records.some((record) => record.state === state)) ?? null
}

import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonFile } from './json-file.ts'
import { RpcError, type Handlers } from './rpc-server.ts'

const MAX_KEYS = 10_000

/**
 * The order the owner gave the sessions, by name: Orc.app's sidebar shows it and Rex's tabs follow it. Names of
 * sessions that have ended are kept, so a session that comes back keeps its place. Kept in `session-order.json` in the
 * profile; `set` is false until an order is first saved. Emits `change` when it changes.
 */
export class SessionOrder extends EventEmitter {
  private keys: string[] = []
  private set = false
  private readonly file: string

  constructor(profile: string) {
    super()
    this.file = join(profile, 'session-order.json')
  }

  async load(): Promise<void> {
    const saved = await readFile(this.file, 'utf8').then((text) => JSON.parse(text) as { keys?: unknown }, () => null)
    this.set = saved !== null
    this.keys = names(saved?.keys)
  }

  get(): { keys: string[]; set: boolean } {
    return { keys: [...this.keys], set: this.set }
  }

  async replace(keys: string[]): Promise<void> {
    const next = [...new Set(keys)]
    if (this.set && next.join('\n') === this.keys.join('\n')) return
    this.keys = next
    this.set = true
    await writeJsonFile(this.file, { keys: this.keys })
    this.emit('change')
  }

  /** A renamed session keeps its place. */
  async rename(from: string, to: string): Promise<void> {
    if (from === to || !this.keys.includes(from)) return
    await this.replace(this.keys.filter((key) => key !== to).map((key) => key === from ? to : key))
  }
}

/**
 * Sessions in the order Orc.app's sidebar shows one project's: each parent, then its children, by their places in
 * `keys`, and those not in `keys` after them in the order given. A session's parent is the one whose name is its own
 * up to a hyphen (`parent-suffix`), as `SessionHierarchy` in OrcKit finds it: the longest such name, one level deep.
 */
export function sidebarOrder(sessions: string[], keys: string[]): string[] {
  const rank = new Map<string, number>()
  keys.forEach((key, index) => { if (!rank.has(key)) rank.set(key, index) })
  const present = new Set(sessions)
  const length = (name: string) => Array.from(name).length
  const parents = new Map<string, string>()
  const byLength = sessions.map((name, index) => ({ name, index })).sort((left, right) => length(left.name) - length(right.name) || left.index - right.index)
  for (const { name } of byLength) {
    let prefix = name
    for (let hyphen = prefix.lastIndexOf('-'); hyphen >= 0; hyphen = prefix.lastIndexOf('-')) {
      prefix = prefix.slice(0, hyphen)
      if (present.has(prefix) && length(name) > length(prefix) + 1 && !parents.has(prefix)) {
        parents.set(name, prefix)
        break
      }
    }
  }
  const ordered = (list: string[]) => list.map((name, index) => ({ name, index, rank: rank.get(name) ?? Infinity }))
    .sort((left, right) => left.rank === right.rank ? left.index - right.index : left.rank < right.rank ? -1 : 1).map(({ name }) => name)
  const children = new Map<string, string[]>()
  for (const name of sessions) {
    const parent = parents.get(name)
    if (parent) children.set(parent, [...children.get(parent) ?? [], name])
  }
  return ordered(sessions.filter((name) => !parents.has(name))).flatMap((name) => [name, ...ordered(children.get(name) ?? [])])
}

/**
 * `keys` with `moved`, sessions now in that order elsewhere (as tabs dragged in Rex), in the places those sessions held.
 * `shown` is every session in the order shown, which places sessions `keys` does not have yet.
 */
export function reorder(keys: string[], shown: string[], moved: string[]): string[] {
  const all = [...keys, ...shown.filter((name) => !keys.includes(name))]
  const places = new Set(moved)
  const queue = [...moved]
  return all.map((name) => places.has(name) ? queue.shift()! : name)
}

/** `session.order.*`, for the owner: on the local socket and to runtime-scope devices. */
export function orderHandlers(order: SessionOrder): Handlers {
  return {
    'session.order.get': () => order.get(),
    'session.order.set': async (params) => {
      if (!Array.isArray(params.keys) || params.keys.length > MAX_KEYS || !params.keys.every((key) => typeof key === 'string')) {
        throw new RpcError('invalid_argument', `keys must be at most ${MAX_KEYS} session names`)
      }
      await order.replace(params.keys)
      return order.get()
    }
  }
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

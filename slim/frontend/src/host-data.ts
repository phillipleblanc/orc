import { randomUUID } from 'node:crypto'
import { chmod, link, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import type { Catalog } from './catalog.ts'
import type { Projects } from './projects.ts'
import { RpcError, type Handlers } from './rpc-server.ts'
import { validateName, type SessionStore } from './session-store.ts'

const MAX_NOTES_BYTES = 256 * 1024
// Orc.app opens Markdown files up to 4 MiB; images and attachments must fit in a 16 MiB WebSocket message as base64.
const MAX_TEXT_BYTES = 4 << 20
const MAX_BINARY_BYTES = 12 << 20
const MAX_ENTRIES = 5000
const SESSION_TYPES = ['codex', 'claude', 'pi', 'durable', 'terminal']

/** Orc's configuration directory, as Orc.app finds it: `ORC_CONFIG_DIR`, or `~/.config/orc`. */
export function configDirectory(): string {
  return process.env.ORC_CONFIG_DIR || join(homedir(), '.config', 'orc')
}

/**
 * What Orc.app reads from its own disk, for the owner's other computers: session notes, files that Markdown links
 * name, dropped attachments, folders to add as projects, and the New Session defaults. Served on the local socket and
 * to runtime-scope devices, which can run any command on the host anyway; keeping file access to the home folder is
 * a second line, not the boundary.
 */
export function hostDataHandlers(options: { store: SessionStore; catalog: Catalog; projects: Projects }): Handlers {
  const { store, catalog, projects } = options
  const notesFile = (name: unknown) => {
    if (typeof name !== 'string') throw new RpcError('invalid_argument', 'name is required')
    validateName(name)
    return join(configDirectory(), 'notes', `${name}.txt`)
  }
  const configFile = () => join(configDirectory(), 'config.json')

  return {
    'notes.get': async (params) => {
      const file = notesFile(params.name)
      const modifiedAt = await modified(file)
      return { text: modifiedAt === null ? '' : await readFile(file, 'utf8'), modifiedAt }
    },

    'notes.set': async (params) => {
      const file = notesFile(params.name)
      if (typeof params.text !== 'string') throw new RpcError('invalid_argument', 'text is required')
      if (Buffer.byteLength(params.text) > MAX_NOTES_BYTES) throw new RpcError('invalid_argument', 'notes are limited to 256 KiB')
      if (params.ifModifiedAt !== undefined && params.ifModifiedAt !== await modified(file)) {
        throw new RpcError('conflict', 'the notes changed since they were read')
      }
      await writePrivate(file, params.text)
      return { modifiedAt: await modified(file) }
    },

    'file.read': async (params) => {
      if (typeof params.path !== 'string' || !params.path) throw new RpcError('invalid_argument', 'path is required')
      if (params.encoding !== undefined && params.encoding !== 'utf8' && params.encoding !== 'base64') throw new RpcError('invalid_argument', 'encoding must be utf8 or base64')
      const folder = typeof params.base === 'string' && params.base ? baseFolder(params.base) : undefined
      if (!folder && !isAbsolute(params.path)) throw new RpcError('invalid_argument', 'a relative path needs a base session or project')
      const path = await inHome(resolve(folder ?? '/', params.path))
      const info = await stat(path)
      if (!info.isFile()) throw new RpcError('invalid_argument', `${params.path} is not a file`)
      const base64 = params.encoding === 'base64'
      if (info.size > (base64 ? MAX_BINARY_BYTES : MAX_TEXT_BYTES)) throw new RpcError('invalid_argument', `${params.path} is larger than ${base64 ? 12 : 4} MiB`)
      const bytes = await readFile(path)
      if (base64) return { data: bytes.toString('base64'), size: bytes.length, modifiedAt: info.mtimeMs }
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new RpcError('invalid_argument', `${params.path} is not UTF-8 text`) }
      return { text, size: bytes.length, modifiedAt: info.mtimeMs }
    },

    'attachment.save': async (params) => {
      const name = typeof params.name === 'string' ? basename(params.name.trim()) : ''
      if (!name || name === '.' || name === '..' || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) throw new RpcError('invalid_argument', 'name the file')
      if (typeof params.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(params.data) || params.data.length > Math.ceil(MAX_BINARY_BYTES / 3) * 4) {
        throw new RpcError('invalid_argument', 'data must be the file in base64, at most 12 MiB')
      }
      // Each attachment keeps its name in a folder of its own; the program it is pasted into may read it much later.
      const path = join(configDirectory(), 'attachments', randomUUID(), name)
      await writePrivate(path, Buffer.from(params.data, 'base64'))
      return { path }
    },

    'fs.list': async (params) => {
      if (typeof params.path !== 'string' || !isAbsolute(params.path)) throw new RpcError('invalid_argument', 'path must be absolute')
      const path = await inHome(params.path)
      if (!(await stat(path)).isDirectory()) throw new RpcError('invalid_argument', `${params.path} is not a folder`)
      const entries: { name: string; directory: boolean }[] = []
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
        const directory = entry.isDirectory() || (entry.isSymbolicLink() && await stat(join(path, entry.name)).then((target) => target.isDirectory(), () => false))
        if (params.directoriesOnly === true && !directory) continue
        if (entries.length === MAX_ENTRIES) return { path, entries, truncated: true }
        entries.push({ name: entry.name, directory })
      }
      return { path, entries, truncated: false }
    },

    'config.get': async () => {
      const settings = await readConfig(configFile())
      return { defaultSessionType: settings.defaultSessionType ?? 'codex', defaultProject: settings.defaultProject ?? null }
    },

    'config.set': async (params) => {
      if (params.defaultSessionType !== undefined && !SESSION_TYPES.includes(params.defaultSessionType)) {
        throw new RpcError('invalid_argument', `defaultSessionType must be ${SESSION_TYPES.join(', ')}`)
      }
      const project = params.defaultProject
      if (project !== undefined && project !== null && (typeof project !== 'string' || !project.trim())) {
        throw new RpcError('invalid_argument', 'defaultProject must be a project selector, or null to remove it')
      }
      const file = configFile()
      const settings = await readConfig(file)
      if (params.defaultSessionType !== undefined) settings.defaultSessionType = params.defaultSessionType
      if (project === null) delete settings.defaultProject
      else if (project !== undefined) settings.defaultProject = project
      const sorted = Object.fromEntries(Object.entries(settings).sort(([left], [right]) => left < right ? -1 : 1))
      await writePrivate(file, JSON.stringify(sorted, null, 2) + '\n')
      return { defaultSessionType: settings.defaultSessionType ?? 'codex', defaultProject: settings.defaultProject ?? null }
    }
  }

  /** A session's folder, by handle or name, or a project's, by any of its selectors. */
  function baseFolder(base: string): string {
    const session = store.get(base)
    if (session) return catalog.worktreeFor(session).path
    const project = projects.resolve(base)
    if (project) return project.path
    throw new RpcError('not_found', `no session or project ${base}`)
  }
}

/** Moves a renamed session's notes to its new name, unless that name already has notes. */
export async function moveNotes(from: string, to: string): Promise<void> {
  if (from === to) return
  const folder = join(configDirectory(), 'notes')
  const source = join(folder, `${from}.txt`)
  try {
    await link(source, join(folder, `${to}.txt`))
  } catch (error) {
    if (['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) return
    throw error
  }
  await unlink(source)
}

/** The real path of `path`, which must be inside the home folder. */
async function inHome(path: string): Promise<string> {
  let real: string
  try { real = await realpath(path) } catch { throw new RpcError('not_found', `${path} does not exist`) }
  const home = await realpath(homedir())
  if (real !== home && !real.startsWith(home + sep)) throw new RpcError('forbidden', 'only files in the home folder are served')
  return real
}

async function modified(file: string): Promise<number | null> {
  return stat(file).then((info) => info.mtimeMs, () => null)
}

/** The settings in `config.json`; one that is not a JSON object is reported, never overwritten. */
async function readConfig(file: string): Promise<Record<string, unknown>> {
  let text: string
  try { text = await readFile(file, 'utf8') } catch { return {} }
  try {
    const value = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  } catch {}
  throw new RpcError('invalid_config', `${file} is not a JSON object; fix or remove it`)
}

/** Replaces `file` in one rename, readable only by its owner. */
async function writePrivate(file: string, contents: string | Buffer): Promise<void> {
  const folder = resolve(file, '..')
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const temporary = join(folder, `.${basename(file)}.${randomUUID()}`)
  try {
    await writeFile(temporary, contents, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { writeJsonFile } from './json-file.ts'

export type Project = { id: string; path: string; displayName: string; createdAt: string }

/** Registered project folders, persisted in `<profile>/projects.json`. */
export class Projects {
  private readonly file: string
  private projects: Project[] = []

  constructor(profile: string) {
    this.file = join(profile, 'projects.json')
  }

  async load(): Promise<void> {
    try {
      this.projects = JSON.parse(await readFile(this.file, 'utf8')) as Project[]
    } catch {
      this.projects = []
    }
  }

  list(): Project[] {
    return [...this.projects]
  }

  /** Orca worktree identifiers are `<repoId>::<path>`; clients pass them back as `id:<worktreeId>`. */
  worktreeId(project: Project): string {
    return `${project.id}::${project.path}`
  }

  resolve(selector: string): Project | undefined {
    const value = selector.startsWith('id:') ? selector.slice(3) : selector.startsWith('path:') ? selector.slice(5) : selector
    return this.projects.find((project) => this.worktreeId(project) === value || project.id === value || project.path === value)
  }

  /** The registered project whose folder contains `path`, preferring the deepest. */
  containing(path: string): Project | undefined {
    const real = (value: string) => { try { return realpathSync(value) } catch { return value } }
    const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
    const target = real(path)
    const candidates = this.projects.filter((project) => inside(path, project.path) || inside(target, real(project.path)))
    return candidates.sort((left, right) => right.path.length - left.path.length)[0]
  }

  /** Keeps the caller's spelling of the path, which clients compare against; duplicates are found by real path. */
  async add(path: string): Promise<Project> {
    const given = resolve(path)
    const real = await realpath(given)
    if (!(await stat(real)).isDirectory()) throw new Error(`${path} is not a directory`)
    for (const project of this.projects) {
      if (project.path === given || (await realpath(project.path).catch(() => '')) === real) return project
    }
    const project: Project = { id: randomUUID(), path: given, displayName: basename(given), createdAt: new Date().toISOString() }
    this.projects.push(project)
    await writeJsonFile(this.file, this.projects)
    return project
  }
}

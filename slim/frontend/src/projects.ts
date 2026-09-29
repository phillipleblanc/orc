import { randomUUID } from 'node:crypto'
import { readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

export type Project = { id: string; path: string; displayName: string; kind: 'git' | 'folder'; createdAt: string }

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

  /** Keeps the caller's spelling of the path, which clients compare against; duplicates are found by real path. */
  async add(path: string, kind: 'git' | 'folder'): Promise<Project> {
    const given = resolve(path)
    const real = await realpath(given)
    if (!(await stat(real)).isDirectory()) throw new Error(`${path} is not a directory`)
    for (const project of this.projects) {
      if (project.path === given || (await realpath(project.path).catch(() => '')) === real) return project
    }
    const project: Project = { id: randomUUID(), path: given, displayName: basename(given), kind, createdAt: new Date().toISOString() }
    this.projects.push(project)
    await writeFile(`${this.file}.tmp`, JSON.stringify(this.projects, null, 2), { mode: 0o600 })
    await rename(`${this.file}.tmp`, this.file)
    return project
  }
}

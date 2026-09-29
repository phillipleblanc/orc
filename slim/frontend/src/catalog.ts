import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import type { AgentMonitor } from './agent-monitor.ts'
import type { AgentDirectory } from './agents.ts'
import type { Project, Projects } from './projects.ts'
import type { SessionStore } from './session-store.ts'
import type { TerminalSession } from './terminal-session.ts'

/** Sessions outside every registered project are grouped by folder under this repository id. */
const FOLDER_REPO_ID = 'local'
const BRANCH_TTL_MS = 30_000

export type Worktree = { id: string; repoId: string; path: string; name: string; project?: Project }

/**
 * The workspace, tab and agent-status view of the sessions, in the shapes Orc and the Orca mobile app
 * read. `version` increases on every change clients can see; `epoch` identifies this frontend process,
 * so clients discard ordering from an earlier one.
 */
export class Catalog extends EventEmitter {
  readonly epoch: string
  version = 1
  private readonly store: SessionStore
  private readonly projects: Projects
  private readonly agents: AgentDirectory
  private readonly branches = new Map<string, { branch: string; at: number }>()
  private pending: NodeJS.Timeout | null = null

  constructor(store: SessionStore, projects: Projects, agents: AgentDirectory, runtimeId: string) {
    super()
    this.store = store
    this.projects = projects
    this.agents = agents
    this.epoch = `boot-${runtimeId}`
    store.on('added', () => this.changed())
    store.on('ended', () => this.changed())
    agents.on('change', () => this.changed())
  }

  changed(): void {
    this.version++
    this.pending ??= setTimeout(() => {
      this.pending = null
      this.emit('changed')
    }, 50)
  }

  worktreeFor(session: TerminalSession): Worktree {
    const project = session.meta.project ? this.projects.list().find((candidate) => candidate.id === session.meta.project) : undefined
    if (project) return { id: this.projects.worktreeId(project), repoId: project.id, path: project.path, name: project.displayName, project }
    return { id: `${FOLDER_REPO_ID}::${session.meta.cwd}`, repoId: FOLDER_REPO_ID, path: session.meta.cwd, name: basename(session.meta.cwd) || session.meta.cwd }
  }

  worktrees(): Worktree[] {
    const result = new Map<string, Worktree>()
    for (const project of this.projects.list()) {
      result.set(this.projects.worktreeId(project), { id: this.projects.worktreeId(project), repoId: project.id, path: project.path, name: project.displayName, project })
    }
    for (const session of this.store.list()) {
      const worktree = this.worktreeFor(session)
      if (!result.has(worktree.id)) result.set(worktree.id, worktree)
    }
    return [...result.values()]
  }

  resolveWorktree(selector: string): Worktree | undefined {
    const id = selector.startsWith('id:') ? selector.slice(3) : selector
    return this.worktrees().find((worktree) => worktree.id === id || worktree.path === id)
  }

  sessionsIn(worktreeId: string): TerminalSession[] {
    return this.store.list().filter((session) => this.worktreeFor(session).id === worktreeId)
  }

  /** `worktree.ps` rows. */
  worktreeRows(): Record<string, unknown>[] {
    return this.worktrees().map((worktree, index) => {
      const sessions = this.sessionsIn(worktree.id)
      const monitors = sessions.map((session) => this.agents.monitor(session)).filter((monitor): monitor is AgentMonitor => Boolean(monitor))
      const lastActivityAt = Math.max(0, ...sessions.map((session) => Date.parse(session.meta.createdAt)), ...monitors.map((monitor) => monitor.lastEventAt))
      return {
        workspaceKind: worktree.project?.kind === 'git' ? 'git' : 'folder',
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        repo: worktree.project?.displayName ?? worktree.name,
        path: worktree.path,
        branch: worktree.project?.kind === 'git' ? this.branch(worktree.path) : '',
        displayName: worktree.name,
        isArchived: false,
        isMainWorktree: true,
        hasHostSidebarActivity: monitors.some((monitor) => monitor.effectiveState === 'working'),
        parentWorktreeId: null,
        childWorktreeIds: [],
        workspaceStatus: 'in-progress',
        sortOrder: index,
        lastActivityAt: lastActivityAt || null,
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        linkedGitLabMR: null,
        linkedGitLabIssue: null,
        comment: '',
        isPinned: false,
        isActive: false,
        unread: false,
        liveTerminalCount: sessions.filter((session) => session.connected).length,
        hasAttachedPty: sessions.some((session) => session.connected),
        lastOutputAt: lastActivityAt || null,
        preview: '',
        status: sessions.length > 0 ? 'active' : 'inactive',
        agents: []
      }
    })
  }

  /** `repo.list` rows; folders outside projects share one repository. */
  repoRows(): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = this.projects.list().map((project) => ({
      id: project.id, displayName: project.displayName, path: project.path, badgeColor: '#6b7280', connectionId: null
    }))
    if (this.worktrees().some((worktree) => worktree.repoId === FOLDER_REPO_ID)) {
      rows.push({ id: FOLDER_REPO_ID, displayName: 'Folders', path: homedir(), badgeColor: '#6b7280', connectionId: null })
    }
    return rows
  }

  snapshotId(rows: unknown): string {
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 32)
  }

  /** A `session.tabs.list` result for one worktree. */
  tabSnapshot(worktree: Worktree): Record<string, unknown> {
    const tabs = this.sessionsIn(worktree.id).map((session) => this.tab(session))
    return {
      worktree: worktree.id,
      publicationEpoch: this.epoch,
      snapshotVersion: this.version,
      activeGroupId: null,
      activeTabId: tabs[0]?.id ?? null,
      activeTabType: tabs.length > 0 ? 'terminal' : null,
      tabs
    }
  }

  tab(session: TerminalSession): Record<string, any> {
    const monitor = this.agents.monitor(session)
    const agentType = monitor ? chatAgentType(monitor.kind) : undefined
    return {
      type: 'terminal',
      id: session.meta.id,
      title: session.meta.name,
      parentTabId: session.meta.id,
      leafId: session.meta.id,
      status: session.connected ? 'ready' : 'exited',
      terminal: session.handle,
      isActive: false,
      ...(agentType ? { launchAgent: agentType } : {}),
      agentStatus: this.agentStatus(session)
    }
  }

  /** Orca's tab `agentStatus`; `null` when the session runs no agent. */
  agentStatus(session: TerminalSession): Record<string, unknown> | null {
    const monitor = this.agents.monitor(session)
    if (!monitor || monitor.state === 'ended') return null
    const state = monitor.effectiveState
    const updatedAt = monitor.lastEventAt || Date.parse(session.meta.createdAt)
    return {
      state: state === 'working' ? 'working' : state === 'permission' ? 'blocked' : state === 'idle' ? 'done' : 'waiting',
      agentType: chatAgentType(monitor.kind),
      prompt: '',
      updatedAt,
      stateStartedAt: updatedAt,
      paneKey: `${session.meta.id}:${session.meta.id}`,
      stateHistory: [],
      ...(monitor.providerSession.id ? { providerSession: { key: 'session_id', ...monitor.providerSession } } : {}),
      ...(monitor.lastAssistantMessage ? { lastAssistantMessage: monitor.lastAssistantMessage } : {}),
      ...(monitor.dialog ? { interactivePrompt: monitor.dialog } : {}),
      restoredUnconfirmed: false
    }
  }

  private branch(path: string): string {
    const cached = this.branches.get(path)
    if (!cached || Date.now() - cached.at > BRANCH_TTL_MS) {
      this.branches.set(path, { branch: cached?.branch ?? '', at: Date.now() })
      execFile('git', ['-C', path, 'symbolic-ref', '--short', '-q', 'HEAD'], { timeout: 2000 }, (error, stdout) => {
        const branch = error ? '' : `refs/heads/${stdout.trim()}`
        if (branch !== cached?.branch) this.changed()
        this.branches.set(path, { branch, at: Date.now() })
      })
    }
    return cached?.branch ?? ''
  }
}

/** Pi transcripts use the omp format; clients render Pi sessions through the omp decoder. */
export function chatAgentType(kind: string): string {
  return kind === 'pi' ? 'omp' : kind
}

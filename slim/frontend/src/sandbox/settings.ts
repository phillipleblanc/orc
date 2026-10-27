import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isAgentKind, type AgentKind } from '../agent-hooks.ts'

/**
 * `<profile>/sandbox.json`. `agents` names the agents that run sandboxed (only `claude` can); `exclude`
 * lists folders whose sessions run on the Mac anyway, such as projects that build with Xcode. `home` adds
 * paths under the home folder to copy into every machine. `sshAgent` names the keys of the SSH agent Orc
 * runs for machines, and the security key provider that loads them; without it, machines reach the
 * login shell's agent, and with `false`, none. `caches` names paths under the machine's home folder, such as
 * `.cargo/registry`, kept per working folder: every agent that works in a folder gets that folder's caches,
 * and no other agent does. A cache given as `{ path, seed }` starts with copies of those folders under the
 * same path on the Mac. `cpus` and `memoryMib` cap each machine.
 */
export type SandboxSettings = {
  agents: AgentKind[]
  exclude: string[]
  template: string
  home: string[]
  sshAgent: { keys: string[]; provider?: string } | 'login' | false
  caches: { path: string; seed: string[] }[]
  cpus?: number
  memoryMib?: number
}

export const SANDBOXABLE: readonly AgentKind[] = ['claude']
export const DEFAULT_TEMPLATE = 'orc-template'

/** Paths under the home folder every machine gets a copy of, when they exist. */
export const DEFAULT_HOME_PATHS = [
  '.claude/settings.json', '.claude/CLAUDE.md', '.claude/skills', '.claude/agents', '.claude/commands', '.claude/hooks',
  '.claude/output-styles', '.claude/plugins', '.claude/keybindings.json', '.gitconfig', '.config/git', '.config/jj', '.ssh/known_hosts', '.ssh/allowed_signers'
]

export async function loadSandboxSettings(profile: string): Promise<SandboxSettings> {
  const saved = await readFile(join(profile, 'sandbox.json'), 'utf8').then(JSON.parse, () => ({})) as Record<string, any>
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : []
  const ssh = saved.sshAgent
  return {
    agents: strings(saved.agents).filter(isAgentKind).filter((kind) => SANDBOXABLE.includes(kind)),
    exclude: strings(saved.exclude),
    template: typeof saved.template === 'string' && saved.template ? saved.template : DEFAULT_TEMPLATE,
    home: strings(saved.home),
    sshAgent: ssh === false ? false : ssh && typeof ssh === 'object' ? { keys: strings(ssh.keys), ...(typeof ssh.provider === 'string' ? { provider: ssh.provider } : {}) } : 'login',
    caches: (Array.isArray(saved.caches) ? saved.caches : []).map((entry: unknown) => typeof entry === 'string' ? { path: entry, seed: [] }
      : entry && typeof entry === 'object' && typeof (entry as any).path === 'string' ? { path: (entry as any).path, seed: strings((entry as any).seed) } : null)
      .filter((entry: { path: string; seed: string[] } | null): entry is { path: string; seed: string[] } => entry !== null)
      .map((entry: { path: string; seed: string[] }) => ({ path: relativePath(entry.path), seed: entry.seed.map(relativePath) }))
      .filter((entry: { path: string; seed: string[] }) => entry.path && entry.seed.every(Boolean)),
    ...(Number.isInteger(saved.cpus) && saved.cpus > 0 ? { cpus: saved.cpus } : {}),
    ...(Number.isInteger(saved.memoryMib) && saved.memoryMib > 0 ? { memoryMib: saved.memoryMib } : {})
  }
}

/** A path inside a folder, without `~/`, a leading `/` or `..`; '' when it is none. */
function relativePath(path: string): string {
  const trimmed = path.replace(/^~\//, '').replace(/\/+$/, '')
  return trimmed && !trimmed.startsWith('/') && !trimmed.split('/').includes('..') ? trimmed : ''
}

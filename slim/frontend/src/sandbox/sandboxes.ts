import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { AgentKind } from '../agent-hooks.ts'
import { writeJsonFile } from '../json-file.ts'
import { loginEnvironment, resolveExecutable } from '../login-environment.ts'
import { RpcError } from '../rpc-server.ts'
import type { SessionStore } from '../session-store.ts'
import type { TerminalSession } from '../terminal-session.ts'
import { SandboxBridge, type Channel } from './bridge.ts'
import { OrbStack, type Mount } from './orbstack.ts'
import { DEFAULT_HOME_PATHS, loadSandboxSettings, type SandboxSettings } from './settings.ts'

const run = promisify(execFile)
const GUEST = join(dirname(fileURLToPath(import.meta.url)), 'guest')

/** What a session's `meta.json` records about its machine. `programIndex` is where the agent's own argv starts. */
export type SandboxMeta = { machine: string; user: string; home: string; programIndex: number }

/** Sockets the bridge serves in every machine, by kind. */
export const GUEST_SOCKETS = { orc: '/run/orc/orc.sock', 'ssh-agent': '/run/orc/ssh-agent.sock' } as const
const GUEST_ORC = '/usr/local/bin/orc'
const GUEST_BRIDGE = '/usr/local/lib/orc/bridge.py'
// Where Orc's own command is on the Mac; settings copied into a machine may run it from either.
const MAC_ORC_PATHS = ['/Applications/Orc.app/Contents/Resources/orc', join(homedir(), '.local/bin/orc')]
// The keychain item holding a Claude token from `claude setup-token`, which machines sign in with.
export const CLAUDE_TOKEN_ITEM = 'Orc sandbox Claude'
const BRIDGE_RESTART_MS = 2000

export type PreparedSandbox = {
  meta: Omit<SandboxMeta, 'programIndex'>
  /** The events file of the session, in a folder the machine mounts. */
  events: string
  /** The holder's argv and environment that run `program` in the machine. */
  wrap(program: string[], env: Record<string, string>): { argv: string[]; env: Record<string, string>; programIndex: number }
}

/**
 * Machines for sandboxed agent sessions: one OrbStack machine per session, cloned from a template, that
 * mounts only the session's folder, the folders granted to its name, its own state folder and its Claude
 * project folder, each at the same path as on the Mac. A bridge in the machine carries the agent's `orc`
 * commands and SSH agent requests to Orc, which knows the caller by the machine the bridge belongs to.
 * A machine lasts as long as its session, through restarts, and is deleted when the session ends.
 */
export class Sandboxes extends EventEmitter {
  readonly orb: OrbStack
  readonly profile: string
  private readonly store: SessionStore
  private readonly tag: string
  private readonly user = userInfo().username
  private readonly home = homedir()
  private readonly bridges = new Map<string, SandboxBridge>()
  private readonly kept = new Set<string>()
  /** Throwaway machines of `exec`, which reach the SSH agent but have no session. */
  private readonly execs = new Set<string>()
  private readonly log: (line: string) => void
  private serveOrc: (session: TerminalSession, channel: Channel) => void = (_session, channel) => channel.end()
  private sshAgent: Promise<string | null> | null = null

  constructor(options: { profile: string; store: SessionStore; log: (line: string) => void; orb?: OrbStack }) {
    super()
    this.profile = options.profile
    this.store = options.store
    this.log = options.log
    this.orb = options.orb ?? new OrbStack()
    this.tag = createHash('sha256').update(this.profile).digest('hex').slice(0, 6)
    this.store.on('added', (session: TerminalSession) => { if (sandboxOf(session)) void this.ensureBridge(session).catch((error) => this.log(`bridge for ${session.meta.name}: ${error.message}`)) })
    this.store.on('ended', (session: TerminalSession) => void this.ended(session))
  }

  /** Serves `orc` channels: the agent's `orc` commands and Mac-side MCP servers. */
  serve(handler: (session: TerminalSession, channel: Channel) => void): void {
    this.serveOrc = handler
  }

  settings(): Promise<SandboxSettings> {
    return loadSandboxSettings(this.profile)
  }

  /** Whether an agent of `kind` in `cwd` runs sandboxed; `requested` overrides the settings. */
  async wanted(kind: AgentKind, cwd: string, requested?: boolean): Promise<boolean> {
    if (requested === false) return false
    const settings = await this.settings()
    if (requested === true) {
      if (kind !== 'claude') throw new RpcError('invalid_argument', `${kind} agents cannot run sandboxed; only Claude can`)
      return true
    }
    if (!settings.agents.includes(kind)) return false
    const real = await realpath(cwd).catch(() => cwd)
    return !settings.exclude.some((folder) => inside(real, folder) || inside(cwd, folder))
  }

  machineName(name: string): string {
    const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'session'
    return `orc-${this.tag}-${slug}-${createHash('sha256').update(name).digest('hex').slice(0, 6)}`
  }

  stateDir(machine: string): string {
    return join(this.profile, 'sandboxes', machine)
  }

  /** The folders granted to an agent name, from `orc sandbox grant`, whether or not it runs. */
  async grants(name: string): Promise<string[]> {
    const all = await this.allGrants()
    return all[name] ?? []
  }

  async grant(name: string, path: string): Promise<string[]> {
    const folder = await checkedFolder(path, this.profile)
    const all = await this.allGrants()
    const list = all[name] ?? []
    if (!list.includes(folder)) all[name] = [...list, folder]
    await writeJsonFile(join(this.profile, 'sandbox-grants.json'), all)
    return all[name]
  }

  async revoke(name: string, path: string): Promise<string[]> {
    const all = await this.allGrants()
    const folder = await realpath(resolve(path)).catch(() => resolve(path))
    all[name] = (all[name] ?? []).filter((granted) => granted !== folder && granted !== resolve(path))
    if (all[name].length === 0) delete all[name]
    await writeJsonFile(join(this.profile, 'sandbox-grants.json'), all)
    return all[name] ?? []
  }

  /**
   * The mounts a session named `name` in `cwd` gets: its folder and those granted to its name at their real paths,
   * its state folder at the path Orc gives it, its Claude project folder, and its folder's caches in its home.
   * A mount's source is a real path.
   */
  async mounts(name: string, cwd: string): Promise<Mount[]> {
    const folder = await checkedFolder(cwd, this.profile)
    const folders = new Set<string>([folder, ...(await this.grants(name))])
    const state = this.stateDir(this.machineName(name))
    const claudeProject = join(this.home, '.claude', 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'))
    const caches = join(this.profile, 'sandbox-caches', createHash('sha256').update(folder).digest('hex').slice(0, 16))
    const own = await Promise.all([
      ...[state, claudeProject].map((path) => ({ path, destination: path, seed: [] as string[], from: '' })),
      ...(await this.settings()).caches.map((cache) => ({
        path: join(caches, cache.path.replace(/\//g, '_')), destination: join(this.home, cache.path), seed: cache.seed, from: join(this.home, cache.path)
      }))
    ].map(async ({ path, destination, seed, from }) => {
      if (!existsSync(path)) {
        await mkdir(path, { recursive: true, mode: 0o700 })
        // A new cache starts with the Mac's own copies of these folders, cloned by APFS, so they cost no space.
        for (const folder of seed.filter((entry) => existsSync(join(from, entry)))) {
          await mkdir(dirname(join(path, folder)), { recursive: true, mode: 0o700 })
          await run('/bin/cp', ['-c', '-R', join(from, folder), join(path, folder)])
            .catch((error) => this.log(`could not seed ${join(path, folder)}: ${String(error.stderr || error.message).trim()}`))
        }
      }
      return { source: await realpath(path), destination }
    }))
    return [...[...folders].map((path) => ({ source: path, destination: path })), ...own]
  }

  /**
   * Gets the session's machine ready to run its agent: cloned from the template if it does not exist,
   * mounting what the session should see, started, and given current copies of the settings, Orc's hooks,
   * Orc's `orc` command and the bridge, which is started too.
   */
  async prepare(options: { name: string; kind: AgentKind; cwd: string; hooks: string }): Promise<PreparedSandbox> {
    const { name, cwd } = options
    if (!this.orb.installed) throw new RpcError('unavailable', 'Sandboxed agents need OrbStack, which is not installed')
    const settings = await this.settings()
    const machine = this.machineName(name)
    const state = this.stateDir(machine)
    await mkdir(join(state, 'events'), { recursive: true, mode: 0o700 })
    const mounts = await this.mounts(name, cwd)
    const folder = mounts[0].destination
    this.bridges.get(machine)?.stop()
    await this.orb.ensureRunning()
    let existing = await this.orb.machine(machine)
    if (!existing) {
      if (!(await this.orb.machine(settings.template))) {
        throw new RpcError('unavailable', `There is no sandbox template machine ${settings.template}; run orc sandbox template to build it`)
      }
      await this.orb.clone(settings.template, machine)
      existing = await this.orb.machine(machine)
      if (!existing?.isolated || !existing.isolateNetwork) {
        await this.orb.delete(machine).catch(() => {})
        throw new RpcError('unavailable', `The template ${settings.template} is not an isolated machine with an isolated network`)
      }
    }
    const wanted = new Set(mounts.map((mount) => `${mount.source}\0${mount.destination}`))
    const have = new Set(existing.mounts.map((mount) => `${mount.source}\0${mount.destination}`))
    const stale = existing.mounts.filter((mount) => !wanted.has(`${mount.source}\0${mount.destination}`))
    const missing = mounts.filter((mount) => !have.has(`${mount.source}\0${mount.destination}`))
    if (stale.length || missing.length) {
      if (existing.state !== 'stopped') await this.orb.stop(machine)
      for (const mount of stale) await this.orb.removeMount(machine, mount)
      for (const mount of missing) await this.orb.addMount(machine, mount)
    }
    if (settings.cpus) await this.orb.configure(machine, 'cpu', settings.cpus)
    if (settings.memoryMib) await this.orb.configure(machine, 'memory_mib', settings.memoryMib)
    await this.orb.start(machine)
    await this.install(machine, settings, mounts, options.hooks)
    const meta = { machine, user: this.user, home: this.home }
    await this.startBridge(meta)
    const events = join(state, 'events', `${createHash('sha256').update(`${name}\0${Date.now()}\0${Math.random()}`).digest('hex').slice(0, 32)}.jsonl`)
    const secrets = await this.secrets()
    return {
      meta, events,
      wrap: (program, env) => {
        const inner = [
          'TERM=xterm-256color', 'COLORTERM=truecolor', 'LANG=C.UTF-8',
          `PATH=${this.home}/.local/bin:${this.home}/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
          `ORC_SESSION_NAME=${env.ORC_SESSION_NAME ?? name}`, `ORC_AGENT_EVENTS=${events}`, `SSH_AUTH_SOCK=${GUEST_SOCKETS['ssh-agent']}`
        ]
        const prefix = [this.orb.orb, ...this.orb.execArgs(machine, this.user, ['/usr/bin/env', ...inner], folder)]
        return {
          argv: [...prefix, basename(program[0]), ...program.slice(1)],
          programIndex: prefix.length,
          // orb asks the terminal for its colors unless TERM is dumb; the program gets its own TERM above.
          env: { HOME: this.home, PATH: env.PATH ?? '/usr/bin:/bin', LANG: env.LANG ?? 'en_US.UTF-8', TERM: 'dumb', ORBENV: Object.keys(secrets).join(':'), ...secrets }
        }
      }
    }
  }

  /**
   * Runs `argv` in a throwaway machine that mounts only `grants`, as the agents' user with the same copied
   * settings, SSH agent and GitHub token an agent gets, and deletes the machine afterwards. Tools that must
   * not run on the Mac in a folder an agent writes to, such as jj with that folder's configuration, run here.
   */
  async exec(options: { grants: string[]; argv: string[]; cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> {
    if (!this.orb.installed) throw new RpcError('unavailable', 'Sandboxes need OrbStack, which is not installed')
    if (options.argv.length === 0) throw new RpcError('invalid_argument', 'give a command to run')
    const settings = await this.settings()
    const folders = [...new Set(await Promise.all(options.grants.map((path) => checkedFolder(path, this.profile))))]
    const cwd = options.cwd ? await realpath(options.cwd).catch(() => resolve(options.cwd!)) : folders[0]
    if (cwd && !folders.some((folder) => inside(cwd, folder))) throw new RpcError('invalid_argument', `${options.cwd} is not inside the folders given`)
    await this.orb.ensureRunning()
    if (!(await this.orb.machine(settings.template))) throw new RpcError('unavailable', `There is no sandbox template machine ${settings.template}; run orc sandbox template to build it`)
    const machine = `orc-${this.tag}-exec-${createHash('sha256').update(`${Date.now()}\0${Math.random()}`).digest('hex').slice(0, 8)}`
    this.execs.add(machine)
    try {
      await this.orb.clone(settings.template, machine)
      for (const folder of folders) await this.orb.addMount(machine, { source: folder, destination: folder })
      await this.orb.start(machine)
      await this.install(machine, settings, folders.map((folder) => ({ source: folder, destination: folder })))
      await this.startBridge({ machine, user: this.user, home: this.home })
      const secrets = await this.secrets()
      const inner = [`PATH=${this.home}/.local/bin:${this.home}/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, 'LANG=C.UTF-8', `SSH_AUTH_SOCK=${GUEST_SOCKETS['ssh-agent']}`]
      return await this.orb.capture(machine, this.user, ['/usr/bin/env', ...inner, ...options.argv], {
        cwd, timeoutMs: options.timeoutMs ?? 600_000, env: { ORBENV: Object.keys(secrets).join(':'), ...secrets }
      })
    } finally {
      this.bridges.get(machine)?.stop()
      this.bridges.delete(machine)
      this.execs.delete(machine)
      await this.orb.delete(machine).catch((error) => this.log(`could not delete ${machine}: ${error.message}`))
    }
  }

  /** Keeps the session's machine through its next end, for a restart that starts it again. */
  keep(session: TerminalSession): void {
    const sandbox = sandboxOf(session)
    if (sandbox) this.kept.add(sandbox.machine)
  }

  /** Stops and deletes a machine prepared for a session that did not start, unless a session runs in it. */
  async discard(machine: string): Promise<void> {
    if (this.sessionIn(machine)) return
    this.bridges.get(machine)?.stop()
    this.bridges.delete(machine)
    this.kept.delete(machine)
    await this.orb.delete(machine).catch((error) => this.log(`could not delete ${machine}: ${error.message}`))
  }

  /** Deletes machines of this profile that no running session uses. */
  async sweep(): Promise<string[]> {
    // Listing machines starts OrbStack, which only sandboxing needs.
    if (!this.orb.installed || ((await this.settings()).agents.length === 0 && !this.store.list().some((session) => sandboxOf(session)))) return []
    const used = new Set(this.store.list().map((session) => sandboxOf(session)?.machine).filter(Boolean))
    const deleted: string[] = []
    for (const machine of await this.orb.machines().catch(() => [])) {
      if (!machine.name.startsWith(`orc-${this.tag}-`) || used.has(machine.name) || this.kept.has(machine.name) || this.execs.has(machine.name)) continue
      await this.orb.delete(machine.name).then(() => deleted.push(machine.name), (error) => this.log(`could not delete ${machine.name}: ${error.message}`))
    }
    return deleted
  }

  /** The session running in `machine`. */
  sessionIn(machine: string): TerminalSession | undefined {
    return this.store.list().find((session) => sandboxOf(session)?.machine === machine)
  }

  /** Starts the bridge of a running session's machine unless it is running. */
  async ensureBridge(session: TerminalSession): Promise<void> {
    const sandbox = sandboxOf(session)
    if (!sandbox || this.bridges.get(sandbox.machine)?.running) return
    await this.startBridge(sandbox)
  }

  private async startBridge(meta: Omit<SandboxMeta, 'programIndex'>): Promise<void> {
    this.bridges.get(meta.machine)?.stop()
    const sockets = Object.entries(GUEST_SOCKETS).map(([kind, path]) => `${kind}=${path}`)
    const child = this.orb.spawn(meta.machine, 'root', ['python3', GUEST_BRIDGE, meta.user, ...sockets])
    const bridge = new SandboxBridge(child, (channel) => void this.channel(meta.machine, channel))
    this.bridges.set(meta.machine, bridge)
    bridge.on('log', (line: string) => this.log(`bridge ${meta.machine}: ${line.trim()}`))
    bridge.on('exit', () => {
      if (this.bridges.get(meta.machine) !== bridge) return
      this.bridges.delete(meta.machine)
      // A bridge ends with its machine; a running session's machine gets a new one.
      setTimeout(() => {
        const session = this.sessionIn(meta.machine)
        if (session && !this.bridges.has(meta.machine)) void this.ensureBridge(session).catch(() => {})
      }, BRIDGE_RESTART_MS).unref()
    })
  }

  private async channel(machine: string, channel: Channel): Promise<void> {
    const session = this.sessionIn(machine)
    if (!session && !this.execs.has(machine)) return void channel.destroy()
    if (channel.kind === 'orc') return session ? this.serveOrc(session, channel) : void channel.destroy()
    if (channel.kind === 'ssh-agent') {
      const path = await this.sshAgentSocket().catch(() => null)
      if (!path) return void channel.destroy()
      const socket = connect(path)
      socket.on('error', () => channel.destroy())
      channel.on('error', () => socket.destroy())
      channel.pipe(socket).pipe(channel)
      return
    }
    channel.destroy()
  }

  /** The SSH agent machines reach: Orc's own, holding the configured keys, or the login shell's. */
  private async sshAgentSocket(): Promise<string | null> {
    const settings = await this.settings()
    if (settings.sshAgent === false) return null
    if (settings.sshAgent === 'login') return (await loginEnvironment()).SSH_AUTH_SOCK ?? null
    const { keys, provider } = settings.sshAgent
    this.sshAgent ??= this.startSshAgent(keys, provider).catch((error) => {
      this.sshAgent = null
      throw error
    })
    const path = await this.sshAgent
    if (path && !(await answers(path))) {
      this.sshAgent = null
      return this.sshAgentSocket()
    }
    return path
  }

  private async startSshAgent(keys: string[], provider?: string): Promise<string> {
    const path = join(this.profile, 'ssh-agent.sock')
    if (await answers(path)) return path
    await rm(path, { force: true })
    const agent = spawn('/usr/bin/ssh-agent', ['-D', '-a', path, ...(provider ? ['-P', provider] : [])], { detached: true, stdio: 'ignore' })
    agent.unref()
    for (let attempt = 0; attempt < 50 && !(await answers(path)); attempt++) await new Promise((done) => setTimeout(done, 20))
    const env = { ...process.env, SSH_AUTH_SOCK: path }
    for (const key of keys) {
      const file = key.startsWith('~/') ? join(this.home, key.slice(2)) : key
      await run('/usr/bin/ssh-add', [...(provider ? ['-S', provider] : []), file], { env, timeout: 30_000 })
        .catch((error) => this.log(`ssh-add ${file}: ${String(error.stderr || error.message).trim()}`))
    }
    return path
  }

  /** Secrets the agent's program gets in its environment: GitHub's token and Claude's sign-in, when there are any. */
  private async secrets(): Promise<Record<string, string>> {
    const env = await loginEnvironment()
    const secrets: Record<string, string> = {}
    const gh = resolveExecutable('gh', env)
    if (gh) {
      const token = await run(gh, ['auth', 'token'], { env, timeout: 10_000 }).then((result) => result.stdout.trim(), () => '')
      if (token) secrets.GH_TOKEN = token
    }
    const claude = await run('/usr/bin/security', ['find-generic-password', '-s', CLAUDE_TOKEN_ITEM, '-w'], { timeout: 5000 }).then((result) => result.stdout.trim(), () => '')
    if (claude) secrets.CLAUDE_CODE_OAUTH_TOKEN = claude
    return secrets
  }

  /**
   * Copies into the machine, as its user: the configured paths under the home folder (following links),
   * Claude's state with trust for the mounted folders, an SSH configuration that reaches Orc's agent, and
   * jj's signing through it. As root: Orc's hooks at their Mac path, the `orc` command and the bridge.
   */
  private async install(machine: string, settings: SandboxSettings, mounts: Mount[], hooks?: string): Promise<void> {
    const stage = join(this.profile, 'sandbox-stage', machine)
    await rm(stage, { recursive: true, force: true })
    const homeStage = join(stage, 'home')
    const rootStage = join(stage, 'root')
    await mkdir(homeStage, { recursive: true, mode: 0o700 })
    await mkdir(rootStage, { recursive: true, mode: 0o700 })
    try {
      const copies: string[] = []
      for (const path of [...new Set([...DEFAULT_HOME_PATHS, ...settings.home, ...(await this.publicKeys())])]) {
        const relativePath = relative(this.home, resolve(this.home, path.replace(/^~\//, '')))
        if (relativePath.startsWith('..') || !relativePath) continue
        if (await stat(join(this.home, relativePath)).then(() => true, () => false)) copies.push(relativePath)
      }
      const generated = await this.generatedHomeFiles(mounts.map((mount) => mount.destination))
      for (const [path, content] of Object.entries(generated)) {
        await mkdir(dirname(join(homeStage, path)), { recursive: true })
        await writeFile(join(homeStage, path), content, { mode: 0o600 })
      }
      const homeArchive = await tar([...(copies.length ? ['-C', this.home, ...copies] : []), '-C', homeStage, ...Object.keys(generated)])
      const removed = [...copies, ...Object.keys(generated)].map(shellQuote).join(' ')
      await this.orb.exec(machine, this.user, ['/bin/sh', '-c', `cd "$HOME" && rm -rf ${removed} && tar -xf - --no-overwrite-dir -C "$HOME"`], { input: homeArchive, timeoutMs: 300_000 })

      await mkdir(join(rootStage, dirname(GUEST_ORC).slice(1)), { recursive: true })
      await copyFile(join(GUEST, 'orc'), join(rootStage, GUEST_ORC.slice(1)))
      await chmod(join(rootStage, GUEST_ORC.slice(1)), 0o755)
      await mkdir(join(rootStage, dirname(GUEST_BRIDGE).slice(1)), { recursive: true })
      await copyFile(join(GUEST, 'bridge.py'), join(rootStage, GUEST_BRIDGE.slice(1)))
      for (const path of MAC_ORC_PATHS) {
        await mkdir(join(rootStage, dirname(path).slice(1)), { recursive: true })
        await symlink(GUEST_ORC, join(rootStage, path.slice(1)))
      }
      const hookDir = hooks ? dirname(hooks) : null
      if (hookDir) {
        await mkdir(join(rootStage, dirname(hookDir).slice(1)), { recursive: true })
        await run('/bin/cp', ['-R', hookDir, join(rootStage, dirname(hookDir).slice(1))])
      }
      // Top-level entries only: an entry for `.` would give the machine's root folder the staging folder's mode.
      const rootArchive = await tar(['-C', rootStage, ...(await readdir(rootStage))])
      const replaced = [...(hookDir ? [hookDir] : []), ...MAC_ORC_PATHS].map(shellQuote).join(' ')
      const readable = [...(hookDir ? [hookDir] : []), dirname(GUEST_BRIDGE)].map(shellQuote).join(' ')
      await this.orb.exec(machine, 'root', ['/bin/sh', '-c', `rm -rf ${replaced} && tar -xpf - --no-same-owner --no-overwrite-dir -C / && chmod -R a+rX ${readable}`],
        { input: rootArchive, timeoutMs: 120_000 })
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }

  /** Public halves of the keys the SSH agent holds, which `IdentityFile` and jj's signing key name. */
  private async publicKeys(): Promise<string[]> {
    const settings = await this.settings()
    if (!settings.sshAgent || settings.sshAgent === 'login') return []
    return settings.sshAgent.keys.map((key) => `${key}.pub`)
  }

  private async generatedHomeFiles(folders: string[]): Promise<Record<string, string>> {
    const files: Record<string, string> = {}
    const claude = await readFile(join(this.home, '.claude.json'), 'utf8').then(JSON.parse, () => ({})) as Record<string, any>
    const trusted = { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true }
    files['.claude.json'] = JSON.stringify({
      hasCompletedOnboarding: true,
      ...(typeof claude.lastOnboardingVersion === 'string' ? { lastOnboardingVersion: claude.lastOnboardingVersion } : {}),
      installMethod: 'native', autoUpdates: false,
      projects: Object.fromEntries(folders.map((folder) => [folder, { ...trusted, mcpServers: this.relayedMcpServers(claude.projects?.[folder]?.mcpServers) }])),
      mcpServers: this.relayedMcpServers(claude.mcpServers)
    }, null, 2)
    const sshConfig = await readFile(join(this.home, '.ssh', 'config'), 'utf8').catch(() => '')
    files['.ssh/config'] = `Host *\n  IdentityAgent ${GUEST_SOCKETS['ssh-agent']}\n\n` + sshConfig.split('\n')
      .filter((line) => !/^\s*(Include|UseKeychain|SecurityKeyProvider|IdentityAgent|AddKeysToAgent)\b/i.test(line))
      .map((line) => line.replace(/^(\s*IdentityFile\s+)(\S+?)(\.pub)?\s*$/i, (_match, start, path) => `${start}${path}.pub`))
      .join('\n')
    const signing = await this.jjSigning()
    if (signing) files['.config/jj/conf.d/orc-sandbox.toml'] = signing
    return files
  }

  /** The user's and the folders' own stdio MCP servers run on the Mac; the machine's Claude reaches each through `orc mcp NAME`. */
  private relayedMcpServers(servers: unknown): Record<string, unknown> {
    if (!servers || typeof servers !== 'object') return {}
    return Object.fromEntries(Object.entries(servers as Record<string, any>)
      .filter(([, server]) => typeof server?.command === 'string')
      .map(([name]) => [name, { type: 'stdio', command: GUEST_ORC, args: ['mcp', name] }]))
  }

  /** jj signs with SSH keys through the relayed agent: the key's public half, with Linux's ssh-keygen. */
  private async jjSigning(): Promise<string | null> {
    const env = await loginEnvironment()
    const jj = resolveExecutable('jj', env)
    if (!jj) return null
    const get = (key: string) => run(jj, ['config', 'get', key], { cwd: '/', env, timeout: 5000 }).then((result) => result.stdout.trim(), () => '')
    if ((await get('signing.backend')) !== 'ssh') return null
    const key = await get('signing.key')
    if (!key) return null
    const publicKey = key.startsWith('ssh-') || key.startsWith('sk-') || key.endsWith('.pub') ? key : `${key}.pub`
    return `[signing]\nkey = ${JSON.stringify(publicKey)}\nbackends.ssh.program = "ssh-keygen"\n`
  }

  private async allGrants(): Promise<Record<string, string[]>> {
    const saved = await readFile(join(this.profile, 'sandbox-grants.json'), 'utf8').then(JSON.parse, () => ({}))
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
  }

  private async ended(session: TerminalSession): Promise<void> {
    const sandbox = sandboxOf(session)
    if (!sandbox) return
    const bridge = this.bridges.get(sandbox.machine)
    this.bridges.delete(sandbox.machine)
    bridge?.stop()
    if (this.kept.delete(sandbox.machine)) return
    await this.orb.delete(sandbox.machine).catch((error) => this.log(`could not delete ${sandbox.machine}: ${error.message}`))
  }
}

export function sandboxOf(session: TerminalSession): SandboxMeta | undefined {
  return (session.meta as { sandbox?: SandboxMeta }).sandbox
}

/**
 * A transcript path a sandboxed agent reported, if Orc may read it: a regular file in the Claude project folder its
 * machine mounts. The agent writes that folder, so a link in it could otherwise lead Orc to any file on the Mac.
 * Sessions on the Mac are trusted with any path.
 */
export async function readableTranscript(meta: { cwd: string; sandbox?: SandboxMeta }, path: string | undefined): Promise<string | null> {
  if (!path) return null
  if (!meta.sandbox) return path
  const folder = await realpath(meta.cwd).catch(() => null)
  if (!folder) return null
  const project = join(meta.sandbox.home, '.claude', 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'))
  const [realProject, parent, info] = await Promise.all([realpath(project).catch(() => null), realpath(dirname(path)).catch(() => null), lstat(path).catch(() => null)])
  if (!realProject || !parent || !info?.isFile() || !inside(resolve(path), project) || !inside(parent, realProject)) return null
  return path
}

/** The argv of the session's program, without the command that runs it in a machine. */
export function programArgv(meta: { argv: string[]; sandbox?: SandboxMeta }): string[] {
  return meta.sandbox ? meta.argv.slice(meta.sandbox.programIndex) : meta.argv
}

// Folders that may not be mounted, nor any folder containing them: they hold the Mac's keys and settings.
const PROTECTED = ['.ssh', 'Library', '.config', '.claude', '.codex', '.pi', '.aws', '.gnupg', '.local', '.orbstack', '.docker', '.kube', '.netrc']

/** The real path of a folder that may be mounted into a machine, or an error saying why it may not. */
export async function checkedFolder(path: string, profile: string): Promise<string> {
  const absolute = resolve(path)
  const real = await realpath(absolute).catch(() => null)
  if (!real || !(await lstat(real)).isDirectory()) throw new RpcError('invalid_argument', `${path} is not a folder`)
  const home = await realpath(homedir())
  if (real.includes(':')) throw new RpcError('invalid_argument', `${path} contains ":", which a machine cannot mount`)
  const guarded = [home, await realpath(profile).catch(() => profile), ...PROTECTED.map((name) => join(home, name))]
  if (real === '/' || guarded.some((protectedPath) => inside(protectedPath, real) || (protectedPath !== home && inside(real, protectedPath)))) {
    throw new RpcError('invalid_argument', `${path} holds the Mac's own files and cannot be given to a sandboxed agent`)
  }
  return real
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** A tar archive of `args`' paths, following symbolic links, without macOS metadata. */
async function tar(args: string[]): Promise<Buffer> {
  const { stdout } = await run('/usr/bin/tar', ['-c', '-h', '-f', '-', '--no-mac-metadata', '--no-xattrs', '--no-acls', '--no-fflags', ...args],
    { encoding: 'buffer', maxBuffer: 1 << 30, env: { ...process.env, COPYFILE_DISABLE: '1' } })
  return stdout as unknown as Buffer
}

/** Whether something answers on the Unix socket at `path`. */
function answers(path: string): Promise<boolean> {
  if (!existsSync(path)) return Promise.resolve(false)
  return new Promise((done) => {
    const socket = connect(path)
    socket.once('connect', () => { socket.destroy(); done(true) })
    socket.once('error', () => done(false))
  })
}

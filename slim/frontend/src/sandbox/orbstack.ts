import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

export type Mount = { source: string; destination: string }
export type Machine = { name: string; state: string; mounts: Mount[]; isolated: boolean; isolateNetwork: boolean }

/** Where `orb` is installed; OrbStack links it here and keeps it in the app. */
export const ORB_PATHS = ['/usr/local/bin/orb', '/Applications/OrbStack.app/Contents/MacOS/bin/orb']

export class OrbError extends Error {}

/**
 * OrbStack's machines, through its `orb` command. Machines share OrbStack's Linux kernel; an isolated
 * machine sees only the Mac folders mounted into it, and mounts apply when it starts.
 */
export class OrbStack {
  readonly orb: string

  constructor(orb = ORB_PATHS.find((path) => existsSync(path)) ?? ORB_PATHS[0]) {
    this.orb = orb
  }

  get installed(): boolean {
    return existsSync(this.orb)
  }

  /** Runs `orb ARGS`, with `input` on its standard input; rejects with its error output when it fails. */
  run(args: string[], { input, timeoutMs = 120_000, env = {} }: { input?: string | Buffer; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      // TERM=dumb keeps orb from asking the terminal for its colors. ORBENV names variables orb passes on to the command.
      const child = execFile(this.orb, args, { timeout: timeoutMs, maxBuffer: 64 << 20, env: { ...process.env, ...env, TERM: 'dumb' } }, (error, stdout, stderr) => {
        if (error) reject(new OrbError(`orb ${args.slice(0, 2).join(' ')} failed: ${String(stderr || error.message).trim()}`))
        else resolve(String(stdout))
      })
      if (input !== undefined) child.stdin!.end(input)
    })
  }

  /** Starts OrbStack itself, which does not start at login unless set to. */
  async ensureRunning(): Promise<void> {
    await this.run(['start'], { timeoutMs: 120_000 })
  }

  async machines(): Promise<Machine[]> {
    const listed = JSON.parse(await this.run(['list', '-f', 'json'])) as any[]
    return (Array.isArray(listed) ? listed : []).map((entry) => ({
      name: String(entry.name),
      state: String(entry.state),
      mounts: Array.isArray(entry.config?.mounts) ? entry.config.mounts.map((mount: any) => ({ source: String(mount.source), destination: String(mount.destination) })) : [],
      isolated: entry.config?.isolated === true,
      isolateNetwork: entry.config?.isolate_network === true
    }))
  }

  async machine(name: string): Promise<Machine | undefined> {
    return (await this.machines()).find((machine) => machine.name === name)
  }

  clone(from: string, to: string): Promise<string> {
    return this.run(['clone', from, to])
  }

  /** Starts a machine. OrbStack occasionally fails to start a container it starts on a second try. */
  async start(name: string): Promise<string> {
    try {
      return await this.run(['start', name])
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return this.run(['start', name])
    }
  }

  stop(name: string): Promise<string> {
    return this.run(['stop', name])
  }

  delete(name: string): Promise<string> {
    return this.run(['delete', '-f', name])
  }

  rename(from: string, to: string): Promise<string> {
    return this.run(['rename', from, to])
  }

  /** Adds a mount; it applies when the machine next starts. Paths may not contain ":", which separates them. */
  addMount(name: string, mount: Mount): Promise<string> {
    return this.run(['config', 'add', `machine.${name}.mounts`, mountSpec(mount)])
  }

  removeMount(name: string, mount: Mount): Promise<string> {
    return this.run(['config', 'remove', `machine.${name}.mounts`, mountSpec(mount)])
  }

  /** Sets one of a machine's settings, such as `cpu` or `memory_mib`; 0 means OrbStack's default. */
  configure(name: string, key: string, value: string | number): Promise<string> {
    return this.run(['config', 'set', `machine.${name}.${key}`, String(value)])
  }

  /** Runs `argv` in the machine as `user` and returns its output. */
  exec(machine: string, user: string, argv: string[], options: { input?: string | Buffer; cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<string> {
    return this.run(this.execArgs(machine, user, argv, options.cwd), options)
  }

  /** Runs `argv` in the machine as `user` and returns its exit status and output, whatever the status. */
  capture(machine: string, user: string, argv: string[], options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(this.orb, this.execArgs(machine, user, argv, options.cwd), { timeout: options.timeoutMs ?? 600_000, maxBuffer: 64 << 20, env: { ...process.env, ...options.env, TERM: 'dumb' } },
        (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }))
    })
  }

  /** Starts `argv` in the machine as `user`, its standard streams piped. */
  spawn(machine: string, user: string, argv: string[], cwd?: string): ChildProcess {
    return spawn(this.orb, this.execArgs(machine, user, argv, cwd), { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TERM: 'dumb' } })
  }

  /** The arguments that run `argv` in the machine. orb takes no `--`; everything from the command on is the command's. */
  execArgs(machine: string, user: string, argv: string[], cwd?: string): string[] {
    return ['-m', machine, '-u', user, ...(cwd ? ['-w', cwd] : []), ...argv]
  }
}

export function mountSpec(mount: Mount): string {
  if (mount.source.includes(':') || mount.destination.includes(':')) throw new OrbError(`a mounted path cannot contain ":": ${mount.source}`)
  return `${mount.source}:${mount.destination}`
}

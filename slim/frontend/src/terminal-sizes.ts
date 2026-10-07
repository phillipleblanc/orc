import { EventEmitter } from 'node:events'
import type { TerminalSession } from './terminal-session.ts'

// A PTY keeps a phone's size this long after the last phone stops viewing it, so switching tabs or
// resubscribing to refit does not bounce the desktop's layout.
const RESTORE_DELAY_MS = 300

export type Size = { cols: number; rows: number }
/** How phones viewing a session show it: fitted to the phone (`auto`), or at the desktop's size. */
export type DisplayMode = 'auto' | 'desktop'

type Fit = { restore: Size; viewers: Map<string, Size>; desktop: boolean; timer?: NodeJS.Timeout }

/** A phone viewing a terminal: its connection, the terminal and the client id it gave. */
export function phoneViewer(connectionId: string, terminal: string, clientId: string): string {
  return `${connectionId}|${terminal}:${clientId}`
}

/**
 * Who sizes each session's PTY. A phone viewing a session wins: the phone that most recently asked
 * sets the size, and when it leaves, the next most recent one's applies. A desktop's size claimed
 * while phones view the session is kept, and applies once the last phone has left; before any
 * desktop claim, that is the size from before the first phone. A viewing phone can switch the
 * session to the desktop's size until it switches back, types into it, or the last phone leaves.
 * Emits `mode` with the session when its display mode changes.
 */
export class TerminalSizes extends EventEmitter {
  private readonly fits = new Map<TerminalSession, Fit>()
  private readonly log: (line: string) => void

  constructor(log: (line: string) => void = () => {}) {
    super()
    this.setMaxListeners(0)
    this.log = log
  }

  displayMode(session: TerminalSession): DisplayMode {
    return this.fits.get(session)?.desktop ? 'desktop' : 'auto'
  }

  phoneFit(session: TerminalSession, viewer: string, size: Size): Promise<void> {
    let fit = this.fits.get(session)
    if (!fit) this.fits.set(session, (fit = { restore: { cols: session.cols, rows: session.rows }, viewers: new Map(), desktop: false }))
    clearTimeout(fit.timer)
    fit.timer = undefined
    fit.viewers.delete(viewer)
    fit.viewers.set(viewer, size)
    if (fit.desktop) return Promise.resolve()
    this.log(`phone fit ${session.meta.name} from ${session.cols}x${session.rows} to ${size.cols}x${size.rows}`)
    return session.resize(size.cols, size.rows)
  }

  viewing(session: TerminalSession, viewer: string): boolean {
    return this.fits.get(session)?.viewers.has(viewer) ?? false
  }

  phoneLeft(session: TerminalSession, viewer: string): void {
    const fit = this.fits.get(session)
    if (!fit?.viewers.delete(viewer)) return
    const latest = [...fit.viewers.values()].at(-1)
    if (latest) {
      if (!fit.desktop) void session.resize(latest.cols, latest.rows).catch(() => {})
      return
    }
    fit.timer = setTimeout(() => {
      this.fits.delete(session)
      // At the desktop's size already.
      if (!session.connected || fit.desktop) return
      this.log(`phone left ${session.meta.name}; back to ${fit.restore.cols}x${fit.restore.rows}`)
      void session.resize(fit.restore.cols, fit.restore.rows).catch(() => {})
    }, RESTORE_DELAY_MS)
    fit.timer.unref()
  }

  /** A desktop's size for the session: applied now, or kept until the phones viewing it leave. */
  desktopClaim(session: TerminalSession, size: Size, from: string): Promise<void> {
    const fit = this.fits.get(session)
    if (!fit) return session.resize(size.cols, size.rows)
    const changed = fit.restore.cols !== size.cols || fit.restore.rows !== size.rows
    fit.restore = size
    if (fit.desktop) return session.resize(size.cols, size.rows)
    if (changed) this.log(`${from} asked for ${size.cols}x${size.rows} on ${session.meta.name}; kept until the phone leaves`)
    return Promise.resolve()
  }

  /**
   * A viewing phone's choice of display mode, with its current viewport. Only a session phones view has
   * a mode other than `auto`.
   */
  async setDisplayMode(session: TerminalSession, mode: DisplayMode, viewer?: string, viewport?: Size): Promise<void> {
    const fit = this.fits.get(session)
    if (fit) {
      if (viewer && viewport && fit.viewers.delete(viewer)) fit.viewers.set(viewer, viewport)
      fit.desktop = mode === 'desktop' && fit.viewers.size > 0
      const size = fit.desktop ? fit.restore : [...fit.viewers.values()].at(-1)
      this.log(`phone switched ${session.meta.name} to ${fit.desktop ? 'the desktop size' : 'the phone size'}`)
      if (size && (size.cols !== session.cols || size.rows !== session.rows)) await session.resize(size.cols, size.rows)
    }
    this.emit('mode', session)
  }

  /** A phone viewing the session typed into it: a session at the desktop's size fits the phone again. */
  async phoneTyped(session: TerminalSession, viewer: string): Promise<void> {
    const fit = this.fits.get(session)
    if (fit?.desktop && fit.viewers.has(viewer)) await this.setDisplayMode(session, 'auto')
  }
}

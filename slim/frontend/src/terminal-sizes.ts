import type { TerminalSession } from './terminal-session.ts'

// A PTY keeps a phone's size this long after the last phone stops viewing it, so switching tabs or
// resubscribing to refit does not bounce the desktop's layout.
const RESTORE_DELAY_MS = 300

export type Size = { cols: number; rows: number }

/**
 * Who sizes each session's PTY. A phone viewing a session wins: the phone that most recently asked
 * sets the size, and when it leaves, the next most recent one's applies. A desktop's size claimed
 * while phones view the session is kept, and applies once the last phone has left; before any
 * desktop claim, that is the size from before the first phone.
 */
export class TerminalSizes {
  private readonly fits = new Map<TerminalSession, { restore: Size; viewers: Map<string, Size>; timer?: NodeJS.Timeout }>()
  private readonly log: (line: string) => void

  constructor(log: (line: string) => void = () => {}) {
    this.log = log
  }

  phoneFit(session: TerminalSession, viewer: string, size: Size): Promise<void> {
    let fit = this.fits.get(session)
    if (!fit) this.fits.set(session, (fit = { restore: { cols: session.cols, rows: session.rows }, viewers: new Map() }))
    clearTimeout(fit.timer)
    fit.viewers.delete(viewer)
    fit.viewers.set(viewer, size)
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
      void session.resize(latest.cols, latest.rows).catch(() => {})
      return
    }
    fit.timer = setTimeout(() => {
      this.fits.delete(session)
      if (!session.connected) return
      this.log(`phone left ${session.meta.name}; back to ${fit.restore.cols}x${fit.restore.rows}`)
      void session.resize(fit.restore.cols, fit.restore.rows).catch(() => {})
    }, RESTORE_DELAY_MS)
    fit.timer.unref()
  }

  /** A desktop's size for the session: applied now, or kept until the phones viewing it leave. */
  desktopClaim(session: TerminalSession, size: Size, from: string): Promise<void> {
    const fit = this.fits.get(session)
    if (!fit) return session.resize(size.cols, size.rows)
    if (fit.restore.cols !== size.cols || fit.restore.rows !== size.rows) {
      this.log(`${from} asked for ${size.cols}x${size.rows} on ${session.meta.name}; kept until the phone leaves`)
      fit.restore = size
    }
    return Promise.resolve()
  }
}

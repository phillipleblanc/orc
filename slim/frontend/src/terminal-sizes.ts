import { EventEmitter } from 'node:events'
import type { TerminalSession } from './terminal-session.ts'

// A PTY keeps a phone's size this long after the last phone stops viewing it, so switching tabs or
// resubscribing to refit does not bounce the desktop's layout.
const RESTORE_DELAY_MS = 300
// A desktop viewer with presence takes a session from an owner that has had no attention for this long, so two
// devices in use at once do not trade it on every presence report.
export const PRESENCE_HOLD_MS = 3000
// A desktop viewer's state outlives its subscriptions this long, so a reconnecting viewer keeps it, and
// `terminal.view` may arrive before the viewer subscribes.
export const UNSUBSCRIBED_VIEWER_MS = 60_000

export type Size = { cols: number; rows: number }
/** How phones viewing a session show it: fitted to the phone (`auto`), or at the desktop's size. */
export type DisplayMode = 'auto' | 'desktop'
/** What the person did with a desktop viewer: `strong` acts on it; `presence` is activity on its device while it is shown. */
export type Attention = 'strong' | 'presence'

type Fit = { restore: Size; viewers: Map<string, Size>; desktop: boolean; timer?: NodeJS.Timeout }

type DesktopViewer = {
  size?: Size
  shown: boolean
  /** Whether it follows the ownership rule; a legacy viewer's every claim is strong attention to a shown viewer. */
  legacy: boolean
  /** The device grant it connected with, which non-owners name. */
  device?: string
  /** When the person last gave it attention of either kind (0 for never), and the order of that attention and its last strong attention. */
  attentionAt: number
  attention: number
  strong: number
  streams: number
  subscribed: boolean
  /** When it last had no subscription, or last claimed without one. */
  idleSince: number
}

type Desktops = { viewers: Map<string, DesktopViewer>; owner?: string; ownerSince: number; applied?: Size }

/** A phone viewing a terminal: its connection, the terminal and the client id it gave. */
export function phoneViewer(connectionId: string, terminal: string, clientId: string): string {
  return `${connectionId}|${terminal}:${clientId}`
}

/**
 * Who sizes each session's PTY. A phone viewing a session wins: the phone that most recently asked
 * sets the size, and when it leaves, the next most recent one's applies. A viewing phone can switch
 * the session to the desktop's size until it switches back, types into it, or the last phone leaves.
 *
 * Underneath, the desktop viewers of a session agree on one owner, whose size is the desktop's size:
 * applied when no phone views the session, and kept until the last phone leaves otherwise. The owner
 * is the shown viewer the person is looking at: strong attention to a shown viewer makes it the owner,
 * presence does once the owner has had no attention for `PRESENCE_HOLD_MS`, and an owner that is
 * hidden or gone hands over to the shown viewer with the most recent attention. With no shown viewer
 * the PTY keeps its size. Hidden viewers never size it.
 *
 * Emits `mode` with the session when its display mode changes, and `owner` with the session when its
 * desktop owner changes.
 */
export class TerminalSizes extends EventEmitter {
  private readonly fits = new Map<TerminalSession, Fit>()
  private readonly desktops = new Map<TerminalSession, Desktops>()
  private readonly log: (line: string) => void
  private readonly now: () => number
  private order = 0

  constructor(log: (line: string) => void = () => {}, now: () => number = Date.now) {
    super()
    this.setMaxListeners(0)
    this.log = log
    this.now = now
  }

  displayMode(session: TerminalSession): DisplayMode {
    return this.fits.get(session)?.desktop ? 'desktop' : 'auto'
  }

  phoneFit(session: TerminalSession, viewer: string, size: Size): Promise<void> {
    let fit = this.fits.get(session)
    if (!fit) this.fits.set(session, (fit = { restore: this.desktops.get(session)?.applied ?? { cols: session.cols, rows: session.rows }, viewers: new Map(), desktop: false }))
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

  /** A desktop viewer subscribed to the session. A new viewer that follows the ownership rule starts shown. */
  desktopSubscribed(session: TerminalSession, clientId: string, options: { legacy: boolean; device?: string; size?: Size | null }): Promise<void> {
    const viewer = this.viewer(session, clientId)
    viewer.streams++
    viewer.subscribed = true
    viewer.legacy = options.legacy
    if (options.device !== undefined) viewer.device = options.device
    if (options.size) viewer.size = options.size
    return this.arbitrate(session)
  }

  desktopUnsubscribed(session: TerminalSession, clientId: string): Promise<void> {
    const viewer = this.desktops.get(session)?.viewers.get(clientId)
    if (!viewer || viewer.streams === 0) return Promise.resolve()
    if (--viewer.streams === 0) viewer.idleSince = this.now()
    return this.arbitrate(session)
  }

  /** The viewer's viewport, which sizes the PTY while it owns the session. */
  desktopSize(session: TerminalSession, clientId: string, size: Size): Promise<void> {
    this.viewer(session, clientId).size = size
    return this.arbitrate(session)
  }

  desktopShown(session: TerminalSession, clientId: string, shown: boolean): Promise<void> {
    this.viewer(session, clientId).shown = shown
    return this.arbitrate(session)
  }

  desktopAttention(session: TerminalSession, clientId: string, attention: Attention): Promise<void> {
    const viewer = this.viewer(session, clientId)
    viewer.attentionAt = this.now()
    viewer.attention = ++this.order
    if (attention === 'strong') viewer.strong = viewer.attention
    return this.arbitrate(session, { clientId, attention })
  }

  /** A claim from a viewer that does not follow the ownership rule: its size, and strong attention to it, shown. */
  legacyClaim(session: TerminalSession, clientId: string, size: Size, device?: string): Promise<void> {
    const viewer = this.viewer(session, clientId)
    viewer.legacy = true
    viewer.shown = true
    viewer.size = size
    if (device !== undefined) viewer.device = device
    if (viewer.streams === 0) viewer.idleSince = this.now()
    return this.desktopAttention(session, clientId, 'strong')
  }

  /** Whether the viewer follows the ownership rule. */
  followsOwnership(session: TerminalSession, clientId: string): boolean {
    const viewer = this.desktops.get(session)?.viewers.get(clientId)
    return viewer !== undefined && !viewer.legacy
  }

  /** The desktop viewer whose size the session has, and the device it connected with. */
  owner(session: TerminalSession): { clientId: string; device: string | null } | null {
    const desktops = this.desktops.get(session)
    const viewer = desktops?.owner === undefined ? undefined : desktops.viewers.get(desktops.owner)
    return viewer ? { clientId: desktops!.owner!, device: viewer.device ?? null } : null
  }

  private viewer(session: TerminalSession, clientId: string): DesktopViewer {
    let desktops = this.desktops.get(session)
    if (!desktops) {
      this.desktops.set(session, (desktops = { viewers: new Map(), ownerSince: 0 }))
      session.once('exit', () => this.desktops.delete(session))
    }
    let viewer = desktops.viewers.get(clientId)
    if (!viewer) {
      viewer = { shown: true, legacy: false, attentionAt: 0, attention: 0, strong: 0, streams: 0, subscribed: false, idleSince: this.now() }
      desktops.viewers.set(clientId, viewer)
    }
    return viewer
  }

  /** Chooses the session's desktop owner after a change, and gives the PTY its size. */
  private arbitrate(session: TerminalSession, event?: { clientId: string; attention: Attention }): Promise<void> {
    const desktops = this.desktops.get(session)
    if (!desktops) return Promise.resolve()
    const now = this.now()
    for (const [clientId, viewer] of desktops.viewers) {
      if (viewer.streams === 0 && now - viewer.idleSince >= UNSUBSCRIBED_VIEWER_MS) desktops.viewers.delete(clientId)
    }
    // A viewer that unsubscribed is gone; one that only ever claims without subscribing is there while its state lasts.
    const present = (viewer: DesktopViewer | undefined): viewer is DesktopViewer & { size: Size } =>
      Boolean(viewer?.size && viewer.shown && (viewer.streams > 0 || (viewer.legacy && !viewer.subscribed)))
    const current = desktops.owner === undefined ? undefined : desktops.viewers.get(desktops.owner)
    let owner = present(current) ? desktops.owner : undefined
    if (event && event.clientId !== owner && present(desktops.viewers.get(event.clientId))) {
      if (event.attention === 'strong' || owner === undefined || now - current!.attentionAt >= PRESENCE_HOLD_MS) owner = event.clientId
    }
    // Strong attention to a viewer that could not take the session then (not yet subscribed, sized or shown) takes it
    // once the viewer can, unless the owner has had strong attention or taken the session since.
    const claimedAt = Math.max(desktops.ownerSince, owner === undefined ? 0 : desktops.viewers.get(owner)!.strong)
    let pending: [string, DesktopViewer] | undefined
    for (const entry of desktops.viewers) {
      if (entry[0] !== owner && present(entry[1]) && entry[1].strong > claimedAt && entry[1].strong > (pending?.[1].strong ?? 0)) pending = entry
    }
    if (pending) owner = pending[0]
    if (owner === undefined) {
      let latest: [string, DesktopViewer] | undefined
      for (const entry of desktops.viewers) {
        if (present(entry[1]) && entry[1].attention > (latest?.[1].attention ?? 0)) latest = entry
      }
      owner = latest?.[0]
    }
    const changed = owner !== desktops.owner
    desktops.owner = owner
    if (changed) {
      desktops.ownerSince = ++this.order
      this.log(owner === undefined ? `no desktop viewer is shown on ${session.meta.name}` : `${this.describe(desktops, owner)} sizes ${session.meta.name}`)
    }
    const size = owner === undefined ? undefined : desktops.viewers.get(owner)!.size
    const resized = size && (size.cols !== desktops.applied?.cols || size.rows !== desktops.applied?.rows) ? this.applyDesktop(session, desktops, size) : Promise.resolve()
    if (changed) this.emit('owner', session)
    return resized
  }

  /** The desktop's size for the session: applied now, or kept until the phones viewing it leave. */
  private applyDesktop(session: TerminalSession, desktops: Desktops, size: Size): Promise<void> {
    desktops.applied = size
    const fit = this.fits.get(session)
    if (!fit) return session.resize(size.cols, size.rows)
    fit.restore = size
    if (fit.desktop) return session.resize(size.cols, size.rows)
    this.log(`the desktop asked for ${size.cols}x${size.rows} on ${session.meta.name}; kept until the phone leaves`)
    return Promise.resolve()
  }

  private describe(desktops: Desktops, clientId: string): string {
    const viewer = desktops.viewers.get(clientId)!
    return `${viewer.legacy ? 'a legacy desktop viewer' : 'a desktop viewer'} on ${viewer.device ?? 'this host'}`
  }
}

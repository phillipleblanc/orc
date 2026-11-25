import AppKit
import SwiftUI
import OrcKit

/// The sessions' quick terminals. A session's quick terminal is the user's shell, started in the session's folder, in a
/// panel over the session's terminal that can be moved and resized. A session has at most one. It keeps running,
/// hidden, while another session shows, and ends when it is closed, its shell exits, its session ends or Orc quits.
@MainActor final class QuickTerminals: ObservableObject {
    struct Panel {
        let terminal: GhosttyView
        /// Where the panel was put in the pane, from the pane's top left; nil until it is moved or resized.
        var frame: CGRect?
    }

    /// Panels by session handle.
    @Published private(set) var panels: [String: Panel] = [:]
    private let makeTerminal: @MainActor (Session) -> GhosttyView

    init(makeTerminal: @escaping @MainActor (Session) -> GhosttyView = { GhosttyView(session: $0, shellIn: $0.cwd ?? $0.worktreePath) }) {
        self.makeTerminal = makeTerminal
    }

    func terminal(for handle: String) -> GhosttyView? { panels[handle]?.terminal }

    /// Opens `session`'s quick terminal unless it has one; the new terminal takes the keyboard when it shows.
    func open(_ session: Session) {
        guard panels[session.handle] == nil else { return }
        let terminal = makeTerminal(session)
        terminal.setAccessibilityLabel("Quick terminal — \(session.name)")
        terminal.onClose = { [weak self] in self?.close(session.handle) }
        panels[session.handle] = Panel(terminal: terminal)
    }

    func place(_ handle: String, at frame: CGRect) { panels[handle]?.frame = frame }

    func close(_ handle: String) {
        guard let panel = panels.removeValue(forKey: handle) else { return }
        panel.terminal.detach()
        panel.terminal.removeFromSuperview()
    }

    /// Closes the quick terminals of sessions that no longer exist.
    func keep(_ sessions: [Session]) {
        let handles = Set(sessions.map(\.handle))
        for handle in Array(panels.keys) where !handles.contains(handle) { close(handle) }
    }

    nonisolated static let minimumSize = CGSize(width: 280, height: 140)
    nonisolated static let margin: CGFloat = 16

    /// Where a new panel shows: the lower right of the pane.
    nonisolated static func defaultFrame(in pane: CGSize) -> CGRect {
        let width = min(max(pane.width * 0.45, 420), pane.width - 2 * margin)
        let height = min(max(pane.height * 0.4, 240), pane.height - 2 * margin)
        return fitted(CGRect(x: pane.width - margin - width, y: pane.height - margin - height, width: width, height: height), in: pane)
    }

    /// `frame` moved, and shrunk if it must be, to lie inside the pane, at least the minimum size where the pane allows.
    nonisolated static func fitted(_ frame: CGRect, in pane: CGSize) -> CGRect {
        let width = min(max(frame.width, minimumSize.width), pane.width)
        let height = min(max(frame.height, minimumSize.height), pane.height)
        return CGRect(x: min(max(frame.minX, 0), pane.width - width), y: min(max(frame.minY, 0), pane.height - height),
                      width: width, height: height)
    }
}

/// A quick terminal's panel: a bar with its close button, to move it by, over the terminal. Its edges and corners
/// resize it.
struct QuickTerminalPanel: View {
    let terminal: GhosttyView
    let frame: CGRect?
    let pane: CGSize
    let theme: TerminalTheme
    let place: (CGRect) -> Void
    let close: () -> Void
    /// The frame while the panel is being moved or resized.
    @State private var adjusting: CGRect?
    static let barHeight: CGFloat = 22
    /// The panel's inset around the terminal, where its edges can be grabbed.
    static let inset: CGFloat = 6
    private static let radius: CGFloat = 8

    var body: some View {
        let placed = QuickTerminals.fitted(frame ?? QuickTerminals.defaultFrame(in: pane), in: pane)
        let shown = QuickTerminals.fitted(adjusting ?? placed, in: pane)
        VStack(spacing: 0) {
            bar(from: placed)
            QuickTerminalHost(terminal: terminal)
                .padding([.horizontal, .bottom], Self.inset)
        }
        .frame(width: shown.width, height: shown.height)
        .background(
            RoundedRectangle(cornerRadius: Self.radius, style: .continuous)
                .fill(theme.background.color)
                .shadow(color: .black.opacity(theme.isDark ? 0.5 : 0.2), radius: 16, y: 6)
        )
        .overlay(RoundedRectangle(cornerRadius: Self.radius, style: .continuous).strokeBorder(theme.line.color))
        .overlay { ForEach(Grip.allCases, id: \.self) { grip($0, from: placed) } }
        .position(x: shown.midX, y: shown.midY)
    }

    private func bar(from placed: CGRect) -> some View {
        HStack(spacing: 0) {
            Button(action: close) {
                Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                    .frame(width: 18, height: 18).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Close Quick Terminal")
            .accessibilityLabel("Close Quick Terminal")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .frame(height: Self.barHeight)
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
            .onChanged { adjusting = placed.offsetBy(dx: $0.translation.width, dy: $0.translation.height) }
            .onEnded { _ in finish() })
    }

    private func grip(_ grip: Grip, from placed: CGRect) -> some View {
        let corner: CGFloat = 10
        return Color.clear
            .frame(width: grip.isCorner ? corner : grip.dx == 0 ? nil : Self.inset,
                   height: grip.isCorner ? corner : grip.dy == 0 ? nil : Self.inset)
            .contentShape(Rectangle())
            .resizePointer(grip)
            .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
                .onChanged { adjusting = grip.resized(placed, by: $0.translation, in: pane) }
                .onEnded { _ in finish() })
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: grip.alignment)
    }

    private func finish() {
        if let adjusting { place(QuickTerminals.fitted(adjusting, in: pane)) }
        adjusting = nil
    }
}

/// A side or corner of a panel, which resizes it.
enum Grip: CaseIterable {
    case top, bottom, leading, trailing, topLeading, topTrailing, bottomLeading, bottomTrailing

    /// The horizontal edge it moves: -1 the left, 1 the right, 0 neither; `dy` likewise for the top and bottom.
    var dx: CGFloat { [.leading, .topLeading, .bottomLeading].contains(self) ? -1 : [.trailing, .topTrailing, .bottomTrailing].contains(self) ? 1 : 0 }
    var dy: CGFloat { [.top, .topLeading, .topTrailing].contains(self) ? -1 : [.bottom, .bottomLeading, .bottomTrailing].contains(self) ? 1 : 0 }
    var isCorner: Bool { dx != 0 && dy != 0 }
    var alignment: Alignment {
        switch (dx, dy) {
        case (-1, -1): .topLeading
        case (1, -1): .topTrailing
        case (-1, 1): .bottomLeading
        case (1, 1): .bottomTrailing
        case (-1, _): .leading
        case (1, _): .trailing
        case (_, -1): .top
        default: .bottom
        }
    }

    /// `frame` with this grip dragged by `translation`, no smaller than the minimum size and no further than the pane.
    func resized(_ frame: CGRect, by translation: CGSize, in pane: CGSize) -> CGRect {
        let minimum = QuickTerminals.minimumSize
        var result = frame
        if dx < 0 {
            let width = min(max(frame.width - translation.width, minimum.width), frame.maxX)
            result.origin.x = frame.maxX - width; result.size.width = width
        } else if dx > 0 {
            result.size.width = min(max(frame.width + translation.width, minimum.width), pane.width - frame.minX)
        }
        if dy < 0 {
            let height = min(max(frame.height - translation.height, minimum.height), frame.maxY)
            result.origin.y = frame.maxY - height; result.size.height = height
        } else if dy > 0 {
            result.size.height = min(max(frame.height + translation.height, minimum.height), pane.height - frame.minY)
        }
        return result
    }

    @available(macOS 15, *)
    var pointerPosition: FrameResizePosition {
        switch self {
        case .top: .top
        case .bottom: .bottom
        case .leading: .leading
        case .trailing: .trailing
        case .topLeading: .topLeading
        case .topTrailing: .topTrailing
        case .bottomLeading: .bottomLeading
        case .bottomTrailing: .bottomTrailing
        }
    }
}

private extension View {
    @ViewBuilder func resizePointer(_ grip: Grip) -> some View {
        if #available(macOS 15, *) { pointerStyle(.frameResize(position: grip.pointerPosition)) } else { self }
    }
}

/// Shows a quick terminal, which outlives this view.
struct QuickTerminalHost: NSViewRepresentable {
    let terminal: GhosttyView
    func makeNSView(context: Context) -> GhosttyView { terminal }
    func updateNSView(_ view: GhosttyView, context: Context) {}
    static func dismantleNSView(_ view: GhosttyView, coordinator: ()) {}
}

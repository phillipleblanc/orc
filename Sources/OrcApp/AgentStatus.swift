import AppKit
import SwiftUI
import OrcKit

/// Agent sessions' status briefs, which the runtime writes from their transcripts; checked every few seconds.
@MainActor final class BriefModel: ObservableObject {
    @Published var briefs: [String: AgentBrief] = [:]
    /// Whether briefs have been read from the runtime at least once.
    @Published var loaded = false
    private var monitor: Task<Void, Never>?

    /// Without `monitor`, briefs are only what is assigned to `briefs`.
    init(monitor: Bool = true) {
        guard monitor else { return }
        self.monitor = Task { [weak self] in
            while !Task.isCancelled {
                await self?.load()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }
    deinit { monitor?.cancel() }

    func load() async {
        guard let result = try? await LocalRPC.call("brief.list"), let briefs = try? AgentBrief.list(from: result) else { return }
        if briefs != self.briefs { self.briefs = briefs }
        if !loaded { loaded = true }
    }

    /// Asks the runtime to write a session's brief now.
    func refresh(_ name: String) async throws {
        let record = try await LocalRPC.call("brief.refresh", ["name": name])
        briefs[name] = try AgentBrief(record: record)
    }

    /// The model briefs are written with, and the models Pi can use.
    static func settings() async throws -> (model: String?, models: [(model: String, name: String)]) {
        let result = try await LocalRPC.call("brief.settings")
        let models = (result["models"] as? [[String: Any]] ?? []).compactMap { entry -> (model: String, name: String)? in
            guard let model = entry["model"] as? String else { return nil }
            return (model, entry["name"] as? String ?? model)
        }
        return (result["model"] as? String, models)
    }

    static func configure(model: String?) async throws {
        _ = try await LocalRPC.call("brief.configure", ["model": model ?? NSNull()])
    }
}

/// When each session was last in view, to tell when its person comes back to it after a while.
struct SessionViewLog {
    /// Coming back to a session after this long, to a newer brief, shows the brief.
    static let away: TimeInterval = 15 * 60
    private static let key = "sessionLastViewed"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func lastViewed(_ name: String) -> Date? {
        (defaults.dictionary(forKey: Self.key)?[name] as? Double).map(Date.init(timeIntervalSince1970:))
    }

    func viewed(_ name: String, at date: Date = .now) {
        var log = defaults.dictionary(forKey: Self.key) ?? [:]
        log[name] = date.timeIntervalSince1970
        defaults.set(log, forKey: Self.key)
    }

    /// Whether a session's brief is worth showing on coming back to it: it was out of view a while, and the brief is
    /// newer than the last look.
    func isReturning(to name: String, brief: AgentBrief, now: Date = .now) -> Bool {
        guard brief.brief != nil, let written = brief.generatedAt else { return false }
        guard let last = lastViewed(name) else { return true }
        return now.timeIntervalSince(last) >= Self.away && written > last
    }
}

/// A brief's sections: goal, progress, what the agent is doing, the next steps, and what it waits on.
struct BriefSections: View {
    let brief: AgentBrief.Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let needsYou = brief.needsYou {
                section("Needs you") {
                    Label { Text(needsYou) } icon: { Image(systemName: "exclamationmark.bubble.fill").foregroundStyle(.orange) }
                }
            }
            section("Goal") { Text(brief.goal) }
            if !brief.progress.isEmpty {
                section("Progress") {
                    ForEach(Array(brief.progress.enumerated()), id: \.offset) { _, item in
                        HStack(alignment: .firstTextBaseline, spacing: 6) { Text("•").foregroundStyle(.secondary); Text(item) }
                    }
                }
            }
            section("Right now") { Text(brief.now) }
            if !brief.next.isEmpty {
                section("Next") {
                    ForEach(Array(brief.next.enumerated()), id: \.offset) { index, step in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("\(index + 1).").monospacedDigit().foregroundStyle(.secondary)
                            Text(step)
                        }
                    }
                }
            }
        }
        .font(.callout)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            content().fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A session's brief with when it was written and a way to write it again.
struct BriefView: View {
    @ObservedObject var briefs: BriefModel
    let name: String
    @State private var error: String?

    private var record: AgentBrief? { briefs.briefs[name] }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text(age).font(.caption).foregroundStyle(.secondary).lineLimit(1).help(record?.model.map { "Written by \($0)" } ?? "")
                Spacer(minLength: 0)
                if record?.generating == true {
                    ProgressView().controlSize(.mini).frame(width: 16, height: 16).help("Writing a newer status…")
                } else {
                    Button { refresh() } label: { Image(systemName: "arrow.clockwise").font(.caption.weight(.semibold)) }
                        .buttonStyle(.borderless).foregroundStyle(.secondary)
                        .help("Write a New Status").accessibilityLabel("Write a New Status")
                }
            }
            if let brief = record?.brief {
                BriefSections(brief: brief)
            } else {
                Text(record?.generating == true ? "Writing the first status…" : "No status yet. Orc writes one after the agent's next turn.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            if let failure = error ?? record?.error {
                Label(failure, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.orange)
                    .lineLimit(4).textSelection(.enabled)
            }
        }
    }

    private var age: String {
        guard let written = record?.generatedAt else { return "Status" }
        return "Status · \(RelativeDateTimeFormatter().localizedString(for: written, relativeTo: .now))"
    }

    private func refresh() {
        error = nil
        Task {
            do { try await briefs.refresh(name) } catch { self.error = error.localizedDescription }
        }
    }
}

/// The floating panel's content: the session's name and its brief.
/// The floating panel's content: the session's name and state, an agent's brief, the session's project and its notes.
struct StatusPanelView: View {
    @ObservedObject var model: SessionModel
    @ObservedObject var briefs: BriefModel
    let name: String
    var close: () -> Void = {}

    private var session: Session? { model.sessions.first { $0.name == name } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header.padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 10)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let session {
                        if session.agentIdentity != nil {
                            // Ages tick by the minute.
                            TimelineView(.everyMinute) { _ in BriefView(briefs: briefs, name: name) }
                            Divider()
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Project").font(.caption).foregroundStyle(.secondary)
                            Text(session.worktreePath).font(.callout).textSelection(.enabled)
                        }
                        if model.hierarchy.parent(of: session) != nil {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Full name").font(.caption).foregroundStyle(.secondary)
                                Text(session.name).font(.callout).textSelection(.enabled)
                            }
                        }
                        SessionNotesEditor(session: session).id(session.name)
                    } else {
                        Text("This session is no longer running.").font(.callout).foregroundStyle(.secondary)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(minWidth: 280, idealWidth: 360, minHeight: 200)
        // The panel's title bar is transparent and hidden; the header takes its place.
        .ignoresSafeArea()
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 8) {
            if let session {
                SessionStatusIcon(session: session, activity: model.activity(for: session), muted: model.isMuted(session))
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(session.map { model.hierarchy.displayName(for: $0) } ?? name).font(.headline).lineLimit(1)
                if let session {
                    Text([session.agentIdentity, model.statusLabel(for: session)].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            Button(action: close) {
                Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary)
                    .frame(width: 22, height: 22).background(Circle().fill(.quaternary))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain).help("Close (Esc)").accessibilityLabel("Close")
        }
    }
}

/// The session in view in a floating translucent panel, which can be dragged anywhere and stays out of the way of
/// typing: it takes keyboard focus only for its notes, and it hides while Orc is in the background.
@MainActor final class StatusPanel: NSObject, NSWindowDelegate {
    static let shared = StatusPanel()
    private var panel: NSPanel?
    /// The session whose brief the panel shows.
    private(set) var name: String?

    var isVisible: Bool { panel?.isVisible == true }

    func show(_ name: String, model: SessionModel, briefs: BriefModel, over window: NSWindow?) {
        let panel = self.panel ?? make()
        self.panel = panel
        self.name = name
        let effect = NSVisualEffectView()
        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active
        let host = NSHostingView(rootView: StatusPanelView(model: model, briefs: briefs, name: name) { [weak self] in self?.close() })
        host.translatesAutoresizingMaskIntoConstraints = false
        effect.addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: effect.leadingAnchor), host.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
            host.topAnchor.constraint(equalTo: effect.topAnchor), host.bottomAnchor.constraint(equalTo: effect.bottomAnchor)
        ])
        panel.contentView = effect
        panel.title = "\(name) Status"
        // Until it is moved, the panel sits at the top right of the window, over the end of the terminal's lines.
        if !panel.setFrameUsingName(Self.frameName), let window {
            let frame = window.frame
            panel.setFrame(NSRect(x: frame.maxX - 380, y: frame.maxY - 620, width: 360, height: 560), display: false)
        }
        panel.orderFront(nil)
    }

    func close() {
        panel?.orderOut(nil)
        name = nil
    }

    private static let frameName = "OrcStatusPanel"

    private func make() -> NSPanel {
        let panel = Panel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 460),
                          styleMask: [.titled, .resizable, .utilityWindow, .fullSizeContentView, .nonactivatingPanel],
                          backing: .buffered, defer: true)
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        // The content's own close button stands in for the title bar's.
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { panel.standardWindowButton(button)?.isHidden = true }
        panel.setFrameAutosaveName(Self.frameName)
        panel.delegate = self
        panel.onClose = { [weak self] in self?.close() }
        return panel
    }

    func windowWillClose(_ notification: Notification) { name = nil }

    private final class Panel: NSPanel {
        var onClose: () -> Void = {}
        override func cancelOperation(_ sender: Any?) { onClose() }
    }
}

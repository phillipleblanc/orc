import SwiftUI
import AppKit
import OrcKit

@main struct OrcApplication: App {
    @NSApplicationDelegateAdaptor(OrcApplicationDelegate.self) private var appDelegate
    @StateObject private var model = SessionModel()
    @StateObject private var board = SessionBoardModel()
    @StateObject private var sidebarOrder = SessionSidebarModel()
    @Environment(\.openWindow) private var openWindow
    var body: some Scene {
        Window("Orc", id: "sessions") { SessionWindow(model: model, sidebarOrder: sidebarOrder, board: board) }
            .defaultSize(width: 1440, height: 936)
            .windowResizability(.contentMinSize)
            .commands {
                CommandGroup(replacing: .newItem) {
                    Button("New Session…") { model.revealWindow?(); model.showCreate = true }.keyboardShortcut("n")
                }
                CommandGroup(after: .newItem) {
                    Button("Open…") { model.revealWindow?(); model.showOpen = true }.keyboardShortcut("k")
                    Button("Session Overview") { openWindow(id: "overview") }
                        .keyboardShortcut("o", modifiers: [.command, .shift])
                    Button("Add Project…") { model.revealWindow?(); model.showProject = true }
                    Button("Pair Phone…") { model.revealWindow?(); model.showPhonePairing = true }
                    Button("Refresh Sessions") { Task { await model.refresh() } }.keyboardShortcut("r")
                    Button("Reopen Closed Session") { model.revealWindow?(); Task { try? await model.reopenLatest() } }
                        .keyboardShortcut("t", modifiers: [.command, .shift]).disabled(model.closed.isEmpty)
                }
            }
        Window("Session Overview", id: "overview") { SessionBoardView(model: model, organization: board) }
            .defaultSize(width: 1120, height: 780)
            .windowResizability(.contentMinSize)
        Settings { SettingsView(model: model) }
    }
}

@MainActor final class OrcApplicationDelegate: NSObject, NSApplicationDelegate {
    override init() {
        super.init()
        _ = IdleNotifications.shared
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationDidFinishLaunching(_ notification: Notification) {
        IdleNotifications.shared.start()
        guard let iconName = Bundle.main.object(forInfoDictionaryKey: "CFBundleIconFile") as? String,
              let url = Bundle.main.url(forResource: iconName, withExtension: "icns"),
              let icon = NSImage(contentsOf: url) else { return }
        NSApplication.shared.applicationIconImage = icon
    }
}

@MainActor final class SessionModel: ObservableObject {
    @Published var sessions: [Session] = [] {
        didSet { hierarchy = SessionHierarchy(sessions: sessions) }
    }
    private(set) var hierarchy = SessionHierarchy(sessions: [])
    @Published var workspaces: [Workspace] = []
    @Published private(set) var activities: [String: AgentActivity] = [:]
    @Published private(set) var unreadKeys: Set<String> = []
    @Published var selected: String?
    @Published var error: String?
    @Published var reviewError: String?
    @Published private(set) var mutes = SessionMutes()
    @Published var showCreate = false
    @Published var showProject = false
    @Published var showPhonePairing = false
    @Published var showOpen = false
    @Published var connected = false
    @Published var loading = false
    @Published private(set) var notificationNavigation = UUID()
    struct AttachmentRequest: Equatable {
        let id = UUID()
        let handle: String
        let incarnation: String?
    }
    @Published var attachmentRequest: AttachmentRequest?
    /// Agent sessions closed in the last week, newest first.
    @Published private(set) var closed: [ClosedSession] = []
    @Published var reopeningAs: ClosedSession?
    let service = SessionService()
    private var closedListedFor: [String]?
    /// Whether the closed sessions have been listed, so names that are neither running nor recently closed are known.
    private var closedLoaded = false
    private var closedListedAt = Date.distantPast
    var revealWindow: (() -> Void)?
    private var reviewState = AgentReviewState()
    private var monitor: Task<Void, Never>?
    private var badgeCount: Int?
    private var badgeTask: Task<Void, Never>?

    init(monitorSessions: Bool = true) {
        guard monitorSessions else { return }
        do { reviewState = try AgentReviewStore.load(); unreadKeys = reviewState.unreadKeys }
        catch { reviewError = "Could not load agent review state: \(error.localizedDescription)" }
        do { mutes = try SessionMuteStore.load() }
        catch { reviewError = "Could not load muted sessions: \(error.localizedDescription)" }
        IdleNotifications.shared.onSelect = { [weak self] target in
            Task { await self?.openNotification(target) }
        }
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }
    deinit { monitor?.cancel() }

    func requestAttachment(to session: Session) {
        attachmentRequest = AttachmentRequest(handle: session.handle, incarnation: session.incarnationId)
    }
    func takeAttachmentRequest() -> Session? {
        guard let request = attachmentRequest else { return nil }
        attachmentRequest = nil
        guard let session = sessions.first(where: { $0.id == request.handle }), session.connected,
              session.incarnationId == request.incarnation else {
            error = "This session is no longer available to attach."
            return nil
        }
        return session
    }

    private func openNotification(_ target: IdleNotifications.Target) async {
        notificationNavigation = UUID()
        let navigation = notificationNavigation
        revealWindow?()
        NSApplication.shared.activate(ignoringOtherApps: true)
        while loading { try? await Task.sleep(for: .milliseconds(50)) }
        await refresh()
        guard navigation == notificationNavigation else { return }
        guard let session = sessions.first(where: { $0.handle == target.handle }),
              target.incarnation == nil || session.incarnationId == target.incarnation else {
            error = "The session from that notification is no longer available."
            return
        }
        selected = session.handle
        revealWindow?()
    }
    func activity(for session: Session) -> AgentActivity {
        reviewState.activity(for: session, base: session.connected ? activities[session.handle] ?? .unknown : .offline)
    }
    func markRead(_ session: Session) {
        let previous = reviewState
        reviewState.markRead(session)
        if reviewState != previous { updateReviewState() }
    }
    private func updateReviewState() {
        unreadKeys = reviewState.unreadKeys
        updateDockBadge()
        do { try AgentReviewStore.save(reviewState); reviewError = nil }
        catch { reviewError = "Could not save agent review state: \(error.localizedDescription)" }
    }
    func isMuted(_ session: Session) -> Bool { mutes.isMuted(session.name) }
    func statusLabel(for session: Session) -> String {
        isMuted(session) ? "Notifications muted · \(activity(for: session).label)" : activity(for: session).label
    }
    func setMuted(_ muted: Bool, for session: Session) {
        var updated = mutes
        updated.set(muted, for: session.name)
        saveMutes(updated)
    }
    /// Renames a session; its notes and its mute follow it.
    func rename(_ session: Session, to name: String) async throws {
        try await service.rename(handle: session.handle, name: name)
        var updated = mutes
        updated.rename(session.name, to: name.trimmingCharacters(in: .whitespacesAndNewlines))
        saveMutes(updated)
    }
    private func saveMutes(_ updated: SessionMutes) {
        guard updated != mutes else { return }
        mutes = updated
        updateDockBadge()
        do { try SessionMuteStore.save(mutes); reviewError = nil }
        catch { reviewError = "Could not save muted sessions: \(error.localizedDescription)" }
    }
    private func updateDockBadge() {
        let count = mutes.unmuted(sessions).filter { activity(for: $0) == .unread }.count
        guard badgeCount != count else { return }
        badgeCount = count
        let previous = badgeTask
        badgeTask = Task {
            await previous?.value
            await IdleNotifications.shared.setBadgeCount(count)
        }
    }
    func refreshDockBadge() {
        badgeCount = nil
        updateDockBadge()
    }
    func refresh() async {
        guard !loading else { return }; loading = true; defer { loading = false }
        do {
            async let listing = service.list()
            async let spaces = service.workspaces()
            let result = try await listing
            async let activity = service.activities(for: result.terminals)
            workspaces = try await spaces
            connected = true
            sessions = result.terminals
            activities = await activity
            let previous = reviewState
            let completed = reviewState.update(sessions: sessions, activities: activities, pruneMissing: !result.truncated)
            if reviewState != previous { updateReviewState() }
            updateDockBadge()
            for session in mutes.unmuted(completed) {
                Task { await IdleNotifications.shared.postIdle(session) }
            }
            await refreshClosed()
            if !result.truncated, closedLoaded {
                var pruned = mutes
                pruned.prune(keeping: Set(sessions.map(\.name) + closed.map(\.name)))
                saveMutes(pruned)
            }
            error = result.truncated ? "The runtime returned \(sessions.count) of \(result.totalCount) sessions." : nil
            if let selected, !sessions.contains(where: { $0.id == selected }) { self.selected = nil }
        } catch {
            connected = false
            self.error = error.localizedDescription
            activities = [:]
            let previous = reviewState
            reviewState.resetCycles()
            if reviewState != previous { updateReviewState() }
            updateDockBadge()
        }
    }
}

extension SessionModel {
    /// Lists closed sessions again when the running sessions change, and every 30 seconds for their ages.
    fileprivate func refreshClosed() async {
        let names = sessions.map(\.name).sorted()
        guard names != closedListedFor || Date().timeIntervalSince(closedListedAt) > 30 else { return }
        closedListedFor = names; closedListedAt = Date()
        if let listed = try? await service.closedSessions() { closed = listed; closedLoaded = true }
    }
    /// Reopens a closed agent session, resuming its conversation, and attaches to it.
    func reopen(_ session: ClosedSession, as name: String? = nil) async throws {
        let reopened = try await service.reopen(entry: session.entry, as: name)
        closedListedFor = nil
        await refresh()
        if let session = sessions.first(where: { $0.handle == reopened.handle }) { requestAttachment(to: session) }
    }
    /// Opens an agent conversation in a new session, or switches to the session that has it open, and attaches.
    func open(_ conversation: AgentConversation, as name: String? = nil) async throws {
        let opened = try await service.open(conversation: conversation.id, as: name)
        closedListedFor = nil
        await refresh()
        if let session = sessions.first(where: { $0.handle == opened.handle }) { requestAttachment(to: session) }
    }
    /// Ends the session; an agent session joins the recently closed sessions.
    func close(_ session: Session) async throws {
        try await service.close(handle: session.handle)
        closedListedFor = nil
        await refresh()
    }
    func reopenLatest() async throws {
        guard let latest = closed.first else { return }
        do { try await reopen(latest) } catch { reopeningAs = latest; throw error }
    }
}

/// What the session window shows in place of a terminal.
enum SessionPlaceholder: Equatable {
    /// Nothing until the first listing, so the window does not flash a state that the listing replaces.
    case loading
    case runtimeNotConnected, offline(String), noProjects, noSessions, noSelection
}

struct SessionWindow: View {
    @ObservedObject var model: SessionModel
    @ObservedObject var sidebarOrder: SessionSidebarModel
    @ObservedObject var board: SessionBoardModel
    @ObservedObject private var notifications = IdleNotifications.shared
    @ObservedObject private var ghostty = GhosttyEngine.shared
    @Environment(\.openWindow) private var openWindow
    @Environment(\.controlActiveState) private var controlActiveState
    @AppStorage("sessionInspectorShown") private var inspectorShown = false
    /// How durable agent sessions show: a chat view's id, or the terminal.
    @AppStorage("durableChatVariant") private var durableView = "durable-1"
    @StateObject private var durableChat = DurableChatModel()
    /// Projects whose sidebar sections are collapsed, by project id, one per line.
    @AppStorage("collapsedSidebarProjects") private var collapsedProjectsStorage = ""
    @State private var renamingSession: Session?
    @State private var closingSession: Session?
    @State private var closeError: String?
    @State private var creatingChildOf: Session?
    @State private var collapsedParents: Set<String> = []
    @State private var terminals = TerminalCache()
    var selected: Session? { model.sessions.first { $0.id == model.selected } }
    /// Whether the selected session is a durable agent, which shows a chat view unless the terminal is chosen.
    var selectedIsDurable: Bool { selected?.agentIdentity == "durable" }
    /// Whether the selected session's terminal is showing.
    var showsTerminal: Bool { selected.map { model.connected && $0.connected } ?? false }
    /// What shows in place of the terminal, or nil while the selected session's terminal shows.
    var placeholder: SessionPlaceholder? {
        if showsTerminal { return nil }
        if !model.connected { return selected != nil || model.error != nil ? .runtimeNotConnected : .loading }
        if let selected { return .offline(selected.name) }
        if model.workspaces.isEmpty { return .noProjects }
        return model.sessions.isEmpty ? .noSessions : .noSelection
    }
    var hierarchy: SessionHierarchy { model.hierarchy }
    var sections: [SessionSidebarSection] {
        sidebarOrder.order.sections(of: model.sessions, workspaces: model.workspaces, collapsed: collapsedParents)
    }
    private var collapsedProjects: Binding<Set<String>> {
        Binding(get: { Set(collapsedProjectsStorage.split(separator: "\n").map(String.init)) },
                set: { collapsedProjectsStorage = $0.sorted().joined(separator: "\n") })
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                sidebar.frame(width: 260)
                Divider()
                detail.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if let error = sidebarOrder.error ?? model.reviewError ?? model.error ?? notifications.warning {
                Divider()
                HStack { Image(systemName: "exclamationmark.triangle"); Text(error).textSelection(.enabled); Spacer() }
                    .font(.callout).foregroundStyle(.orange).padding(12)
                    .background(Color(nsColor: .windowBackgroundColor))
            }
        }
        .frame(minWidth: 900, minHeight: 440)
        .background(TerminalWindowBackground(engine: ghostty, showingTerminal: showsTerminal).allowsHitTesting(false).accessibilityHidden(true))
        .toolbar {
            if selectedIsDurable {
                ToolbarItem {
                    Menu {
                        Picker("View", selection: $durableView) {
                            ForEach(durableChat.variants) { variant in
                                Text(variant.title).tag(variant.id).help(variant.description)
                            }
                            Divider()
                            Text("Terminal").tag(DurableChatModel.terminal)
                        }.pickerStyle(.inline)
                    } label: {
                        Label("View", systemImage: durableView == DurableChatModel.terminal ? "terminal" : "bubble.left.and.text.bubble.right")
                    }
                    .help("Choose how this durable agent shows")
                }
            }
            ToolbarItem {
                Button { openWindow(id: "overview") } label: { Label("Session Overview", systemImage: "square.grid.2x2") }
                    .help("Session Overview (⇧⌘O)").accessibilityIdentifier("session-overview")
            }
            ToolbarItem { Button { model.showCreate = true } label: { Label("New Session", systemImage: "plus") }.help("New Session (⌘N)") }
            ToolbarItem {
                Button { inspectorShown.toggle() } label: { Label("Info", systemImage: "info.circle") }
                    .keyboardShortcut("i", modifiers: [.command, .option])
                    .help(inspectorShown ? "Hide Session Info (⌥⌘I)" : "Show Session Info (⌥⌘I)")
            }
        }
        .sheet(isPresented: $model.showCreate) { CreateSessionView(model: model) }
        .sheet(isPresented: $model.showProject) { AddProjectView(model: model) }
        .sheet(isPresented: $model.showPhonePairing) { PhonePairingView() }
        .sheet(item: $creatingChildOf) { CreateSessionView(model: model, parent: $0) }
        .sheet(item: $renamingSession) { RenameSessionView(model: model, session: $0) }
        .alert("Close “\(closingSession?.name ?? "")”?", isPresented: Binding(get: { closingSession != nil }, set: { if !$0 { closingSession = nil } }),
               presenting: closingSession) { session in
            Button("Close Session", role: .destructive) {
                Task {
                    do { try await model.close(session) }
                    catch { closeError = "Could not close \(session.name): \(error.localizedDescription)" }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { session in
            Text(session.agentIdentity == nil ? "The terminal and everything running in it stop."
                                              : "The agent stops. You can reopen it from Recently Closed.")
        }
        .alert("Could Not Close Session", isPresented: Binding(get: { closeError != nil }, set: { if !$0 { closeError = nil } })) {
            Button("OK") {}
        } message: { Text(closeError ?? "") }
        .sheet(item: $model.reopeningAs) { ReopenSessionView(model: model, closed: $0) }
        .sheet(isPresented: $model.showOpen) { OpenConversationView(model: model) }
        .onChange(of: model.selected) { _, _ in
            if let selected, collapsedProjects.wrappedValue.contains(selected.worktreeId) {
                collapsedProjects.wrappedValue.remove(selected.worktreeId)
            }
            if let selected, let parent = hierarchy.parent(of: selected) { collapsedParents.remove(parent.id) }
            markVisibleOutputRead()
        }
        .onAppear {
            model.revealWindow = { openWindow(id: "sessions") }
            openRequestedAttachment()
        }
        .onChange(of: model.attachmentRequest) { _, _ in openRequestedAttachment() }
        .onChange(of: controlActiveState) { _, _ in markVisibleOutputRead() }
        .onChange(of: model.unreadKeys) { _, _ in markVisibleOutputRead() }
        .onChange(of: showsTerminal) { _, _ in markVisibleOutputRead() }
        .onChange(of: model.sessions) { _, sessions in terminals.keep(sessions) }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            markVisibleOutputRead()
            Task { await notifications.refreshSettings(); model.refreshDockBadge() }
        }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didActivateApplicationNotification)) { _ in markVisibleOutputRead() }
    }
    private var sidebar: some View {
        VStack(spacing: 0) {
            SessionSidebarList(organization: sidebarOrder, sections: sections, collapsedProjects: collapsedProjects,
                               selection: $model.selected) { section, row in
                sessionRow(row.session, name: section.hierarchy.displayName(for: row.session),
                           hasChildren: row.hasChildren, isChild: row.parentID != nil)
            }
            if !model.closed.isEmpty { RecentlyClosedSection(model: model) }
            HStack {
                Text("\(model.sessions.count) session\(model.sessions.count == 1 ? "" : "s")").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button { model.showPhonePairing = true } label: { Image(systemName: "iphone") }
                    .buttonStyle(.borderless).help("Pair Phone").accessibilityLabel("Pair Phone")
            }.padding(12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // A translucent terminal makes the window clear; the sidebar keeps its own background.
        .background(Color(nsColor: .windowBackgroundColor))
    }
    private func sessionRow(_ session: Session, name: String, hasChildren: Bool, isChild: Bool) -> some View {
        SessionSidebarRow(session: session, name: name, activity: model.activity(for: session), muted: model.isMuted(session),
                          group: board.board.group(of: session.name)?.name, labels: board.board.labels(for: session.name).map(\.name),
                          isChild: isChild, childrenCollapsed: hasChildren ? collapsedParents.contains(session.id) : nil) {
            if !collapsedParents.insert(session.id).inserted { collapsedParents.remove(session.id) }
        }
        .accessibilityElement(children: hasChildren ? .contain : .combine)
        .accessibilityValue(model.statusLabel(for: session))
        .help(model.statusLabel(for: session) + " · Drag to reorder")
        .contextMenu {
            if !isChild, hierarchy.canCreateChild(of: session) {
                Button("Create Child…", systemImage: "plus") { creatingChildOf = session }
            }
            Button("Rename Session…", systemImage: "pencil") { renamingSession = session }
            if session.agentIdentity != nil {
                let muted = model.isMuted(session)
                Button(muted ? "Unmute Notifications" : "Mute Notifications", systemImage: muted ? "bell" : "bell.slash") {
                    model.setMuted(!muted, for: session)
                }
            }
            Divider()
            Button("Close Session…", systemImage: "xmark.circle", role: .destructive) { closingSession = session }
        }
    }
    /// The selected session's terminal, or a placeholder in its place, with an inspector beside it.
    private var detail: some View {
        Group {
            if let selected, showsTerminal {
                if selectedIsDurable, durableView != DurableChatModel.terminal {
                    DurableChatHost(session: selected, variant: durableView, model: durableChat)
                } else {
                    TerminalHost(cache: terminals, session: selected)
                }
            } else {
                emptyState.frame(maxWidth: .infinity, maxHeight: .infinity).background(Color(nsColor: .windowBackgroundColor))
            }
        }
        .onChange(of: durableChat.variants) { _, variants in
            // A view the runtime no longer offers falls back to the first one.
            if durableView != DurableChatModel.terminal, let first = variants.first, !variants.contains(where: { $0.id == durableView }) {
                durableView = first.id
            }
        }
        .inspector(isPresented: $inspectorShown) {
            Group {
                if let selected { inspector(selected) }
                else { ContentUnavailableView("No Selection", systemImage: "info.circle").background(Color(nsColor: .windowBackgroundColor)) }
            }
            .inspectorColumnWidth(min: 240, ideal: 300, max: 440)
        }
    }
    @ViewBuilder private var emptyState: some View {
        switch placeholder {
        case .runtimeNotConnected:
            ContentUnavailableView("Runtime Not Connected", systemImage: "bolt.horizontal.circle",
                                   description: Text("Orc is reconnecting to the session runtime."))
        case .offline(let name):
            ContentUnavailableView("Session Offline", systemImage: "bolt.horizontal.circle",
                                   description: Text("\(name) is not connected. Orc reconnects when it is available."))
        case .noProjects:
            ContentUnavailableView {
                Label("No Projects", systemImage: "folder")
            } description: {
                Text("Add a project to start agents and terminals in it.")
            } actions: {
                Button("Add Project…") { model.showProject = true }
            }
        case .noSessions, .noSelection:
            ContentUnavailableView {
                Label(placeholder == .noSessions ? "No Sessions" : "No Session Selected", systemImage: "terminal")
            } description: {
                Text(placeholder == .noSessions ? "Start an agent or terminal in one of your projects, or open a previous conversation."
                                                : "Choose a session from the list, start a new one, or open a previous conversation.")
            } actions: {
                Button("New Session") { model.showCreate = true }
                Button("Open…") { model.showOpen = true }
            }
        case .loading, nil:
            Color.clear
        }
    }
    private func inspector(_ session: Session) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text(hierarchy.displayName(for: session)).font(.title3.bold()).textSelection(.enabled)
                HStack(spacing: 7) {
                    SessionStatusIcon(session: session, activity: model.activity(for: session), muted: model.isMuted(session))
                        .accessibilityHidden(true)
                    Text(model.statusLabel(for: session))
                }.font(.callout)
                Divider()
                VStack(alignment: .leading, spacing: 6) {
                    Text("Project").font(.caption).foregroundStyle(.secondary)
                    Text(session.worktreePath).font(.callout).textSelection(.enabled)
                }
                if hierarchy.parent(of: session) != nil {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Full name").font(.caption).foregroundStyle(.secondary)
                        Text(session.name).font(.callout).textSelection(.enabled)
                    }
                }
                if let agent = session.agentIdentity {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Agent").font(.caption).foregroundStyle(.secondary)
                        Text(agent).font(.callout)
                    }
                }
                SessionNotesEditor(session: session).id(session.name)
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
    private func openRequestedAttachment() {
        guard let session = model.takeAttachmentRequest() else { return }
        model.selected = session.id
    }
    private func markVisibleOutputRead() {
        guard NSApplication.shared.isActive,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier,
              controlActiveState == .key, let session = selected, showsTerminal,
              model.unreadKeys.contains(session.handle) else { return }
        model.markRead(session)
    }
}

private struct SessionNotesEditor: View {
    let session: Session
    @State private var notes: String
    @State private var error: String?
    @State private var saveFailed = false

    init(session: Session) {
        self.session = session
        _notes = State(initialValue: (try? SessionNotesStore.load(session.name)) ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Notes").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: Binding(get: { notes }, set: { value in
                notes = value
                do { try SessionNotesStore.save(value, for: session.name); error = nil; saveFailed = false }
                catch { self.error = error.localizedDescription; saveFailed = true }
            }))
                .font(.callout)
                .scrollContentBackground(.hidden)
                .padding(8)
                .frame(height: 140)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .textBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(nsColor: .separatorColor)))
                .accessibilityLabel("Session notes")
                .accessibilityIdentifier("session-notes")
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .task(id: session.name) {
            while !Task.isCancelled {
                if !saveFailed {
                    do {
                        let saved = try SessionNotesStore.load(session.name)
                        if saved != notes { notes = saved }
                        error = nil
                    } catch { self.error = error.localizedDescription }
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
}

/// Makes the window translucent while it shows a terminal whose Ghostty settings ask for it.
struct TerminalWindowBackground: NSViewRepresentable {
    @ObservedObject var engine: GhosttyEngine
    let showingTerminal: Bool
    func makeNSView(context: Context) -> ApplyingView { ApplyingView() }
    func updateNSView(_ view: ApplyingView, context: Context) {
        view.showingTerminal = showingTerminal
        view.apply()
    }
    final class ApplyingView: NSView {
        var showingTerminal = false
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); apply() }
        func apply() {
            guard let window else { return }
            GhosttyEngine.shared.applyWindowBackground(window, showingTerminal: showingTerminal)
        }
    }
}

struct CreateSessionView: View {
    @ObservedObject var model: SessionModel
    var parent: Session? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var workspace = ""
    @State private var agent = "codex"
    @State private var customCommand = ""
    @State private var creating = false
    @State private var showProject = false
    @State private var error: String?
    private var fullName: String {
        guard let parent else { return name.trimmingCharacters(in: .whitespacesAndNewlines) }
        return parent.name + "-" + name.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(parent == nil ? "New Session" : "New Child Session").font(.title2.bold())
            if let parent {
                Text("Create a session grouped under \(parent.name).").foregroundStyle(.secondary)
            } else {
                Text("Start an agent or terminal in a registered project.").foregroundStyle(.secondary)
            }
            Form {
                TextField(parent == nil ? "Name" : "Child name", text: $name).accessibilityIdentifier("session-name")
                if parent != nil, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    LabeledContent("Full name", value: fullName).textSelection(.enabled)
                }
                Picker("Project", selection: $workspace) {
                    Text("Choose a project").tag("")
                    ForEach(model.workspaces) { Text("\($0.name) — \($0.path)").tag("id:" + $0.id) }
                }
                Button("Add Project…") { showProject = true }.disabled(creating)
                Picker("Run", selection: $agent) {
                    Text("Pi").tag("pi"); Text("Codex").tag("codex"); Text("Claude Code").tag("claude")
                    Text("Durable (experimental)").tag("durable")
                    Text("Terminal").tag("terminal"); Text("Custom command").tag("custom")
                }
                if agent == "custom" { TextField("Command", text: $customCommand) }
            }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(creating)
                Button(creating ? "Creating…" : parent == nil ? "Create Session" : "Create Child") { Task { await create() } }
                    .keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
                    .disabled(creating || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                              fullName.utf8.count > 200 || workspace.isEmpty || (agent == "custom" && customCommand.isEmpty))
            }
        }.padding(24).frame(width: 550)
        .sheet(isPresented: $showProject) {
            AddProjectView(model: model) { project in workspace = "id:" + project.id }
        }
        .onAppear {
            do {
                let config = try OrcConfiguration.load()
                agent = config.defaultSessionType.rawValue
                let project: Workspace
                if let parent {
                    guard let matching = model.workspaces.first(where: { $0.id == parent.worktreeId }) else {
                        throw OrcError("The parent session's project is no longer available. Choose another project.")
                    }
                    project = matching
                } else {
                    project = try SessionCreationDefaults.project(config.defaultProject, in: model.workspaces)
                }
                workspace = "id:" + project.id
            } catch { self.error = error.localizedDescription }
        }
        .onChange(of: workspace) { _, project in
            if !project.isEmpty { error = nil }
        }
    }
    func create() async {
        creating = true; defer { creating = false }
        do {
            let sessionName: String
            if let parent {
                let liveSessions = try await model.service.list().terminals
                guard let current = liveSessions.first(where: { $0.handle == parent.handle }),
                      SessionHierarchy(sessions: liveSessions).canCreateChild(of: current) else {
                    throw OrcError("This session can no longer be a parent or its name is ambiguous. Refresh or rename it first.")
                }
                sessionName = try SessionHierarchy.childName(parent: current, suffix: name)
            } else {
                sessionName = name
            }
            let handle = try await model.service.create(name: sessionName, worktree: workspace,
                command: agent == "custom" ? customCommand : SessionType(rawValue: agent)?.command)
            await model.refresh(); model.selected = handle; dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

struct RenameSessionView: View {
    @ObservedObject var model: SessionModel
    let session: Session
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @State private var name: String
    @State private var saving = false
    @State private var error: String?
    init(model: SessionModel, session: Session) {
        self.model = model; self.session = session
        _name = State(initialValue: session.name)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Rename Session").font(.title2.bold())
            Text("Use the full name. A parent-name prefix groups this session in Orc's sidebar.")
                .font(.callout).foregroundStyle(.secondary)
            TextField("Name", text: $name).textFieldStyle(.roundedBorder)
                .accessibilityLabel("Session name").focused($focused).disabled(saving)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(saving)
                Button(saving ? "Renaming…" : "Rename") { Task { await rename() } }
                    .keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
                    .disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 380).interactiveDismissDisabled(saving)
        .onAppear { focused = true }
    }
    private func rename() async {
        saving = true; defer { saving = false }
        do {
            try await model.rename(session, to: name)
            await model.refresh(); dismiss()
        } catch { self.error = error.localizedDescription }
    }
}


import SwiftUI
import AppKit
import OrcKit

@main struct OrcApplication: App {
    @NSApplicationDelegateAdaptor(OrcApplicationDelegate.self) private var appDelegate
    @StateObject private var model = SessionModel()
    var body: some Scene {
        Window("Orc", id: "sessions") { SessionWindow(model: model) }
            .defaultSize(width: 380, height: 560)
            .windowResizability(.contentMinSize)
            .commands {
                CommandGroup(replacing: .newItem) {
                    Button("New Session…") { model.revealWindow?(); model.showCreate = true }.keyboardShortcut("n")
                }
                CommandGroup(after: .newItem) { Button("Refresh Sessions") { Task { await model.refresh() } }.keyboardShortcut("r") }
            }
        Settings { ConnectionView().frame(width: 480) }
    }
}

@MainActor final class OrcApplicationDelegate: NSObject, NSApplicationDelegate {
    override init() {
        super.init()
        SessionNotesStore.migrateLegacyPreferences()
        _ = IdleNotifications.shared
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationDidFinishLaunching(_ notification: Notification) {
        IdleNotifications.shared.start()
        guard let url = Bundle.main.url(forResource: "Orc", withExtension: "icns"),
              let icon = NSImage(contentsOf: url) else { return }
        NSApplication.shared.applicationIconImage = icon
    }
}

@MainActor final class SessionModel: ObservableObject {
    @Published var sessions: [Session] = []
    private(set) var hierarchy = SessionHierarchy(sessions: [])
    @Published var workspaces: [Workspace] = []
    @Published var chatTargets: [String: ChatTarget] = [:]
    @Published private(set) var activities: [String: AgentActivity] = [:]
    @Published private(set) var unreadKeys: Set<String> = []
    @Published var selected: String?
    @Published var error: String?
    @Published var reviewError: String?
    @Published var showCreate = false
    @Published var showConnection = false
    @Published var connected = Pairing.isConfigured
    @Published var loading = false
    @Published private(set) var notificationNavigation = UUID()
    let service = SessionService()
    var revealWindow: (() -> Void)?
    private var reviewState = AgentReviewState()
    private var monitor: Task<Void, Never>?
    private var badgeCount: Int?
    private var badgeTask: Task<Void, Never>?

    init() {
        do { reviewState = try AgentReviewStore.load(); unreadKeys = reviewState.unreadKeys }
        catch { reviewError = "Could not load agent review state: \(error.localizedDescription)" }
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
    private func updateDockBadge() {
        let count = Set(sessions.filter { activity(for: $0) == .unread }.map(\.notesKey)).count
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
        connected = Pairing.isConfigured
        do {
            async let listing = service.list()
            async let spaces = service.workspaces()
            async let tabs = try? LocalRPC.call("session.tabs.listAll")
            let result = try await listing
            async let activity = service.activities(for: result.terminals)
            workspaces = try await spaces
            hierarchy = SessionHierarchy(sessions: result.terminals)
            sessions = result.terminals
            chatTargets = ChatTarget.targets(in: await tabs ?? [:])
            activities = await activity
            let previous = reviewState
            let completed = reviewState.update(sessions: sessions, activities: activities, pruneMissing: !result.truncated)
            if reviewState != previous { updateReviewState() }
            updateDockBadge()
            for session in completed {
                Task { await IdleNotifications.shared.postIdle(session) }
            }
            error = result.truncated ? "Orca returned \(sessions.count) of \(result.totalCount) sessions." : nil
            if let selected, !sessions.contains(where: { $0.id == selected }) { self.selected = nil }
        } catch {
            self.error = error.localizedDescription
            activities = [:]
            let previous = reviewState
            reviewState.resetCycles()
            if reviewState != previous { updateReviewState() }
            updateDockBadge()
        }
    }
}

enum SessionWindowMode: Equatable {
    case compact, details, attached, chat
    var size: NSSize {
        switch self {
        case .compact: return NSSize(width: 380, height: 560)
        case .details: return NSSize(width: 760, height: 700)
        case .attached: return NSSize(width: 1200, height: 780)
        case .chat: return NSSize(width: 1060, height: 780)
        }
    }
    var minimumWidth: CGFloat { self == .compact ? 340 : self == .details ? 680 : 900 }
}

struct SessionWindow: View {
    @ObservedObject var model: SessionModel
    @ObservedObject private var notifications = IdleNotifications.shared
    @Environment(\.openWindow) private var openWindow
    @Environment(\.controlActiveState) private var controlActiveState
    @AppStorage("autoAttachSessions") private var autoAttachSessions = false
    @State private var search = ""
    @State private var copied = false
    @State private var attachedSession: String?
    @State private var pendingAttach: String?
    @State private var chatSession: String?
    @State private var pendingChat: String?
    @State private var chatDrafts: [String: String] = [:]
    @State private var terminalGeneration = UUID()
    @State private var renamingSession: Session?
    @State private var creatingChildOf: Session?
    @State private var collapsedParents: Set<String> = []
    var selected: Session? { model.sessions.first { $0.id == model.selected } }
    var attached: Bool { selected != nil && attachedSession == selected?.id }
    var chatting: Bool { selected != nil && chatSession == selected?.id }
    var mode: SessionWindowMode { selected == nil ? .compact : attachedSession != nil ? .attached : chatSession != nil ? .chat : .details }
    var hierarchy: SessionHierarchy { model.hierarchy }
    var visibleGroups: [SessionHierarchy.Group] { hierarchy.matching(search) }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                sidebar.frame(width: selected == nil ? nil : 260)
                if let selected {
                    Divider()
                    detail(selected).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            if let error = model.reviewError ?? model.error ?? notifications.warning {
                Divider()
                HStack { Image(systemName: "exclamationmark.triangle"); Text(error).textSelection(.enabled); Spacer() }
                    .font(.callout).foregroundStyle(.orange).padding(12)
            }
        }
        .frame(minWidth: mode.minimumWidth, minHeight: 440)
        .background(SessionWindowSizer(mode: mode).allowsHitTesting(false).accessibilityHidden(true))
        .toolbar { ToolbarItem { Button { model.showCreate = true } label: { Label("New Session", systemImage: "plus") }.help("New Session (⌘N)") } }
        .sheet(isPresented: $model.showCreate) { CreateSessionView(model: model) }
        .sheet(item: $creatingChildOf) { CreateSessionView(model: model, parent: $0) }
        .sheet(item: $renamingSession) { RenameSessionView(model: model, session: $0) }
        .sheet(isPresented: $model.showConnection, onDismiss: {
            model.connected = Pairing.isConfigured
            if pendingAttach == model.selected, pendingAttach != nil, model.connected { attachedSession = pendingAttach }
            if pendingChat == model.selected, pendingChat != nil, model.connected { chatSession = pendingChat }
            pendingAttach = nil
            pendingChat = nil
        }) { ConnectionView().frame(width: 500) }
        .onChange(of: model.selected) { previous, _ in
            let wasAttached = attachedSession != nil && attachedSession == previous && model.connected
                && model.sessions.contains { $0.id == previous && $0.connected }
            chatSession = nil; copied = false; pendingAttach = nil; pendingChat = nil
            if let selected, let parent = hierarchy.parent(of: selected) { collapsedParents.remove(parent.id) }
            if (autoAttachSessions || wasAttached), let session = selected, session.connected { attach(session) }
            else { attachedSession = nil }
        }
        .onAppear { model.revealWindow = { openWindow(id: "sessions") } }
        .onChange(of: model.notificationNavigation) { _, _ in search = "" }
        .onChange(of: controlActiveState) { _, _ in markVisibleOutputRead() }
        .onChange(of: model.unreadKeys) { _, _ in markVisibleOutputRead() }
        .onChange(of: attachedSession) { _, _ in markVisibleOutputRead() }
        .onChange(of: chatSession) { _, _ in markVisibleOutputRead() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            markVisibleOutputRead()
            Task { await notifications.refreshSettings(); model.refreshDockBadge() }
        }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didActivateApplicationNotification)) { _ in markVisibleOutputRead() }
    }
    private var sidebar: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Sessions").font(.title2.bold())
                Spacer()
            }.padding(.horizontal, 16).padding(.top, 12)
            TextField("Find a session", text: $search).textFieldStyle(.roundedBorder)
                .accessibilityLabel("Find a session").padding(12)
            List(selection: $model.selected) {
                ForEach(visibleGroups) { group in
                    sessionRow(group.session, name: group.session.name,
                               hasChildren: !group.children.isEmpty, isChild: false)
                    if !collapsedParents.contains(group.id) || !search.isEmpty {
                        ForEach(group.children) { child in
                            sessionRow(child, name: hierarchy.displayName(for: child),
                                       hasChildren: false, isChild: true)
                        }
                    }
                }
            }.listStyle(.sidebar)
            if model.sessions.isEmpty, !model.loading {
                Text("Create a session with + or ⌘N.").font(.callout).foregroundStyle(.secondary).padding()
            }
            HStack {
                Text("\(model.sessions.count) sessions").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Toggle(isOn: $autoAttachSessions) {
                    Image(systemName: autoAttachSessions ? "bolt.fill" : "bolt.slash")
                }
                    .toggleStyle(.button).controlSize(.small)
                    .tint(autoAttachSessions ? .accentColor : .gray)
                    .help(autoAttachSessions ? "Auto-attach on: selecting a session opens its terminal" :
                            "Auto-attach off: selecting a session shows its details")
                    .accessibilityLabel("Auto-attach sessions")
                    .accessibilityValue(autoAttachSessions ? "On" : "Off")
                    .accessibilityIdentifier("auto-attach-toggle")
                Button { model.showConnection = true } label: { Image(systemName: model.connected ? "link" : "link.badge.plus") }
                    .buttonStyle(.borderless).help("Connection Settings").accessibilityLabel("Connection Settings")
                Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).help("Refresh Sessions").accessibilityLabel("Refresh Sessions")
            }.padding(12)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private func sessionRow(_ session: Session, name: String, hasChildren: Bool, isChild: Bool) -> some View {
        HStack(spacing: 6) {
            if isChild { Color.clear.frame(width: 16, height: 16).accessibilityHidden(true) }
            if hasChildren {
                Button {
                    if !collapsedParents.insert(session.id).inserted { collapsedParents.remove(session.id) }
                } label: {
                    Image(systemName: collapsedParents.contains(session.id) && search.isEmpty ? "chevron.right" : "chevron.down")
                        .font(.caption.weight(.semibold)).frame(width: 16, height: 16)
                }
                .buttonStyle(.plain)
                .disabled(!search.isEmpty)
                .accessibilityLabel("\(collapsedParents.contains(session.id) && search.isEmpty ? "Expand" : "Collapse") children of \(session.name)")
            } else {
                Color.clear.frame(width: 16, height: 16).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 7) {
                    AgentActivityIndicator(activity: model.activity(for: session)).accessibilityHidden(true)
                    Text(name).font(.headline).lineLimit(1)
                }
                Text(URL(fileURLWithPath: session.worktreePath).lastPathComponent).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 5).tag(session.id)
        .accessibilityElement(children: hasChildren ? .contain : .combine)
        .accessibilityValue(model.activity(for: session).label)
        .help(model.activity(for: session).label)
        .contextMenu {
            if !isChild, hierarchy.canCreateChild(of: session) {
                Button("Create Child…", systemImage: "plus") { creatingChildOf = session }
            }
            Button("Rename Session…", systemImage: "pencil") { renamingSession = session }
            Divider()
            Button("Copy Attach Command") { copy(session) }
        }
    }
    @ViewBuilder private func detail(_ session: Session) -> some View {
        if chatting, model.connected {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Button { chatSession = nil } label: { Label("Close Chat", systemImage: "chevron.left") }
                    Text(hierarchy.displayName(for: session)).font(.headline).lineLimit(1)
                    Spacer()
                    copyButton(session)
                    Button("Attach", systemImage: "terminal") { attach(session) }.disabled(!session.connected)
                }.padding(14)
                Divider()
                ChatView(session: session, draft: Binding(get: { chatDrafts[session.id] ?? "" }, set: { chatDrafts[session.id] = $0 })) {
                    attach(session)
                }.id(session.id)
            }
        } else if attached, model.connected, session.connected {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Button { attachedSession = nil } label: { Label("Detach", systemImage: "rectangle.compress.vertical") }
                    Text(hierarchy.displayName(for: session)).font(.headline).lineLimit(1)
                    Spacer()
                    if model.chatTargets[session.id]?.supported == true {
                        Button("Chat", systemImage: "bubble.left.and.bubble.right") { attachedSession = nil; chatSession = session.id }
                    }
                    copyButton(session)
                    Button { terminalGeneration = UUID() } label: { Image(systemName: "arrow.clockwise") }
                        .help("Reconnect Terminal").accessibilityLabel("Reconnect Terminal")
                }.padding(14)
                Divider()
                GhosttyTerminal(session: session).id(session.id + terminalGeneration.uuidString)
            }
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Button { model.selected = nil } label: { Label("Sessions", systemImage: "chevron.left") }
                        .buttonStyle(.borderless).accessibilityLabel("Back to Session List")
                    Image(systemName: "terminal").font(.system(size: 36)).foregroundStyle(.secondary).padding(.top, 12)
                    Text(hierarchy.displayName(for: session)).font(.title2.bold()).textSelection(.enabled)
                    HStack(spacing: 7) {
                        AgentActivityIndicator(activity: model.activity(for: session)).accessibilityHidden(true)
                        Text(model.activity(for: session).label)
                    }.font(.callout)
                    Divider()
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Project").font(.caption).foregroundStyle(.secondary)
                        Text(session.worktreePath).font(.callout).textSelection(.enabled)
                    }
                    if hierarchy.parent(of: session) != nil {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Orca name").font(.caption).foregroundStyle(.secondary)
                            Text(session.name).font(.callout).textSelection(.enabled)
                        }
                    }
                    if let agent = session.agentIdentity {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Agent").font(.caption).foregroundStyle(.secondary)
                            Text(agent).font(.callout)
                        }
                    }
                    SessionNotesEditor(session: session).id(session.notesKey)
                    Text("Open chat, attach here, or copy the command for Ghostty.").font(.callout).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 10) {
                        copyButton(session)
                        HStack {
                            Button("Open Chat", systemImage: "bubble.left.and.bubble.right") {
                                if Pairing.isConfigured { chatSession = session.id }
                                else { pendingChat = session.id; model.showConnection = true }
                            }.buttonStyle(.borderedProminent).disabled(model.chatTargets[session.id]?.supported != true)
                            Button("Attach", systemImage: "terminal") { attach(session) }.disabled(!session.connected)
                        }
                        if model.chatTargets[session.id]?.supported != true {
                            Text("Chat requires a supported agent with history available to this Orca runtime.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
    private func attach(_ session: Session) {
        chatSession = nil
        if Pairing.isConfigured { attachedSession = session.id }
        else { attachedSession = nil; pendingAttach = session.id; model.showConnection = true }
    }
    private func markVisibleOutputRead() {
        guard NSApplication.shared.isActive,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier,
              controlActiveState == .key, let session = selected,
              attached || chatting, model.connected, session.connected,
              model.unreadKeys.contains(session.notesKey) else { return }
        model.markRead(session)
    }
    private func copyButton(_ session: Session) -> some View {
        Button { copy(session) } label: { Label(copied ? "Copied" : "Copy Attach Command", systemImage: copied ? "checkmark" : "doc.on.doc") }
            .help("Copy a command to paste into Ghostty")
    }
    private func copy(_ session: Session) {
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(session.attachCommand, forType: .string)
        copied = true
        Task { try? await Task.sleep(for: .seconds(2)); copied = false }
    }
}

private struct SessionNotesEditor: View {
    let session: Session
    @State private var notes: String
    @State private var error: String?
    @State private var saveFailed = false

    init(session: Session) {
        self.session = session
        _notes = State(initialValue: (try? SessionNotesStore.load(
            key: session.notesKey, legacyHandle: session.handle,
            legacy: UserDefaults.standard.string(forKey: "sessionNotes.\(session.handle)"))) ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Notes").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: Binding(get: { notes }, set: { value in
                notes = value
                do { try SessionNotesStore.save(value, key: session.notesKey); error = nil; saveFailed = false }
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
        .task(id: session.notesKey) {
            while !Task.isCancelled {
                if !saveFailed {
                    do {
                        let saved = try SessionNotesStore.load(
                            key: session.notesKey, legacyHandle: session.handle,
                            legacy: UserDefaults.standard.string(forKey: "sessionNotes.\(session.handle)"))
                        if saved != notes { notes = saved }
                        error = nil
                    } catch { self.error = error.localizedDescription }
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
}

/// Resize only when moving between list, details and attachment, preserving
/// manual resizing within each mode. The top-left corner stays in place.
struct SessionWindowSizer: NSViewRepresentable {
    let mode: SessionWindowMode
    func makeNSView(context: Context) -> SizingView { SizingView(mode: mode) }
    func updateNSView(_ view: SizingView, context: Context) { view.setMode(mode) }
    final class SizingView: NSView {
        private var mode: SessionWindowMode
        init(mode: SessionWindowMode) { self.mode = mode; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); resize() }
        func setMode(_ mode: SessionWindowMode) {
            guard self.mode != mode else { return }; self.mode = mode
            DispatchQueue.main.async { [weak self] in self?.resize() }
        }
        private func resize() {
            guard let window else { return }
            let size = window.frameRect(forContentRect: NSRect(origin: .zero, size: mode.size)).size
            let screen = window.screen?.visibleFrame ?? window.frame
            let width = min(size.width, screen.width), height = min(size.height, screen.height)
            let x = max(screen.minX, min(window.frame.minX, screen.maxX - width))
            let y = max(screen.minY, min(window.frame.maxY - height, screen.maxY - height))
            window.setFrame(NSRect(x: x, y: y, width: width, height: height), display: true, animate: false)
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
                Text("Start an agent or terminal in an existing Orca project.").foregroundStyle(.secondary)
            }
            Form {
                TextField(parent == nil ? "Name" : "Child name", text: $name).accessibilityIdentifier("session-name")
                if parent != nil, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    LabeledContent("Orca name", value: fullName).textSelection(.enabled)
                }
                Picker("Project", selection: $workspace) {
                    Text("Choose a project").tag("")
                    ForEach(model.workspaces) { Text("\($0.name) — \($0.path)").tag("id:" + $0.id) }
                }
                Picker("Run", selection: $agent) {
                    Text("Pi").tag("pi"); Text("Codex").tag("codex"); Text("Claude Code").tag("claude")
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
                command: agent == "terminal" ? nil : agent == "custom" ? customCommand : agent)
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
            Text("Use the full Orca name. A parent-name prefix groups this session in Orc's sidebar.")
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
            try await model.service.rename(handle: session.handle, name: name)
            await model.refresh(); dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

struct ConnectionView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var link = ""
    @State private var connecting = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Connect to Orca").font(.title2.bold())
            Text("In Orca, open Settings → Remote Orca Servers. Create an access link for this computer and paste it below.")
            Text("Listing and creating sessions use the local Orca runtime. Inline terminals and `orc attach` share this connection.").foregroundStyle(.secondary)
            SecureField("Orca runtime access link", text: $link)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(connecting)
                Button(connecting ? "Connecting…" : "Connect") { Task { await connect() } }
                    .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(link.isEmpty || connecting)
            }
        }.padding(24)
    }
    func connect() async {
        connecting = true; defer { connecting = false }
        do {
            let pairing = try Pairing.parse(link)
            let connection = try StreamConnection(pairing: pairing)
            try await connection.connect(); defer { connection.close() }
            _ = try await connection.request("status.get")
            try pairing.save(); link = ""; dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

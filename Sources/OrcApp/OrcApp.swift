import SwiftUI
import AppKit
import OrcKit

@main struct OrcApplication: App {
    @StateObject private var model = SessionModel()
    var body: some Scene {
        WindowGroup("Orc") { SessionWindow(model: model) }
            .defaultSize(width: 380, height: 560)
            .windowResizability(.contentMinSize)
            .commands {
                CommandGroup(replacing: .newItem) { Button("New Session…") { model.showCreate = true }.keyboardShortcut("n") }
                CommandGroup(after: .newItem) { Button("Refresh Sessions") { Task { await model.refresh() } }.keyboardShortcut("r") }
            }
        Settings { ConnectionView().frame(width: 480) }
    }
}

@MainActor final class SessionModel: ObservableObject {
    @Published var sessions: [Session] = []
    @Published var workspaces: [Workspace] = []
    @Published var selected: String?
    @Published var error: String?
    @Published var showCreate = false
    @Published var showConnection = false
    @Published var connected = Pairing.isConfigured
    @Published var loading = false
    let service = SessionService()
    func refresh() async {
        guard !loading else { return }; loading = true; defer { loading = false }
        connected = Pairing.isConfigured
        do {
            async let listing = service.list()
            async let spaces = service.workspaces()
            let result = try await listing
            workspaces = try await spaces
            sessions = result.terminals
            error = result.truncated ? "Orca returned \(sessions.count) of \(result.totalCount) sessions." : nil
            if let selected, !sessions.contains(where: { $0.id == selected }) { self.selected = nil }
        } catch { self.error = error.localizedDescription }
    }
}

enum SessionWindowMode: Equatable {
    case compact, details, attached
    var size: NSSize {
        switch self {
        case .compact: return NSSize(width: 380, height: 560)
        case .details: return NSSize(width: 760, height: 560)
        case .attached: return NSSize(width: 1200, height: 780)
        }
    }
    var minimumWidth: CGFloat { self == .compact ? 340 : self == .details ? 680 : 900 }
}

struct SessionWindow: View {
    @ObservedObject var model: SessionModel
    @State private var search = ""
    @State private var copied = false
    @State private var attachedSession: String?
    @State private var pendingAttach: String?
    @State private var terminalGeneration = UUID()
    var selected: Session? { model.sessions.first { $0.id == model.selected } }
    var attached: Bool { selected != nil && attachedSession == selected?.id }
    var mode: SessionWindowMode { selected == nil ? .compact : attached ? .attached : .details }
    var filtered: [Session] { model.sessions.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || $0.worktreePath.localizedCaseInsensitiveContains(search) } }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                sidebar.frame(width: selected == nil ? nil : 260)
                if let selected {
                    Divider()
                    detail(selected).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            if let error = model.error {
                Divider()
                HStack { Image(systemName: "exclamationmark.triangle"); Text(error).textSelection(.enabled); Spacer() }
                    .font(.callout).foregroundStyle(.orange).padding(12)
            }
        }
        .frame(minWidth: mode.minimumWidth, minHeight: 440)
        .background(SessionWindowSizer(mode: mode).allowsHitTesting(false).accessibilityHidden(true))
        .toolbar { ToolbarItem { Button { model.showCreate = true } label: { Label("New Session", systemImage: "plus") }.help("New Session (⌘N)") } }
        .sheet(isPresented: $model.showCreate) { CreateSessionView(model: model) }
        .sheet(isPresented: $model.showConnection, onDismiss: {
            model.connected = Pairing.isConfigured
            if pendingAttach == model.selected, pendingAttach != nil, model.connected { attachedSession = pendingAttach }
            pendingAttach = nil
        }) { ConnectionView().frame(width: 500) }
        .onChange(of: model.selected) { _, _ in attachedSession = nil; copied = false; pendingAttach = nil }
        .task {
            while !Task.isCancelled {
                await model.refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }
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
                ForEach(filtered) { session in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 7) {
                            Circle().fill(session.connected ? Color.green : Color.secondary).frame(width: 6, height: 6)
                            Text(session.name).font(.headline).lineLimit(1)
                        }
                        Text(URL(fileURLWithPath: session.worktreePath).lastPathComponent).font(.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 5).tag(session.id)
                    .contextMenu { Button("Copy Attach Command") { copy(session) } }
                }
            }.listStyle(.sidebar)
            if model.sessions.isEmpty, !model.loading {
                Text("Create a session with + or ⌘N.").font(.callout).foregroundStyle(.secondary).padding()
            }
            HStack {
                Text("\(model.sessions.count) sessions").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button { model.showConnection = true } label: { Image(systemName: model.connected ? "link" : "link.badge.plus") }
                    .buttonStyle(.borderless).help("Connection Settings").accessibilityLabel("Connection Settings")
                Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).help("Refresh Sessions").accessibilityLabel("Refresh Sessions")
            }.padding(12)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    @ViewBuilder private func detail(_ session: Session) -> some View {
        if attached, model.connected, session.connected {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Button { attachedSession = nil } label: { Label("Detach", systemImage: "rectangle.compress.vertical") }
                    Text(session.name).font(.headline).lineLimit(1)
                    Spacer()
                    copyButton(session)
                    Button { terminalGeneration = UUID() } label: { Image(systemName: "arrow.clockwise") }
                        .help("Reconnect Terminal").accessibilityLabel("Reconnect Terminal")
                }.padding(14)
                Divider()
                GhosttyTerminal(session: session).id(session.id + terminalGeneration.uuidString)
                HStack {
                    Text("Powered by libghostty").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Text("Ctrl-] detaches · Session stays running in Orca").font(.caption).foregroundStyle(.secondary)
                }.padding(.horizontal, 14).padding(.vertical, 7)
            }
        } else {
            VStack(alignment: .leading, spacing: 20) {
                Button { model.selected = nil } label: { Label("Sessions", systemImage: "chevron.left") }
                    .buttonStyle(.borderless).accessibilityLabel("Back to Session List")
                Image(systemName: "terminal").font(.system(size: 36)).foregroundStyle(.secondary).padding(.top, 12)
                Text(session.name).font(.title2.bold()).textSelection(.enabled)
                Label(session.connected ? "Running in Orca" : "Offline", systemImage: session.connected ? "circle.fill" : "circle")
                    .font(.callout).foregroundStyle(session.connected ? .green : .secondary)
                Divider()
                VStack(alignment: .leading, spacing: 6) {
                    Text("Workspace").font(.caption).foregroundStyle(.secondary)
                    Text(session.worktreePath).font(.callout).textSelection(.enabled)
                }
                if let agent = session.agentIdentity {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Agent").font(.caption).foregroundStyle(.secondary)
                        Text(agent).font(.callout)
                    }
                }
                Spacer()
                Text("Copy the command for Ghostty, or attach here.").font(.callout).foregroundStyle(.secondary)
                HStack(spacing: 10) {
                    copyButton(session)
                    Button("Attach", systemImage: "terminal") {
                        if Pairing.isConfigured { attachedSession = session.id }
                        else { pendingAttach = session.id; model.showConnection = true }
                    }.buttonStyle(.borderedProminent).disabled(!session.connected)
                }
            }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
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
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var workspace = ""
    @State private var agent = "pi"
    @State private var customCommand = ""
    @State private var creating = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("New Session").font(.title2.bold())
            Text("Start an agent or shell in an existing Orca workspace.").foregroundStyle(.secondary)
            Form {
                TextField("Name", text: $name).accessibilityIdentifier("session-name")
                Picker("Workspace", selection: $workspace) {
                    ForEach(model.workspaces) { Text("\($0.name) — \($0.path)").tag("id:" + $0.id) }
                }
                Picker("Run", selection: $agent) {
                    Text("Pi").tag("pi"); Text("Codex").tag("codex"); Text("Claude Code").tag("claude")
                    Text("Shell").tag("shell"); Text("Custom command").tag("custom")
                }
                if agent == "custom" { TextField("Command", text: $customCommand) }
            }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(creating)
                Button(creating ? "Creating…" : "Create Session") { Task { await create() } }
                    .keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
                    .disabled(creating || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || workspace.isEmpty || (agent == "custom" && customCommand.isEmpty))
            }
        }.padding(24).frame(width: 550)
        .onAppear { workspace = model.workspaces.first.map { "id:" + $0.id } ?? "" }
    }
    func create() async {
        creating = true; defer { creating = false }
        do {
            let handle = try await model.service.create(name: name, worktree: workspace, command: agent == "shell" ? nil : agent == "custom" ? customCommand : agent)
            await model.refresh(); model.selected = handle; dismiss()
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

import SwiftUI
import OrcKit

@MainActor final class ChatModel: ObservableObject {
    @Published private(set) var target: ChatTarget?
    @Published private(set) var history = ChatHistory()
    @Published private(set) var connected = false
    @Published private(set) var ready = false
    @Published private(set) var sending = false
    @Published private(set) var loadingEarlier = false
    @Published var error: String?
    let session: Session
    private var connection: StreamConnection?
    private var generation = UUID()
    private var transcriptID: String?
    private let clientID = "orc-chat-" + UUID().uuidString
    init(session: Session) { self.session = session }

    func connect() async {
        disconnect()
        let generation = self.generation
        error = nil
        do {
            let connection = try StreamConnection(pairing: Pairing.load())
            self.connection = connection
            connection.onStreamEvent = { [weak self] id, event in
                guard let self, self.generation == generation else { return }
                if id == "chat-tabs" { self.updateTarget(event) }
                else if id == self.transcriptID {
                    if let error = event["error"] { self.error = String(describing: error) }
                    else if event["type"] as? String == "end" {
                        self.ready = false
                        self.error = "Conversation stream ended. Reconnect Chat to continue."
                    } else if event["pending"] as? Bool != true {
                        self.history.apply(event); self.ready = true
                    }
                }
            }
            connection.onClose = { [weak self] error in
                guard let self, self.generation == generation else { return }
                self.connected = false; self.ready = false
                self.error = "Chat disconnected. \(error?.localizedDescription ?? "Reconnect to continue.")"
            }
            try await connection.connect()
            guard self.generation == generation, !Task.isCancelled else { connection.close(); return }
            connected = true
            try await connection.subscribe("session.tabs.subscribe", ["worktree": "id:" + session.worktreeId], id: "chat-tabs")
        } catch {
            guard self.generation == generation else { return }
            self.error = error.localizedDescription; connected = false
        }
    }
    func disconnect() {
        generation = UUID(); connected = false; ready = false
        transcriptID = nil; target = nil
        connection?.close(); connection = nil
    }
    private func updateTarget(_ event: [String: Any]) {
        let next = ChatTarget.targets(in: event)[session.handle]
        let oldIdentity = target?.identity
        target = next
        guard next?.identity != oldIdentity || (next?.identity != nil && transcriptID == nil) else { return }
        let previous = transcriptID
        let id = "chat-transcript-" + UUID().uuidString
        transcriptID = id; ready = false
        if let identity = next?.identity { history.bind(to: identity) }
        guard let connection else { return }
        Task {
            do {
                if let previous { _ = try await connection.request("nativeChat.unsubscribe", ["subscriptionId": previous]) }
                guard self.transcriptID == id, let next, next.identity != nil else { return }
                var params = next.params
                params["subscriptionId"] = id
                params["capabilities"] = ["transcriptPending": 1]
                try await connection.subscribe("nativeChat.subscribe", params, id: id)
            } catch {
                if self.transcriptID == id { self.error = error.localizedDescription }
            }
        }
    }
    func loadEarlier() async {
        guard connected, ready, !loadingEarlier, let connection, let target, target.identity != nil,
              let offset = history.beforeOffset else { return }
        loadingEarlier = true; defer { loadingEarlier = false }
        let id = transcriptID
        do {
            var params = target.params; params["beforeOffset"] = offset
            let page = try await connection.request("nativeChat.readSession", params)
            if transcriptID == id { try history.prepend(page) }
        } catch { if transcriptID == id { self.error = error.localizedDescription } }
    }
    func send(_ text: String) async -> Bool {
        guard !sending, connected, ready, let connection, let target else { return false }
        sending = true; defer { sending = false }
        let generation = self.generation
        do {
            let current = try await checkedTarget(target)
            try await ChatWriter.send(text, target: current, connection: connection, clientID: clientID)
            if self.generation == generation { error = nil }
            return true
        } catch {
            if self.generation == generation { self.error = error.localizedDescription }
            return false
        }
    }
    func stop() async {
        guard !sending, connected, let connection, let target else { return }
        sending = true; defer { sending = false }
        let generation = self.generation
        do {
            let current = try await checkedTarget(target)
            try await ChatWriter.stop(target: current, connection: connection, clientID: clientID)
            if self.generation == generation { error = nil }
        } catch { if self.generation == generation { self.error = error.localizedDescription } }
    }
    private func checkedTarget(_ expected: ChatTarget) async throws -> ChatTarget {
        let response = try await LocalRPC.call("session.tabs.list", ["worktree": "id:" + session.worktreeId])
        guard let current = ChatTarget.targets(in: response)[session.handle], current.identity == expected.identity, current.canSend else {
            throw OrcError("The agent changed or needs attention. Check its terminal before sending.")
        }
        return current
    }
}

struct ChatView: View {
    @StateObject private var model: ChatModel
    @Binding private var draft: String
    @State private var followLatest = true
    let attach: () -> Void
    init(session: Session, draft: Binding<String>, attach: @escaping () -> Void) {
        _model = StateObject(wrappedValue: ChatModel(session: session)); _draft = draft; self.attach = attach
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                AgentActivityIndicator(activity: model.connected ? model.target?.activity ?? .unknown : .offline)
                Text(status).font(.callout).foregroundStyle(.secondary)
                Spacer()
                Toggle("Follow latest", isOn: $followLatest).toggleStyle(.checkbox).font(.caption)
                Button { Task { await model.connect() } } label: { Image(systemName: "arrow.clockwise") }
                    .help("Reconnect Chat").accessibilityLabel("Reconnect Chat").disabled(model.sending)
            }.padding(.horizontal, 20).padding(.vertical, 10)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 20) {
                        if model.history.hasMore, model.history.beforeOffset != nil {
                            Button(model.loadingEarlier ? "Loading…" : "Load Earlier Messages") {
                                followLatest = false
                                Task { await model.loadEarlier() }
                            }.disabled(model.loadingEarlier || !model.connected || !model.ready).frame(maxWidth: .infinity)
                        }
                        if model.history.messages.isEmpty {
                            ContentUnavailableView(emptyTitle, systemImage: "bubble.left.and.bubble.right", description: Text(emptyDescription))
                                .frame(maxWidth: .infinity).padding(.top, 60)
                        }
                        ForEach(model.history.messages) { ChatMessageView(message: $0) }
                        if model.target?.isWorking == true {
                            Label("Agent is working…", systemImage: "ellipsis.bubble").foregroundStyle(.secondary).font(.callout)
                        }
                        Color.clear.frame(height: 1).id("chat-bottom")
                    }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
                }
                .defaultScrollAnchor(followLatest ? .bottom : nil)
                .onChange(of: model.history.messages) { _, _ in if followLatest { proxy.scrollTo("chat-bottom", anchor: .bottom) } }
            }
            if model.target?.requiresTerminal == true {
                HStack {
                    Label("The agent needs a response in its terminal.", systemImage: "hand.raised")
                    Spacer(); Button("Attach", action: attach)
                }.font(.callout).padding(14).background(.orange.opacity(0.12))
            }
            if let error = model.error {
                HStack(alignment: .top) {
                    Image(systemName: "exclamationmark.triangle")
                    Text(error).textSelection(.enabled)
                    Spacer()
                }.font(.callout).foregroundStyle(.orange).padding(14)
            }
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                TextField("Message the agent…", text: $draft, axis: .vertical)
                    .lineLimit(2...7).textFieldStyle(.plain).font(.body)
                    .accessibilityLabel("Message the agent").padding(10)
                    .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
                    .disabled(!model.connected || model.sending || model.target?.canSend != true || !model.ready)
                HStack {
                    Text("⌘Return to send · Enter for a new line").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    if model.target?.isWorking == true {
                        Button("Stop", systemImage: "stop.fill") { Task { await model.stop() } }
                            .disabled(!model.connected || model.sending || model.target?.canSend != true)
                    }
                    Button(model.sending ? "Sending…" : "Send", systemImage: "arrow.up") {
                        let text = draft
                        Task { if await model.send(text), draft == text { draft = "" } }
                    }.keyboardShortcut(.return, modifiers: .command).buttonStyle(.borderedProminent)
                        .disabled(!model.connected || !model.ready || model.sending || model.target?.canSend != true || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }.padding(16)
        }
        .task { await model.connect() }
        .onDisappear { model.disconnect() }
    }
    private var status: String {
        guard model.connected else { return model.error == nil ? "Connecting to Orca" : "Disconnected" }
        guard let target = model.target else { return "Waiting for session metadata" }
        return (target.agent?.capitalized ?? "Agent") + " · " + target.activity.label
    }
    private var emptyTitle: String {
        if model.target?.supported == false { return "Chat is unavailable for this session" }
        return model.ready ? "Start a conversation" : "Waiting for the agent's conversation"
    }
    private var emptyDescription: String {
        if model.target?.supported == false { return "Use Attach to interact with this agent." }
        if model.target?.agent == "pi", model.target?.identity == nil {
            return "Orca hasn't published this Pi session's local chat history yet. Use Attach to continue in its terminal."
        }
        if model.target?.identity == nil { return "Orca hasn't published this agent's conversation ID yet. Use Attach for startup prompts and terminal access." }
        return "Messages and tool activity appear here. The session stays available in Orca and on your phone."
    }
}

private struct ChatMessageView: View {
    let message: ChatMessage
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(message.role == "user" ? "You" : message.role.capitalized,
                  systemImage: message.role == "user" ? "person.crop.circle" : message.role == "tool" ? "wrench.and.screwdriver" : "sparkle")
                .font(.caption.bold()).foregroundStyle(.secondary)
            ForEach(Array(message.blocks.enumerated()), id: \.offset) { _, block in
                if let diff = block.diff {
                    ChatDiffView(block: block, diff: diff)
                } else if block.type == "text", message.role != "reasoning" {
                    Text((try? AttributedString(markdown: block.body, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(block.body))
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    DisclosureGroup(block.title.isEmpty ? "Reasoning" : block.title) {
                        Text(block.body).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
                    }.foregroundStyle(block.isError ? Color.red : Color.secondary)
                }
            }
        }.padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(message.role == "user" ? Color.accentColor.opacity(0.09) : Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
    }
}

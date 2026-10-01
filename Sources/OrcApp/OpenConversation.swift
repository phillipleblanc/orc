import SwiftUI
import OrcKit

/// Searches recently closed agent sessions and agent conversations, and opens one in Orc.
struct OpenConversationView: View {
    @ObservedObject var model: SessionModel
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focus: Field?
    @State private var query = ""
    @State private var allProjects = false
    @State private var conversations: [AgentConversation] = []
    @State private var searched = false
    @State private var selection: String?
    @State private var naming = false
    @State private var newName = ""
    @State private var opening = false
    @State private var error: String?

    private enum Field { case search, name }
    private enum Item: Identifiable {
        case closed(ClosedSession), conversation(AgentConversation)
        var id: String {
            switch self {
            case .closed(let closed): "closed:\(closed.entry)"
            case .conversation(let conversation): "conversation:\(conversation.agent):\(conversation.id)"
            }
        }
        var suggestedName: String {
            switch self {
            case .closed(let closed): closed.name
            case .conversation(let conversation): conversation.openIn ?? ""
            }
        }
    }
    private struct Search: Equatable { let query: String; let allProjects: Bool }

    private var closedMatches: [ClosedSession] {
        let terms = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        return model.closed.filter { closed in
            let words = [closed.name, closed.agent, closed.cwd, closed.lastMessage ?? ""].joined(separator: "\n").lowercased()
            return terms.allSatisfy { words.contains($0) }
        }
    }
    private var items: [Item] { closedMatches.map(Item.closed) + conversations.map(Item.conversation) }
    private var selected: Item? { items.first { $0.id == selection } ?? items.first }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search recently closed sessions and agent conversations", text: $query)
                    .textFieldStyle(.plain).font(.title3).focused($focus, equals: .search)
                    .onSubmit { open() }
                    .onKeyPress(.downArrow) { move(1); return .handled }
                    .onKeyPress(.upArrow) { move(-1); return .handled }
                    .onKeyPress(.return, phases: .down) { press in
                        guard press.modifiers.contains(.option) else { return .ignored }
                        startNaming(); return .handled
                    }
                    .accessibilityIdentifier("open-search")
                Toggle("All projects", isOn: $allProjects).toggleStyle(.checkbox)
                    .help("Include conversations outside registered projects")
            }.padding(14)
            Divider()
            HStack(spacing: 0) {
                List(selection: $selection) {
                    if !closedMatches.isEmpty {
                        Section("Recently Closed") { ForEach(closedMatches) { closedRow($0).tag(Item.closed($0).id) } }
                    }
                    Section(allProjects ? "Conversations" : "Conversations in Registered Projects") {
                        ForEach(conversations) { conversationRow($0).tag(Item.conversation($0).id) }
                        if conversations.isEmpty, searched {
                            Text(query.isEmpty ? "No conversations." : "No conversations match.").foregroundStyle(.secondary)
                        }
                    }
                }
                .listStyle(.sidebar).frame(width: 380)
                .contextMenu(forSelectionType: String.self, menu: { _ in }) { ids in
                    if let id = ids.first { selection = id; open() }
                }
                Divider()
                ScrollView { preview.padding(16).frame(maxWidth: .infinity, alignment: .topLeading) }
            }
            Divider()
            footer.padding(12)
        }
        .frame(width: 860, height: 540)
        .onAppear { focus = .search }
        .task(id: Search(query: query, allProjects: allProjects)) {
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            do {
                conversations = try await model.service.conversations(query: query, allProjects: allProjects)
                error = nil
            } catch { self.error = error.localizedDescription }
            searched = true
            if selected == nil || !items.contains(where: { $0.id == selection }) { selection = items.first?.id }
        }
    }

    private func closedRow(_ closed: ClosedSession) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(closed.name).lineLimit(1)
                Text([closed.agent, URL(fileURLWithPath: closed.cwd).lastPathComponent, "closed \(closed.age())"].joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        } icon: { Image(systemName: "arrow.uturn.backward.circle") }
    }

    private func conversationRow(_ conversation: AgentConversation) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(firstLine(conversation.displayTitle)).lineLimit(1)
                Text(([conversation.agent, URL(fileURLWithPath: conversation.cwd).lastPathComponent, conversation.age()]
                      + (conversation.openIn.map { ["open in \($0)"] } ?? [])).joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        } icon: { Image(systemName: conversation.openIn == nil ? "text.bubble" : "text.bubble.fill") }
    }

    @ViewBuilder private var preview: some View {
        switch selected {
        case .closed(let closed):
            ClosedSessionPreview(closed: closed)
        case .conversation(let conversation):
            VStack(alignment: .leading, spacing: 12) {
                Text(firstLine(conversation.displayTitle)).font(.headline).textSelection(.enabled)
                Text("\(conversation.agent) · \(conversation.cwd) · updated \(conversation.age())")
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                if let openIn = conversation.openIn {
                    Label("Open in \(openIn). Opening switches to it.", systemImage: "arrow.right.circle").font(.callout)
                }
                if let prompt = conversation.firstPrompt {
                    Text("First prompt").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(prompt).font(.callout).textSelection(.enabled)
                }
                if let reply = conversation.lastMessage {
                    Text("Last reply").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(reply).font(.callout).textSelection(.enabled)
                }
                if conversation.openIn == nil {
                    Text("If this conversation is open in another app or terminal, close it there first.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        case nil:
            Text(searched ? "Nothing to open." : "Searching…").foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var footer: some View {
        HStack(spacing: 12) {
            if naming {
                TextField("Session name", text: $newName).textFieldStyle(.roundedBorder).focused($focus, equals: .name)
                    .onSubmit { open(as: newName) }.frame(width: 260)
                    .onKeyPress(.escape) { naming = false; focus = .search; return .handled }
                Text("↵ Open with this name · esc Back").font(.caption).foregroundStyle(.secondary)
            } else {
                Text("↵ Open in Orc · ⌥↵ Open with a new name · ↑↓ Move · esc Close").font(.caption).foregroundStyle(.secondary)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red).lineLimit(2).textSelection(.enabled) }
            Spacer()
            if opening { ProgressView().controlSize(.small) }
            Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(opening)
        }
    }

    private func move(_ amount: Int) {
        guard !items.isEmpty else { return }
        let index = items.firstIndex { $0.id == selected?.id } ?? 0
        selection = items[min(max(0, index + amount), items.count - 1)].id
    }

    private func startNaming() {
        guard let selected else { return }
        newName = selected.suggestedName
        naming = true; focus = .name
    }

    private func open(as name: String? = nil) {
        guard let item = selected, !opening else { return }
        let name = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        opening = true; error = nil
        Task {
            defer { opening = false }
            do {
                switch item {
                case .closed(let closed): try await model.reopen(closed, as: name?.isEmpty == false ? name : nil)
                case .conversation(let conversation): try await model.open(conversation, as: name?.isEmpty == false ? name : nil)
                }
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }

    private func firstLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
    }
}

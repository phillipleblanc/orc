import SwiftUI
import OrcKit

/// Agent sessions closed in the last week. Clicking one reopens it, resuming its conversation.
struct RecentlyClosedSection: View {
    @ObservedObject var model: SessionModel
    @AppStorage("recentlyClosedExpanded") private var expanded = false
    @State private var previewing: String?
    @State private var hoverTask: Task<Void, Never>?

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(model.closed) { row($0) }
                }
            }.frame(maxHeight: 220)
        } label: {
            Text("Recently Closed (\(model.closed.count))").font(.callout.weight(.semibold)).foregroundStyle(.secondary)
        }
        .accessibilityIdentifier("recently-closed")
        .padding(.horizontal, 16).padding(.top, 8)
    }

    private func row(_ closed: ClosedSession) -> some View {
        HStack(spacing: 7) {
            Image(systemName: "arrow.uturn.backward.circle").foregroundStyle(.secondary).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(closed.name).lineLimit(1)
                Text([closed.agent, URL(fileURLWithPath: closed.cwd).lastPathComponent, closed.age()].joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4).padding(.horizontal, 6)
        .contentShape(Rectangle())
        .onTapGesture { reopen(closed) }
        .onHover { hovering in
            hoverTask?.cancel()
            if hovering {
                hoverTask = Task {
                    try? await Task.sleep(for: .milliseconds(600))
                    if !Task.isCancelled { previewing = closed.id }
                }
            } else if previewing == closed.id { previewing = nil }
        }
        .popover(isPresented: Binding(get: { previewing == closed.id }, set: { if !$0 { previewing = nil } }), arrowEdge: .trailing) {
            ClosedSessionPreview(closed: closed)
        }
        .contextMenu {
            Button("Reopen", systemImage: "arrow.uturn.backward") { reopen(closed) }
            Button("Reopen with New Name…", systemImage: "pencil") { model.reopeningAs = closed }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Reopens the session, resuming its conversation")
    }

    private func reopen(_ closed: ClosedSession) {
        previewing = nil
        Task {
            // A name in use again is the common failure; the sheet asks for another and shows the error.
            do { try await model.reopen(closed) } catch { model.reopeningAs = closed }
        }
    }
}

/// The closed session's last reply and the end of its last screen.
struct ClosedSessionPreview: View {
    let closed: ClosedSession

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(closed.name).font(.headline)
            Text("\(closed.agent) · closed \(closed.age())").font(.caption).foregroundStyle(.secondary)
            if let message = closed.lastMessage, !message.isEmpty {
                Text(message).font(.callout).lineLimit(12).textSelection(.enabled)
            }
            if !closed.screen.isEmpty {
                Divider()
                Text(closed.screen.suffix(15).joined(separator: "\n"))
                    .font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary).lineLimit(15)
            }
        }.padding(14).frame(width: 440, alignment: .leading)
    }
}

struct ReopenSessionView: View {
    @ObservedObject var model: SessionModel
    let closed: ClosedSession
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @State private var name: String
    @State private var reopening = false
    @State private var error: String?
    init(model: SessionModel, closed: ClosedSession) {
        self.model = model; self.closed = closed
        _name = State(initialValue: closed.name)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Reopen Session").font(.title2.bold())
            Text("Reopens \(closed.name) and resumes its \(closed.agent) conversation under this name.")
                .font(.callout).foregroundStyle(.secondary)
            TextField("Name", text: $name).textFieldStyle(.roundedBorder)
                .accessibilityLabel("Session name").focused($focused).disabled(reopening)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(reopening)
                Button(reopening ? "Reopening…" : "Reopen") { Task { await reopen() } }
                    .keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
                    .disabled(reopening || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 380).interactiveDismissDisabled(reopening)
        .onAppear { focused = true }
        .task {
            // Explains why the sheet opened when reopening under the session's own name failed.
            if model.sessions.contains(where: { $0.name == closed.name }) {
                error = "A session named \(closed.name) is running. Choose another name."
            }
        }
    }
    private func reopen() async {
        reopening = true; defer { reopening = false }
        do {
            try await model.reopen(closed, as: name)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

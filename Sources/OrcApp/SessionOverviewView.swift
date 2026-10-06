import AppKit
import SwiftUI
import OrcKit

/// The runtime's agents with who spawned them, their queues, time in state and wakes; checked every few seconds while
/// the overview shows.
@MainActor final class OverviewAgents: ObservableObject {
    @Published var agents: [String: AgentSummary] = [:]
    private var task: Task<Void, Never>?

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                await self?.load()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    private func load() async {
        guard let result = try? await LocalRPC.call("agent.list"), let agents = try? AgentSummary.list(from: result) else { return }
        if agents != self.agents { self.agents = agents }
    }
}

/// Every session at a glance, sorted by what it needs: agents waiting on their person, then working, then idle. A
/// session's card carries the agents it spawned and its named children, and an agent's status brief.
struct SessionOverviewView: View {
    @ObservedObject var model: SessionModel
    @ObservedObject var briefs: BriefModel
    @ObservedObject var usage: UsageModel
    @ObservedObject var agents: OverviewAgents
    /// Whether it checks the runtime's agents while it shows; off in tests.
    var monitor = true

    init(model: SessionModel, briefs: BriefModel, usage: UsageModel, agents: OverviewAgents, monitor: Bool = true, selected: String? = nil) {
        self.model = model; self.briefs = briefs; self.usage = usage; self.agents = agents; self.monitor = monitor
        _selected = State(initialValue: selected)
    }
    @Environment(\.openWindow) private var openWindow
    @State private var search = ""
    /// The selected session's name.
    @State private var selected: String?
    /// The session a reply is being written to.
    @State private var replying: String?
    /// Whether the keyboard shortcuts show over the board.
    @State private var showingShortcuts = false
    /// When each session was last marked read here, which acknowledges what its brief says it waits on.
    @State private var acknowledged = OverviewAcknowledgements.load()
    /// Why asking for a session's new status failed.
    @State private var refreshErrors: [String: String] = [:]
    @FocusState private var boardFocused: Bool

    private var lanes: [(lane: OverviewLane, families: [OverviewFamily])] {
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        let sessions = model.sessions.filter { session in
            guard !query.isEmpty else { return true }
            let brief = briefs.briefs[session.name]?.brief
            return [session.name, session.worktreePath, session.agentIdentity ?? "terminal", brief?.headline ?? "", brief?.goal ?? "", brief?.now ?? ""]
                .contains { $0.lowercased().contains(query) }
        }
        let activities = Dictionary(model.sessions.map { ($0.handle, model.activity(for: $0)) }, uniquingKeysWith: { first, _ in first })
        return SessionOverview.arrange(sessions: sessions, activities: activities, agents: agents.agents, briefs: briefs.briefs,
                                       hierarchy: model.hierarchy, acknowledged: acknowledged)
    }

    var body: some View {
        let lanes = self.lanes
        let order = lanes.flatMap { $0.families.flatMap(\.items) }.map(\.session.name)
        VStack(spacing: 0) {
            if lanes.isEmpty {
                ContentUnavailableView(model.sessions.isEmpty ? "No Sessions" : "No Matching Sessions", systemImage: "rectangle.stack",
                                       description: Text(model.sessions.isEmpty ? "Sessions you create appear here." : "Try another project or search."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 24) {
                            ForEach(lanes, id: \.lane) { lane in section(lane.lane, lane.families) }
                        }
                        .padding(20)
                    }
                    .background(Color(nsColor: .underPageBackgroundColor))
                    .focusable()
                    .focused($boardFocused)
                    .focusEffectDisabled()
                    .onKeyPress { press in key(press, order: order) }
                    .overlay {
                        if showingShortcuts {
                            OverviewShortcuts().onTapGesture { showingShortcuts = false }
                        }
                    }
                    .onChange(of: selected) { _, name in
                        guard let name, let family = lanes.flatMap(\.families).first(where: { $0.items.contains { $0.session.name == name } }) else { return }
                        withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(family.id) }
                    }
                }
            }
        }
        .frame(minWidth: 640, minHeight: 440)
        .navigationTitle("Session Overview")
        .navigationSubtitle(counts(lanes))
        .searchable(text: $search, placement: .toolbar, prompt: "Find sessions")
        .toolbar {
            ToolbarItem { UsageSummary(usage: usage).padding(.horizontal, 6) }
        }
        .onAppear {
            if monitor { agents.start() }
            boardFocused = true
        }
        .onDisappear { agents.stop() }
        // Keys work on the board again once a reply is sent or cancelled.
        .onChange(of: replying) { _, name in if name == nil { boardFocused = true } }
        .onChange(of: model.sessions) { _, sessions in
            if let selected, !sessions.contains(where: { $0.name == selected }) { self.selected = nil }
        }
    }

    /// How many sessions need you, work and idle; each counts by its own state, wherever its card sits.
    private func counts(_ lanes: [(lane: OverviewLane, families: [OverviewFamily])]) -> String {
        let items = lanes.flatMap { $0.families.flatMap(\.items) }
        let counts = OverviewLane.allCases.compactMap { lane in
            let count = items.filter { $0.lane == lane }.count
            return count == 0 ? nil : "\(count) \(lane.title.lowercased())"
        }
        return counts.isEmpty ? "No sessions" : counts.joined(separator: " · ")
    }

    private func section(_ lane: OverviewLane, _ families: [OverviewFamily]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(lane.title).font(.headline)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 360), spacing: 14, alignment: .top)], alignment: .leading, spacing: 14) {
                ForEach(families) { family in
                    FamilyCard(family: family, model: model, selected: $selected, replying: $replying, refreshErrors: refreshErrors, open: open)
                        .id(family.id)
                }
            }
        }
    }

    enum KeyAction: Equatable { case next, previous, open, reply, refreshStatus, markRead, shortcuts, close }

    /// What a key does on the board. While a reply is being written, keys go to its field, which sits inside the board.
    static func keyAction(_ key: KeyEquivalent, characters: String, replying: Bool) -> KeyAction? {
        guard !replying else { return nil }
        switch (key, characters) {
        case (.downArrow, _), (_, "j"): return .next
        case (.upArrow, _), (_, "k"): return .previous
        case (.return, _): return .open
        case (_, "r"): return .reply
        case (_, "s"): return .refreshStatus
        case (_, "m"): return .markRead
        case (_, "?"): return .shortcuts
        case (.escape, _): return .close
        default: return nil
        }
    }

    private func key(_ press: KeyPress, order: [String]) -> KeyPress.Result {
        guard let action = Self.keyAction(press.key, characters: press.characters, replying: replying != nil) else { return .ignored }
        let index = selected.flatMap { order.firstIndex(of: $0) }
        switch action {
        case .next:
            selected = order.isEmpty ? nil : order[min((index ?? -1) + 1, order.count - 1)]
        case .previous:
            selected = order.isEmpty ? nil : order[max((index ?? order.count) - 1, 0)]
        case .open:
            guard let selected, let session = model.sessions.first(where: { $0.name == selected }) else { return .ignored }
            open(session)
        case .reply:
            guard let selected, model.sessions.first(where: { $0.name == selected })?.agentIdentity != nil else { return .ignored }
            replying = selected
        case .refreshStatus:
            guard let selected, model.sessions.first(where: { $0.name == selected })?.agentIdentity != nil else { return .ignored }
            refreshErrors[selected] = nil
            Task {
                do { try await briefs.refresh(selected) } catch { refreshErrors[selected] = error.localizedDescription }
            }
        case .markRead:
            guard let selected, let session = model.sessions.first(where: { $0.name == selected }) else { return .ignored }
            model.markRead(session)
            acknowledged[selected] = Date()
            OverviewAcknowledgements.save(acknowledged, keeping: Set(model.sessions.map(\.name)))
            // On to the next session, as in a mail inbox; the marked one may leave its lane.
            if let index, order.count > 1 { self.selected = index + 1 < order.count ? order[index + 1] : order[index - 1] }
        case .shortcuts:
            showingShortcuts.toggle()
        case .close:
            if showingShortcuts { showingShortcuts = false }
            else if selected != nil { selected = nil }
            else { return .ignored }
        }
        return .handled
    }

    private func open(_ session: Session) {
        model.requestAttachment(to: session)
        openWindow(id: "sessions")
    }
}

/// Each agent's window closest to its limit, as in the sidebar's usage section.
private struct UsageSummary: View {
    @ObservedObject var usage: UsageModel

    var body: some View {
        HStack(spacing: 10) {
            ForEach(usage.visible) { provider in
                if let window = provider.tightest {
                    let level = UsageLevel(usedPercent: window.usedPercent)
                    HStack(spacing: 4) {
                        Text(provider.name).foregroundStyle(.secondary)
                        Text("\(Int(window.usedPercent.rounded()))%").monospacedDigit()
                            .foregroundStyle(level == .critical ? .red : level == .high ? .orange : .primary)
                    }
                    .font(.callout)
                    .help("\(provider.name) \(window.label): \(Int(window.usedPercent.rounded()))% used"
                          + (window.resetsAt.map { ", resets in \(formatDuration($0.timeIntervalSinceNow))" } ?? ""))
                }
            }
        }
    }
}

/// A session and the sessions under it, one short row each, with the project at the top right.
private struct FamilyCard: View {
    let family: OverviewFamily
    @ObservedObject var model: SessionModel
    @Binding var selected: String?
    @Binding var replying: String?
    let refreshErrors: [String: String]
    let open: (Session) -> Void

    private var isSelected: Bool { family.items.contains { $0.session.name == selected } }
    private func project(of session: Session) -> String { URL(fileURLWithPath: session.worktreePath).lastPathComponent }

    var body: some View {
        // Times in state tick by the minute.
        TimelineView(.everyMinute) { context in
            VStack(alignment: .leading, spacing: 4) {
                row(family.head, now: context.date, head: true)
                if !family.members.isEmpty {
                    Divider().padding(.vertical, 4)
                    ForEach(family.members) { member in row(member, now: context.date, head: false) }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(isSelected ? Color.accentColor.opacity(0.7) : Color.primary.opacity(0.08)))
    }

    private func row(_ item: OverviewItem, now: Date, head: Bool) -> some View {
        let headProject = project(of: family.head.session)
        let own = project(of: item.session)
        return VStack(alignment: .leading, spacing: 6) {
            OverviewRow(item: item, model: model, now: now, head: head, project: head ? headProject : nil,
                        otherProject: !head && own != headProject ? own : nil, selected: selected == item.session.name,
                        refreshError: refreshErrors[item.session.name], open: { open(item.session) }, reply: { replying = item.session.name })
                .contentShape(Rectangle())
                .onTapGesture(count: 2) { open(item.session) }
                .onTapGesture { selected = selected == item.session.name ? nil : item.session.name }
            if replying == item.session.name {
                ReplyField(name: item.session.name) { replying = nil }
            }
        }
    }
}

/// One session in a short row: its state and time in it, what an agent waits on from its person, its pull requests,
/// and its status headline. Selected, an agent's row opens to show its status in full.
private struct OverviewRow: View {
    let item: OverviewItem
    @ObservedObject var model: SessionModel
    let now: Date
    let head: Bool
    /// The project, shown at the row's end: the card's top right.
    let project: String?
    /// A member's project when it differs from the card's.
    let otherProject: String?
    let selected: Bool
    /// Why asking for a new status failed.
    let refreshError: String?
    let open: () -> Void
    let reply: () -> Void
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                SessionStatusIcon(session: item.session, activity: item.activity, muted: model.isMuted(item.session))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.hierarchy.displayName(for: item.session)).font(head ? .headline : .callout.weight(.semibold)).lineLimit(1)
                    Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                if hovering || selected {
                    if item.session.agentIdentity != nil {
                        Button(action: reply) { Image(systemName: "arrowshape.turn.up.left") }
                            .buttonStyle(.borderless).help("Reply (R)").accessibilityLabel("Reply to \(item.session.name)")
                    }
                    Button(action: open) { Image(systemName: "arrow.up.forward.square") }
                        .buttonStyle(.borderless).disabled(!item.session.connected)
                        .help("Open in the main window (↩)").accessibilityLabel("Open \(item.session.name)")
                }
                if let project {
                    Label(project, systemImage: "folder").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        .help(item.session.worktreePath)
                }
            }
            if let question = item.needsYou {
                Label(question, systemImage: "exclamationmark.bubble.fill")
                    .font(.caption).foregroundStyle(.orange).lineLimit(selected ? nil : 2).padding(.leading, 20)
            }
            ForEach(item.handedOver, id: \.check) { handedOver in
                HandedOverCheck(name: item.session.name, pullRequest: handedOver.pullRequest, check: handedOver.check).padding(.leading, 20)
            }
            ForEach(item.agent?.pullRequests ?? []) { pullRequest in
                PullRequestLine(pullRequest: pullRequest).padding(.leading, 20)
            }
            if selected, let brief = item.brief, brief.brief != nil {
                ExpandedBrief(brief: brief, now: now).padding(.leading, 20).padding(.top, 4)
            } else if let headline = item.brief?.brief?.headline {
                HStack(spacing: 4) {
                    Text(headline).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    if item.brief?.generating == true { ProgressView().controlSize(.mini).help("Writing a new status…") }
                }
                .padding(.leading, 20)
            } else if item.session.agentIdentity != nil {
                Text(item.brief?.generating == true ? "Writing the first status…" : "No status yet").font(.caption).foregroundStyle(.tertiary).padding(.leading, 20)
            }
            // The latest attempt's failure, while the row is selected, where S asks for a new status.
            if let failure = refreshError ?? (selected ? item.brief?.error : nil) {
                Label(failure, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.orange).lineLimit(2).padding(.leading, 20)
            }
        }
        .padding(.vertical, 3).padding(.horizontal, 4)
        .background(selected ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 6))
        .onHover { hovering = $0 }
        .accessibilityElement(children: .combine)
    }

    /// The agent, its state and how long it has been in it, its queue, its next wake, and a project unlike the card's.
    private var detail: String {
        var parts = [item.session.agentIdentity ?? "terminal"]
        let state: String? = switch item.activity {
        case .active: "working"
        case .idle: "idle"
        case .unread: "finished"
        case .needsAttention: "at a prompt"
        case .offline: "offline"
        default: nil
        }
        if let state {
            parts.append(item.agent?.since.map { "\(state) \(formatDuration(now.timeIntervalSince($0)))" } ?? state)
        }
        if let queued = item.agent?.queued, queued > 0 { parts.append("\(queued) queued") }
        if let wake = item.agent?.nextWake {
            parts.append(wake.dueAt.map { "wake in \(formatDuration($0.timeIntervalSince(now)))" } ?? (wake.kind == "pid" ? "waits on a process" : "waits on a script"))
        }
        if let otherProject { parts.append(otherProject) }
        return parts.joined(separator: " · ")
    }
}

/// An agent's status in full, inside its row: its goal, progress, what it is doing, its next steps and when it was written.
struct ExpandedBrief: View {
    let brief: AgentBrief
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let content = brief.brief {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 6) {
                    if !content.goal.isEmpty { row("Goal") { Text(content.goal) } }
                    if !content.progress.isEmpty {
                        row("Progress") { list(content.progress) { _ in "•" } }
                    }
                    row("Now") { Text(content.now) }
                    if !content.next.isEmpty {
                        row("Next") { list(content.next) { "\($0 + 1)." } }
                    }
                }
            }
            if let written = brief.generatedAt {
                HStack(spacing: 4) {
                    // The minute's tick can predate a brief just written.
                    Text("Status from \(now.timeIntervalSince(written) < 60 ? "just now" : RelativeDateTimeFormatter().localizedString(for: written, relativeTo: now))")
                    if brief.generating {
                        ProgressView().controlSize(.mini)
                        Text("writing a new one…")
                    }
                }
                .font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .font(.callout)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func row<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        GridRow {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary).gridColumnAlignment(.trailing)
            content().fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func list(_ items: [String], marker: @escaping (Int) -> String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, text in
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(marker(index)).monospacedDigit().foregroundStyle(.secondary)
                    Text(text)
                }
            }
        }
    }
}

/// When sessions were last marked read in the overview, by name.
enum OverviewAcknowledgements {
    private static let key = "overviewAcknowledged"

    static func load(defaults: UserDefaults = .standard) -> [String: Date] {
        (defaults.dictionary(forKey: key) as? [String: Double] ?? [:]).mapValues(Date.init(timeIntervalSince1970:))
    }

    /// Saves the marks of the sessions in `keeping`; others are forgotten.
    static func save(_ marks: [String: Date], keeping names: Set<String>, defaults: UserDefaults = .standard) {
        defaults.set(marks.filter { names.contains($0.key) }.mapValues(\.timeIntervalSince1970), forKey: key)
    }
}

/// The overview's keyboard shortcuts, laid over the board: ? shows and hides them, as do Escape and a click.
struct OverviewShortcuts: View {
    private static let groups: [(title: String, keys: [(keys: [String], action: String)])] = [
        ("Sessions", [(["↑", "↓", "or", "J", "K"], "Select the next or previous session; it opens to its full status"),
                      (["↩"], "Open the selected session in the main window"), (["R"], "Reply to the selected agent"),
                      (["S"], "Write a new status for the selected agent"),
                      (["M"], "Mark the selected agent read, then select the next"),
                      (["Esc"], "Close the selected session")]),
        ("Reply", [(["↩"], "Send now, steering a working agent"), (["⌘", "↩"], "Send once the agent is idle"), (["Esc"], "Cancel the reply")]),
        ("Overview", [(["?"], "Show or hide these shortcuts"), (["⇧", "⌘", "O"], "Open the overview from anywhere in Orc")])
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Keyboard Shortcuts").font(.headline)
                Spacer()
                Text("Press ? or Esc to close").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(Self.groups, id: \.title) { group in
                VStack(alignment: .leading, spacing: 6) {
                    Text(group.title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(Array(group.keys.enumerated()), id: \.offset) { _, entry in
                        HStack(spacing: 10) {
                            HStack(spacing: 3) {
                                ForEach(entry.keys, id: \.self) { key in
                                    if key == "or" {
                                        Text("or").font(.caption).foregroundStyle(.secondary).padding(.horizontal, 2)
                                    } else {
                                        Text(key).font(.system(.caption, design: .rounded).weight(.medium)).frame(minWidth: 14)
                                            .padding(.horizontal, 5).padding(.vertical, 2)
                                            .background(RoundedRectangle(cornerRadius: 4).fill(Color.primary.opacity(0.08)))
                                            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.primary.opacity(0.25)))
                                    }
                                }
                            }
                            .frame(width: 128, alignment: .trailing)
                            Text(entry.action).font(.callout)
                        }
                    }
                }
            }
        }
        .padding(18)
        .frame(width: 480)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.primary.opacity(0.1)))
        .shadow(color: .black.opacity(0.18), radius: 20, y: 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Keyboard shortcuts")
    }
}

/// A message to an agent: Return sends it now, steering a working agent; ⌘Return sends it once the agent is idle.
private struct ReplyField: View {
    let name: String
    let close: () -> Void
    @State private var text = ""
    @State private var sending = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                TextField("Message \(name)…", text: $text).textFieldStyle(.roundedBorder)
                    .focused($focused).disabled(sending)
                    .onSubmit { send(whenIdle: false) }
                    .onExitCommand(perform: close)
                Button("When Idle") { send(whenIdle: true) }
                    .keyboardShortcut(.return, modifiers: .command).disabled(sending || text.trimmingCharacters(in: .whitespaces).isEmpty)
                    .help("Send once the agent finishes its turn (⌘↩)")
            }
            Text(error ?? "↩ sends now · ⌘↩ when idle · esc cancels").font(.caption2)
                .foregroundStyle(error == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(.red)).lineLimit(2)
        }
        .onAppear { focused = true }
    }

    private func send(whenIdle: Bool) {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty, !sending else { return }
        sending = true
        Task {
            defer { sending = false }
            do {
                _ = try await LocalRPC.call("agent.send", ["to": name, "text": message, "whenIdle": whenIdle])
                close()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

import AppKit
import SwiftUI
import OrcKit

@MainActor final class SessionBoardModel: ObservableObject {
    @Published private(set) var board = SessionBoard()
    @Published private(set) var error: String?
    @Published private(set) var loaded = false
    private let file: URL

    init(file: URL = SessionBoardStore.file) { self.file = file; reload() }

    func reload() {
        do { board = try SessionBoardStore.load(from: file); loaded = true; error = nil }
        catch { loaded = false; self.error = "Could not load the session board: \(error.localizedDescription)" }
    }

    func update(_ change: (inout SessionBoard) -> Void) {
        guard loaded else { return }
        var next = board
        change(&next)
        guard next != board else { return }
        do { try SessionBoardStore.save(next, to: file); board = next; error = nil }
        catch { self.error = "Could not save the session board: \(error.localizedDescription)" }
    }
}

struct SessionBoardView: View {
    @ObservedObject var model: SessionModel
    @ObservedObject var organization: SessionBoardModel
    @Environment(\.openWindow) private var openWindow
    @State private var search = ""
    @State private var projectFilter = SessionProjectFilter()
    @State private var labelFilter: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.controlActiveState) private var controlActiveState
    @State private var drag: SessionBoardDrag?
    @State private var scroll = BoardScrollContext()
    @State private var dropTargets: [String: BoardDropLocation] = [:]
    @GestureState private var dragActive = false
    @State private var dragBlockedUntilRelease = false
    @State private var groupEditor: GroupEditor?

    private struct GroupEditor: Identifiable {
        let id: String
        let name: String
        let isNew: Bool
    }

    private var displayedBoard: SessionBoard {
        if let drag, drag.phase == .dragging { return drag.preview }
        return organization.board
    }
    private var gridAnimation: Animation? {
        reduceMotion ? nil : .interactiveSpring(response: 0.28, dampingFraction: 0.84)
    }
    private var viewport: CGRect { dropTargets["viewport"]?.frame ?? .zero }

    private var projects: [Workspace] { SessionProjectFilter.projects(in: model.sessions, workspaces: model.workspaces) }
    private var availableLabels: [SessionBoard.Label] { organization.board.labels(in: projectFilter.projectID) }
    private var filteredSessions: [Session] {
        organization.board.filteredSessions(from: model.sessions, project: projectFilter, labelID: labelFilter, search: search)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if !organization.loaded {
                ContentUnavailableView {
                    Label("Board unavailable", systemImage: "exclamationmark.triangle")
                } actions: {
                    Button("Retry") { organization.reload(); reconcile() }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 24) {
                        ForEach(displayedBoard.groups) { group in
                            section(id: group.id, name: group.name)
                        }
                        section(id: nil, name: "Ungrouped")
                    }
                    .padding(24)
                    .animation(gridAnimation, value: displayedBoard)
                    .animation(gridAnimation, value: drag?.phase)
                    .background(BoardScrollProbe(scroll: scroll).frame(width: 0, height: 0))
                }
                .background(Color(nsColor: .underPageBackgroundColor))
                .modifier(BoardDropTarget(id: "viewport", groupID: nil, anchor: nil))
            }
            if let error = organization.error ?? model.reviewError ?? model.error {
                Divider()
                HStack(alignment: .top) {
                    Image(systemName: "exclamationmark.triangle")
                    Text(error).textSelection(.enabled)
                    Spacer()
                }.font(.callout).foregroundStyle(.orange).padding(12)
            }
        }
        .frame(minWidth: 700, minHeight: 440)
        .coordinateSpace(name: "sessionBoard")
        .onPreferenceChange(BoardDropLocations.self) { dropTargets = $0 }
        .overlay(alignment: .topLeading) { floatingCard }
        .simultaneousGesture(DragGesture(minimumDistance: 4, coordinateSpace: .named("sessionBoard"))
            .updating($dragActive) { _, active, _ in active = true }
            .onChanged { value in updateDrag(start: value.startLocation, location: value.location) }
            .onEnded { value in
                updateDrag(start: value.startLocation, location: value.location)
                endDrag(commit: viewport.contains(value.location))
                dragBlockedUntilRelease = false
            })
        .onExitCommand { endDrag(commit: false) }
        .navigationTitle("Session Overview")
        .toolbar {
            ToolbarItem {
                Button { groupEditor = GroupEditor(id: UUID().uuidString, name: "", isNew: true) } label: {
                    Label("New Group", systemImage: "folder.badge.plus")
                }.help("Create a group").disabled(!organization.loaded || drag != nil)
            }
            ToolbarItem {
                Button { Task { await model.refresh() } } label: { Label("Refresh Sessions", systemImage: "arrow.clockwise") }
                    .disabled(model.loading).help("Refresh Sessions")
            }
        }
        .sheet(item: $groupEditor) { editor in
            BoardGroupEditor(name: editor.name, isNew: editor.isNew) { name in
                organization.update {
                    if editor.isNew { $0.addGroup(name) }
                    else { $0.renameGroup(editor.id, to: name) }
                }
            }
        }
        .onAppear { reconcile() }
        .onChange(of: model.sessions) { _, _ in
            reconcile()
            projectFilter.reconcile(with: model.sessions)
            if let drag, !model.sessions.contains(where: { $0.id == drag.session.id }) { self.drag = nil }
        }
        .onChange(of: dragActive) { _, active in
            if active { dragBlockedUntilRelease = false }
            if !active, drag?.phase == .dragging { endDrag(commit: false) }
        }
        .onChange(of: controlActiveState) { _, state in
            if state != .key { endDrag(commit: false) }
        }
        .onChange(of: search) { _, _ in drag = nil }
        .onChange(of: labelFilter) { _, _ in drag = nil }
        .onChange(of: projectFilter) { _, _ in
            drag = nil
            if let labelFilter, !availableLabels.contains(where: { $0.id == labelFilter }) { self.labelFilter = nil }
        }
        .onDisappear { drag = nil }
        .task(id: drag?.id) {
            while !Task.isCancelled, drag?.phase == .dragging {
                do { try await Task.sleep(for: .milliseconds(16)) } catch { return }
                guard let current = drag, current.phase == .dragging else { return }
                if scroll.scroll(pointer: current.location, viewport: viewport) {
                    // Geometry preferences arrive after the scroll view lays out its new visible cells.
                    await Task.yield()
                    drag?.reflow(at: current.location, targets: Array(dropTargets.values))
                }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Your sessions, at a glance").font(.headline)
                Text("\(filteredSessions.count) session\(filteredSessions.count == 1 ? "" : "s") · Drag cards to organize your board")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                SessionProjectPicker(projects: projects, selection: $projectFilter.projectID)
                    .frame(maxWidth: 200, alignment: .leading).fixedSize(horizontal: true, vertical: false)
                    .accessibilityIdentifier("board-project-filter")
                Picker("Label", selection: $labelFilter) {
                    Text("All labels").tag(String?.none)
                    ForEach(availableLabels) { label in
                        Text(labelTitle(label)).tag(Optional(label.id))
                    }
                }.labelsHidden().frame(maxWidth: 200, alignment: .leading).fixedSize(horizontal: true, vertical: false)
                    .accessibilityLabel("Filter by label")
                TextField("Find sessions or labels", text: $search).textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 260).accessibilityLabel("Find sessions or labels")
                Spacer(minLength: 0)
            }
        }.padding(16)
    }

    private func labelTitle(_ label: SessionBoard.Label) -> String {
        guard projectFilter.projectID == nil, let projectID = label.projectID else { return label.name }
        let name = model.workspaces.first { $0.id == projectID }?.name
            ?? projects.first { $0.id == projectID }?.name ?? projectID
        return "\(label.name) · \(name)"
    }

    private func section(id: String?, name: String) -> some View {
        let sessions = displayedBoard.sessions(in: id, from: filteredSessions)
        let allSessions = displayedBoard.sessions(in: id, from: projectFilter.sessions(in: model.sessions))
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: id == nil ? "tray" : "rectangle.3.group").foregroundStyle(.secondary)
                Text(name).font(.title3.weight(.semibold)).lineLimit(1).help(name)
                Text("\(sessions.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    .padding(.horizontal, 7).padding(.vertical, 3).background(.quaternary, in: Capsule())
                Spacer()
                if let id {
                    Menu {
                        Button("Rename Group…") { groupEditor = GroupEditor(id: id, name: name, isNew: false) }
                        Button("Move Group Up") { organization.update { $0.moveGroup(id, by: -1) } }
                            .disabled(organization.board.groups.first?.id == id)
                        Button("Move Group Down") { organization.update { $0.moveGroup(id, by: 1) } }
                            .disabled(organization.board.groups.last?.id == id)
                        Divider()
                        Button("Remove Group (Keep Sessions)") { organization.update { $0.removeGroup(id) } }
                    } label: { Image(systemName: "ellipsis") }
                    .menuStyle(.borderlessButton).fixedSize().help("Group options").accessibilityLabel("Options for \(name)")
                }
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 270, maximum: 400), spacing: 12, alignment: .top)], alignment: .leading, spacing: 12) {
                ForEach(sessions) { session in
                    BoardSessionCard(session: session, activity: model.activity(for: session), organization: organization,
                                     earlier: neighbor(of: session, in: allSessions, offset: -1),
                                     later: neighbor(of: session, in: allSessions, offset: 1)) {
                        model.requestAttachment(to: session)
                        openWindow(id: "sessions")
                    }
                    .opacity(drag?.key == session.name ? 0 : 1)
                    .overlay {
                        if drag?.key == session.name {
                            RoundedRectangle(cornerRadius: 12).fill(Color.accentColor.opacity(0.06))
                                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.accentColor.opacity(0.35),
                                    style: StrokeStyle(lineWidth: 1.5, dash: [5])))
                                .allowsHitTesting(false)
                        }
                    }
                    .modifier(BoardDropTarget(id: "card:" + session.id, groupID: id, anchor: session.name))
                }
            }
            BoardDropArea(empty: sessions.isEmpty, message: emptyMessage(empty: sessions.isEmpty, allSessions: allSessions))
                .modifier(BoardDropTarget(id: "group:" + (id ?? "ungrouped"), groupID: id, anchor: nil))
        }
        .frame(minHeight: drag?.phase == .dragging ? drag?.sectionHeights["section:" + (id ?? "ungrouped")] : nil,
               alignment: .top)
        .modifier(BoardDropTarget(id: "section:" + (id ?? "ungrouped"), groupID: id, anchor: nil))
    }

    @ViewBuilder private var floatingCard: some View {
        if let drag {
            BoardSessionCard(session: drag.session, activity: model.activity(for: drag.session), organization: organization,
                             earlier: nil, later: nil, attach: {})
                .frame(width: drag.cardFrame.width, height: drag.cardFrame.height)
                .scaleEffect(drag.phase == .settling || reduceMotion ? 1 : 1.025)
                .shadow(color: .black.opacity(drag.phase == .settling ? 0 : 0.24), radius: 16, y: 8)
                .position(x: drag.cardFrame.midX, y: drag.cardFrame.midY)
                .animation(reduceMotion ? nil : .spring(response: 0.24, dampingFraction: 0.86), value: drag.phase)
                .allowsHitTesting(false).accessibilityHidden(true)
        }
    }

    private func updateDrag(start: CGPoint, location: CGPoint) {
        guard !dragBlockedUntilRelease else { return }
        if drag == nil {
            guard organization.loaded, viewport.contains(start),
                  let source = dropTargets.values.first(where: { $0.anchor != nil && $0.frame.contains(start) }),
                  let session = filteredSessions.first(where: { $0.name == source.anchor }) else { return }
            let heights = dropTargets.filter { $0.key.hasPrefix("section:") }.mapValues { $0.frame.height }
            drag = SessionBoardDrag(session: session, board: organization.board, frame: source.frame,
                                    start: start, sectionHeights: heights)
        }
        guard drag?.phase == .dragging else { return }
        drag?.reflow(at: location, targets: Array(dropTargets.values))
    }

    private func endDrag(commit: Bool) {
        guard let current = drag, current.phase == .dragging else { return }
        if !commit { dragBlockedUntilRelease = true }
        drag?.phase = .ending
        if commit, model.sessions.contains(where: { $0.id == current.session.id }) {
            organization.update { current.apply(to: &$0) }
        }
        Task { @MainActor in
            // Settle into the saved layout, including a restored layout after cancellation or a failed save.
            try? await Task.sleep(for: .milliseconds(32))
            guard drag?.id == current.id else { return }
            if let frame = dropTargets["card:" + current.session.id]?.frame { drag?.landingFrame = frame }
            drag?.phase = .settling
            try? await Task.sleep(for: .milliseconds(reduceMotion ? 0 : 240))
            if drag?.id == current.id { drag = nil }
        }
    }

    private func emptyMessage(empty: Bool, allSessions: [Session]) -> String {
        if empty && (!search.isEmpty || labelFilter != nil || projectFilter.projectID != nil) {
            return "No matching sessions · Drop a card here to move it into this group"
        }
        if model.loading && model.sessions.isEmpty { return "Loading sessions…" }
        return allSessions.isEmpty ? "Drop sessions here" : "Drop here to place a card at the end"
    }

    private func neighbor(of session: Session, in sessions: [Session], offset: Int) -> String? {
        guard let index = sessions.firstIndex(where: { $0.id == session.id }), sessions.indices.contains(index + offset) else { return nil }
        return sessions[index + offset].name
    }
    private func reconcile() { organization.update { $0.reconcile(model.sessions) } }
}

private struct BoardSessionCard: View {
    let session: Session
    let activity: AgentActivity
    @ObservedObject var organization: SessionBoardModel
    let earlier: String?
    let later: String?
    let attach: () -> Void
    @State private var showLabels = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(session.name).font(.headline).lineLimit(2).help(session.name)
                    Label(URL(fileURLWithPath: session.worktreePath).lastPathComponent, systemImage: "folder")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1).help(session.worktreePath)
                }
                Spacer(minLength: 0)
                Button(action: attach) { Image(systemName: "arrow.up.forward.square").font(.system(size: 16)) }
                    .buttonStyle(.borderless).disabled(!session.connected)
                    .help("Attach in main window").accessibilityLabel("Attach to \(session.name) in main window")
                    .accessibilityIdentifier("board-attach-\(session.handle)")
            }
            HStack(spacing: 7) {
                if session.agentIdentity != nil { AgentActivityIndicator(activity: activity).accessibilityHidden(true) }
                Text(activity.label).font(.caption).lineLimit(1)
                Spacer(minLength: 0)
                if let agent = session.agentIdentity { Text(agent).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
            Spacer(minLength: 0)
            HStack(spacing: 6) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 5) {
                        ForEach(organization.board.labels(for: session.name)) { label in
                            Text(label.name).font(.caption).lineLimit(1).padding(.horizontal, 8).padding(.vertical, 4)
                                .background(Color.accentColor.opacity(0.12), in: Capsule()).help(label.name)
                        }
                    }
                }
                Button { showLabels.toggle() } label: { Image(systemName: "tag") }
                    .buttonStyle(.borderless).help("Edit labels").accessibilityLabel("Edit labels for \(session.name)")
                    .popover(isPresented: $showLabels) { BoardLabelPicker(organization: organization, key: session.name) }
                Menu {
                    Menu("Move to Group") {
                        Button("Ungrouped") { move(to: nil) }
                        ForEach(organization.board.groups) { group in Button(group.name) { move(to: group.id) } }
                    }
                    Button("Move Earlier") {
                        organization.update { $0.move(session.name, to: $0.cards[session.name]?.groupID, before: earlier) }
                    }.disabled(earlier == nil)
                    Button("Move Later") {
                        guard let later else { return }
                        organization.update { $0.move(later, to: $0.cards[session.name]?.groupID, before: session.name) }
                    }.disabled(later == nil)
                } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton).fixedSize().help("Move session").accessibilityLabel("Move \(session.name)")
            }.frame(height: 28)
        }
        .padding(16).frame(maxWidth: .infinity).frame(height: 174)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(activity == .unread ? Color.blue.opacity(0.5) : Color.primary.opacity(0.1)))
        .contentShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("board-card-\(session.handle)")
    }
    private func move(to groupID: String?) { organization.update { $0.move(session.name, to: groupID) } }
}

private struct BoardLabelPicker: View {
    @ObservedObject var organization: SessionBoardModel
    let key: String
    @State private var query = ""
    @FocusState private var focused: Bool
    private var name: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var availableLabels: [SessionBoard.Label] { organization.board.availableLabels(for: key) }
    private var matches: [SessionBoard.Label] {
        availableLabels.filter { name.isEmpty || $0.name.localizedCaseInsensitiveContains(name) }
    }
    private var exactMatch: Bool {
        availableLabels.contains { $0.name.compare(name, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Labels").font(.headline)
            TextField("Find or create a label", text: $query).textFieldStyle(.roundedBorder).focused($focused)
                .accessibilityLabel("Find or create a label").onSubmit { add() }
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(matches) { label in
                        Button { organization.update { $0.toggleLabel(label.id, for: key) } } label: {
                            HStack {
                                Image(systemName: organization.board.cards[key]?.labelIDs.contains(label.id) == true ? "checkmark.square.fill" : "square")
                                Text(label.name).lineLimit(2)
                                Spacer()
                            }.padding(6).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                        .accessibilityValue(organization.board.cards[key]?.labelIDs.contains(label.id) == true ? "Applied" : "Not applied")
                    }
                    if matches.isEmpty {
                        Text(name.isEmpty ? "Create a label to reuse in this project." : "No matching labels")
                            .font(.callout).foregroundStyle(.secondary).padding(.vertical, 8)
                    }
                }
            }.frame(maxHeight: 220)
            if !name.isEmpty {
                Button(exactMatch ? "Apply “\(name)”" : "Create “\(name)”", action: add).lineLimit(1)
            }
        }.padding(16).frame(width: 280).onAppear { focused = true }
    }
    private func add() {
        guard !name.isEmpty else { return }
        organization.update { $0.addLabel(name, to: key) }
        query = ""
    }
}

private struct BoardGroupEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var name: String
    let isNew: Bool
    let save: (String) -> Void
    @FocusState private var focused: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(isNew ? "New Group" : "Rename Group").font(.title2.bold())
            TextField("e.g. Waiting for review", text: $name).textFieldStyle(.roundedBorder)
                .accessibilityLabel("Group name").focused($focused)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(isNew ? "Create Group" : "Save") { save(name); dismiss() }
                    .keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 360).onAppear { focused = true }
    }
}

private struct BoardDropArea: View {
    let empty: Bool
    let message: String
    var body: some View {
        Text(message).font(.caption).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity).frame(height: empty ? 90 : 28)
            .background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.12), style: StrokeStyle(lineWidth: 1, dash: [4])))
            .contentShape(Rectangle())
    }
}

private struct BoardDropLocations: PreferenceKey {
    static var defaultValue: [String: BoardDropLocation] = [:]
    static func reduce(value: inout [String: BoardDropLocation], nextValue: () -> [String: BoardDropLocation]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

private struct BoardDropTarget: ViewModifier {
    let id: String
    let groupID: String?
    let anchor: String?
    func body(content: Content) -> some View {
        content
            .background(GeometryReader { geometry in
                Color.clear.preference(key: BoardDropLocations.self, value: [id: BoardDropLocation(
                    id: id, groupID: groupID, anchor: anchor, frame: geometry.frame(in: .named("sessionBoard")))])
            })
    }
}

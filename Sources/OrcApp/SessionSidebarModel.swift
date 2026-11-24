import Foundation
import SwiftUI
import OrcKit

/// Sessions in a section per project, which collapses with the sidebar's own control on its header. Sessions can be
/// dragged within their project.
struct SessionSidebarList<RowContent: View>: View {
    @ObservedObject var organization: SessionSidebarModel
    let sections: [SessionSidebarSection]
    @Binding var collapsedProjects: Set<String>
    @Binding var selection: String?
    @ViewBuilder var rowContent: (SessionSidebarSection, SessionSidebarOrder.Row) -> RowContent

    var body: some View {
        let names = Dictionary(grouping: sections, by: \.project.name)
        List(selection: $selection) {
            ForEach(sections) { section in
                Section(isExpanded: Binding(get: { !collapsedProjects.contains(section.id) },
                                            set: { if $0 { collapsedProjects.remove(section.id) } else { collapsedProjects.insert(section.id) } })) {
                    ForEach(section.rows) { row in
                        rowContent(section, row).tag(row.id).moveDisabled(!organization.loaded)
                            // The row draws its own selection, so its text keeps its colors when selected.
                            .environment(\.backgroundProminence, .standard)
                            .listRowBackground(selection == row.id ? SelectionPill() : nil)
                    }
                    .onMove { source, destination in
                        organization.move(fromOffsets: source, toOffset: destination, rows: section.rows, search: "")
                    }
                } header: {
                    SessionSidebarHeader(title: (names[section.project.name]?.count ?? 0) > 1
                                             ? "\(section.project.name) · \(section.project.path)" : section.project.name,
                                         path: section.project.path, count: section.count)
                }
            }
        }
        .listStyle(.sidebar)
        // The sidebar's color shows through, in place of the system's sidebar material.
        .scrollContentBackground(.hidden)
        .background(SystemSelectionHidden())
    }
}

/// The selected row's background: a faint rounded fill with a fine edge.
struct SelectionPill: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(Color.primary.opacity(0.08))
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Color.primary.opacity(0.1)))
            .padding(.horizontal, 8).padding(.vertical, 1)
    }
}

/// Stops the window's lists from drawing the system's selection, so their rows draw `SelectionPill` instead.
/// SwiftUI has no setting for it; the table's highlight style is set again whenever the list updates.
private struct SystemSelectionHidden: NSViewRepresentable {
    func makeNSView(context: Context) -> Applier { Applier() }
    func updateNSView(_ view: Applier, context: Context) { view.apply() }

    final class Applier: NSView {
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); apply() }
        func apply() {
            DispatchQueue.main.async { [weak self] in
                guard let root = self?.window?.contentView else { return }
                for table in Self.tables(in: root) where table.selectionHighlightStyle != .none { table.selectionHighlightStyle = .none }
            }
        }
        private static func tables(in view: NSView) -> [NSTableView] {
            (view as? NSTableView).map { [$0] } ?? view.subviews.flatMap(tables)
        }
    }
}

/// A project's header: its name, with its folder and number of sessions in the tooltip.
struct SessionSidebarHeader: View {
    let title: String
    let path: String
    let count: Int

    var body: some View {
        HStack(spacing: 6) {
            Text(title).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 0)
        }
        .font(.system(size: 11.5, weight: .medium)).foregroundStyle(.tertiary)
        .help("\(path) · \(count) session\(count == 1 ? "" : "s")")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(count) session\(count == 1 ? "" : "s")")
    }
}

/// Where the sessions' order is kept: by the runtime, which Rex's tabs and other Macs showing its sessions share.
struct SessionOrderStore {
    var load: () async throws -> [String]
    var save: ([String]) async throws -> Void

    static let runtime = SessionOrderStore(
        load: { try await RuntimeRPC.call("session.order.get")["keys"] as? [String] ?? [] },
        save: { _ = try await RuntimeRPC.call("session.order.set", ["keys": $0]) })
}

/// The sessions' order, read again every two seconds, as it also changes in Rex and on other Macs. A drag shows at
/// once and is saved after.
@MainActor final class SessionSidebarModel: ObservableObject {
    @Published private(set) var order = SessionSidebarOrder()
    @Published private(set) var error: String?
    /// Whether the order has been read; until then, sessions can't be moved.
    @Published private(set) var loaded = false
    private let store: SessionOrderStore
    private var monitor: Task<Void, Never>?
    /// Saves begun and saves under way: a read made while one was under way may not have it yet.
    private var saves = 0
    private var saving = 0

    init(store: SessionOrderStore = .runtime, monitor: Bool = true) {
        self.store = store
        guard monitor else { return }
        self.monitor = Task { [weak self] in
            while !Task.isCancelled {
                await self?.reload()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }
    deinit { monitor?.cancel() }

    /// Reads the order. A failed read keeps the order shown; the session list reports an unreachable runtime.
    func reload() async {
        let started = saves
        guard let keys = try? await store.load(), started == saves, saving == 0 else { return }
        let next = SessionSidebarOrder(keys: keys)
        if next != order { order = next }
        loaded = true
    }

    func move(fromOffsets source: IndexSet, toOffset destination: Int,
              rows: [SessionSidebarOrder.Row], search: String) {
        update(search: search) { $0.move(fromOffsets: source, toOffset: destination, rows: rows) }
    }

    private func update(search: String, _ change: (inout SessionSidebarOrder) -> Void) {
        guard loaded, search.isEmpty else { return }
        var next = order
        change(&next)
        guard next != order else { return }
        order = next
        saves += 1
        saving += 1
        Task {
            defer { saving -= 1 }
            do { try await store.save(next.keys); error = nil }
            catch { self.error = "Could not save the session order: \(error.localizedDescription)" }
        }
    }
}

/// A session in the sidebar on one line: its program's tile and its name, with its activity at the end when there is
/// something to notice. A child is indented under its parent; a parent with children can collapse them.
struct SessionSidebarRow: View {
    let session: Session
    let name: String
    let activity: AgentActivity
    let muted: Bool
    /// The headline of the agent's status brief.
    var headline: String? = nil
    let isChild: Bool
    /// Whether the session's children are collapsed, for a session that has children.
    let childrenCollapsed: Bool?
    var toggleChildren: () -> Void = {}

    var body: some View {
        HStack(spacing: 8) {
            ProgramTile(session: session)
            Text(name).font(.system(size: 13)).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 0)
            if AgentActivityIndicator.shows(activity, for: session, muted: muted) {
                AgentActivityIndicator(activity: activity, muted: muted).accessibilityHidden(true)
            }
            if let collapsed = childrenCollapsed {
                Button(action: toggleChildren) {
                    Image(systemName: "chevron.right").rotationEffect(.degrees(collapsed ? 0 : 90))
                        .font(.caption.weight(.semibold)).foregroundStyle(.secondary).frame(width: 16, height: 16)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(collapsed ? "Expand" : "Collapse") children of \(session.name)")
            }
        }
        .padding(.leading, isChild ? 18 : 0)
        .padding(.vertical, 3)
    }

    /// The session's program and what its status says, for its tooltip.
    var detail: String {
        ([session.agentIdentity ?? session.programStatus?.app ?? "terminal"] + [headline ?? session.programStatus?.text].compactMap { $0 }).joined(separator: " · ")
    }
}

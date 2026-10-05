import Foundation
import SwiftUI
import OrcKit

/// Sessions in a section per project; clicking a project's header collapses it. Sessions can be dragged
/// within their project.
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
                let collapsed = collapsedProjects.contains(section.id)
                Section {
                    if !collapsed {
                        ForEach(section.rows) { row in
                            rowContent(section, row).tag(row.id).moveDisabled(!organization.loaded)
                        }
                        .onMove { source, destination in
                            organization.move(fromOffsets: source, toOffset: destination, rows: section.rows, search: "")
                        }
                    }
                } header: {
                    SessionSidebarHeader(title: (names[section.project.name]?.count ?? 0) > 1
                                             ? "\(section.project.name) · \(section.project.path)" : section.project.name,
                                         path: section.project.path, count: section.count, collapsed: collapsed) {
                        if collapsed { collapsedProjects.remove(section.id) } else { collapsedProjects.insert(section.id) }
                    }
                }
                .collapsible(false)
            }
        }
        .listStyle(.sidebar)
    }
}

/// A project's header: a disclosure chevron, the project and its number of sessions.
struct SessionSidebarHeader: View {
    let title: String
    let path: String
    let count: Int
    let collapsed: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right").rotationEffect(.degrees(collapsed ? 0 : 90))
                    .font(.system(size: 9, weight: .bold)).foregroundStyle(.tertiary).frame(width: 12)
                Text(title).lineLimit(1).truncationMode(.middle)
                Text("\(count)").monospacedDigit().foregroundStyle(.tertiary)
                Spacer(minLength: 0)
            }
            .font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(path)
        .accessibilityLabel("\(title), \(count) session\(count == 1 ? "" : "s")")
        .accessibilityValue(collapsed ? "Collapsed" : "Expanded")
        .accessibilityHint(collapsed ? "Shows this project's sessions" : "Hides this project's sessions")
    }
}

@MainActor final class SessionSidebarModel: ObservableObject {
    @Published private(set) var order = SessionSidebarOrder()
    @Published private(set) var error: String?
    @Published private(set) var loaded = false
    private let file: URL

    init(file: URL = SessionSidebarOrderStore.file) { self.file = file; reload() }

    func reload() {
        do { order = try SessionSidebarOrderStore.load(from: file); loaded = true; error = nil }
        catch { loaded = false; self.error = "Could not load sidebar order: \(error.localizedDescription)" }
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
        do { try SessionSidebarOrderStore.save(next, to: file); order = next; error = nil }
        catch { self.error = "Could not save sidebar order: \(error.localizedDescription)" }
    }
}

/// A session in the sidebar: its status icon and name, with its agent, overview group and labels beneath
/// the name. A child is indented under its parent; a parent with children can collapse them.
struct SessionSidebarRow: View {
    let session: Session
    let name: String
    let activity: AgentActivity
    let muted: Bool
    /// The headline of the agent's status brief.
    var headline: String? = nil
    /// The session's overview group, unless it is ungrouped.
    var group: String? = nil
    /// The names of the session's overview labels.
    var labels: [String] = []
    let isChild: Bool
    /// Whether the session's children are collapsed, for a session that has children.
    let childrenCollapsed: Bool?
    var toggleChildren: () -> Void = {}

    var body: some View {
        HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    SessionStatusIcon(session: session, activity: activity, muted: muted).accessibilityHidden(true)
                    Text(name).font(.headline).lineLimit(1)
                }
                // Aligned with the name: the icon is 12 points wide, followed by 8 points of spacing.
                Text(detail)
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    .padding(.leading, 20)
                    .help(detail)
            }
            Spacer(minLength: 0)
            if let collapsed = childrenCollapsed {
                Button(action: toggleChildren) {
                    Image(systemName: "chevron.right").rotationEffect(.degrees(collapsed ? 0 : 90))
                        .font(.caption.weight(.semibold)).foregroundStyle(.secondary).frame(width: 16, height: 16)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(collapsed ? "Expand" : "Collapse") children of \(session.name)")
            }
        }
        .padding(.leading, isChild ? 20 : 0)
        .padding(.vertical, 3)
    }

    var detail: String { ([session.agentIdentity ?? "terminal"] + [headline, group].compactMap { $0 } + labels).joined(separator: " · ") }
}

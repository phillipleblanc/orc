import Foundation
import SwiftUI
import OrcKit

/// Sessions in a collapsible section per project. Sessions can be dragged within their project.
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
                Section(isExpanded: Binding(
                    get: { !collapsedProjects.contains(section.id) },
                    set: { expanded in if expanded { collapsedProjects.remove(section.id) } else { collapsedProjects.insert(section.id) } }
                )) {
                    ForEach(section.rows) { row in
                        rowContent(section, row).tag(row.id).moveDisabled(!organization.loaded)
                    }
                    .onMove { source, destination in
                        organization.move(fromOffsets: source, toOffset: destination, rows: section.rows, search: "")
                    }
                } header: {
                    HStack {
                        Text((names[section.project.name]?.count ?? 0) > 1 ? "\(section.project.name) · \(section.project.path)" : section.project.name)
                            .lineLimit(1).truncationMode(.middle)
                        Spacer()
                        Text("\(section.count)").monospacedDigit().foregroundStyle(.secondary)
                    }
                    .help(section.project.path)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(section.project.name), \(section.count) session\(section.count == 1 ? "" : "s")")
                }
            }
        }.listStyle(.sidebar)
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

    func move(_ id: String, by offset: Int, rows: [SessionSidebarOrder.Row], search: String) {
        update(search: search) { $0.move(id, by: offset, rows: rows) }
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

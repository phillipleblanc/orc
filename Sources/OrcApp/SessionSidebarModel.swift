import Foundation
import SwiftUI
import OrcKit

struct SessionSidebarList<RowContent: View>: View {
    @ObservedObject var organization: SessionSidebarModel
    let hierarchy: SessionHierarchy
    let search: String
    let collapsed: Set<String>
    @Binding var selection: String?
    @ViewBuilder var rowContent: (SessionSidebarOrder.Row) -> RowContent

    var body: some View {
        let rows = organization.order.rows(in: hierarchy, matching: search, collapsed: collapsed)
        List(selection: $selection) {
            ForEach(rows) { row in
                rowContent(row).tag(row.id)
                    .moveDisabled(!search.isEmpty || !organization.loaded)
            }
            .onMove { source, destination in
                organization.move(fromOffsets: source, toOffset: destination, rows: rows, search: search)
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

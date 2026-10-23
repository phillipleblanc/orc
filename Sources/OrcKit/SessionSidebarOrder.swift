import Foundation

/// Sidebar placement is keyed by session name and never changes name-based parentage. The runtime keeps the keys
/// (`session.order.get`), and its Rex sync orders tabs as `rows(in:)` does.
public struct SessionSidebarOrder: Equatable {
    public struct Row: Identifiable {
        public let session: Session
        public let parentID: String?
        public let hasChildren: Bool
        public var id: String { session.id }
    }

    public private(set) var keys: [String] = []
    public init(keys: [String] = []) { self.keys = keys }

    public func rows(in hierarchy: SessionHierarchy, matching search: String = "",
                     collapsed: Set<String> = []) -> [Row] {
        let ranks = Dictionary(keys.enumerated().map { ($0.element, $0.offset) }, uniquingKeysWith: min)
        func ordered<T>(_ values: [T], session: (T) -> Session) -> [T] {
            values.enumerated().sorted {
                let left = ranks[session($0.element).name] ?? Int.max
                let right = ranks[session($1.element).name] ?? Int.max
                return left == right ? $0.offset < $1.offset : left < right
            }.map(\.element)
        }
        return ordered(hierarchy.matching(search), session: { $0.session }).flatMap { group in
            let parent = Row(session: group.session, parentID: nil, hasChildren: !group.children.isEmpty)
            guard !collapsed.contains(group.id) || !search.isEmpty else { return [parent] }
            return [parent] + ordered(group.children, session: { $0 }).map {
                Row(session: $0, parentID: group.id, hasChildren: false)
            }
        }
    }

    /// List offsets include expanded children. Only sibling boundaries are valid destinations.
    public mutating func move(fromOffsets source: IndexSet, toOffset destination: Int, rows: [Row]) {
        guard source.count == 1, let index = source.first, rows.indices.contains(index),
              (0...rows.count).contains(destination) else { return }
        let row = rows[index]
        if row.parentID == nil {
            guard destination == rows.count || rows[destination].parentID == nil else { return }
        } else {
            let indices = rows.indices.filter { rows[$0].parentID == row.parentID }
            guard let first = indices.first, let last = indices.last,
                  (first...(last + 1)).contains(destination) else { return }
        }
        let siblings = rows.filter { $0.parentID == row.parentID }.map { $0.session.name }
        let anchor = rows.dropFirst(destination).first { $0.parentID == row.parentID }?.session.name
        move(row.session.name, before: anchor, siblings: siblings)
    }

    private mutating func move(_ key: String, before anchor: String?, siblings: [String]) {
        guard anchor != key, let index = siblings.firstIndex(of: key),
              siblings.dropFirst(index + 1).first != anchor else { return }
        // Retain absent panes so partial inventories and disconnects do not erase placement.
        for sibling in siblings where !keys.contains(sibling) { keys.append(sibling) }
        keys.removeAll { $0 == key }
        if let anchor, let index = keys.firstIndex(of: anchor) { keys.insert(key, at: index) }
        else { keys.append(key) }
    }
}

/// One project's part of the sidebar.
public struct SessionSidebarSection: Identifiable {
    public let project: Workspace
    /// Parentage among this project's sessions.
    public let hierarchy: SessionHierarchy
    public let rows: [SessionSidebarOrder.Row]
    /// Sessions in the project, including children of collapsed parents.
    public let count: Int
    public var id: String { project.id }
}

extension SessionSidebarOrder {
    /// Sessions grouped by project. Each project's rows keep this order and their parentage, and a
    /// project is placed where its first session is in this order.
    public func sections(of sessions: [Session], workspaces: [Workspace], collapsed: Set<String> = []) -> [SessionSidebarSection] {
        let firstRow = Dictionary(rows(in: SessionHierarchy(sessions: sessions)).enumerated().map { ($0.element.session.worktreeId, $0.offset) },
                                  uniquingKeysWith: min)
        return SessionProjectFilter.projects(in: sessions, workspaces: workspaces).map { project in
            let members = sessions.filter { $0.worktreeId == project.id }
            let hierarchy = SessionHierarchy(sessions: members)
            return SessionSidebarSection(project: project, hierarchy: hierarchy, rows: rows(in: hierarchy, collapsed: collapsed), count: members.count)
        }.sorted { (firstRow[$0.id] ?? .max, $0.project.name) < (firstRow[$1.id] ?? .max, $1.project.name) }
    }
}

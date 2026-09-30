import Foundation
import CryptoKit

/// Sidebar placement is keyed by session name and never changes name-based parentage.
public struct SessionSidebarOrder: Codable, Equatable {
    public struct Row: Identifiable {
        public let session: Session
        public let parentID: String?
        public let hasChildren: Bool
        public var id: String { session.id }
    }

    public private(set) var keys: [String] = []
    public init() {}

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

    public func canMove(_ id: String, by offset: Int, rows: [Row]) -> Bool {
        guard let row = rows.first(where: { $0.id == id }) else { return false }
        let siblings = rows.filter { $0.parentID == row.parentID }
        guard let index = siblings.firstIndex(where: { $0.id == id }) else { return false }
        return (offset == -1 || offset == 1) && siblings.indices.contains(index + offset)
    }

    public mutating func move(_ id: String, by offset: Int, rows: [Row]) {
        guard canMove(id, by: offset, rows: rows), let row = rows.first(where: { $0.id == id }) else { return }
        let siblings = rows.filter { $0.parentID == row.parentID }.map { $0.session.name }
        guard let index = siblings.firstIndex(of: row.session.name) else { return }
        let destination = index + (offset > 0 ? 2 : -1)
        let anchor = siblings.indices.contains(destination) ? siblings[destination] : nil
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

public enum SessionSidebarOrderStore {
    public static var file: URL { file(config: Pairing.directory, profile: RuntimeMetadata.directory) }

    public static func file(config: URL, profile: URL) -> URL {
        let scope = SHA256.hash(data: Data(profile.standardizedFileURL.resolvingSymlinksInPath().path.utf8))
            .map { String(format: "%02x", $0) }.joined()
        return config.appendingPathComponent("sidebar-order").appendingPathComponent(scope + ".json")
    }

    public static func load(from file: URL = Self.file) throws -> SessionSidebarOrder {
        guard FileManager.default.fileExists(atPath: file.path) else { return SessionSidebarOrder() }
        return try JSONDecoder().decode(SessionSidebarOrder.self, from: Data(contentsOf: file))
    }

    public static func save(_ order: SessionSidebarOrder, to file: URL = Self.file) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(order).write(to: file, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}

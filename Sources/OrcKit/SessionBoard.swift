import Foundation
import CryptoKit

/// Local organization keyed by session name, independent of activity.
public struct SessionBoard: Codable, Equatable {
    public struct Group: Codable, Equatable, Identifiable {
        public let id: String
        public var name: String
    }
    public struct Label: Codable, Equatable, Identifiable {
        public let id: String
        public let name: String
        public let projectID: String?
    }
    public struct Card: Codable, Equatable {
        public var groupID: String?
        public var labelIDs: Set<String> = []
        public var projectID: String?
    }
    public private(set) var groups: [Group] = []
    public private(set) var labels: [Label] = []
    public private(set) var cards: [String: Card] = [:]
    public private(set) var order: [String] = []

    public init() {}

    /// Missing sessions retain their metadata through disconnects and partial inventories.
    public mutating func reconcile(_ sessions: [Session]) {
        for session in sessions {
            let key = session.name
            if cards[key] == nil { cards[key] = Card() }
            cards[key]?.projectID = session.worktreeId
            if !order.contains(key) { order.append(key) }
        }
        migrateLabels()
    }

    public func sessions(in groupID: String?, from sessions: [Session]) -> [Session] {
        let ranks = Dictionary(order.enumerated().map { ($0.element, $0.offset) }, uniquingKeysWith: min)
        return sessions.filter { cards[$0.name]?.groupID == groupID }.sorted {
            let left = ranks[$0.name] ?? Int.max, right = ranks[$1.name] ?? Int.max
            return left == right ? $0.handle < $1.handle : left < right
        }
    }

    /// The overview group a session is in, or nil when it is ungrouped.
    public func group(of key: String) -> Group? {
        guard let id = cards[key]?.groupID else { return nil }
        return groups.first { $0.id == id }
    }

    public func labels(for key: String) -> [Label] {
        availableLabels(for: key).filter { cards[key]?.labelIDs.contains($0.id) == true }
    }

    public func labels(in projectID: String? = nil) -> [Label] {
        labels.filter { $0.projectID != nil && (projectID == nil || $0.projectID == projectID) }
    }

    public func availableLabels(for key: String) -> [Label] {
        guard let projectID = cards[key]?.projectID else { return [] }
        return labels(in: projectID)
    }

    public func filteredSessions(from sessions: [Session], project: SessionProjectFilter,
                                 labelID: String?, search: String) -> [Session] {
        project.sessions(in: sessions).filter { session in
            let labels = labels(for: session.name)
            return (labelID == nil || labels.contains { $0.id == labelID }) &&
                (search.isEmpty || ([session.name, session.worktreePath, session.agentIdentity ?? ""] + labels.map(\.name))
                    .contains { $0.localizedCaseInsensitiveContains(search) })
        }
    }

    /// Unscoped labels remain as migration sources for panes absent from a partial inventory.
    private mutating func migrateLabels() {
        for label in labels where label.projectID == nil {
            for key in cards.keys.sorted() {
                guard cards[key]?.labelIDs.contains(label.id) == true, addLabel(label.name, to: key) != nil else { continue }
                cards[key]?.labelIDs.remove(label.id)
            }
        }
    }

    @discardableResult public mutating func addGroup(_ name: String) -> String? {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return nil }
        let group = Group(id: UUID().uuidString, name: name)
        groups.append(group)
        return group.id
    }

    public mutating func renameGroup(_ id: String, to name: String) {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, let index = groups.firstIndex(where: { $0.id == id }) else { return }
        groups[index].name = name
    }

    public mutating func removeGroup(_ id: String) {
        groups.removeAll { $0.id == id }
        for key in Array(cards.keys) where cards[key]?.groupID == id { cards[key]?.groupID = nil }
    }

    public mutating func moveGroup(_ id: String, by offset: Int) {
        guard let index = groups.firstIndex(where: { $0.id == id }),
              groups.indices.contains(index + offset) else { return }
        groups.swapAt(index, index + offset)
    }

    /// A nil anchor appends to the destination group. Removing first makes moves in either direction stable.
    public mutating func move(_ key: String, to groupID: String?, before anchor: String? = nil) {
        guard cards[key] != nil, anchor != key,
              groupID == nil || groups.contains(where: { $0.id == groupID }) else { return }
        if let anchor {
            guard cards[anchor] != nil, cards[anchor]?.groupID == groupID, order.contains(anchor) else { return }
        }
        cards[key]?.groupID = groupID
        order.removeAll { $0 == key }
        if let anchor, let index = order.firstIndex(of: anchor) { order.insert(key, at: index) }
        else { order.append(key) }
    }

    @discardableResult public mutating func addLabel(_ name: String, to key: String) -> String? {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, let projectID = cards[key]?.projectID else { return nil }
        let label: Label
        if let existing = labels.first(where: {
            $0.projectID == projectID && $0.name.compare(name, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
        }) {
            label = existing
        } else {
            label = Label(id: UUID().uuidString, name: name, projectID: projectID)
            labels.append(label)
        }
        cards[key]?.labelIDs.insert(label.id)
        return label.id
    }

    public mutating func toggleLabel(_ id: String, for key: String) {
        guard availableLabels(for: key).contains(where: { $0.id == id }) else { return }
        if cards[key]?.labelIDs.contains(id) == true { cards[key]?.labelIDs.remove(id) }
        else { cards[key]?.labelIDs.insert(id) }
    }
}

public enum SessionBoardStore {
    public static var file: URL { file(config: Pairing.directory, profile: RuntimeMetadata.directory) }

    public static func file(config: URL, profile: URL) -> URL {
        let scope = SHA256.hash(data: Data(profile.standardizedFileURL.resolvingSymlinksInPath().path.utf8))
            .map { String(format: "%02x", $0) }.joined()
        return config.appendingPathComponent("boards").appendingPathComponent(scope + ".json")
    }

    public static func load(from file: URL = Self.file) throws -> SessionBoard {
        guard FileManager.default.fileExists(atPath: file.path) else { return SessionBoard() }
        return try JSONDecoder().decode(SessionBoard.self, from: Data(contentsOf: file))
    }

    public static func save(_ board: SessionBoard, to file: URL = Self.file) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder().encode(board)
        try data.write(to: file, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}

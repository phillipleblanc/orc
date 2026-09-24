import Foundation

/// A one-level view of Orca sessions. The saved Orca name is the only grouping
/// signal; no separate parent metadata needs to be kept in sync with renames.
public struct SessionHierarchy {
    public struct Group: Identifiable {
        public let session: Session
        public let children: [Session]
        public var id: String { session.id }
    }

    public let groups: [Group]
    private let parentByHandle: [String: Session]
    private let uniqueNames: Set<String>

    public init(sessions: [Session]) {
        let byName = Dictionary(grouping: sessions, by: \.name)
        uniqueNames = Set(byName.compactMap { $0.value.count == 1 ? $0.key : nil })
        let ordered = sessions.enumerated().sorted {
            if $0.element.name.count != $1.element.name.count {
                return $0.element.name.count < $1.element.name.count
            }
            return $0.offset < $1.offset
        }
        var parents: [String: Session] = [:]
        for (_, session) in ordered {
            var prefix = session.name
            while let hyphen = prefix.range(of: "-", options: .backwards) {
                prefix = String(prefix[..<hyphen.lowerBound])
                guard let candidates = byName[prefix], candidates.count == 1,
                      let candidate = candidates.first,
                      session.name.count > candidate.name.count + 1,
                      parents[candidate.handle] == nil else { continue }
                parents[session.handle] = candidate
                break
            }
        }
        parentByHandle = parents
        var children: [String: [Session]] = [:]
        for session in sessions {
            if let parent = parents[session.handle] { children[parent.handle, default: []].append(session) }
        }
        groups = sessions.filter { parents[$0.handle] == nil }.map { parent in
            Group(session: parent, children: children[parent.handle] ?? [])
        }
    }

    public func parent(of session: Session) -> Session? { parentByHandle[session.handle] }
    public func canCreateChild(of session: Session) -> Bool {
        parent(of: session) == nil && uniqueNames.contains(session.name)
    }

    public func displayName(for session: Session) -> String {
        guard let parent = parent(of: session) else { return session.name }
        return String(session.name.dropFirst(parent.name.count + 1))
    }

    public func matching(_ query: String) -> [Group] {
        guard !query.isEmpty else { return groups }
        func matches(_ session: Session) -> Bool {
            session.name.localizedCaseInsensitiveContains(query) ||
            session.worktreePath.localizedCaseInsensitiveContains(query)
        }
        return groups.compactMap { group in
            if matches(group.session) { return group }
            let children = group.children.filter(matches)
            return children.isEmpty ? nil : Group(session: group.session, children: children)
        }
    }

    public static func childName(parent: Session, suffix: String) throws -> String {
        let suffix = suffix.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !suffix.isEmpty else { throw OrcError("Enter a child session name.") }
        let name = parent.name + "-" + suffix
        guard name.utf8.count <= 200,
              !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw OrcError("Choose a combined session name of at most 200 bytes without control characters.")
        }
        return name
    }
}

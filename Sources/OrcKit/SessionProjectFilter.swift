import Foundation

public struct SessionProjectFilter: Equatable {
    public var projectID: String?

    public init(projectID: String? = nil) { self.projectID = projectID }

    public func sessions(in sessions: [Session]) -> [Session] {
        guard let projectID else { return sessions }
        return sessions.filter { $0.worktreeId == projectID }
    }

    public mutating func reconcile(with sessions: [Session]) {
        if let projectID, !sessions.contains(where: { $0.worktreeId == projectID }) { self.projectID = nil }
    }

    /// Projects in the session inventory, including sessions whose connections are temporarily offline.
    public static func projects(in sessions: [Session], workspaces: [Workspace]) -> [Workspace] {
        let workspacesByID = Dictionary(workspaces.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return Dictionary(grouping: sessions, by: \.worktreeId).compactMap { id, sessions in
            if let workspace = workspacesByID[id] { return workspace }
            guard let session = sessions.first else { return nil }
            return Workspace(id: id, path: session.worktreePath, displayName: nil, hostId: nil)
        }.sorted {
            let comparison = $0.name.localizedStandardCompare($1.name)
            return comparison == .orderedSame ? $0.id < $1.id : comparison == .orderedAscending
        }
    }
}

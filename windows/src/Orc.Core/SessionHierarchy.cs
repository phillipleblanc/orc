namespace Orc.Core;

/// <summary>
/// One level of parentage derived from names alone (Sources/OrcKit/SessionHierarchy.swift): a session's parent is
/// the session whose unique name is the longest hyphen-prefix of its own, unless that session is itself a child.
/// `frontend-review` nests under `frontend` and shows as `review`. Renaming regroups; there is no other metadata.
/// </summary>
public sealed class SessionHierarchy
{
    public sealed record Group(SessionInfo Session, IReadOnlyList<SessionInfo> Children);

    private readonly Dictionary<string, SessionInfo> parentByHandle = [];
    private readonly HashSet<string> uniqueNames;

    public IReadOnlyList<Group> Groups { get; }

    public SessionHierarchy(IReadOnlyList<SessionInfo> sessions)
    {
        var byName = sessions.GroupBy(s => s.Name).ToDictionary(g => g.Key, g => g.ToList());
        uniqueNames = byName.Where(g => g.Value.Count == 1).Select(g => g.Key).ToHashSet();
        // Shorter names first, so a parent is placed before its children are considered.
        var ordered = sessions.Select((session, index) => (session, index)).OrderBy(x => x.session.Name.Length).ThenBy(x => x.index);
        foreach (var (session, _) in ordered)
        {
            var prefix = session.Name;
            int hyphen;
            while ((hyphen = prefix.LastIndexOf('-')) >= 0)
            {
                prefix = prefix[..hyphen];
                if (!byName.TryGetValue(prefix, out var candidates) || candidates.Count != 1) continue;
                var candidate = candidates[0];
                if (session.Name.Length <= candidate.Name.Length + 1 || parentByHandle.ContainsKey(candidate.Handle)) continue;
                parentByHandle[session.Handle] = candidate;
                break;
            }
        }
        var children = sessions.Where(s => parentByHandle.ContainsKey(s.Handle)).GroupBy(s => parentByHandle[s.Handle].Handle)
            .ToDictionary(g => g.Key, g => (IReadOnlyList<SessionInfo>)g.ToList());
        Groups = sessions.Where(s => !parentByHandle.ContainsKey(s.Handle))
            .Select(parent => new Group(parent, children.GetValueOrDefault(parent.Handle, []))).ToList();
    }

    public SessionInfo? ParentOf(SessionInfo session) => parentByHandle.GetValueOrDefault(session.Handle);

    /// <summary>A top-level session with a unique name can have children; a child cannot.</summary>
    public bool CanCreateChild(SessionInfo session) => ParentOf(session) is null && uniqueNames.Contains(session.Name);

    /// <summary>A child's name without its parent's prefix; a top-level session's full name.</summary>
    public string DisplayName(SessionInfo session) =>
        ParentOf(session) is { } parent ? session.Name[(parent.Name.Length + 1)..] : session.Name;

    /// <summary>The rows of a sidebar section: each top-level session, then its children unless collapsed.</summary>
    public IReadOnlyList<SidebarRow> Rows(IReadOnlySet<string> collapsed) => Groups.SelectMany(group =>
        new[] { new SidebarRow(group.Session, null, group.Children.Count > 0) }
            .Concat(collapsed.Contains(group.Session.Handle) ? Enumerable.Empty<SidebarRow>()
                : group.Children.Select(child => new SidebarRow(child, group.Session.Handle, false))))
        .ToList();
}

public sealed record SidebarRow(SessionInfo Session, string? ParentHandle, bool HasChildren);

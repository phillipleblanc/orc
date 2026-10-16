using System.Text.Json.Nodes;

namespace Orc.Core;

/// <summary>A session's activity light, as Sources/OrcKit/AgentActivity.swift derives it from terminal.agentStatus.</summary>
public enum AgentActivity { Idle, Active, NeedsAttention, NoAgent, Unknown, Offline }

public static class AgentActivities
{
    public static AgentActivity From(bool? isRunningAgent, string? state) => isRunningAgent switch
    {
        null => AgentActivity.Unknown,
        false => AgentActivity.NoAgent,
        true => state switch
        {
            "idle" or "done" => AgentActivity.Idle,
            "working" => AgentActivity.Active,
            "permission" or "blocked" or "waiting" => AgentActivity.NeedsAttention,
            _ => AgentActivity.Unknown
        }
    };

    public static string Label(this AgentActivity activity) => activity switch
    {
        AgentActivity.Idle => "Idle",
        AgentActivity.Active => "Active",
        AgentActivity.NeedsAttention => "Needs attention",
        AgentActivity.NoAgent => "No agent running",
        AgentActivity.Offline => "Offline",
        _ => "Activity unavailable"
    };
}

/// <summary>One record a program reported with OSC 7501 (Sources/OrcKit/ProgramStatus.swift).</summary>
public sealed record ProgramRecord(string Id, string State, string? Kind, int? Progress, string? App, string? Title, string? Msg)
{
    public string StateText => State switch
    {
        "working" => Progress is { } p ? $"working, {p}%" : "working",
        "blocked" => Kind switch
        {
            "permission" => "needs permission",
            "question" => "has a question",
            "auth" => "needs you to sign in",
            _ => "needs you"
        },
        "error" => "failed",
        _ => State
    };

    public string Text => (Msg ?? Title) is not { } said ? StateText : State == "working" && Progress is { } p ? $"{said} · {p}%" : said;
}

public sealed record ProgramStatus(string? State, IReadOnlyList<ProgramRecord> Records)
{
    /// <summary>The record that speaks for the terminal: the most urgent one, the root first among equals.</summary>
    public ProgramRecord? Lead
    {
        get
        {
            var urgent = Records.Where(r => r.State == State).ToList();
            return urgent.FirstOrDefault(r => r.Id.Length == 0) ?? urgent.FirstOrDefault() ?? Records.FirstOrDefault();
        }
    }

    public static ProgramStatus? FromJson(JsonNode? node)
    {
        if (node is not JsonObject status) return null;
        var records = (status["records"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(r => new ProgramRecord(
            r["id"]?.ToString() ?? "", r["state"]?.ToString() ?? "idle", r["kind"]?.ToString(),
            r["progress"] is JsonValue p && p.TryGetValue(out int progress) ? progress : null,
            r["app"]?.ToString(), r["title"]?.ToString(), r["msg"]?.ToString())).ToList();
        return new ProgramStatus(status["state"]?.ToString(), records);
    }
}

/// <summary>A session as terminal.list describes it (slim/frontend/src/methods.ts, describe()).</summary>
public sealed record SessionInfo(string Handle, string Name, string WorktreeId, string WorktreePath, bool Connected,
    string? Agent, string? IncarnationId, ProgramStatus? Program)
{
    /// <summary>The line under the name: the agent (or program, or "terminal") and what the program says it is doing.</summary>
    public string Detail => DescribeWith(null);

    /// <summary>
    /// The line under the name as Orc.app's sidebar writes it: the agent (or program, or "terminal"), then the agent's
    /// status headline, or else what the program says it is doing.
    /// </summary>
    public string DescribeWith(string? headline) =>
        string.Join(" · ", new[] { Agent ?? Program?.Lead?.App ?? "terminal", headline ?? Program?.Lead?.Text }.OfType<string>());

    public static SessionInfo? FromJson(JsonObject terminal)
    {
        if (terminal["handle"]?.ToString() is not { Length: > 0 } handle) return null;
        var title = terminal["title"]?.ToString();
        return new SessionInfo(handle, string.IsNullOrEmpty(title) ? handle : title,
            terminal["worktreeId"]?.ToString() ?? "", terminal["worktreePath"]?.ToString() ?? "",
            terminal["connected"]?.GetValue<bool>() == true, terminal["agentIdentity"]?.ToString(),
            terminal["incarnationId"]?.ToString(), ProgramStatus.FromJson(terminal["programStatus"]));
    }
}

/// <summary>A registered project, as worktree.list describes it.</summary>
public sealed record Project(string Id, string Path, string? DisplayName)
{
    public string Name => DisplayName is { Length: > 0 } name ? name : LastComponent(Path);

    public static Project? FromJson(JsonObject worktree) =>
        worktree["id"]?.ToString() is { Length: > 0 } id ? new Project(id, worktree["path"]?.ToString() ?? "", worktree["displayName"]?.ToString()) : null;

    internal static string LastComponent(string path) =>
        path.TrimEnd('/', '\\') is { Length: > 0 } trimmed ? trimmed[(trimmed.LastIndexOfAny(['/', '\\']) + 1)..] : path;
}

/// <summary>One project's part of the sidebar, with the parentage among its own sessions (SessionSidebarSection).</summary>
public sealed record SessionSection(string Id, string Title, string Path, IReadOnlyList<SessionInfo> Sessions)
{
    public SessionHierarchy Hierarchy { get; } = new(Sessions);
}

public static class SessionSections
{
    /// <summary>
    /// A section per project that has sessions, placed where its first session is in the session order; a folder
    /// outside every project gets a section of its own. Two sections with the same name show their paths.
    /// </summary>
    public static IReadOnlyList<SessionSection> Build(IReadOnlyList<SessionInfo> sessions, IReadOnlyList<Project> projects)
    {
        var byId = projects.ToDictionary(p => p.Id);
        var groups = sessions.GroupBy(s => s.WorktreeId).Select(group =>
        {
            var project = byId.GetValueOrDefault(group.Key);
            var path = project?.Path ?? group.First().WorktreePath;
            return (Id: group.Key, Name: project?.Name ?? Project.LastComponent(path), Path: path, Sessions: group.ToList());
        }).ToList();
        var duplicateNames = groups.GroupBy(g => g.Name).Where(g => g.Count() > 1).Select(g => g.Key).ToHashSet();
        return groups.Select(g => new SessionSection(g.Id, duplicateNames.Contains(g.Name) ? $"{g.Name} · {g.Path}" : g.Name, g.Path, g.Sessions)).ToList();
    }
}

/// <summary>What the host's sessions are and do, and (from hosts that serve them) their agents' briefs by session name.</summary>
public sealed record HostSnapshot(IReadOnlyList<SessionInfo> Sessions, IReadOnlyList<Project> Projects,
    IReadOnlyDictionary<string, AgentActivity> Activity, DateTimeOffset At, IReadOnlyDictionary<string, AgentBrief>? Briefs = null)
{
    public AgentActivity ActivityOf(SessionInfo session) =>
        !session.Connected ? AgentActivity.Offline : Activity.GetValueOrDefault(session.Handle, AgentActivity.Unknown);

    public AgentBrief? BriefOf(SessionInfo session) => Briefs?.GetValueOrDefault(session.Name);

    /// <summary>The line under a session's name, with its agent's status headline when it has one.</summary>
    public string DetailOf(SessionInfo session) => session.DescribeWith(BriefOf(session)?.Headline);
}

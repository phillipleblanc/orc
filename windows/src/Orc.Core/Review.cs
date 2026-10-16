using System.Text.Json;
using System.Text.Json.Nodes;
using Orc.Protocol;

namespace Orc.Core;

/// <summary>A message a session sent with <c>orc notify</c>, as <c>notify.since</c> reports it (slim/frontend/src/notifications.ts).</summary>
public sealed record SessionNotification(string Id, long Seq, string? Session, string? Handle, string Message, DateTimeOffset At);

/// <summary>Where this PC is in the host's notifications: the runtime instance and the last sequence number shown.</summary>
public sealed record NotificationCursor(string RuntimeId, long Latest);

/// <summary>What came from <c>notify.since</c>; <see cref="CatchingUp"/> when the cursor was unknown and these are the newest few.</summary>
public sealed record NotificationBatch(IReadOnlyList<SessionNotification> Notifications, NotificationCursor Cursor, bool CatchingUp);

public static class NotificationFeed
{
    /// <summary>
    /// The notifications after <paramref name="cursor"/>, each desktop through its own cursor (capability
    /// <c>orc.notify-cursor.v1</c>). A cursor from another runtime instance asks again without one.
    /// </summary>
    public static async Task<NotificationBatch> SinceAsync(SessionCommands.Request request, NotificationCursor? cursor)
    {
        var result = await request("notify.since", cursor is null ? new JsonObject() : new JsonObject { ["after"] = cursor.Latest }, null);
        if (result["runtimeId"]?.ToString() is not { Length: > 0 } runtimeId || result["latest"] is not JsonValue l || !l.TryGetValue(out long latest))
            throw new RpcException("invalid_result", "The host returned no notification cursor.");
        if (cursor is not null && cursor.RuntimeId != runtimeId) return await SinceAsync(request, null);
        var notifications = (result["notifications"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(n => new SessionNotification(
            n["id"]?.ToString() ?? "", n["seq"] is JsonValue s && s.TryGetValue(out long seq) ? seq : 0,
            n["session"] is JsonValue session && session.TryGetValue(out string? name) ? name : null,
            n["handle"] is JsonValue handle && handle.TryGetValue(out string? h) ? h : null,
            n["message"]?.ToString() ?? "", Insights.Time(n["at"]) ?? DateTimeOffset.Now)).ToList();
        // Without a known cursor the host sends the newest few, which may be old; with one, everything after it.
        var known = cursor is not null && (notifications.Count == 0 || notifications[0].Seq == cursor.Latest + 1);
        return new NotificationBatch(notifications, new NotificationCursor(runtimeId, latest), CatchingUp: !known);
    }
}

/// <summary>
/// Sessions with something to review, as Orc.app keeps them (Sources/OrcKit/AgentReviewState.swift and
/// AgentIdleTracker.swift): an agent that finished a turn seen working, or a session that sent a notification, since
/// it was last viewed. Each is fenced to the session's process and agent, so a restart does not replay it. Kept in
/// <c>%LOCALAPPDATA%\Orc\agent-review.json</c>.
/// </summary>
public sealed class ReviewState
{
    private sealed record Identity(string? Incarnation, string? Agent)
    {
        public static Identity Of(SessionInfo session) => new(session.IncarnationId, session.Agent);
    }

    private Dictionary<string, Identity> working = [];
    private Dictionary<string, Identity> unread = [];
    private Dictionary<string, Identity> notified = [];

    /// <summary>
    /// Follows each session's work cycle and returns the agents that finished one: seen working, then idle with the same
    /// process and agent. Waiting at a prompt keeps the cycle open; anything uncertain ends it without a finish.
    /// </summary>
    public IReadOnlyList<SessionInfo> Update(IReadOnlyList<SessionInfo> sessions, Func<SessionInfo, AgentActivity> activityOf)
    {
        var next = new Dictionary<string, Identity>();
        var completed = new List<SessionInfo>();
        foreach (var session in sessions.Where(s => s.Connected))
        {
            var identity = Identity.Of(session);
            switch (activityOf(session))
            {
                case AgentActivity.Active:
                    next[session.Handle] = identity;
                    break;
                case AgentActivity.NeedsAttention:
                    if (working.GetValueOrDefault(session.Handle) == identity) next[session.Handle] = identity;
                    break;
                case AgentActivity.Idle:
                    if (working.GetValueOrDefault(session.Handle) == identity) completed.Add(session);
                    break;
            }
        }
        working = next;
        foreach (var session in completed) unread[session.Handle] = Identity.Of(session);
        var current = sessions.GroupBy(s => s.Handle).ToDictionary(g => g.Key, g => Identity.Of(g.First()));
        unread = unread.Where(e => current.GetValueOrDefault(e.Key) == e.Value).ToDictionary();
        notified = notified.Where(e => current.GetValueOrDefault(e.Key) == e.Value).ToDictionary();
        return completed;
    }

    /// <summary>The session sent a notification; it shows until the session is viewed.</summary>
    public void MarkNotified(SessionInfo session) => notified[session.Handle] = Identity.Of(session);

    /// <summary>The session was viewed: what it had to review is read. Returns whether anything changed.</summary>
    public bool MarkRead(SessionInfo session)
    {
        var identity = Identity.Of(session);
        var changed = false;
        if (unread.GetValueOrDefault(session.Handle) == identity) changed |= unread.Remove(session.Handle);
        if (notified.GetValueOrDefault(session.Handle) == identity) changed |= notified.Remove(session.Handle);
        return changed;
    }

    /// <summary>The connection was lost: open work cycles end, so a finish is never inferred across the gap.</summary>
    public void ResetCycles() => working.Clear();

    public bool HasUnread(SessionInfo session) => unread.ContainsKey(session.Handle) || notified.ContainsKey(session.Handle);

    /// <summary>A notification shows over working and idle; a prompt waiting for an answer, or an offline session, shows as such.</summary>
    public AgentActivity ActivityOf(SessionInfo session, AgentActivity activity)
    {
        if (notified.GetValueOrDefault(session.Handle) == Identity.Of(session) && activity is not (AgentActivity.NeedsAttention or AgentActivity.Offline))
            return AgentActivity.Notified;
        return activity == AgentActivity.Idle && unread.GetValueOrDefault(session.Handle) == Identity.Of(session) ? AgentActivity.Unread : activity;
    }

    private sealed record Stored(Dictionary<string, Identity> Working, Dictionary<string, Identity> Unread, Dictionary<string, Identity> Notified);

    private static string FilePath => Path.Combine(PairingStore.Directory, "agent-review.json");

    public static ReviewState Load(string? file = null)
    {
        var state = new ReviewState();
        try
        {
            var path = file ?? FilePath;
            if (File.Exists(path) && JsonSerializer.Deserialize<Stored>(File.ReadAllText(path)) is { } stored)
            {
                state.working = stored.Working ?? [];
                state.unread = stored.Unread ?? [];
                state.notified = stored.Notified ?? [];
            }
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException) { }
        return state;
    }

    public void Save(string? file = null)
    {
        try
        {
            var path = file ?? FilePath;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var temp = path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(new Stored(working, unread, notified)));
            File.Move(temp, path, overwrite: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }
}

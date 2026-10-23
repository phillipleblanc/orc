using System.Text.Json.Nodes;
using Orc.Protocol;

namespace Orc.Core;

public enum HostState
{
    /// <summary>Trying for the first time.</summary>
    Connecting,
    Connected,
    /// <summary>Was connected and lost it; trying again.</summary>
    Reconnecting,
    /// <summary>Several tries found nothing at the address; trying less often.</summary>
    Unreachable,
    /// <summary>The host refused this PC's pairing or could not prove its identity. Retrying cannot help; pairing again can.</summary>
    Unauthorized,
    /// <summary>The host speaks another protocol version.</summary>
    Incompatible
}

/// <summary>The control connection's state, why it is in it, and when the next try is.</summary>
public sealed record HostStatus(HostState State, string? Detail = null, int Failures = 0, DateTimeOffset? NextTry = null, HostInfo? Info = null)
{
    public bool IsConnected => State == HostState.Connected;
}

/// <summary>
/// Keeps one control connection to the host and refreshes what Orc.app's sidebar shows, on the Mac app's schedule:
/// every 2 seconds, terminal.list and worktree.list, then terminal.agentStatus for each running session, at most 8 at
/// a time with a 3-second limit each (Sources/OrcApp/OrcApp.swift, Sources/OrcKit/AgentActivity.swift); from hosts
/// that serve them, the session order, agents' briefs every 5 seconds and new <c>orc notify</c> messages. After a failure it retries with
/// backoff (1 s up to 30 s); a refused pairing waits for <see cref="RetryNow"/>.
/// </summary>
public sealed class HostMonitor(Pairing pairing, TimeSpan? interval = null, Func<int, TimeSpan>? backoff = null)
{
    private static readonly TimeSpan StatusTimeout = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan IncompatibleRetry = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan BriefInterval = TimeSpan.FromSeconds(5);
    private readonly TimeSpan interval = interval ?? TimeSpan.FromSeconds(2);
    private readonly Func<int, TimeSpan> backoff = backoff ?? Backoff;
    private readonly SemaphoreSlim wake = new(0, 1);
    private RuntimeConnection? connection;

    /// <summary>A fresh snapshot, on a background thread.</summary>
    public event Action<HostSnapshot>? Updated;

    /// <summary>The control connection changed state, on a background thread.</summary>
    public event Action<HostStatus>? StatusChanged;

    public Pairing Pairing => pairing;

    public HostStatus Status { get; private set; } = new(HostState.Connecting);

    /// <summary>Try now instead of at the next interval or retry, and forget the backoff.</summary>
    public void RetryNow()
    {
        if (wake.CurrentCount == 0) wake.Release();
    }

    /// <summary>Refresh the sessions now, after a command changed them.</summary>
    public void RefreshNow() => RetryNow();

    /// <summary>A request over the control connection, for commands such as creating or closing a session.</summary>
    public Task<JsonObject> RequestAsync(string method, JsonObject? parameters = null, TimeSpan? timeout = null) =>
        (connection ?? throw new HostUnreachableException("This PC isn't connected to the host right now.")).RequestAsync(method, parameters, timeout);

    public static TimeSpan Backoff(int failures) => TimeSpan.FromSeconds(failures switch { <= 1 => 1, 2 => 2, 3 => 4, 4 => 8, 5 => 15, _ => 30 });

    public async Task RunAsync(CancellationToken stop)
    {
        var failures = 0;
        var everConnected = false;
        HostInfo? info = null;
        Report(new HostStatus(HostState.Connecting), always: true);
        while (!stop.IsCancellationRequested)
        {
            try
            {
                if (connection is null)
                {
                    // Trying again keeps the state the last failure set (unreachable stays unreachable), with no next try pending.
                    if (failures > 0) Report(Status with { NextTry = null });
                    var opened = await RuntimeConnection.ConnectAsync(pairing, stop);
                    try { info = await HostPairing.CheckAsync(opened); }
                    catch { await opened.DisposeAsync(); throw; }
                    opened.Closed += _ =>
                    {
                        // Dropped while in use: say so now and try again at once, rather than at the next poll.
                        if (Interlocked.CompareExchange(ref connection, null, opened) != opened) return;
                        Report(Status with { State = HostState.Reconnecting, Detail = "The connection to the host dropped.", NextTry = null });
                        RetryNow();
                    };
                    connection = opened;
                }
                var snapshot = await PollAsync(connection, stop);
                if (info?.Has(HostInfo.OwnerMethods) == true) snapshot = snapshot with { Briefs = await BriefsAsync(connection), Order = await OrderAsync(connection) };
                if (info?.Has(HostInfo.NotifyCursor) == true) snapshot = snapshot with { Notifications = await NotificationsAsync(connection) };
                failures = 0;
                everConnected = true;
                Report(new HostStatus(HostState.Connected, Info: info));
                Updated?.Invoke(snapshot);
                await WaitAsync(interval, stop);
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { break; }
            catch (Exception error)
            {
                if (Interlocked.Exchange(ref connection, null) is { } failed) await failed.DisposeAsync();
                failures++;
                var (state, delay) = error switch
                {
                    HostRefusedException or HostIdentityException => (HostState.Unauthorized, (TimeSpan?)null),
                    HostIncompatibleException => (HostState.Incompatible, IncompatibleRetry),
                    _ => (everConnected && failures <= 3 ? HostState.Reconnecting : HostState.Unreachable, backoff(failures))
                };
                Report(new HostStatus(state, error.Message, failures, delay is { } d ? DateTimeOffset.Now + d : null, info));
                try { await WaitAsync(delay ?? Timeout.InfiniteTimeSpan, stop); }
                catch (OperationCanceledException) { break; }
            }
        }
        // Cleared before disposing, so stopping is not reported as a drop.
        if (Interlocked.Exchange(ref connection, null) is { } last) await last.DisposeAsync();
    }

    private readonly object reporting = new();

    private void Report(HostStatus status, bool always = false)
    {
        lock (reporting)
        {
            if (!always && status == Status) return;
            Status = status;
        }
        StatusChanged?.Invoke(status);
    }

    private async Task WaitAsync(TimeSpan delay, CancellationToken stop) => await wake.WaitAsync(delay, stop);

    private IReadOnlyDictionary<string, AgentBrief>? briefs;
    private DateTimeOffset briefsAt;

    /// <summary>The agents' briefs, read every five seconds as Orc.app reads them (Sources/OrcApp/AgentStatus.swift); the last ones between.</summary>
    private async Task<IReadOnlyDictionary<string, AgentBrief>?> BriefsAsync(RuntimeConnection current)
    {
        if (briefs is not null && DateTimeOffset.Now - briefsAt < BriefInterval) return briefs;
        try
        {
            briefs = AgentBrief.List(await current.RequestAsync("brief.list", timeout: StatusTimeout));
            briefsAt = DateTimeOffset.Now;
        }
        // A host whose briefs are unavailable leaves the last ones.
        catch (Exception error) when (error is TimeoutException or RpcException) { }
        return briefs;
    }

    /// <summary>The host's session order, or null when it does not serve one.</summary>
    private static async Task<SessionOrderRead?> OrderAsync(RuntimeConnection current)
    {
        var asked = DateTimeOffset.Now;
        try
        {
            var result = await current.RequestAsync("session.order.get", timeout: StatusTimeout);
            return new SessionOrderRead((result["keys"] as JsonArray ?? new JsonArray()).Select(k => k?.ToString()).OfType<string>().ToList(), asked);
        }
        catch (Exception error) when (error is TimeoutException or RpcException) { return null; }
    }

    /// <summary>
    /// Where this PC is in the host's <c>orc notify</c> messages; set before running to resume from a saved cursor, and
    /// moved on by each snapshot that carries notifications.
    /// </summary>
    public NotificationCursor? NotificationCursor { get; set; }

    private async Task<NotificationBatch?> NotificationsAsync(RuntimeConnection current)
    {
        try
        {
            var batch = await NotificationFeed.SinceAsync((method, parameters, timeout) => current.RequestAsync(method, parameters, timeout ?? StatusTimeout), NotificationCursor);
            NotificationCursor = batch.Cursor;
            return batch;
        }
        catch (Exception error) when (error is TimeoutException or RpcException) { return null; }
    }

    private static async Task<HostSnapshot> PollAsync(RuntimeConnection connection, CancellationToken stop)
    {
        var list = await connection.RequestAsync("terminal.list", new JsonObject { ["limit"] = 10000 });
        var worktrees = await connection.RequestAsync("worktree.list", new JsonObject { ["limit"] = 10000 });
        var sessions = (list["terminals"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(SessionInfo.FromJson).OfType<SessionInfo>().ToList();
        var projects = (worktrees["worktrees"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(Project.FromJson).OfType<Project>().ToList();

        var activity = new Dictionary<string, AgentActivity>();
        using var limit = new SemaphoreSlim(8);
        await Task.WhenAll(sessions.Where(s => s.Connected).Select(async session =>
        {
            await limit.WaitAsync(stop);
            try
            {
                var reply = await connection.RequestAsync("terminal.agentStatus", new JsonObject { ["terminal"] = session.Handle }, StatusTimeout);
                var status = reply["agentStatus"] as JsonObject;
                var value = status is not null && status["handle"]?.ToString() == session.Handle
                    ? AgentActivities.From(status["isRunningAgent"] is JsonValue running && running.TryGetValue(out bool r) ? r : (bool?)null, status["status"]?.ToString())
                    : AgentActivity.Unknown;
                lock (activity) activity[session.Handle] = value;
            }
            catch (Exception error) when (error is TimeoutException or RpcException)
            {
                lock (activity) activity[session.Handle] = AgentActivity.Unknown;
            }
            finally { limit.Release(); }
        }));
        return new HostSnapshot(sessions, projects, activity, DateTimeOffset.Now);
    }
}

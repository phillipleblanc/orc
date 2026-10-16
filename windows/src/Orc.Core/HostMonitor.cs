using System.Text.Json.Nodes;
using Orc.Protocol;

namespace Orc.Core;

/// <summary>
/// Keeps one control connection to the host and refreshes what Orc.app's sidebar shows, on the Mac app's schedule:
/// every 2 seconds, terminal.list and worktree.list, then terminal.agentStatus for each running session, at most 8 at
/// a time with a 3-second limit each (Sources/OrcApp/OrcApp.swift, Sources/OrcKit/AgentActivity.swift).
/// </summary>
public sealed class HostMonitor(Pairing pairing, TimeSpan? interval = null)
{
    private static readonly TimeSpan StatusTimeout = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan RetryDelay = TimeSpan.FromSeconds(3);
    private readonly TimeSpan interval = interval ?? TimeSpan.FromSeconds(2);
    private readonly SemaphoreSlim wake = new(0, 1);
    private RuntimeConnection? connection;

    /// <summary>A fresh snapshot, on a background thread.</summary>
    public event Action<HostSnapshot>? Updated;

    /// <summary>The control connection's state: null when connected, otherwise why it is not.</summary>
    public event Action<string?>? ConnectionChanged;

    public Pairing Pairing => pairing;

    /// <summary>Refresh now instead of at the next interval.</summary>
    public void RefreshNow()
    {
        if (wake.CurrentCount == 0) wake.Release();
    }

    /// <summary>A request over the control connection, for commands such as creating or closing a session.</summary>
    public Task<JsonObject> RequestAsync(string method, JsonObject? parameters = null, TimeSpan? timeout = null) =>
        (connection ?? throw new IOException("Not connected to the host.")).RequestAsync(method, parameters, timeout);

    public async Task RunAsync(CancellationToken stop)
    {
        string? reported = "";
        void Report(string? state)
        {
            if (state == reported) return;
            reported = state;
            ConnectionChanged?.Invoke(state);
        }

        while (!stop.IsCancellationRequested)
        {
            try
            {
                if (connection is null)
                {
                    var opened = await RuntimeConnection.ConnectAsync(pairing, stop);
                    opened.Closed += _ => { if (ReferenceEquals(connection, opened)) connection = null; };
                    connection = opened;
                }
                var snapshot = await PollAsync(connection, stop);
                Report(null);
                Updated?.Invoke(snapshot);
                await WaitAsync(interval, stop);
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { break; }
            catch (Exception error)
            {
                if (connection is { } failed)
                {
                    connection = null;
                    await failed.DisposeAsync();
                }
                Report(error.Message);
                try { await WaitAsync(RetryDelay, stop); }
                catch (OperationCanceledException) { break; }
            }
        }
        if (connection is { } last) await last.DisposeAsync();
        connection = null;
    }

    private async Task WaitAsync(TimeSpan delay, CancellationToken stop) => await wake.WaitAsync(delay, stop);

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

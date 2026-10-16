using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

namespace Orc.Protocol;

public readonly record struct TerminalSize(int Cols, int Rows)
{
    public TerminalSize Clamped => new(Math.Clamp(Cols, 1, 1000), Math.Clamp(Rows, 1, 500));
    public JsonObject ToJson() => new() { ["cols"] = Clamped.Cols, ["rows"] = Clamped.Rows };
}

/// <summary>The screen to show after a subscription or resnapshot, serialized by the runtime's xterm.</summary>
public sealed record TerminalSnapshot(byte[] Data, int Cols, int Rows, int? KittyKeyboardFlags, bool IsScrollbackReplay);

/// <summary>
/// The size of a session's PTY. For a viewer that follows viewport ownership, also whether this viewer owns the
/// session (the PTY takes its size) and the device grant name of the viewer that does, if any; both are null from a
/// host without viewport ownership.
/// </summary>
public sealed record PtySize(int Cols, int Rows, bool? Owner = null, string? OwnerDevice = null);

/// <summary>
/// What the person did with a shown viewer: <see cref="Strong"/> acts on it (selecting its session, bringing its window
/// forward, clicking, scrolling, typing, resizing); <see cref="Presence"/> is input anywhere on this PC while it is shown.
/// </summary>
public enum ViewAttention { Strong, Presence }

/// <summary>
/// What draws a terminal. The attach controller owns the Orc protocol; a surface only shows bytes. The console spike
/// implements it on a Windows console; the app implements it on xterm.js (and possibly Ghostty later).
/// </summary>
public interface ITerminalSurface
{
    /// <summary>The size this surface wants: the PTY takes it while this viewer owns the session.</summary>
    TerminalSize Size { get; }
    /// <summary>Replace the screen with a snapshot taken at its size, then restore the kitty keyboard flags it reports.</summary>
    void Reset(TerminalSnapshot snapshot);
    void Write(ReadOnlySpan<byte> output);
    /// <summary>The PTY changed size, or its owner changed; output from here on is laid out for this size.</summary>
    void Resized(PtySize size) { }
    void Note(string message);
}

public enum AttachExit { Detached, Ended }

/// <summary>
/// Attaches one terminal over <c>terminal.multiplex</c>, as Sources/OrcKit/TerminalAttach.swift does: subscribe as a
/// desktop client, replay the viewport snapshot, then ask once for 5000 rows of scrollback; type with
/// <c>terminal.send</c> claiming the viewport; claim the size again on every resize; reconnect after drops.
/// <para>
/// On a host with viewport ownership (<c>orc.viewport-ownership.v1</c>) the viewer opts in: its claims only report its
/// size, and <see cref="ReportView"/> tells the host whether it is on screen and what the person did with it
/// (<c>terminal.view</c>), as Orc.app's TerminalViewReport does. The host gives the session the size of the shown
/// viewer the person is using; <see cref="ITerminalSurface.Resized"/> says which one that is.
/// </para>
/// </summary>
public sealed class AttachController(Pairing pairing, string handle, string? incarnationId, ITerminalSurface surface, bool readOnly = false)
{
    public const string ViewportOwnershipCapability = "orc.viewport-ownership.v1";
    private const int MaxQueuedInputBytes = 256 * 1024;
    private const int MaxSnapshotBytes = 8 * 1024 * 1024;
    private const int MaxAttempts = 5;
    /// <summary>The same attention repeated this soon (scrolling, clicking) is reported once.</summary>
    private static readonly TimeSpan RepeatInterval = TimeSpan.FromMilliseconds(250);

    private readonly string clientId = "orc-win-" + Guid.NewGuid();
    private readonly object gate = new();

    // What the person sees of this viewer, kept across reconnects, and what is still to be reported.
    private bool viewShown = true;
    private ViewAttention? pendingAttention;
    private (ViewAttention Attention, long At)? lastAttention;
    private readonly Queue<string> inputQueue = new();
    private readonly SemaphoreSlim draining = new(1, 1);
    private readonly List<double> echoSamples = [];
    private int inputBytes;
    private long echoStartedAt;

    // Per-connection state, reset on every reconnect.
    private RuntimeConnection? connection;
    private TaskCompletionSource<Exception?> disconnect = new();
    private uint? streamId;
    private bool ready;
    private bool collecting;
    private bool snapshotUnavailable;
    private int? snapshotKeyboardFlags;
    private int snapshotCols, snapshotRows;
    private bool requestedScrollback, scrollbackPending, replayingScrollback;
    private int? activeKeyboardFlags;
    private bool followsOwnership;
    private bool viewing;
    private bool? reportedShown;
    private int resizedFrames;
    private Task viewSending = Task.CompletedTask;
    private readonly MemoryStream snapshot = new();
    private readonly HashSet<byte> unknownOpcodes = [];

    private volatile bool stopping;
    private volatile bool ended;

    /// <summary>This viewer's id on the host, the same across reconnects.</summary>
    public string ClientId => clientId;

    /// <summary>Whether the connected host gives the session the size of the viewer the person is looking at.</summary>
    public bool FollowsOwnership { get { lock (gate) return followsOwnership; } }

    /// <summary>Milliseconds from sending input to the next output frame, one sample per keystroke burst.</summary>
    public IReadOnlyList<double> EchoSamples { get { lock (gate) return echoSamples.ToArray(); } }

    public async Task<AttachExit> RunAsync(CancellationToken stop)
    {
        using var registration = stop.Register(() => Stop());
        var attempts = 0;
        var connectedOnce = false;
        Exception? failure = null;
        while (!this.stopping && !ended)
        {
            ResetConnectionState();
            failure = null;
            RuntimeConnection? current = null;
            try
            {
                current = await RuntimeConnection.ConnectAsync(pairing, stop);
                lock (gate) connection = current;
                current.FrameReceived += Receive;
                current.Closed += (error) => Disconnected(error);

                var status = await current.RequestAsync("status.get");
                var capabilities = (status["capabilities"] as JsonArray)?.Select(value => value?.GetValue<string>()).ToHashSet() ?? [];
                if (!capabilities.Contains("terminal.binary-stream.v1") || !capabilities.Contains("terminal.multiplex.v1"))
                    throw new InvalidOperationException("The runtime does not advertise terminal multiplex streaming.");
                lock (gate) followsOwnership = !readOnly && capabilities.Contains(ViewportOwnershipCapability);

                // Reattaching to a replaced process must take another explicit attach.
                var list = await current.RequestAsync("terminal.list");
                var live = (list["terminals"] as JsonArray)?.OfType<JsonObject>().FirstOrDefault(t => t["handle"]?.GetValue<string>() == handle);
                if (live is null || live["connected"]?.GetValue<bool>() != true
                    || (incarnationId is not null && live["incarnationId"]?.GetValue<string>() != incarnationId))
                {
                    ended = true;
                    throw new InvalidOperationException("The original terminal exited or was replaced. Run `orcspike list` to choose a session.");
                }

                // Before subscribing, so a hidden terminal that reconnects is hidden from the start and never sizes its session.
                Task initialView;
                lock (gate)
                {
                    viewing = followsOwnership;
                    initialView = FlushView();
                }
                await initialView;

                await current.SubscribeAsync("terminal.multiplex", new JsonObject(), "orc-stream", OnStreamEvent);
                connectedOnce = true;
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                using var deadlineRegistration = deadline.Token.Register(() => { if (!IsReady) Disconnected(new TimeoutException("The runtime did not send a terminal snapshot.")); });
                failure = await disconnect.Task;
                if (IsReady) attempts = 0;
            }
            catch (Exception error) { failure = error; }
            finally
            {
                lock (gate) { connection = null; ready = false; }
                if (current is not null) await current.DisposeAsync();
            }

            if (this.stopping || ended) break;
            if (!connectedOnce || attempts >= MaxAttempts) throw failure ?? new IOException("The runtime disconnected.");
            attempts++;
            lock (gate) { inputQueue.Clear(); inputBytes = 0; }
            surface.Note($"Connection lost ({failure?.Message ?? "closed"}). Reconnecting ({attempts}/{MaxAttempts}); input is paused.");
            try { await Task.Delay(TimeSpan.FromSeconds(Math.Min(8, attempts * 2)), stop); }
            catch (OperationCanceledException) { break; }
        }
        if (ended && !this.stopping)
        {
            if (failure is not null && failure is not IOException) surface.Note(failure.Message);
            surface.Note("Session ended.");
            return AttachExit.Ended;
        }
        return AttachExit.Detached;
    }

    private bool IsReady { get { lock (gate) return ready; } }

    /// <summary>Queues typed text; it is sent in order, coalesced while a send is in flight. Nothing is retried.</summary>
    public void SendInput(string text)
    {
        if (readOnly || text.Length == 0) return;
        lock (gate)
        {
            if (!ready || stopping) return;
            var bytes = Encoding.UTF8.GetByteCount(text);
            if (inputBytes + bytes > MaxQueuedInputBytes)
            {
                surface.Note("Input buffer full; detaching to avoid losing input silently.");
                Stop();
                return;
            }
            inputQueue.Enqueue(text);
            inputBytes += bytes;
        }
        _ = DrainInputAsync();
    }

    /// <summary>
    /// The surface changed size: claim the PTY for it, as a desktop does on SIGWINCH. With viewport ownership this only
    /// reports the size, which the PTY takes while this viewer owns the session.
    /// </summary>
    public void ViewportChanged()
    {
        if (!readOnly) _ = SendFrameAsync(Opcode.ClaimViewport, () => Encoding.UTF8.GetBytes(surface.Size.ToJson().ToJsonString()));
    }

    /// <summary>
    /// Whether the terminal is on screen, and any attention the person just gave it. Reported to the host in order
    /// when it follows viewport ownership; kept until the next connection while there is none, and ignored by hosts
    /// without it. A hidden viewer has no attention.
    /// </summary>
    public void ReportView(bool shown, ViewAttention? attention = null)
    {
        if (readOnly) return;
        lock (gate)
        {
            var changed = shown != viewShown;
            viewShown = shown;
            if (!shown) attention = null;
            var now = Stopwatch.GetTimestamp();
            if (attention is { } repeated && !changed && lastAttention is { } last && last.Attention == repeated
                && Stopwatch.GetElapsedTime(last.At, now) < RepeatInterval) attention = null;
            if (attention is { } given)
            {
                lastAttention = (given, now);
                if (pendingAttention != ViewAttention.Strong) pendingAttention = given;
            }
            else if (!shown) pendingAttention = null;
            _ = FlushView();
        }
    }

    /// <summary>Sends what the host has not heard of this viewer yet, after any report still in flight. Holds the gate.</summary>
    private Task FlushView()
    {
        if (!viewing || stopping || connection is not { } current || (reportedShown == viewShown && pendingAttention is null)) return viewSending;
        var request = new JsonObject
        {
            ["terminal"] = handle, ["client"] = new JsonObject { ["id"] = clientId }, ["shown"] = viewShown
        };
        if (pendingAttention is { } attention) request["attention"] = attention == ViewAttention.Strong ? "strong" : "presence";
        reportedShown = viewShown;
        pendingAttention = null;
        return viewSending = SendViewAsync(viewSending, current, request, resizedFrames);
    }

    private async Task SendViewAsync(Task previous, RuntimeConnection current, JsonObject request, int framesAtSend)
    {
        await previous;
        JsonObject result;
        // A host restarting leaves the session's size as it was; the next connection reports the view again.
        try { result = await current.RequestAsync("terminal.view", request, TimeSpan.FromSeconds(3)); }
        catch (Exception) { return; }
        lock (gate)
        {
            // A Resized frame that arrived meanwhile is at least as recent as this reply.
            if (connection != current || resizedFrames != framesAtSend || stopping) return;
            if (ReadPtySize(result) is { } size) surface.Resized(size);
        }
    }

    private static PtySize? ReadPtySize(JsonObject value)
    {
        if (value["cols"] is not JsonValue c || !c.TryGetValue(out int cols) || value["rows"] is not JsonValue r || !r.TryGetValue(out int rows)) return null;
        bool? owner = value["owner"] is JsonValue o && o.TryGetValue(out bool owns) ? owns : null;
        var device = value["ownerDevice"] is JsonValue d && d.TryGetValue(out string? name) ? name : null;
        return new PtySize(cols, rows, owner, device);
    }

    public void Stop()
    {
        lock (gate)
        {
            if (stopping) return;
            stopping = true;
            inputQueue.Clear();
            inputBytes = 0;
        }
        Disconnected(null);
    }

    private async Task DrainInputAsync()
    {
        if (!await draining.WaitAsync(0)) return;
        try
        {
            while (true)
            {
                string text;
                RuntimeConnection? current;
                lock (gate)
                {
                    if (inputQueue.Count == 0 || !ready || stopping || connection is null) return;
                    var batch = new StringBuilder();
                    while (inputQueue.Count > 0 && batch.Length < 64 * 1024) batch.Append(inputQueue.Dequeue());
                    text = batch.ToString();
                    inputBytes = Math.Max(0, inputBytes - Encoding.UTF8.GetByteCount(text));
                    current = connection;
                    if (echoStartedAt == 0) echoStartedAt = Stopwatch.GetTimestamp();
                }
                try
                {
                    var result = await current.RequestAsync("terminal.send", new JsonObject
                    {
                        ["terminal"] = handle, ["text"] = text, ["enter"] = false,
                        ["client"] = new JsonObject { ["id"] = clientId, ["type"] = "desktop" },
                        ["viewport"] = surface.Size.ToJson(), ["claimViewport"] = true
                    });
                    var send = result["send"] as JsonObject ?? result;
                    if (send["accepted"]?.GetValue<bool>() == false)
                        surface.Note("Input not accepted: another client (a phone?) controls this session.");
                }
                catch (Exception error)
                {
                    if (IsStopping) return;
                    surface.Note($"Input delivery uncertain; it was not retried. {error.Message}");
                    Disconnected(error);
                    return;
                }
            }
        }
        finally { draining.Release(); }
    }

    private bool IsStopping { get { lock (gate) return stopping; } }

    private void OnStreamEvent(JsonObject value)
    {
        var type = value["type"]?.GetValue<string>();
        switch (type)
        {
            case "ready":
                lock (gate)
                {
                    if (streamId is not null) return;
                    streamId = 1;
                }
                _ = SendSubscribeAsync();
                break;
            case "subscribed":
                lock (gate) if (value["streamId"] is JsonValue id) streamId = id.GetValue<uint>();
                break;
            case "end":
                // A per-session end carries its stream id: the program exited. Without one, the stream itself closed.
                if (value["streamId"] is not null) ended = true;
                Disconnected(null);
                break;
            case "error":
                Disconnected(new IOException(value["message"]?.GetValue<string>() ?? "The terminal stream failed."));
                break;
        }
    }

    private Task SendSubscribeAsync()
    {
        var size = surface.Size;
        return SendFrameAsync(Opcode.Subscribe, () => Encoding.UTF8.GetBytes(new JsonObject
        {
            ["streamId"] = 1, ["terminal"] = handle,
            ["client"] = new JsonObject { ["id"] = clientId, ["type"] = "desktop" },
            ["viewport"] = size.ToJson(),
            ["capabilities"] = FollowsOwnership
                ? new JsonObject { ["desktopViewportClaims"] = 1, ["writeUnavailable"] = 1, ["viewportOwnership"] = 1 }
                : new JsonObject { ["desktopViewportClaims"] = 1, ["writeUnavailable"] = 1 }
        }.ToJsonString()), controlStream: true);
    }

    private async Task SendFrameAsync(byte opcode, Func<byte[]> payload, bool controlStream = false)
    {
        RuntimeConnection? current;
        uint id;
        lock (gate)
        {
            current = connection;
            if (current is null || (!controlStream && streamId is null)) return;
            id = controlStream ? 0 : streamId!.Value;
        }
        try { await current.SendFrameAsync(new TerminalFrame(opcode, id, 0, payload())); }
        catch (Exception error) { if (!IsStopping) Disconnected(error); }
    }

    private void Receive(TerminalFrame frame)
    {
        try
        {
            lock (gate)
            {
                if (stopping) return;
                if (streamId is { } id && frame.StreamId != id) throw new IOException("Mismatched terminal stream.");
                switch (frame.Opcode)
                {
                    case Opcode.Output:
                        Echoed();
                        surface.Write(frame.Payload.Span);
                        break;
                    case Opcode.OutputSpan:
                        Echoed();
                        var span = JsonNode.Parse(frame.Payload.Span)?["data"]?.GetValue<string>() ?? throw new IOException("Invalid terminal output span.");
                        surface.Write(Encoding.UTF8.GetBytes(span));
                        break;
                    case Opcode.SnapshotStart:
                        collecting = true;
                        snapshot.SetLength(0);
                        replayingScrollback = scrollbackPending;
                        scrollbackPending = false;
                        var metadata = JsonNode.Parse(frame.Payload.Span) as JsonObject ?? new JsonObject();
                        snapshotUnavailable = metadata["unavailable"] is not null;
                        snapshotKeyboardFlags = metadata["kittyKeyboardFlags"] is JsonValue flags && flags.TryGetValue(out int f) && f is >= 0 and <= 31 ? f : null;
                        snapshotCols = metadata["cols"] is JsonValue c && c.TryGetValue(out int cols) ? cols : surface.Size.Cols;
                        snapshotRows = metadata["rows"] is JsonValue r && r.TryGetValue(out int rows) ? rows : surface.Size.Rows;
                        break;
                    case Opcode.SnapshotChunk:
                        if (!collecting || snapshot.Length + frame.Payload.Length > MaxSnapshotBytes) throw new IOException("Invalid or oversized terminal snapshot.");
                        snapshot.Write(frame.Payload.Span);
                        break;
                    case Opcode.SnapshotEnd:
                        if (!collecting) throw new IOException("Unexpected snapshot end.");
                        collecting = false;
                        if (snapshotUnavailable)
                        {
                            surface.Note("The runtime could not provide retained scrollback; keeping the live screen.");
                            break;
                        }
                        // Scrollback replay is historical: its keyboard flags can be zero while the live agent is still in
                        // kitty mode, so keep the current flags rather than turning Shift+Enter into Enter.
                        if (!replayingScrollback || activeKeyboardFlags is null) activeKeyboardFlags = snapshotKeyboardFlags;
                        surface.Reset(new TerminalSnapshot(snapshot.ToArray(), snapshotCols, snapshotRows, activeKeyboardFlags, replayingScrollback));
                        ready = true;
                        // A read-only viewer never sizes the PTY, as `orc attach --read-only` doesn't. With viewport
                        // ownership this reports the size, which the PTY takes only while this viewer owns the session.
                        if (!readOnly) _ = SendFrameAsync(Opcode.ClaimViewport, () => Encoding.UTF8.GetBytes(surface.Size.ToJson().ToJsonString()));
                        if (!requestedScrollback)
                        {
                            requestedScrollback = true;
                            scrollbackPending = true;
                            // Desktop subscriptions start with the viewport only; this replaces it with history and lets the
                            // runtime drop buffered output the snapshot already covers.
                            _ = SendFrameAsync(Opcode.SnapshotRequest, () => Encoding.UTF8.GetBytes("{\"scrollbackRows\":5000}"));
                        }
                        break;
                    case Opcode.Resized:
                        resizedFrames++;
                        if (JsonNode.Parse(frame.Payload.Span) is JsonObject resized && ReadPtySize(resized) is { } size) surface.Resized(size);
                        break;
                    case Opcode.Metadata:
                        break;
                    case Opcode.Error:
                        var error = JsonNode.Parse(frame.Payload.Span);
                        if (error?["code"]?.GetValue<string>() == "terminal_not_found") ended = true;
                        throw new IOException(error?["message"]?.GetValue<string>() ?? "The runtime reported a terminal stream error.");
                    case Opcode.WriteUnavailable:
                        surface.Note("The runtime refused terminal input.");
                        break;
                    default:
                        if (unknownOpcodes.Add(frame.Opcode)) surface.Note($"Ignoring terminal opcode {frame.Opcode}.");
                        break;
                }
            }
        }
        catch (Exception error) { Disconnected(error); }
    }

    private void Echoed()
    {
        if (echoStartedAt == 0) return;
        echoSamples.Add(Stopwatch.GetElapsedTime(echoStartedAt).TotalMilliseconds);
        echoStartedAt = 0;
    }

    private void ResetConnectionState()
    {
        lock (gate)
        {
            disconnect = new TaskCompletionSource<Exception?>(TaskCreationOptions.RunContinuationsAsynchronously);
            streamId = null; ready = false; collecting = false; snapshot.SetLength(0);
            requestedScrollback = false; scrollbackPending = false; replayingScrollback = false;
            activeKeyboardFlags = null; snapshotUnavailable = false; snapshotKeyboardFlags = null;
            echoStartedAt = 0;
            followsOwnership = false; viewing = false; reportedShown = null; viewSending = Task.CompletedTask;
        }
    }

    private void Disconnected(Exception? error)
    {
        TaskCompletionSource<Exception?> current;
        lock (gate) { ready = false; current = disconnect; }
        current.TrySetResult(error);
    }
}

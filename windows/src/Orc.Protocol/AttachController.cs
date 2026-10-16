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
/// What draws a terminal. The attach controller owns the Orc protocol; a surface only shows bytes. The console spike
/// implements it on a Windows console; the app will implement it on xterm.js (and possibly Ghostty later).
/// </summary>
public interface ITerminalSurface
{
    TerminalSize Size { get; }
    /// <summary>Replace the screen with a snapshot, then restore the kitty keyboard flags it reports.</summary>
    void Reset(TerminalSnapshot snapshot);
    void Write(ReadOnlySpan<byte> output);
    void Note(string message);
}

public enum AttachExit { Detached, Ended }

/// <summary>
/// Attaches one terminal over <c>terminal.multiplex</c>, as Sources/OrcKit/TerminalAttach.swift does: subscribe as a
/// desktop client, replay the viewport snapshot, then ask once for 5000 rows of scrollback; type with
/// <c>terminal.send</c> claiming the viewport; claim the size again on every resize; reconnect after drops.
/// </summary>
public sealed class AttachController(Pairing pairing, string handle, string? incarnationId, ITerminalSurface surface, bool readOnly = false)
{
    private const int MaxQueuedInputBytes = 256 * 1024;
    private const int MaxSnapshotBytes = 8 * 1024 * 1024;
    private const int MaxAttempts = 5;

    private readonly string clientId = "orc-win-" + Guid.NewGuid();
    private readonly object gate = new();
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
    private readonly MemoryStream snapshot = new();
    private readonly HashSet<byte> unknownOpcodes = [];

    private volatile bool stopping;
    private volatile bool ended;

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

                // Reattaching to a replaced process must take another explicit attach.
                var list = await current.RequestAsync("terminal.list");
                var live = (list["terminals"] as JsonArray)?.OfType<JsonObject>().FirstOrDefault(t => t["handle"]?.GetValue<string>() == handle);
                if (live is null || live["connected"]?.GetValue<bool>() != true
                    || (incarnationId is not null && live["incarnationId"]?.GetValue<string>() != incarnationId))
                {
                    ended = true;
                    throw new InvalidOperationException("The original terminal exited or was replaced. Run `orcspike list` to choose a session.");
                }

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

    /// <summary>The surface changed size: claim the PTY for it, as a desktop does on SIGWINCH.</summary>
    public void ViewportChanged()
    {
        if (!readOnly) _ = SendFrameAsync(Opcode.ClaimViewport, () => Encoding.UTF8.GetBytes(surface.Size.ToJson().ToJsonString()));
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
            ["capabilities"] = new JsonObject { ["desktopViewportClaims"] = 1, ["writeUnavailable"] = 1 }
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
                        // A read-only viewer never sizes the PTY, as `orc attach --read-only` doesn't.
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
        }
    }

    private void Disconnected(Exception? error)
    {
        TaskCompletionSource<Exception?> current;
        lock (gate) { ready = false; current = disconnect; }
        current.TrySetResult(error);
    }
}

using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Orc.Protocol;

public sealed class RpcException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>
/// One encrypted WebSocket to an Orc runtime: the E2EE v1 handshake authenticated by a device token, then JSON RPC in
/// text frames (base64 of a sealed message) and terminal stream frames in binary frames (the sealed bytes).
/// Mirrors slim/frontend/src/websocket-server.ts and Sources/OrcKit/Wire.swift.
/// </summary>
public sealed class RuntimeConnection : IAsyncDisposable
{
    private const int MaxMessageBytes = 32 << 20;
    private static readonly TimeSpan HandshakeTimeout = TimeSpan.FromSeconds(12);
    private static readonly TimeSpan DefaultRequestTimeout = TimeSpan.FromSeconds(15);

    private readonly ClientWebSocket socket = new();
    private readonly Pairing pairing;
    private readonly E2eeChannel channel;
    private readonly SemaphoreSlim sendLock = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonObject>> pending = new();
    private readonly ConcurrentDictionary<string, Action<JsonObject>> streams = new();
    private readonly CancellationTokenSource closing = new();
    private Task? receiving;
    private int closed;

    /// <summary>A terminal stream frame from the runtime.</summary>
    public event Action<TerminalFrame>? FrameReceived;

    /// <summary>The connection ended; null when this side closed it.</summary>
    public event Action<Exception?>? Closed;

    /// <summary>The runtime instance that answered; it changes when the runtime's frontend restarts.</summary>
    public string? RuntimeId { get; private set; }

    private RuntimeConnection(Pairing pairing)
    {
        this.pairing = pairing;
        channel = new E2eeChannel(pairing.PublicKey);
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
        socket.Options.KeepAliveTimeout = TimeSpan.FromSeconds(10);
    }

    public static async Task<RuntimeConnection> ConnectAsync(Pairing pairing, CancellationToken cancellation = default)
    {
        RuntimeConnection connection;
        // libsodium refuses keys that cannot be a host's (all zeros, low-order points): the pairing itself is bad.
        try { connection = new RuntimeConnection(pairing); }
        catch (InvalidOperationException) { throw new HostIdentityException("The pairing's host key isn't a valid key. Pair again with a new link."); }
        try
        {
            await connection.HandshakeAsync(cancellation);
            connection.receiving = Task.Run(connection.ReceiveLoopAsync);
            return connection;
        }
        catch
        {
            await connection.DisposeAsync();
            throw;
        }
    }

    private async Task HandshakeAsync(CancellationToken cancellation)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(HandshakeTimeout);
        var endpoint = pairing.EndpointUri;
        if (LocalNames.IsLocal(endpoint.Host))
        {
            IPAddress? address;
            try { address = await LocalNames.ResolveAsync(endpoint.Host, timeout.Token); }
            catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { address = null; }
            cancellation.ThrowIfCancellationRequested();
            if (address is null)
                throw new HostUnreachableException($"No computer named {endpoint.Host} answered on this network. Check that the host is awake "
                    + "and on this network, or change the address to its IP address.");
            endpoint = new UriBuilder(endpoint) { Host = address.ToString() }.Uri;
        }
        try
        {
            await socket.ConnectAsync(endpoint, timeout.Token);
        }
        catch (Exception error) when (error is WebSocketException or OperationCanceledException or HttpRequestException)
        {
            if (cancellation.IsCancellationRequested) throw;
            throw new HostUnreachableException($"Nothing answered at {pairing.EndpointUri.Host}. Check that the host is awake, on this "
                + "network, and running Orc.", error);
        }

        try
        {
            var hello = new JsonObject { ["type"] = "e2ee_hello", ["publicKeyB64"] = Convert.ToBase64String(channel.PublicKey) };
            await socket.SendAsync(Encoding.UTF8.GetBytes(hello.ToJsonString()), WebSocketMessageType.Text, true, timeout.Token);

            var (readyType, readyBytes) = await ReceiveMessageAsync(timeout.Token);
            if (readyType != WebSocketMessageType.Text || ParseObject(readyBytes)?["type"]?.GetValue<string>() != "e2ee_ready")
                throw new HostIncompatibleException("The host did not start an Orc encryption handshake. Is this an Orc host?");

            await SendJsonAsync(new JsonObject { ["type"] = "e2ee_auth", ["deviceToken"] = pairing.DeviceToken }, timeout.Token);
            var (authType, authBytes) = await ReceiveMessageAsync(timeout.Token);
            if (authType == WebSocketMessageType.Close)
            {
                // The runtime closes with 4001 for a token it does not know and 4003 for a message it cannot decrypt.
                if ((int?)socket.CloseStatus == 4003) throw new HostIdentityException(IdentityProblem);
                throw new HostRefusedException(RefusedProblem);
            }
            var auth = authType == WebSocketMessageType.Text ? OpenText(authBytes) : null;
            switch (auth?["type"]?.GetValue<string>())
            {
                case "e2ee_authenticated": return;
                case "e2ee_error": throw new HostRefusedException(RefusedProblem);
                default: throw new HostIdentityException(IdentityProblem);
            }
        }
        catch (Exception error) when (error is WebSocketException or OperationCanceledException && !cancellation.IsCancellationRequested)
        {
            throw new HostUnreachableException($"The connection to {pairing.EndpointUri.Host} dropped during the handshake.", error);
        }
    }

    private const string RefusedProblem = "The host refused this PC's pairing. Its access may have been revoked; pair again with a new link.";
    private const string IdentityProblem = "The host at this address isn't the one this PC paired with: it can't prove it holds the paired key. "
        + "Pair again if the host's Orc was reset.";

    public async Task<JsonObject> RequestAsync(string method, JsonObject? parameters = null, TimeSpan? timeout = null)
    {
        var id = Guid.NewGuid().ToString();
        var completion = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[id] = completion;
        try
        {
            await SendJsonAsync(Request(id, method, parameters), closing.Token);
            var finished = await Task.WhenAny(completion.Task, Task.Delay(timeout ?? DefaultRequestTimeout));
            if (finished != completion.Task) throw new TimeoutException($"The runtime did not answer {method} in time. It was not retried.");
            return await completion.Task;
        }
        finally { pending.TryRemove(id, out _); }
    }

    /// <summary>Starts a streaming method; <paramref name="onEvent"/> receives each event, ending with <c>{type: "end"}</c>.</summary>
    public async Task SubscribeAsync(string method, JsonObject parameters, string id, Action<JsonObject> onEvent)
    {
        streams[id] = onEvent;
        await SendJsonAsync(Request(id, method, parameters), closing.Token);
    }

    public async Task SendFrameAsync(TerminalFrame frame) => await SendAsync(channel.Seal(frame.Encode()), WebSocketMessageType.Binary, closing.Token);

    private JsonObject Request(string id, string method, JsonObject? parameters) =>
        new() { ["id"] = id, ["method"] = method, ["params"] = parameters ?? new JsonObject(), ["deviceToken"] = pairing.DeviceToken };

    private Task SendJsonAsync(JsonObject value, CancellationToken cancellation) =>
        SendAsync(Encoding.ASCII.GetBytes(Convert.ToBase64String(channel.Seal(Encoding.UTF8.GetBytes(value.ToJsonString())))),
            WebSocketMessageType.Text, cancellation);

    private async Task SendAsync(byte[] bytes, WebSocketMessageType type, CancellationToken cancellation)
    {
        if (Volatile.Read(ref closed) == 1) throw new IOException("The runtime connection is closed.");
        // ClientWebSocket allows one send at a time.
        await sendLock.WaitAsync(cancellation);
        try { await socket.SendAsync(bytes, type, true, cancellation); }
        finally { sendLock.Release(); }
    }

    private async Task ReceiveLoopAsync()
    {
        Exception? failure = null;
        try
        {
            while (!closing.IsCancellationRequested)
            {
                var (type, bytes) = await ReceiveMessageAsync(closing.Token);
                if (type == WebSocketMessageType.Close)
                {
                    failure = new IOException("The runtime closed the connection" + (socket.CloseStatusDescription is { Length: > 0 } reason ? $": {reason}." : "."));
                    break;
                }
                if (type == WebSocketMessageType.Binary)
                {
                    var opened = channel.Open(bytes) ?? throw new IOException("A terminal frame failed authentication.");
                    if (TerminalFrame.Decode(opened) is { } frame) FrameReceived?.Invoke(frame);
                    continue;
                }
                Dispatch(OpenText(bytes) ?? throw new IOException("A runtime reply failed authentication."));
            }
        }
        catch (OperationCanceledException) when (closing.IsCancellationRequested) { }
        catch (Exception error) { failure = error; }
        Shutdown(failure);
    }

    private void Dispatch(JsonObject response)
    {
        if (response["_keepalive"]?.GetValue<bool>() == true) return;
        if (response["_meta"]?["runtimeId"]?.GetValue<string>() is { } runtimeId) RuntimeId = runtimeId;
        if (response["id"]?.GetValue<string>() is not { } id) return;
        var ok = response["ok"]?.GetValue<bool>() == true;
        if (streams.TryGetValue(id, out var onEvent))
        {
            var result = ok ? response["result"] as JsonObject ?? new JsonObject() : ErrorEvent(response);
            if (result["type"]?.GetValue<string>() is "end" or "error" && result["streamId"] is null) streams.TryRemove(id, out _);
            onEvent(result);
            return;
        }
        if (!pending.TryGetValue(id, out var completion)) return;
        if (ok) completion.TrySetResult(response["result"] as JsonObject ?? new JsonObject());
        else completion.TrySetException(new RpcException(response["error"]?["code"]?.GetValue<string>() ?? "internal_error",
            response["error"]?["message"]?.GetValue<string>() ?? "The runtime rejected the request."));
    }

    private static JsonObject ErrorEvent(JsonObject response) => new()
    {
        ["type"] = "error",
        ["code"] = response["error"]?["code"]?.GetValue<string>() ?? "internal_error",
        ["message"] = response["error"]?["message"]?.GetValue<string>() ?? "The stream failed."
    };

    private async Task<(WebSocketMessageType Type, byte[] Bytes)> ReceiveMessageAsync(CancellationToken cancellation)
    {
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, cancellation);
            if (result.MessageType == WebSocketMessageType.Close) return (WebSocketMessageType.Close, []);
            message.Write(buffer, 0, result.Count);
            if (message.Length > MaxMessageBytes) throw new IOException("A runtime message exceeded 32 MiB.");
            if (result.EndOfMessage) return (result.MessageType, message.ToArray());
        }
    }

    private JsonObject? OpenText(byte[] bytes)
    {
        byte[] sealedBytes;
        try { sealedBytes = Convert.FromBase64String(Encoding.ASCII.GetString(bytes)); }
        catch (FormatException) { return null; }
        return channel.Open(sealedBytes) is { } opened ? ParseObject(opened) : null;
    }

    private static JsonObject? ParseObject(byte[] bytes)
    {
        try { return JsonNode.Parse(bytes) as JsonObject; }
        catch (JsonException) { return null; }
    }

    private void Shutdown(Exception? failure)
    {
        if (Interlocked.Exchange(ref closed, 1) == 1) return;
        closing.Cancel();
        var error = failure ?? new IOException("Detached from the runtime.");
        foreach (var completion in pending.Values) completion.TrySetException(error);
        foreach (var onEvent in streams.Values) onEvent(new JsonObject { ["type"] = "error", ["code"] = "disconnected", ["message"] = error.Message });
        streams.Clear();
        Closed?.Invoke(failure);
    }

    public async ValueTask DisposeAsync()
    {
        Shutdown(null);
        try
        {
            if (socket.State == WebSocketState.Open)
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "detached", timeout.Token);
            }
        }
        catch { /* The socket is going away either way. */ }
        if (receiving is not null) await Task.WhenAny(receiving, Task.Delay(1000));
        socket.Dispose();
        channel.Dispose();
    }
}

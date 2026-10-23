using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Orc.Protocol;

namespace Orc.Protocol.Tests;

/// <summary>
/// A stand-in for the runtime's WebSocket (slim/frontend/src/websocket-server.ts and multiplex.ts) with one terminal.
/// It proves this client's framing and flows, not interop with tweetnacl; `orcspike probe` against a Mac does that.
/// </summary>
internal sealed class FakeRuntime : IAsyncDisposable
{
    public const string Handle = "term-1";
    public const string Token = "fake-device-token";
    private const string RuntimeId = "fake-runtime";

    private readonly HttpListener listener = new();
    private readonly byte[] publicKey = new byte[32];
    private readonly byte[] secretKey = new byte[32];
    private readonly CancellationTokenSource stopping = new();
    private readonly ConcurrentBag<Session> sessions = [];
    private readonly Task accepting;

    public ConcurrentQueue<string> Inputs { get; } = new();
    public ConcurrentQueue<string> Claims { get; } = new();
    public ConcurrentQueue<string> Subscribes { get; } = new();
    /// <summary>Lifecycle requests (create, rename, close, restart) with their parameters, in order.</summary>
    public ConcurrentQueue<(string Method, string Parameters)> Calls { get; } = new();
    public int SnapshotRequests;
    public int Port { get; }
    /// <summary>What terminal.agentStatus reports for the terminal: working, permission or idle.</summary>
    public volatile string AgentState = "working";
    /// <summary>What status.get reports: the protocol version and the grant's scope.</summary>
    public volatile int ProtocolVersion = 3;
    public volatile string DeviceScope = "runtime";
    /// <summary>WebSocket connections accepted so far.</summary>
    public int Connections;
    /// <summary>Capabilities status.get reports besides terminal streaming.</summary>
    public string[] Capabilities = ["orc.agents.v1"];
    /// <summary>terminal.view requests, in order, and what they are answered with.</summary>
    public ConcurrentQueue<string> Views { get; } = new();
    public JsonObject ViewReply = new() { ["owner"] = false, ["cols"] = 120, ["rows"] = 40, ["ownerDevice"] = "Studio" };
    /// <summary>The headline of the terminal's brief, from a host with owner methods.</summary>
    public volatile string Headline = "Writing the tests";
    /// <summary>The session order session.order.get serves, from a host with owner methods.</summary>
    public volatile string[] Order = ["fake-agent"];
    /// <summary>`orc notify` messages kept, oldest first, numbered from 1; notify.since serves them as notifications.ts does.</summary>
    public readonly List<string> Notices = [];

    private JsonObject NotifySince(JsonObject parameters)
    {
        lock (Notices)
        {
            long latest = Notices.Count;
            long? after = parameters["after"] is JsonValue a && a.TryGetValue(out long n) ? n : null;
            var known = after is { } cursor && cursor >= 0 && cursor <= latest;
            var from = known ? after!.Value : Math.Max(0, latest - 20);
            var list = new JsonArray();
            for (var seq = from + 1; seq <= latest; seq++)
                list.Add(new JsonObject
                {
                    ["id"] = $"n{seq}", ["seq"] = seq, ["session"] = "fake-agent", ["handle"] = Handle, ["message"] = Notices[(int)seq - 1],
                    ["at"] = DateTimeOffset.Now.ToUnixTimeMilliseconds()
                });
            return new JsonObject { ["runtimeId"] = RuntimeId, ["notifications"] = list, ["latest"] = latest };
        }
    }

    /// <summary>Sends every subscribed viewer a Resized frame with <paramref name="payload"/>.</summary>
    public async Task ResizedAsync(JsonObject payload)
    {
        foreach (var session in sessions) await session.ResizedAsync(payload);
    }

    /// <summary>Drops every open connection, as a network blip or a runtime restart would.</summary>
    public void DropConnections()
    {
        foreach (var session in sessions) session.Abort();
    }

    public FakeRuntime()
    {
        Sodium.Keypair(publicKey, secretKey);
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        Port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        listener.Prefixes.Add($"http://localhost:{Port}/");
        listener.Start();
        accepting = Task.Run(AcceptLoopAsync);
    }

    public Pairing Pairing(string token = Token) =>
        new($"ws://localhost:{Port}", token, Convert.ToBase64String(publicKey), "runtime", "fake-device");

    /// <summary>The program in the terminal exits: every viewer gets the per-session end event.</summary>
    public async Task EndSessionAsync()
    {
        foreach (var session in sessions) await session.EndAsync();
    }

    private async Task AcceptLoopAsync()
    {
        while (!stopping.IsCancellationRequested)
        {
            HttpListenerContext context;
            try { context = await listener.GetContextAsync(); }
            catch { return; }
            if (!context.Request.IsWebSocketRequest)
            {
                context.Response.StatusCode = 426;
                context.Response.Close();
                continue;
            }
            var socket = (await context.AcceptWebSocketAsync(null)).WebSocket;
            Interlocked.Increment(ref Connections);
            var session = new Session(this, socket);
            sessions.Add(session);
            _ = Task.Run(session.RunAsync);
        }
    }

    public async ValueTask DisposeAsync()
    {
        stopping.Cancel();
        listener.Stop();
        listener.Close();
        await Task.WhenAny(accepting, Task.Delay(1000));
    }

    private sealed class Session(FakeRuntime runtime, WebSocket socket)
    {
        private readonly SemaphoreSlim sendLock = new(1, 1);
        private E2eeChannel? channel;
        private string? multiplexId;

        public void Abort() => socket.Abort();

        public async Task RunAsync()
        {
            try
            {
                var (_, helloBytes) = await ReceiveAsync();
                var hello = JsonNode.Parse(helloBytes)!;
                var clientKey = Convert.FromBase64String(hello["publicKeyB64"]!.GetValue<string>());
                channel = new E2eeChannel(clientKey, runtime.secretKey, runtime.publicKey);
                await SendRawAsync(Encoding.UTF8.GetBytes("{\"type\":\"e2ee_ready\"}"), WebSocketMessageType.Text);

                var auth = Open((await ReceiveAsync()).Bytes);
                if (auth?["deviceToken"]?.GetValue<string>() != Token)
                {
                    await SendJsonAsync(new JsonObject { ["type"] = "e2ee_error", ["error"] = new JsonObject { ["code"] = "unauthorized" } });
                    await socket.CloseAsync((WebSocketCloseStatus)4001, "unauthorized", CancellationToken.None);
                    return;
                }
                await SendJsonAsync(new JsonObject { ["type"] = "e2ee_authenticated" });

                while (socket.State == WebSocketState.Open)
                {
                    var (type, bytes) = await ReceiveAsync();
                    if (type == WebSocketMessageType.Close) return;
                    if (type == WebSocketMessageType.Binary)
                    {
                        if (channel.Open(bytes) is { } opened && TerminalFrame.Decode(opened) is { } frame) await OnFrameAsync(frame);
                        continue;
                    }
                    if (Open(bytes) is { } request) await OnRequestAsync(request);
                }
            }
            catch (WebSocketException) { }
            catch (ObjectDisposedException) { }
        }

        public async Task EndAsync()
        {
            if (multiplexId is null || socket.State != WebSocketState.Open) return;
            await StreamEventAsync(new JsonObject { ["type"] = "end", ["streamId"] = 1, ["terminal"] = Handle });
        }

        public async Task ResizedAsync(JsonObject payload)
        {
            if (multiplexId is null || socket.State != WebSocketState.Open) return;
            await FrameAsync(Opcode.Resized, 0, Encoding.UTF8.GetBytes(payload.ToJsonString()));
        }

        private async Task OnRequestAsync(JsonObject request)
        {
            var id = request["id"]?.GetValue<string>();
            var method = request["method"]?.GetValue<string>();
            var parameters = request["params"] as JsonObject ?? new JsonObject();
            if (request["deviceToken"]?.GetValue<string>() != Token) { await ErrorAsync(id, "unauthorized", "device token does not match"); return; }
            switch (method)
            {
                case "status.get":
                    await ReplyAsync(id, new JsonObject
                    {
                        ["runtimeId"] = RuntimeId, ["runtimeProtocolVersion"] = runtime.ProtocolVersion, ["hostPlatform"] = "darwin",
                        ["deviceScope"] = runtime.DeviceScope,
                        ["capabilities"] = new JsonArray(new[] { "terminal.binary-stream.v1", "terminal.multiplex.v1" }.Concat(runtime.Capabilities)
                            .Select(c => (JsonNode?)JsonValue.Create(c)).ToArray())
                    });
                    break;
                case "terminal.view":
                    runtime.Views.Enqueue(parameters.ToJsonString());
                    await ReplyAsync(id, (JsonObject)runtime.ViewReply.DeepClone());
                    break;
                case "attachment.save":
                    runtime.Calls.Enqueue((method, parameters.ToJsonString()));
                    await ReplyAsync(id, new JsonObject { ["path"] = $"/Users/me/.config/orc/attachments/abc/{parameters["name"]}" });
                    break;
                case "fs.list":
                    var listed = parameters["path"]?.ToString() ?? "";
                    if (!listed.StartsWith("/Users/me")) { await ErrorAsync(id, "forbidden", "only files in the home folder are served"); break; }
                    await ReplyAsync(id, new JsonObject
                    {
                        ["path"] = listed.TrimEnd('/'), ["truncated"] = false,
                        ["entries"] = new JsonArray(new JsonObject { ["name"] = "code", ["directory"] = true }, new JsonObject { ["name"] = "notes.txt", ["directory"] = false })
                    });
                    break;
                case "config.get":
                    await ReplyAsync(id, new JsonObject { ["defaultSessionType"] = "claude", ["defaultProject"] = "id:local::/Users/me/proj" });
                    break;
                case "config.set":
                case "repo.add":
                    runtime.Calls.Enqueue((method, parameters.ToJsonString()));
                    await ReplyAsync(id, method == "repo.add"
                        ? new JsonObject { ["repo"] = new JsonObject { ["id"] = "r2", ["path"] = parameters["path"]?.ToString(), ["displayName"] = "site" } }
                        : new JsonObject { ["defaultSessionType"] = "claude", ["defaultProject"] = parameters["defaultProject"]?.DeepClone() });
                    break;
                case "notify.since" when runtime.Capabilities.Contains("orc.notify-cursor.v1"):
                    await ReplyAsync(id, runtime.NotifySince(parameters));
                    break;
                case "session.order.get" when runtime.Capabilities.Contains("orc.owner-methods.v1"):
                    await ReplyAsync(id, new JsonObject { ["keys"] = new JsonArray([.. runtime.Order.Select(k => (JsonNode?)JsonValue.Create(k))]), ["set"] = true });
                    break;
                case "brief.list" when runtime.Capabilities.Contains("orc.owner-methods.v1"):
                    await ReplyAsync(id, new JsonObject
                    {
                        ["briefs"] = new JsonArray(new JsonObject
                        {
                            ["name"] = "fake-agent", ["generating"] = false, ["generatedAt"] = 1_760_000_000_000, ["error"] = null,
                            ["brief"] = new JsonObject { ["headline"] = runtime.Headline, ["goal"] = "Ship it", ["progress"] = new JsonArray(), ["now"] = "Testing", ["next"] = new JsonArray() }
                        })
                    });
                    break;
                case "terminal.list":
                    await ReplyAsync(id, new JsonObject
                    {
                        ["terminals"] = new JsonArray(new JsonObject
                        {
                            ["handle"] = Handle, ["title"] = "fake-agent", ["connected"] = true, ["writable"] = true,
                            ["incarnationId"] = "inc-1", ["worktreeId"] = "local::/Users/me/proj", ["worktreePath"] = "/Users/me/proj",
                            ["agentIdentity"] = "claude"
                        })
                    });
                    break;
                case "worktree.list":
                    await ReplyAsync(id, new JsonObject
                    {
                        ["worktrees"] = new JsonArray(new JsonObject { ["id"] = "local::/Users/me/proj", ["path"] = "/Users/me/proj", ["displayName"] = "proj", ["hostId"] = "local" })
                    });
                    break;
                case "terminal.agentStatus":
                    await ReplyAsync(id, new JsonObject
                    {
                        ["agentStatus"] = new JsonObject { ["handle"] = parameters["terminal"]?.ToString(), ["isRunningAgent"] = true, ["status"] = runtime.AgentState }
                    });
                    break;
                case "terminal.create":
                    runtime.Calls.Enqueue((method, parameters.ToJsonString()));
                    await ReplyAsync(id, new JsonObject
                    {
                        ["terminal"] = new JsonObject { ["handle"] = "term-new", ["title"] = parameters["title"]?.ToString(), ["worktreeId"] = "local::/Users/me/proj" }
                    });
                    break;
                case "terminal.rename":
                    runtime.Calls.Enqueue((method, parameters.ToJsonString()));
                    await ReplyAsync(id, new JsonObject { ["rename"] = new JsonObject { ["handle"] = parameters["terminal"]?.ToString(), ["title"] = parameters["title"]?.ToString() } });
                    break;
                case "terminal.close":
                    runtime.Calls.Enqueue((method, parameters.ToJsonString()));
                    await ReplyAsync(id, new JsonObject { ["close"] = new JsonObject { ["handle"] = parameters["terminal"]?.ToString() } });
                    break;
                case "terminal.restart":
                    runtime.Calls.Enqueue((method, parameters.ToJsonString()));
                    await ReplyAsync(id, new JsonObject { ["restart"] = new JsonObject { ["handle"] = "term-restarted", ["title"] = "fake-agent" } });
                    break;
                case "mcp.list":
                    await ReplyAsync(id, new JsonObject
                    {
                        ["configs"] = new JsonArray(
                            new JsonObject { ["name"] = "github", ["path"] = "/Users/me/proj/.mcp/github.json", ["servers"] = new JsonArray("github"), ["error"] = null },
                            new JsonObject { ["name"] = "broken", ["path"] = "/Users/me/proj/.mcp/broken.json", ["servers"] = new JsonArray(), ["error"] = "not valid JSON" })
                    });
                    break;
                case "terminal.send":
                    var text = parameters["text"]?.GetValue<string>() ?? "";
                    runtime.Inputs.Enqueue(text);
                    if (parameters["claimViewport"]?.GetValue<bool>() == true) runtime.Claims.Enqueue("typing " + parameters["viewport"]?.ToJsonString());
                    await ReplyAsync(id, new JsonObject { ["send"] = new JsonObject { ["handle"] = Handle, ["accepted"] = true, ["bytesWritten"] = Encoding.UTF8.GetByteCount(text) } });
                    // The program echoes what was typed.
                    if (multiplexId is not null) await FrameAsync(Opcode.Output, 1, Encoding.UTF8.GetBytes(text));
                    break;
                case "terminal.multiplex":
                    multiplexId = id;
                    await StreamEventAsync(new JsonObject { ["type"] = "ready" });
                    break;
                default:
                    await ErrorAsync(id, "method_not_found", $"Unknown method: {method}");
                    break;
            }
        }

        private async Task OnFrameAsync(TerminalFrame frame)
        {
            var payload = Encoding.UTF8.GetString(frame.Payload.Span);
            switch (frame.Opcode)
            {
                case Opcode.Subscribe:
                    runtime.Subscribes.Enqueue(payload);
                    await StreamEventAsync(new JsonObject { ["type"] = "subscribed", ["streamId"] = 1, ["terminal"] = Handle, ["cols"] = 80, ["rows"] = 24, ["seq"] = 100 });
                    await SnapshotAsync("viewport screen\r\n$ ", kittyFlags: 1);
                    break;
                case Opcode.SnapshotRequest:
                    Interlocked.Increment(ref runtime.SnapshotRequests);
                    // History's keyboard metadata can read zero even while the live agent is in kitty mode.
                    await SnapshotAsync("older history\r\nviewport screen\r\n$ ", kittyFlags: 0);
                    break;
                case Opcode.ClaimViewport:
                    runtime.Claims.Enqueue("claim " + payload);
                    break;
            }
        }

        private async Task SnapshotAsync(string screen, int kittyFlags)
        {
            await FrameAsync(Opcode.SnapshotStart, 100, Encoding.UTF8.GetBytes(new JsonObject
            {
                ["kind"] = "scrollback", ["cols"] = 80, ["rows"] = 24, ["seq"] = 100, ["kittyKeyboardFlags"] = kittyFlags, ["alternateScreen"] = false
            }.ToJsonString()));
            // Split mid-string to exercise chunk reassembly.
            var bytes = Encoding.UTF8.GetBytes(screen);
            await FrameAsync(Opcode.SnapshotChunk, 100, bytes[..5]);
            await FrameAsync(Opcode.SnapshotChunk, 100, bytes[5..]);
            await FrameAsync(Opcode.SnapshotEnd, 100, []);
        }

        private Task FrameAsync(byte opcode, ulong seq, byte[] payload) =>
            SendRawAsync(channel!.Seal(new TerminalFrame(opcode, 1, seq, payload).Encode()), WebSocketMessageType.Binary);

        private Task StreamEventAsync(JsonObject result) =>
            SendJsonAsync(new JsonObject { ["id"] = multiplexId, ["ok"] = true, ["streaming"] = true, ["result"] = result, ["_meta"] = Meta() });

        private Task ReplyAsync(string? id, JsonObject result) =>
            SendJsonAsync(new JsonObject { ["id"] = id, ["ok"] = true, ["result"] = result, ["_meta"] = Meta() });

        private Task ErrorAsync(string? id, string code, string message) =>
            SendJsonAsync(new JsonObject { ["id"] = id, ["ok"] = false, ["error"] = new JsonObject { ["code"] = code, ["message"] = message }, ["_meta"] = Meta() });

        private static JsonObject Meta() => new() { ["runtimeId"] = RuntimeId };

        private Task SendJsonAsync(JsonObject value) =>
            SendRawAsync(Encoding.ASCII.GetBytes(Convert.ToBase64String(channel!.Seal(Encoding.UTF8.GetBytes(value.ToJsonString())))), WebSocketMessageType.Text);

        private async Task SendRawAsync(byte[] bytes, WebSocketMessageType type)
        {
            await sendLock.WaitAsync();
            try { if (socket.State == WebSocketState.Open) await socket.SendAsync(bytes, type, true, CancellationToken.None); }
            finally { sendLock.Release(); }
        }

        private JsonObject? Open(byte[] text)
        {
            var opened = channel!.Open(Convert.FromBase64String(Encoding.ASCII.GetString(text)));
            return opened is null ? null : JsonNode.Parse(opened) as JsonObject;
        }

        private async Task<(WebSocketMessageType Type, byte[] Bytes)> ReceiveAsync()
        {
            var buffer = new byte[64 * 1024];
            using var message = new MemoryStream();
            while (true)
            {
                var result = await socket.ReceiveAsync(buffer, CancellationToken.None);
                if (result.MessageType == WebSocketMessageType.Close) return (WebSocketMessageType.Close, []);
                message.Write(buffer, 0, result.Count);
                if (result.EndOfMessage) return (result.MessageType, message.ToArray());
            }
        }
    }
}

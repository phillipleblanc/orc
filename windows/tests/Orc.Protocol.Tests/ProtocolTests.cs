using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace Orc.Protocol.Tests;

public sealed class FrameTests
{
    [Fact]
    public void HeaderMatchesTerminalFramesTs()
    {
        var bytes = new TerminalFrame(Opcode.Subscribe, 1, 0x0000_0001_0000_0002, "{}"u8.ToArray()).Encode();
        Assert.Equal("74010900" + "01000000" + "01000000" + "02000000", Convert.ToHexString(bytes[..16]));
    }

    [Fact]
    public void RoundTrips()
    {
        var decoded = TerminalFrame.Decode(new TerminalFrame(Opcode.Output, 7, 0x0000_0100_0000_0005, "hi"u8.ToArray()).Encode());
        Assert.NotNull(decoded);
        Assert.Equal((Opcode.Output, 7u, 0x0000_0100_0000_0005ul), (decoded.Value.Opcode, decoded.Value.StreamId, decoded.Value.Sequence));
        Assert.Equal("hi"u8.ToArray(), decoded.Value.Payload.ToArray());
    }

    [Fact]
    public void RejectsAnotherMagicByte() => Assert.Null(TerminalFrame.Decode([0x75, 1, 1, 0, .. new byte[12]]));
}

public sealed class Utf8CarryTests
{
    [Fact]
    public void HoldsBackASplitCharacter()
    {
        var carry = new Utf8Carry();
        var e = "é"u8.ToArray();
        Assert.Equal("a"u8.ToArray(), carry.Take([(byte)'a', e[0]]));
        Assert.Equal("éb"u8.ToArray(), carry.Take([e[1], (byte)'b']));
    }

    [Fact]
    public void ReassemblesAFourByteSequence()
    {
        var carry = new Utf8Carry();
        var emoji = "🦄"u8.ToArray();
        Assert.Empty(carry.Take(emoji[..3]));
        Assert.Equal(emoji, carry.Take(emoji[3..]));
    }
}

public sealed class E2eeTests
{
    private static (E2eeChannel Client, E2eeChannel Server) Pair()
    {
        var serverPublic = new byte[32];
        var serverSecret = new byte[32];
        Sodium.Keypair(serverPublic, serverSecret);
        var client = new E2eeChannel(serverPublic);
        return (client, new E2eeChannel(client.PublicKey, serverSecret, serverPublic));
    }

    private static readonly byte[] Message = Encoding.UTF8.GetBytes("{\"type\":\"e2ee_auth\"}");

    [Fact]
    public void SealsAsNonceMacCiphertext() => Assert.Equal(Message.Length + 40, Pair().Client.Seal(Message).Length);

    [Fact]
    public void OpensBothWays()
    {
        var (client, server) = Pair();
        Assert.Equal(Message, server.Open(client.Seal(Message)));
        Assert.Equal(Message, client.Open(server.Seal(Message)));
    }

    [Fact]
    public void UsesAFreshNoncePerMessage()
    {
        var client = Pair().Client;
        Assert.NotEqual(client.Seal(Message)[..24], client.Seal(Message)[..24]);
    }

    [Fact]
    public void RejectsTampering()
    {
        var (client, server) = Pair();
        var sealedMessage = client.Seal(Message);
        sealedMessage[^1] ^= 1;
        Assert.Null(server.Open(sealedMessage));
    }

    [Fact]
    public void RoundTripsAnEmptyMessage()
    {
        var (client, server) = Pair();
        Assert.Equal(0, server.Open(client.Seal([]))?.Length);
    }

    [Fact]
    public void RejectsAChannelToAnotherKey()
    {
        var server = Pair().Server;
        var otherPublic = new byte[32];
        Sodium.Keypair(otherPublic, new byte[32]);
        Assert.Null(server.Open(new E2eeChannel(otherPublic).Seal(Message)));
    }
}

public sealed class PairingTests
{
    private static readonly string Key = Convert.ToBase64String(new byte[32]);

    private static string Link(object claims) => "orca://pair?code=" + Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(claims)))
        .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    [Fact]
    public void ParsesARuntimeLink()
    {
        var parsed = Pairing.Parse(Link(new { v = 2, endpoint = "ws://192.168.1.20:6768", deviceToken = "abc", publicKeyB64 = Key, scope = "runtime", pairedDeviceId = "d1" }));
        Assert.Equal(("ws://192.168.1.20:6768", "abc", "runtime", "d1"), (parsed.Endpoint, parsed.DeviceToken, parsed.Scope, parsed.DeviceId));
    }

    [Theory]
    [InlineData("ws://192.168.1.20:6768", "mobile", 32)]
    [InlineData("ws://127.0.0.1:6768", "runtime", 32)]
    [InlineData("ws://10.0.0.2:6768", "runtime", 3)]
    public void RefusesPhoneLoopbackAndShortKeyLinks(string endpoint, string scope, int keyBytes) =>
        Assert.Throws<FormatException>(() => Pairing.Parse(Link(new { v = 2, endpoint, deviceToken = "abc", publicKeyB64 = Convert.ToBase64String(new byte[keyBytes]), scope })));

    [Fact]
    public void RefusesOtherUrls() => Assert.Throws<FormatException>(() => Pairing.Parse("https://example.com/?code=x"));

    [Fact]
    public void MovesTheEndpointButKeepsTheKey()
    {
        var parsed = Pairing.Parse(Link(new { v = 2, endpoint = "ws://192.168.1.20:6768", deviceToken = "abc", publicKeyB64 = Key, scope = "runtime" }));
        var moved = parsed.WithEndpoint("ws://10.0.0.9:6768/");
        Assert.Equal(("ws://10.0.0.9:6768", Key), (moved.Endpoint, moved.PublicKeyB64));
    }
}

public sealed class RuntimeConnectionTests
{
    [Fact]
    public async Task HandshakesAndAnswers()
    {
        await using var runtime = new FakeRuntime();
        await using var connection = await RuntimeConnection.ConnectAsync(runtime.Pairing(), TestContext.Current.CancellationToken);
        var status = await connection.RequestAsync("status.get");
        Assert.Equal(3, status["runtimeProtocolVersion"]?.GetValue<int>());
        Assert.Equal("fake-runtime", connection.RuntimeId);
        Assert.Single((await connection.RequestAsync("terminal.list"))["terminals"]!.AsArray());
    }

    [Fact]
    public async Task SurfacesErrorCodes()
    {
        await using var runtime = new FakeRuntime();
        await using var connection = await RuntimeConnection.ConnectAsync(runtime.Pairing(), TestContext.Current.CancellationToken);
        var error = await Assert.ThrowsAsync<RpcException>(() => connection.RequestAsync("no.such"));
        Assert.Equal("method_not_found", error.Code);
    }

    [Fact]
    public async Task RefusesAWrongToken()
    {
        await using var runtime = new FakeRuntime();
        var error = await Assert.ThrowsAsync<IOException>(() => RuntimeConnection.ConnectAsync(runtime.Pairing("wrong"), TestContext.Current.CancellationToken));
        Assert.Contains("refused", error.Message);
    }
}

public sealed class AttachControllerTests
{
    [Fact]
    public async Task AttachesTypesResizesAndEnds()
    {
        await using var runtime = new FakeRuntime();
        var surface = new RecordingSurface();
        var controller = new AttachController(runtime.Pairing(), FakeRuntime.Handle, "inc-1", surface);
        var run = controller.RunAsync(TestContext.Current.CancellationToken);

        // The viewport snapshot, then the scrollback snapshot the controller asks for once.
        Assert.True(await Eventually(() => surface.Resets.Count >= 2));
        Assert.Equal(1, runtime.SnapshotRequests);
        Assert.StartsWith("older history", Encoding.UTF8.GetString(surface.Resets[^1].Data));
        // History's flags read 0 while the agent is still in kitty mode; the live flags are kept.
        Assert.Equal(new[] { 1, 1 }, surface.Resets.Select(r => r.KittyKeyboardFlags ?? -1));

        Assert.True(runtime.Subscribes.TryPeek(out var subscribe));
        var request = JsonNode.Parse(subscribe)!;
        Assert.Equal("desktop", request["client"]?["type"]?.ToString());
        Assert.Equal(100, request["viewport"]?["cols"]?.GetValue<int>());
        Assert.Equal(1, request["capabilities"]?["desktopViewportClaims"]?.GetValue<int>());
        Assert.True(await Eventually(() => runtime.Claims.Any(c => c.StartsWith("claim ") && c.Contains("\"cols\":100"))));

        controller.SendInput("ls -la\r");
        Assert.True(await Eventually(() => runtime.Inputs.Contains("ls -la\r") && runtime.Claims.Any(c => c.StartsWith("typing "))));
        Assert.True(await Eventually(() => surface.Text.Contains("ls -la")));
        Assert.True(await Eventually(() => controller.EchoSamples.Count == 1));

        surface.Size = new TerminalSize(132, 40);
        controller.ViewportChanged();
        Assert.True(await Eventually(() => runtime.Claims.Any(c => c.Contains("\"cols\":132"))));

        await runtime.EndSessionAsync();
        Assert.Equal(AttachExit.Ended, await run.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task StoppingDetaches()
    {
        await using var runtime = new FakeRuntime();
        using var stop = new CancellationTokenSource();
        var run = new AttachController(runtime.Pairing(), FakeRuntime.Handle, "inc-1", new RecordingSurface()).RunAsync(stop.Token);
        Assert.True(await Eventually(() => runtime.SnapshotRequests == 1));
        stop.Cancel();
        Assert.Equal(AttachExit.Detached, await run.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task ReadOnlyNeverClaimsTheViewport()
    {
        await using var runtime = new FakeRuntime();
        using var stop = new CancellationTokenSource();
        var viewer = new AttachController(runtime.Pairing(), FakeRuntime.Handle, "inc-1", new RecordingSurface(), readOnly: true);
        var run = viewer.RunAsync(stop.Token);
        Assert.True(await Eventually(() => runtime.SnapshotRequests == 1));
        viewer.ViewportChanged();
        await Task.Delay(300, TestContext.Current.CancellationToken);
        Assert.Empty(runtime.Claims);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task DoesNotReattachAReplacedTerminal()
    {
        await using var runtime = new FakeRuntime();
        var replaced = new AttachController(runtime.Pairing(), FakeRuntime.Handle, "inc-OLD", new RecordingSurface());
        Assert.Equal(AttachExit.Ended, await replaced.RunAsync(TestContext.Current.CancellationToken).WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken));
    }

    private static async Task<bool> Eventually(Func<bool> condition, int timeoutMs = 5000)
    {
        for (var waited = 0; waited < timeoutMs; waited += 20)
        {
            if (condition()) return true;
            await Task.Delay(20);
        }
        return condition();
    }

    private sealed class RecordingSurface : ITerminalSurface
    {
        private readonly StringBuilder output = new();
        public List<TerminalSnapshot> Resets { get; } = [];
        public TerminalSize Size { get; set; } = new(100, 30);
        public string Text { get { lock (output) return output.ToString(); } }
        public void Reset(TerminalSnapshot snapshot) { lock (Resets) Resets.Add(snapshot); }
        public void Write(ReadOnlySpan<byte> bytes) { lock (output) output.Append(Encoding.UTF8.GetString(bytes)); }
        public void Note(string message) { }
    }
}

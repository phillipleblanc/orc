using System.Net;
using System.Net.Sockets;
using Orc.Protocol;
using Orc.Protocol.Tests;
using Xunit;

namespace Orc.Core.Tests;

public sealed class HostMonitorTests
{
    private static readonly Func<int, TimeSpan> Quick = _ => TimeSpan.FromMilliseconds(100);

    [Fact]
    public async Task PublishesSessionsProjectsAndActivity()
    {
        await using var runtime = new FakeRuntime();
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var monitor = new HostMonitor(runtime.Pairing(), TimeSpan.FromMilliseconds(100));
        var snapshots = new Recorder<HostSnapshot>();
        var states = new Recorder<HostStatus>();
        monitor.Updated += snapshots.Add;
        monitor.StatusChanged += states.Add;
        var run = monitor.RunAsync(stop.Token);

        Assert.True(await Eventually(() => snapshots.Count > 0));
        var first = snapshots.Latest;
        var session = Assert.Single(first.Sessions);
        Assert.Equal(("fake-agent", AgentActivity.Active), (session.Name, first.ActivityOf(session)));
        Assert.Equal("proj", Assert.Single(first.Projects).Name);
        Assert.Equal(new[] { HostState.Connecting, HostState.Connected }, states.All.Select(s => s.State));
        Assert.Equal(("darwin", "macOS", 3), (monitor.Status.Info?.Platform, monitor.Status.Info?.PlatformName, monitor.Status.Info?.ProtocolVersion));

        runtime.AgentState = "permission";
        monitor.RefreshNow();
        Assert.True(await Eventually(() => snapshots.Latest.ActivityOf(session) == AgentActivity.NeedsAttention));

        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task ReadsBriefHeadlinesFromAHostThatServesThem()
    {
        await using var runtime = new FakeRuntime { Capabilities = [HostInfo.OwnerMethods] };
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var monitor = new HostMonitor(runtime.Pairing(), TimeSpan.FromMilliseconds(100));
        var snapshots = new Recorder<HostSnapshot>();
        monitor.Updated += snapshots.Add;
        var run = monitor.RunAsync(stop.Token);
        Assert.True(await Eventually(() => snapshots.Count > 0));
        var session = Assert.Single(snapshots.Latest.Sessions);
        Assert.Equal("Writing the tests", snapshots.Latest.BriefOf(session)?.Headline);
        Assert.Equal("claude · Writing the tests", snapshots.Latest.DetailOf(session));
        // Briefs are read every five seconds; the polls between keep the last ones.
        runtime.Headline = "Fixing the build";
        await Task.Delay(500, TestContext.Current.CancellationToken);
        Assert.Equal("Writing the tests", snapshots.Latest.BriefOf(session)?.Headline);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task AnOlderHostHasNoBriefs()
    {
        await using var runtime = new FakeRuntime();
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var monitor = new HostMonitor(runtime.Pairing(), TimeSpan.FromMilliseconds(100));
        var snapshots = new Recorder<HostSnapshot>();
        monitor.Updated += snapshots.Add;
        var run = monitor.RunAsync(stop.Token);
        Assert.True(await Eventually(() => snapshots.Count > 0));
        Assert.Null(snapshots.Latest.Briefs);
        Assert.Equal("claude", snapshots.Latest.DetailOf(snapshots.Latest.Sessions[0]));
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task ReconnectsAfterTheConnectionDrops()
    {
        await using var runtime = new FakeRuntime();
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var monitor = new HostMonitor(runtime.Pairing(), TimeSpan.FromMilliseconds(100), Quick);
        var states = new Recorder<HostStatus>();
        monitor.StatusChanged += states.Add;
        var run = monitor.RunAsync(stop.Token);
        Assert.True(await Eventually(() => monitor.Status.IsConnected));

        runtime.DropConnections();
        Assert.True(await Eventually(() => states.All.Any(s => s.State == HostState.Reconnecting)));
        Assert.True(await Eventually(() => monitor.Status.IsConnected && runtime.Connections >= 2));
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task ARefusedPairingWaitsInsteadOfRetrying()
    {
        await using var runtime = new FakeRuntime();
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var monitor = new HostMonitor(runtime.Pairing("revoked-token"), backoff: Quick);
        var run = monitor.RunAsync(stop.Token);
        Assert.True(await Eventually(() => monitor.Status.State == HostState.Unauthorized));
        Assert.Contains("refused", monitor.Status.Detail);
        Assert.Null(monitor.Status.NextTry);
        var tries = runtime.Connections;
        await Task.Delay(500, TestContext.Current.CancellationToken);
        Assert.Equal(tries, runtime.Connections);

        monitor.RetryNow();
        Assert.True(await Eventually(() => runtime.Connections > tries));
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task AnAbsentHostIsUnreachableWithANextTry()
    {
        var pairing = new Pairing($"ws://localhost:{FreePort()}", "token", RandomKey(), "runtime", null);
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var monitor = new HostMonitor(pairing, backoff: _ => TimeSpan.FromSeconds(30));
        var run = monitor.RunAsync(stop.Token);
        Assert.True(await Eventually(() => monitor.Status.State == HostState.Unreachable));
        Assert.True(monitor.Status.NextTry > DateTimeOffset.Now.AddSeconds(20));
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task RetryingAnAbsentHostStaysUnreachable()
    {
        // 127.0.0.1 rather than localhost: Windows takes two seconds to refuse each loopback address it tries.
        var pairing = new Pairing($"ws://127.0.0.1:{FreePort()}", "token", RandomKey(), "runtime", null);
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var monitor = new HostMonitor(pairing, backoff: Quick);
        var states = new Recorder<HostStatus>();
        monitor.StatusChanged += states.Add;
        var run = monitor.RunAsync(stop.Token);
        Assert.True(await Eventually(() => states.All.Count(s => s.State == HostState.Unreachable && s.NextTry is not null) >= 3, timeoutMs: 15000));
        var afterFirstFailure = states.All.SkipWhile(s => s.State != HostState.Unreachable).ToList();
        Assert.DoesNotContain(afterFirstFailure, s => s.State == HostState.Connecting);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task AnOlderProtocolIsIncompatible()
    {
        await using var runtime = new FakeRuntime { ProtocolVersion = 2 };
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var monitor = new HostMonitor(runtime.Pairing());
        var run = monitor.RunAsync(stop.Token);
        Assert.True(await Eventually(() => monitor.Status.State == HostState.Incompatible));
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
    }

    [Theory]
    [InlineData(1, 1)]
    [InlineData(3, 4)]
    [InlineData(5, 15)]
    [InlineData(40, 30)]
    public void BacksOffUpToThirtySeconds(int failures, int seconds) => Assert.Equal(TimeSpan.FromSeconds(seconds), HostMonitor.Backoff(failures));

    internal static string RandomKey()
    {
        var key = new byte[32];
        Sodium.Keypair(key, new byte[32]);
        return Convert.ToBase64String(key);
    }

    internal static int FreePort()
    {
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return port;
    }

    internal static async Task<bool> Eventually(Func<bool> condition, int timeoutMs = 8000)
    {
        for (var waited = 0; waited < timeoutMs; waited += 20)
        {
            if (condition()) return true;
            await Task.Delay(20);
        }
        return condition();
    }

    private sealed class Recorder<T>
    {
        private readonly List<T> items = [];
        public void Add(T item) { lock (items) items.Add(item); }
        public int Count { get { lock (items) return items.Count; } }
        public T Latest { get { lock (items) return items[^1]; } }
        public T[] All { get { lock (items) return items.ToArray(); } }
    }
}

public sealed class HostPairingTests
{
    [Fact]
    public async Task VerifiesAComputerPairing()
    {
        await using var runtime = new FakeRuntime();
        var info = await HostPairing.VerifyAsync(runtime.Pairing(), TestContext.Current.CancellationToken);
        Assert.Equal(new HostInfo("darwin", 3, "runtime", new HashSet<string> { "terminal.binary-stream.v1", "terminal.multiplex.v1", "orc.agents.v1" }), info);
        Assert.False(info.Has(HostInfo.ViewportOwnership));
    }

    [Fact]
    public async Task RefusesAPhonesGrant()
    {
        await using var runtime = new FakeRuntime { DeviceScope = "mobile" };
        await Assert.ThrowsAsync<HostRefusedException>(() => HostPairing.VerifyAsync(runtime.Pairing(), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task TellsARevokedTokenFromAnotherHost()
    {
        await using var runtime = new FakeRuntime();
        await Assert.ThrowsAsync<HostRefusedException>(() => HostPairing.VerifyAsync(runtime.Pairing("revoked"), TestContext.Current.CancellationToken));
        var otherKey = new byte[32];
        Sodium.Keypair(otherKey, new byte[32]);
        var impostor = runtime.Pairing() with { PublicKeyB64 = Convert.ToBase64String(otherKey) };
        await Assert.ThrowsAsync<HostIdentityException>(() => HostPairing.VerifyAsync(impostor, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task TellsAnAbsentHost()
    {
        var pairing = new Pairing($"ws://localhost:{HostMonitorTests.FreePort()}", "token", HostMonitorTests.RandomKey(), "runtime", null);
        await Assert.ThrowsAsync<HostUnreachableException>(() => HostPairing.VerifyAsync(pairing, TestContext.Current.CancellationToken));
    }

    [Theory]
    [InlineData("192.168.1.30", "ws://192.168.1.30:6768")]
    [InlineData(" 192.168.1.30:7000 ", "ws://192.168.1.30:7000")]
    [InlineData("phils-mac.local", "ws://phils-mac.local:6768")]
    [InlineData("ws://10.0.0.5:6768/", "ws://10.0.0.5:6768")]
    [InlineData("ws://10.0.0.5", "ws://10.0.0.5:6768")]
    [InlineData("[fe80::1]:6768", "ws://[fe80::1]:6768")]
    [InlineData("", null)]
    [InlineData("http://example.com", null)]
    [InlineData("10.0.0.5/path", null)]
    public void ReadsTypedAddresses(string typed, string? endpoint) => Assert.Equal(endpoint, HostPairing.EndpointFrom(typed));

    [Theory]
    [InlineData("EPYC-WINDOWS", "orc pair-computer --name EPYC-WINDOWS --link")]
    [InlineData("O'Brien's PC", "orc pair-computer --name 'OBriens PC' --link")]
    public void TheHostCommandNamesTheGrantAfterThisPc(string computer, string command) => Assert.Equal(command, HostPairing.HostCommand(computer));

    [Fact]
    public void TheOlderHostsCommandNamesTheGrantAfterThisPc()
    {
        var command = HostPairing.LegacyHostCommand("DESKTOP-O'BRIEN");
        Assert.Contains("'name': 'DESKTOP-OBRIEN'", command);
        Assert.Contains("slim.pairing.create", command);
        Assert.DoesNotContain("authToken': '", command);
    }
}

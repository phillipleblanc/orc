using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Orc.Core;
using Orc.Protocol;
using Orc.Spike;

const string Usage = """
    orcspike: Phase 0 spike of a Windows client for an Orc runtime on another machine.

      orcspike probe [ws://HOST:PORT KEY] Credential-free check: reach the runtime and prove E2EE interop with a bogus token
      orcspike pair                       Paste an orca://pair link (runtime scope) at a hidden prompt; verifies, then saves
      orcspike status                     The runtime's status.get
      orcspike list                       Sessions on the host
      orcspike sidebar                    Sessions by project with their activity, as the app's sidebar shows them
      orcspike modes SESSION              Read-only: the screen, mouse and keyboard modes a session's snapshot sets
      orcspike ping [COUNT]               Connection setup time and RPC round trips
      orcspike attach SESSION [--read-only]  Attach in this console (Windows Terminal recommended); Ctrl-] detaches
      orcspike send SESSION TEXT [--enter]   Type into a session
      orcspike endpoint ws://HOST:PORT    Follow the host to a new address; its key stays pinned
      orcspike forget                     Delete the saved host
    """;

try
{
    return args.FirstOrDefault() switch
    {
        "probe" => await ProbeAsync(args.Length == 3 ? new Pairing(args[1], "orcspike-probe", args[2], "runtime", null) : null),
        "pair" => await PairAsync(),
        "status" => await StatusAsync(),
        "list" => await ListAsync(),
        "sidebar" => await SidebarAsync(),
        "modes" when args.Length == 2 => await ModesAsync(args[1]),
        "ping" => await PingAsync(args.Length > 1 ? int.Parse(args[1]) : 20),
        "attach" when args.Length >= 2 => await AttachAsync(args[1], args.Contains("--read-only")),
        "send" when args.Length >= 3 => await SendAsync(args[1], args[2], args.Contains("--enter")),
        "endpoint" when args.Length == 2 => await EndpointAsync(args[1]),
        "forget" => Forget(),
        _ => Help()
    };
}
catch (Exception error) when (error is not OutOfMemoryException)
{
    var code = error is RpcException rpc ? $" ({rpc.Code})" : "";
    Console.Error.WriteLine($"orcspike: {error.Message}{code}");
    if (error.InnerException is { } inner && Environment.GetEnvironmentVariable("ORC_SPIKE_DEBUG") == "1") Console.Error.WriteLine(inner);
    return 1;
}

static int Help()
{
    Console.WriteLine(Usage);
    return 2;
}

static async Task<int> ProbeAsync(Pairing? target)
{
    // A bogus token: the runtime must open our sealed e2ee_auth to refuse it, and we must open its sealed refusal.
    var saved = target ?? PairingStore.Load();
    var probe = saved with { DeviceToken = "orcspike-probe-not-a-token" };
    var started = Stopwatch.GetTimestamp();
    try
    {
        await using var connection = await RuntimeConnection.ConnectAsync(probe);
        Console.WriteLine("Unexpected: the runtime accepted a bogus token.");
        return 1;
    }
    catch (IOException error) when (error.Message.Contains("refused this device token"))
    {
        Console.WriteLine($"""
            Reached {probe.Endpoint} and completed the E2EE handshake in {Stopwatch.GetElapsedTime(started).TotalMilliseconds:F0} ms.
            The runtime decrypted our sealed auth and sent a sealed refusal we decrypted: libsodium and tweetnacl interoperate both ways.
            Server key {probe.Fingerprint} matches the one in the link.
            """);
        return 0;
    }
}

static async Task<int> PairAsync()
{
    var link = Console.IsInputRedirected ? Console.ReadLine() ?? "" : ReadHidden("Paste the orca://pair link (input is hidden), then press Enter: ");
    var pairing = Pairing.Parse(link);
    Console.WriteLine($"Connecting to {pairing.Endpoint} (server key {pairing.Fingerprint})…");
    var started = Stopwatch.GetTimestamp();
    await using var connection = await RuntimeConnection.ConnectAsync(pairing);
    var connectMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
    var status = await connection.RequestAsync("status.get");
    var terminals = (await connection.RequestAsync("terminal.list"))["terminals"] as JsonArray;
    PairingStore.Save(pairing);
    Console.WriteLine($"""
        Paired and saved (device token encrypted for this Windows user).
          Endpoint:       {pairing.Endpoint}  (connected and authenticated in {connectMs:F0} ms)
          Grant scope:    {status["deviceScope"]}
          Host platform:  {status["hostPlatform"]}
          Protocol:       {status["runtimeProtocolVersion"]}
          Capabilities:   {string.Join(", ", (status["capabilities"] as JsonArray ?? new JsonArray()).Select(c => c?.ToString()))}
          Sessions:       {terminals?.Count ?? 0}
        Next: orcspike list, then orcspike attach NAME
        """);
    return 0;
}

static async Task<int> StatusAsync()
{
    await using var connection = await RuntimeConnection.ConnectAsync(PairingStore.Load());
    var status = await connection.RequestAsync("status.get");
    Console.WriteLine(status.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    return 0;
}

static async Task<int> ListAsync()
{
    await using var connection = await RuntimeConnection.ConnectAsync(PairingStore.Load());
    var terminals = await Terminals(connection);
    if (terminals.Count == 0) { Console.WriteLine("No sessions on the host."); return 0; }
    var rows = terminals.Select(t => new[]
    {
        Name(t), t["connected"]?.GetValue<bool>() == true ? "running" : "offline",
        t["agentIdentity"]?.ToString() ?? "-", t["worktreePath"]?.ToString() ?? "", t["handle"]?.ToString() ?? ""
    }).Prepend(["NAME", "STATE", "AGENT", "FOLDER", "HANDLE"]).ToList();
    var widths = Enumerable.Range(0, 5).Select(i => rows.Max(r => r[i].Length)).ToArray();
    foreach (var row in rows) Console.WriteLine(string.Join("  ", row.Select((cell, i) => cell.PadRight(widths[i]))).TrimEnd());
    return 0;
}

static async Task<int> SidebarAsync()
{
    var monitor = new HostMonitor(PairingStore.Load());
    using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(20));
    var first = new TaskCompletionSource<HostSnapshot>();
    monitor.Updated += snapshot => first.TrySetResult(snapshot);
    monitor.ConnectionChanged += state => { if (state is not null) first.TrySetException(new IOException(state)); };
    var run = monitor.RunAsync(stop.Token);
    var snapshot = await first.Task.WaitAsync(stop.Token);
    stop.Cancel();
    await run;
    foreach (var section in SessionSections.Build(snapshot.Sessions, snapshot.Projects))
    {
        Console.WriteLine($"{section.Title}  {section.Sessions.Count}");
        foreach (var session in section.Sessions)
            Console.WriteLine($"  {Light(snapshot.ActivityOf(session))} {session.Name,-26} {session.Detail}");
    }
    return 0;
}

static async Task<int> ModesAsync(string selector)
{
    var pairing = PairingStore.Load();
    JsonObject target;
    await using (var connection = await RuntimeConnection.ConnectAsync(pairing))
        target = Resolve(await Terminals(connection), selector);
    var surface = new SnapshotSurface();
    var controller = new AttachController(pairing, target["handle"]!.ToString(), target["incarnationId"]?.ToString(), surface, readOnly: true);
    using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(20));
    var run = controller.RunAsync(stop.Token);
    var snapshot = await surface.Scrollback.Task.WaitAsync(stop.Token);
    controller.Stop();
    await run;

    var text = Encoding.UTF8.GetString(snapshot.Data);
    // DECSET/DECRST private modes in the serialized screen; the last one set or reset wins.
    var modes = new Dictionary<int, bool>();
    foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(text, @"\e\[\?([\d;]+)([hl])"))
        foreach (var mode in m.Groups[1].Value.Split(';')) modes[int.Parse(mode)] = m.Groups[2].Value == "h";
    string On(params int[] codes) => string.Join(", ", codes.Where(c => modes.GetValueOrDefault(c)).Select(c => c.ToString())) is { Length: > 0 } s ? $"on ({s})" : "off";
    var lines = text.Split('\n').Length;
    Console.WriteLine($"""
        {Name(target)} at {snapshot.Cols}×{snapshot.Rows}, {snapshot.Data.Length:N0} bytes of snapshot, {lines:N0} lines
          alternate screen:      {On(47, 1047, 1049)}
          mouse tracking:        {On(9, 1000, 1002, 1003)}
          mouse encoding:        {(modes.GetValueOrDefault(1006) ? "SGR (1006)" : modes.GetValueOrDefault(1015) ? "urxvt (1015)" : modes.GetValueOrDefault(1005) ? "UTF-8 (1005)" : "default (X10)")}
          alternate scroll:      {On(1007)}
          bracketed paste:       {On(2004)}
          application cursor:    {On(1)}
          kitty keyboard flags:  {snapshot.KittyKeyboardFlags?.ToString() ?? "none"}
        """);
    return 0;
}

static string Light(AgentActivity activity) => activity switch
{
    AgentActivity.Idle => "idle   ",
    AgentActivity.Active => "active ",
    AgentActivity.NeedsAttention => "needs !",
    _ => "-      "
};

static async Task<int> PingAsync(int count)
{
    var pairing = PairingStore.Load();
    var started = Stopwatch.GetTimestamp();
    await using var connection = await RuntimeConnection.ConnectAsync(pairing);
    Console.WriteLine($"Connect + E2EE handshake + auth: {Stopwatch.GetElapsedTime(started).TotalMilliseconds:F1} ms");
    var samples = new List<double>();
    for (var i = 0; i < Math.Max(1, count); i++)
    {
        var sent = Stopwatch.GetTimestamp();
        await connection.RequestAsync("status.get");
        samples.Add(Stopwatch.GetElapsedTime(sent).TotalMilliseconds);
    }
    Console.WriteLine($"status.get round trip over {samples.Count}: {Summary(samples)}");
    return 0;
}

static async Task<int> AttachAsync(string selector, bool readOnly)
{
    var pairing = PairingStore.Load();
    JsonObject target;
    await using (var connection = await RuntimeConnection.ConnectAsync(pairing))
        target = Resolve(await Terminals(connection), selector);
    if (target["connected"]?.GetValue<bool>() != true) throw new InvalidOperationException($"{Name(target)} is not running.");

    using var console = new WindowsConsole();
    var surface = new ConsoleSurface(console);
    var controller = new AttachController(pairing, target["handle"]!.ToString(), target["incarnationId"]?.ToString(), surface, readOnly);
    using var stop = new CancellationTokenSource();
    // The remote application owns screen selection; an outer alternate screen would disable scrollback.
    console.Write("\e[?1049l\e[2J\e[H");
    surface.Note($"Attaching to {Name(target)} on {pairing.Endpoint}. Ctrl-] detaches; the session keeps running.");

    var input = new Thread(() =>
    {
        while (!stop.IsCancellationRequested)
        {
            var text = console.Read();
            if (text is null) { stop.Cancel(); return; }
            var detach = text.IndexOf('\u001d');
            if (detach >= 0)
            {
                controller.SendInput(text[..detach]);
                stop.Cancel();
                return;
            }
            controller.SendInput(text);
        }
    }) { IsBackground = true, Name = "console input" };
    input.Start();

    var size = console.Size;
    using var resizes = new Timer(_ =>
    {
        var now = console.Size;
        if (now == size) return;
        size = now;
        controller.ViewportChanged();
    }, null, 200, 200);

    AttachExit exit;
    try { exit = await controller.RunAsync(stop.Token); }
    finally
    {
        // Keyboard and mouse modes are per screen; the shell must not inherit the remote application's.
        console.Write("\e[?2026l\e[<u\e[=0u\e[?2004l\e[?1000l\e[?1002l\e[?1003l\e[?1006l\e[?1004l\e[0m\e[?25h\e[?1049l\e[r\e[?6l\e[999;1H\r\n");
    }
    console.Dispose();
    var echoes = controller.EchoSamples;
    Console.WriteLine(exit == AttachExit.Ended ? "The session ended." : "Detached; the session keeps running.");
    if (echoes.Count > 0) Console.WriteLine($"Typing to echo over {echoes.Count} keystroke bursts: {Summary(echoes)}");
    return 0;
}

static async Task<int> SendAsync(string selector, string text, bool enter)
{
    await using var connection = await RuntimeConnection.ConnectAsync(PairingStore.Load());
    var target = Resolve(await Terminals(connection), selector);
    var result = await connection.RequestAsync("terminal.send", new JsonObject
    {
        ["terminal"] = target["handle"]!.ToString(), ["text"] = text, ["enter"] = enter,
        ["client"] = new JsonObject { ["id"] = "orcspike-send", ["type"] = "desktop" }
    });
    var send = result["send"] as JsonObject ?? result;
    Console.WriteLine(send["accepted"]?.GetValue<bool>() == true ? $"Sent to {Name(target)}." : $"{Name(target)} did not accept the input.");
    return 0;
}

static async Task<int> EndpointAsync(string endpoint)
{
    var pairing = PairingStore.Load().WithEndpoint(endpoint);
    await using (var connection = await RuntimeConnection.ConnectAsync(pairing)) await connection.RequestAsync("status.get");
    PairingStore.Save(pairing);
    Console.WriteLine($"Now using {pairing.Endpoint}; the server key {pairing.Fingerprint} still matched.");
    return 0;
}

static int Forget()
{
    Console.WriteLine(PairingStore.Forget() ? "Forgot the saved host. Revoke its grant on the Mac too." : "No host was saved.");
    return 0;
}

static async Task<List<JsonObject>> Terminals(RuntimeConnection connection) =>
    ((await connection.RequestAsync("terminal.list"))["terminals"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().ToList();

static string Name(JsonObject terminal) =>
    terminal["title"]?.ToString() is { Length: > 0 } title ? title : terminal["handle"]?.ToString() ?? "?";

static JsonObject Resolve(List<JsonObject> terminals, string selector)
{
    if (terminals.FirstOrDefault(t => t["handle"]?.ToString() == selector) is { } byHandle) return byHandle;
    if (terminals.FirstOrDefault(t => Name(t) == selector) is { } byName) return byName;
    var matches = terminals.Where(t => Name(t).Contains(selector, StringComparison.OrdinalIgnoreCase)).ToList();
    return matches.Count switch
    {
        1 => matches[0],
        0 => throw new InvalidOperationException($"No session matches {selector}. Run `orcspike list`."),
        _ => throw new InvalidOperationException($"{selector} matches {string.Join(", ", matches.Select(Name))}. Be more specific.")
    };
}

static string Summary(IReadOnlyList<double> samples)
{
    var sorted = samples.Order().ToArray();
    double At(double q) => sorted[Math.Min(sorted.Length - 1, (int)Math.Ceiling(q * sorted.Length) - 1)];
    return $"min {sorted[0]:F1} ms, median {At(0.5):F1} ms, p95 {At(0.95):F1} ms, max {sorted[^1]:F1} ms";
}

static string ReadHidden(string prompt)
{
    Console.Write(prompt);
    var text = new StringBuilder();
    while (true)
    {
        var key = Console.ReadKey(intercept: true);
        if (key.Key == ConsoleKey.Enter) break;
        if (key.Key == ConsoleKey.Backspace) { if (text.Length > 0) text.Length--; continue; }
        if (!char.IsControl(key.KeyChar)) text.Append(key.KeyChar);
    }
    Console.WriteLine($"(received {text.Length} characters)");
    return text.ToString();
}

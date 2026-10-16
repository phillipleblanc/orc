using System.Text.Json.Nodes;
using Orc.Protocol;

namespace Orc.Core;

/// <summary>What a host says about itself once this PC is connected to it.</summary>
public sealed record HostInfo(string Platform, int ProtocolVersion, string Scope, IReadOnlySet<string>? Capabilities = null)
{
    /// <summary>The host shows its sessions at the size of the screen the person is looking at (`terminal.view`).</summary>
    public const string ViewportOwnership = "orc.viewport-ownership.v1";
    /// <summary>`orc pair-computer` makes pairing links for computers.</summary>
    public const string DesktopPairing = "orc.desktop-pairing.v1";
    /// <summary>Briefs, pull requests and usage are served to this PC.</summary>
    public const string OwnerMethods = "orc.owner-methods.v1";
    /// <summary>`notify.since` reads `orc notify` messages through this PC's own cursor.</summary>
    public const string NotifyCursor = "orc.notify-cursor.v1";
    /// <summary>Notes, files, attachments, folders and the New Session defaults on the host's disk.</summary>
    public const string HostData = "orc.host-data.v1";

    public string PlatformName => Platform switch { "darwin" => "macOS", "linux" => "Linux", "win32" => "Windows", _ => Platform };

    public bool Has(string capability) => Capabilities?.Contains(capability) == true;

    public bool Equals(HostInfo? other) => other is not null && Platform == other.Platform && ProtocolVersion == other.ProtocolVersion
        && Scope == other.Scope && (Capabilities ?? EmptySet).SetEquals(other.Capabilities ?? EmptySet);

    public override int GetHashCode() => HashCode.Combine(Platform, ProtocolVersion, Scope, Capabilities?.Count ?? 0);

    private static readonly HashSet<string> EmptySet = [];
}

/// <summary>Pairing with a host: checking a link works before it is saved, and the command that makes one on the host.</summary>
public static class HostPairing
{
    public const int RuntimeProtocolVersion = 3;
    private static readonly string[] RequiredCapabilities = ["terminal.binary-stream.v1", "terminal.multiplex.v1"];

    /// <summary>Connects with <paramref name="pairing"/> and checks the host can serve this app; throws a HostConnectionException if not.</summary>
    public static async Task<HostInfo> VerifyAsync(Pairing pairing, CancellationToken cancellation = default)
    {
        await using var connection = await RuntimeConnection.ConnectAsync(pairing, cancellation);
        return await CheckAsync(connection);
    }

    /// <summary>Checks a connected host's protocol, capabilities and the grant's scope.</summary>
    public static async Task<HostInfo> CheckAsync(RuntimeConnection connection)
    {
        var status = await connection.RequestAsync("status.get");
        var version = status["runtimeProtocolVersion"] is JsonValue v && v.TryGetValue(out int number) ? number : 0;
        var capabilities = (status["capabilities"] as JsonArray ?? new JsonArray()).Select(c => c?.ToString()).OfType<string>().ToHashSet();
        if (version != RuntimeProtocolVersion || !RequiredCapabilities.All(capabilities.Contains))
            throw new HostIncompatibleException($"The host runs Orc protocol {version}; this app needs {RuntimeProtocolVersion}. Update Orc on the host or this app.");
        var scope = status["deviceScope"]?.ToString() ?? "runtime";
        if (scope != "runtime")
            throw new HostRefusedException("This pairing only lets a phone view and type. Pair with a link made for a computer.");
        return new HostInfo(status["hostPlatform"]?.ToString() ?? "unknown", version, scope, capabilities);
    }

    /// <summary>
    /// The command on the host that prints a pairing link for this PC: a computer's grant named after it, at the host's
    /// local name (docs/computers.md). It contains no secret; the link it prints does.
    /// </summary>
    public static string HostCommand(string computerName) =>
        $"orc pair-computer --name {(computerName.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.') ? computerName : $"'{computerName.Replace("'", "")}'")} --link";

    /// <summary>
    /// The same for a host whose Orc predates <c>orc pair-computer</c>: a script that issues a runtime-scope grant
    /// named after this PC, at the host's own LAN address.
    /// </summary>
    public static string LegacyHostCommand(string computerName) => $$$"""
        python3 - <<'EOF'
        import json, os, socket, uuid
        meta = json.load(open(os.path.expanduser('~/.config/orc/runtime/orca-runtime.json')))
        rpc = next(t['endpoint'] for t in meta['transports'] if t['kind'] == 'unix')
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); probe.connect(('192.0.2.1', 9))
        address = probe.getsockname()[0]
        s = socket.socket(socket.AF_UNIX); s.connect(rpc)
        s.sendall((json.dumps({'id': str(uuid.uuid4()), 'authToken': meta['authToken'], 'method': 'slim.pairing.create',
            'params': {'scope': 'runtime', 'name': '{{{computerName.Replace("'", "")}}}', 'endpoint': f'ws://{address}:6768'}}) + '\n').encode())
        print(json.loads(s.makefile().readline())['result']['link'])
        EOF
        """;

    /// <summary>
    /// A WebSocket endpoint from what someone typed: an address or host name, optionally with a port, or a ws:// URL.
    /// Null when it is not one.
    /// </summary>
    public static string? EndpointFrom(string typed)
    {
        typed = typed.Trim();
        if (typed.Length == 0) return null;
        var withScheme = typed.Contains("://") ? typed : "ws://" + typed;
        if (!Uri.TryCreate(withScheme, UriKind.Absolute, out var uri) || uri.Scheme is not ("ws" or "wss") || string.IsNullOrEmpty(uri.Host)
            || uri.AbsolutePath is not ("/" or "") || uri.Query.Length > 0) return null;
        // A port only when one was typed (after any IPv6 brackets); otherwise Orc's.
        var authority = withScheme[(withScheme.IndexOf("://", StringComparison.Ordinal) + 3)..].TrimEnd('/');
        var typedPort = authority.LastIndexOf(':') > authority.LastIndexOf(']');
        return $"{uri.Scheme}://{uri.Host}:{(typedPort ? uri.Port : 6768)}";
    }
}

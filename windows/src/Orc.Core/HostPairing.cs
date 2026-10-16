using System.Text.Json.Nodes;
using Orc.Protocol;

namespace Orc.Core;

/// <summary>What a host says about itself once this PC is connected to it.</summary>
public sealed record HostInfo(string Platform, int ProtocolVersion, string Scope)
{
    public string PlatformName => Platform switch { "darwin" => "macOS", "linux" => "Linux", "win32" => "Windows", _ => Platform };
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
        var capabilities = (status["capabilities"] as JsonArray ?? new JsonArray()).Select(c => c?.ToString()).ToHashSet();
        if (version != RuntimeProtocolVersion || !RequiredCapabilities.All(capabilities.Contains))
            throw new HostIncompatibleException($"The host runs Orc protocol {version}; this app needs {RuntimeProtocolVersion}. Update Orc on the host or this app.");
        var scope = status["deviceScope"]?.ToString() ?? "runtime";
        if (scope != "runtime")
            throw new HostRefusedException("This pairing only lets a phone view and type. Pair with a link made for a computer.");
        return new HostInfo(status["hostPlatform"]?.ToString() ?? "unknown", version, scope);
    }

    /// <summary>
    /// A shell command for the host that prints a pairing link for this PC: a runtime-scope grant named after it, at the
    /// host's own LAN address. It contains no secret; the link it prints does.
    /// </summary>
    public static string HostCommand(string computerName) => $$$"""
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

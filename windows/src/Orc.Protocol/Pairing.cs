using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Orc.Protocol;

/// <summary>
/// Runtime access from an <c>orca://pair?code=base64url(JSON)</c> link: the WebSocket endpoint, a device token and
/// the runtime's public key, which pins its identity. The endpoint may change (a new DHCP lease); the key may not.
/// </summary>
public sealed record Pairing(string Endpoint, string DeviceToken, string PublicKeyB64, string Scope, string? DeviceId)
{
    public byte[] PublicKey => Convert.FromBase64String(PublicKeyB64);

    /// <summary>A short, stable label for the runtime's key, safe to show.</summary>
    public string Fingerprint => Convert.ToHexString(SHA256.HashData(PublicKey).AsSpan(0, 6)).ToLowerInvariant();

    public Uri EndpointUri => new(Endpoint);

    public static Pairing Parse(string input)
    {
        input = input.Trim();
        const string invalid = "That is not a valid Orc access link (orca://pair?code=…).";
        if (input.Length > 32768 || !Uri.TryCreate(input, UriKind.Absolute, out var uri) || uri.Scheme != "orca" || uri.Host != "pair")
            throw new FormatException(invalid);
        var code = QueryValue(uri.Query, "code") ?? (uri.Fragment.Length > 1 ? uri.Fragment[1..] : null);
        if (string.IsNullOrEmpty(code)) throw new FormatException(invalid);

        Claims claims;
        try { claims = JsonSerializer.Deserialize<Claims>(FromBase64Url(code)) ?? throw new FormatException(invalid); }
        catch (Exception error) when (error is JsonException or FormatException) { throw new FormatException(invalid); }

        if (claims.Endpoint is null || !Uri.TryCreate(claims.Endpoint, UriKind.Absolute, out var endpoint)
            || endpoint.Scheme is not ("ws" or "wss") || string.IsNullOrEmpty(endpoint.Host)
            || string.IsNullOrEmpty(claims.DeviceToken) || claims.PublicKeyB64 is null || DecodedLength(claims.PublicKeyB64) != 32)
            throw new FormatException(invalid);
        var scope = claims.Scope ?? "runtime";
        if (scope == "mobile")
            throw new FormatException("This is a phone (mobile-scope) link. Phones can only view and type, so it cannot attach desktop terminals. "
                + "Issue a runtime-scope link with slim.pairing.create instead.");
        if (scope != "runtime") throw new FormatException(invalid);
        if (endpoint.Host is "127.0.0.1" or "localhost" or "::1")
            throw new FormatException($"This link points at {endpoint.Host}, which is the Mac itself. Issue it with the Mac's LAN address as the endpoint.");
        return new Pairing(claims.Endpoint, claims.DeviceToken, claims.PublicKeyB64, scope, claims.PairedDeviceId);
    }

    public Pairing WithEndpoint(string endpoint)
    {
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || uri.Scheme is not ("ws" or "wss") || string.IsNullOrEmpty(uri.Host))
            throw new FormatException("The endpoint must look like ws://192.168.1.20:6768.");
        return this with { Endpoint = uri.GetLeftPart(UriPartial.Authority) };
    }

    private static string? QueryValue(string query, string name)
    {
        foreach (var part in query.TrimStart('?').Split('&'))
        {
            var pair = part.Split('=', 2);
            if (pair.Length == 2 && pair[0] == name) return Uri.UnescapeDataString(pair[1]);
        }
        return null;
    }

    internal static byte[] FromBase64Url(string value)
    {
        var base64 = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(base64 + new string('=', (4 - base64.Length % 4) % 4));
    }

    private static int DecodedLength(string base64)
    {
        try { return Convert.FromBase64String(base64).Length; } catch (FormatException) { return -1; }
    }

    private sealed record Claims(
        [property: JsonPropertyName("v")] int V,
        [property: JsonPropertyName("endpoint")] string? Endpoint,
        [property: JsonPropertyName("deviceToken")] string? DeviceToken,
        [property: JsonPropertyName("publicKeyB64")] string? PublicKeyB64,
        [property: JsonPropertyName("scope")] string? Scope,
        [property: JsonPropertyName("pairedDeviceId")] string? PairedDeviceId);
}

/// <summary>The saved host, with its device token encrypted for the current Windows user (DPAPI).</summary>
public static class PairingStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("orc-spike-host-v1");

    public static string Directory =>
        Environment.GetEnvironmentVariable("ORC_WINDOWS_DIR") is { Length: > 0 } dir ? dir
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Orc");

    private static string FilePath => Path.Combine(Directory, "host.json");

    // Where the Phase 0 spike saved its host; read until the next save writes FilePath.
    private static string LegacyFilePath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OrcSpike", "host.json");

    public static void Save(Pairing pairing)
    {
        System.IO.Directory.CreateDirectory(Directory);
        var token = ProtectedData.Protect(Encoding.UTF8.GetBytes(pairing.DeviceToken), Entropy, DataProtectionScope.CurrentUser);
        var record = new Stored(pairing.Endpoint, pairing.PublicKeyB64, pairing.Scope, pairing.DeviceId, Convert.ToBase64String(token));
        var temp = FilePath + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(record, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(temp, FilePath, overwrite: true);
    }

    public static Pairing Load()
    {
        var path = File.Exists(FilePath) ? FilePath
            : Environment.GetEnvironmentVariable("ORC_WINDOWS_DIR") is not { Length: > 0 } && File.Exists(LegacyFilePath) ? LegacyFilePath
            : throw new InvalidOperationException("No Mac is paired yet. Run `orcspike pair` and paste the access link.");
        var stored = JsonSerializer.Deserialize<Stored>(File.ReadAllText(path)) ?? throw new InvalidOperationException("The saved host is unreadable.");
        var token = Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(stored.ProtectedToken), Entropy, DataProtectionScope.CurrentUser));
        return new Pairing(stored.Endpoint, token, stored.PublicKeyB64, stored.Scope, stored.DeviceId);
    }

    public static bool Forget()
    {
        var forgot = false;
        foreach (var path in new[] { FilePath, LegacyFilePath }.Where(File.Exists))
        {
            File.Delete(path);
            forgot = true;
        }
        return forgot;
    }

    private sealed record Stored(string Endpoint, string PublicKeyB64, string Scope, string? DeviceId, string ProtectedToken);
}

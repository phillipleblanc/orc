using System.Runtime.InteropServices;

namespace Orc.Protocol;

/// <summary>
/// Orca E2EE v1, as the runtime (tweetnacl) and Orc.app (libsodium) implement it: X25519 + XSalsa20-Poly1305
/// with a precomputed shared key, framed as <c>nonce(24) || crypto_box_easy_afternm(message)</c>.
/// The client makes a fresh keypair per connection; the runtime's static public key comes from the pairing link.
/// </summary>
public sealed class E2eeChannel : IDisposable
{
    public const int KeyBytes = 32;
    public const int NonceBytes = 24;
    public const int MacBytes = 16;
    public const int Overhead = NonceBytes + MacBytes;

    private readonly byte[] shared = new byte[KeyBytes];

    public byte[] PublicKey { get; } = new byte[KeyBytes];

    public unsafe E2eeChannel(ReadOnlySpan<byte> serverPublicKey)
    {
        if (serverPublicKey.Length != KeyBytes) throw new ArgumentException("The runtime public key must be 32 bytes.");
        Sodium.EnsureInitialized();
        var secret = new byte[KeyBytes];
        try
        {
            fixed (byte* pk = PublicKey, sk = secret, peer = serverPublicKey, key = shared)
            {
                if (Sodium.crypto_box_keypair(pk, sk) != 0 || Sodium.crypto_box_beforenm(key, peer, sk) != 0)
                    throw new InvalidOperationException("Cannot establish runtime encryption.");
            }
        }
        finally { Sodium.Wipe(secret); }
    }

    /// <summary>For tests: a channel with a known keypair, as the runtime side would hold it.</summary>
    internal unsafe E2eeChannel(ReadOnlySpan<byte> peerPublicKey, ReadOnlySpan<byte> ownSecretKey, ReadOnlySpan<byte> ownPublicKey)
    {
        Sodium.EnsureInitialized();
        ownPublicKey.CopyTo(PublicKey);
        fixed (byte* peer = peerPublicKey, sk = ownSecretKey, key = shared)
        {
            if (Sodium.crypto_box_beforenm(key, peer, sk) != 0) throw new InvalidOperationException("Cannot establish encryption.");
        }
    }

    public unsafe byte[] Seal(ReadOnlySpan<byte> message)
    {
        var output = new byte[message.Length + Overhead];
        fixed (byte* o = output, m = message, key = shared)
        {
            Sodium.randombytes_buf(o, NonceBytes);
            if (Sodium.crypto_box_easy_afternm(o + NonceBytes, m, (ulong)message.Length, o, key) != 0)
                throw new InvalidOperationException("Encryption failed.");
        }
        return output;
    }

    /// <summary>Returns null when the bundle is malformed or fails authentication.</summary>
    public unsafe byte[]? Open(ReadOnlySpan<byte> bundle)
    {
        if (bundle.Length < Overhead) return null;
        var output = new byte[bundle.Length - Overhead];
        byte empty = 0;
        fixed (byte* o = output, b = bundle, key = shared)
        {
            // crypto_box_open_easy_afternm needs a valid pointer even for an empty message.
            byte* target = output.Length == 0 ? &empty : o;
            return Sodium.crypto_box_open_easy_afternm(target, b + NonceBytes, (ulong)(bundle.Length - NonceBytes), b, key) == 0 ? output : null;
        }
    }

    public void Dispose() => Sodium.Wipe(shared);
}

internal static unsafe partial class Sodium
{
    private const string Library = "libsodium";
    private static int initialized;

    public static void EnsureInitialized()
    {
        if (Volatile.Read(ref initialized) == 1) return;
        // 0: initialized now, 1: already initialized, -1: failure.
        if (sodium_init() < 0) throw new InvalidOperationException("libsodium failed to initialize.");
        Volatile.Write(ref initialized, 1);
    }

    public static void Wipe(byte[] buffer)
    {
        fixed (byte* b = buffer) sodium_memzero(b, (nuint)buffer.Length);
    }

    public static void Keypair(Span<byte> publicKey, Span<byte> secretKey)
    {
        EnsureInitialized();
        fixed (byte* pk = publicKey, sk = secretKey)
            if (crypto_box_keypair(pk, sk) != 0) throw new InvalidOperationException("Keypair generation failed.");
    }

    [LibraryImport(Library)] private static partial int sodium_init();
    [LibraryImport(Library)] private static partial void sodium_memzero(byte* buffer, nuint length);
    [LibraryImport(Library)] internal static partial void randombytes_buf(byte* buffer, nuint size);
    [LibraryImport(Library)] internal static partial int crypto_box_keypair(byte* publicKey, byte* secretKey);
    [LibraryImport(Library)] internal static partial int crypto_box_beforenm(byte* key, byte* publicKey, byte* secretKey);
    [LibraryImport(Library)] internal static partial int crypto_box_easy_afternm(byte* cipher, byte* message, ulong length, byte* nonce, byte* key);
    [LibraryImport(Library)] internal static partial int crypto_box_open_easy_afternm(byte* message, byte* cipher, ulong length, byte* nonce, byte* key);
}

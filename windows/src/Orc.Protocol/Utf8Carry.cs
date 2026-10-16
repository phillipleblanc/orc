namespace Orc.Protocol;

/// <summary>
/// Holds back a UTF-8 sequence split across output frames, for surfaces that decode each write on its own
/// (a Windows console does; xterm.js does not need it).
/// </summary>
public sealed class Utf8Carry
{
    private byte[] pending = [];

    public void Clear() => pending = [];

    public byte[] Take(ReadOnlySpan<byte> bytes)
    {
        var all = pending.Length == 0 ? bytes.ToArray() : [.. pending, .. bytes];
        var cut = all.Length;
        // Walk back over at most 3 continuation bytes to the lead byte of the last sequence.
        for (var back = 1; back <= Math.Min(4, all.Length); back++)
        {
            var b = all[^back];
            if ((b & 0xC0) == 0x80) continue;
            var length = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : b >= 0xC0 ? 2 : 1;
            if (length > back) cut = all.Length - back;
            break;
        }
        pending = all[cut..];
        return cut == all.Length ? all : all[..cut];
    }
}

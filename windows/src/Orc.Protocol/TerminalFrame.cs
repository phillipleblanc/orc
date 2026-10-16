using System.Buffers.Binary;

namespace Orc.Protocol;

/// <summary>Opcodes of Orca terminal stream frames (slim/frontend/src/terminal-frames.ts).</summary>
public static class Opcode
{
    public const byte Output = 1;
    public const byte SnapshotStart = 2;
    public const byte SnapshotChunk = 3;
    public const byte SnapshotEnd = 4;
    public const byte Resized = 5;
    public const byte Error = 6;
    public const byte Input = 7;
    public const byte Resize = 8;
    public const byte Subscribe = 9;
    public const byte Unsubscribe = 10;
    public const byte SnapshotRequest = 11;
    public const byte Metadata = 12;
    public const byte Ack = 13;
    public const byte ClaimViewport = 14;
    public const byte OutputSpan = 15;
    public const byte SetOutputPaused = 16;
    public const byte WriteUnavailable = 17;
}

/// <summary>
/// A 16-byte little-endian header <c>0x74, version 1, opcode, 0, u32 streamId, u32 seq high, u32 seq low</c>,
/// then the payload.
/// </summary>
public readonly record struct TerminalFrame(byte Opcode, uint StreamId, ulong Sequence, ReadOnlyMemory<byte> Payload)
{
    public const int HeaderBytes = 16;
    private const byte Magic = 0x74;
    private const byte Version = 1;

    public byte[] Encode()
    {
        var bytes = new byte[HeaderBytes + Payload.Length];
        bytes[0] = Magic;
        bytes[1] = Version;
        bytes[2] = Opcode;
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), StreamId);
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(8), (uint)(Sequence >> 32));
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(12), (uint)Sequence);
        Payload.Span.CopyTo(bytes.AsSpan(HeaderBytes));
        return bytes;
    }

    public static TerminalFrame? Decode(byte[] bytes)
    {
        if (bytes.Length < HeaderBytes || bytes[0] != Magic || bytes[1] != Version) return null;
        var high = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(8));
        var low = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(12));
        return new TerminalFrame(bytes[2], BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(4)),
            (ulong)high << 32 | low, bytes.AsMemory(HeaderBytes));
    }
}

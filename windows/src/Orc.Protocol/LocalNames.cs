using System.Buffers.Binary;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;

namespace Orc.Protocol;

/// <summary>
/// Finds a computer by its local name (<c>NAME.local</c>). Orc's pairing links name the Mac this way, since the name
/// outlasts its DHCP addresses, but Windows' resolver does not always ask the network for such names; this asks with a
/// multicast DNS query (RFC 6762) on each network this PC is on when the resolver has no answer.
/// </summary>
public static class LocalNames
{
    private static readonly IPEndPoint Group = new(IPAddress.Parse("224.0.0.251"), 5353);

    public static bool IsLocal(string host) =>
        host.EndsWith(".local", StringComparison.OrdinalIgnoreCase) && Uri.CheckHostName(host) == UriHostNameType.Dns;

    /// <summary>The IPv4 address <paramref name="host"/> has on this network, or null when nothing answers for it.</summary>
    public static async Task<IPAddress?> ResolveAsync(string host, CancellationToken cancellation)
    {
        try
        {
            var addresses = await Dns.GetHostAddressesAsync(host, AddressFamily.InterNetwork, cancellation);
            if (addresses.Length > 0) return addresses[0];
        }
        catch (SocketException) { }
        // Asked twice, as RFC 6762 suggests for a lost query or reply.
        for (var attempt = 0; attempt < 2; attempt++)
            if (await QueryAsync(host, TimeSpan.FromSeconds(1), cancellation) is { } address) return address;
        return null;
    }

    private static async Task<IPAddress?> QueryAsync(string host, TimeSpan timeout, CancellationToken cancellation)
    {
        var query = Query(host);
        using var waiting = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        waiting.CancelAfter(timeout);
        var sockets = new List<UdpClient>();
        var found = new TaskCompletionSource<IPAddress?>(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task ListenAsync(UdpClient socket)
        {
            try
            {
                while (!found.Task.IsCompleted)
                {
                    var reply = await socket.ReceiveAsync(waiting.Token);
                    if (Answer(reply.Buffer, host) is { } address) found.TrySetResult(address);
                }
            }
            catch (Exception error) when (error is OperationCanceledException or SocketException or ObjectDisposedException) { }
        }
        try
        {
            using var expired = waiting.Token.Register(() => found.TrySetResult(null));
            foreach (var local in Networks())
            {
                try
                {
                    var socket = new UdpClient(new IPEndPoint(local, 0));
                    sockets.Add(socket);
                    socket.Client.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastInterface, local.GetAddressBytes());
                    // From a port other than 5353, so responders answer this socket directly (RFC 6762, section 6.7).
                    await socket.SendAsync(query, Group, waiting.Token);
                    _ = ListenAsync(socket);
                }
                catch (SocketException) { }
            }
            var address = await found.Task;
            cancellation.ThrowIfCancellationRequested();
            return address;
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { return null; }
        finally
        {
            foreach (var socket in sockets) socket.Dispose();
        }
    }

    /// <summary>This PC's IPv4 addresses on networks that are up and carry multicast.</summary>
    private static IEnumerable<IPAddress> Networks() =>
        NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == OperationalStatus.Up && n.SupportsMulticast && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .SelectMany(n => n.GetIPProperties().UnicastAddresses)
            .Select(a => a.Address)
            .Where(a => a.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a));

    /// <summary>A query for the name's IPv4 address, asking for a reply sent straight back.</summary>
    internal static byte[] Query(string host)
    {
        var message = new List<byte>(64) { 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0 };
        foreach (var label in host.TrimEnd('.').Split('.'))
        {
            var bytes = Encoding.UTF8.GetBytes(label);
            message.Add((byte)bytes.Length);
            message.AddRange(bytes);
        }
        // Type A, class IN with the unicast-response bit.
        message.AddRange([0, 0, 1, 0x80, 1]);
        return [.. message];
    }

    /// <summary>The IPv4 address a reply gives for the name, if it is a reply that gives one.</summary>
    internal static IPAddress? Answer(byte[] message, string host)
    {
        if (message.Length < 12 || (message[2] & 0x80) == 0) return null;
        var questions = BinaryPrimitives.ReadUInt16BigEndian(message.AsSpan(4));
        var records = BinaryPrimitives.ReadUInt16BigEndian(message.AsSpan(6)) + BinaryPrimitives.ReadUInt16BigEndian(message.AsSpan(8))
            + BinaryPrimitives.ReadUInt16BigEndian(message.AsSpan(10));
        var offset = 12;
        for (var i = 0; i < questions; i++)
        {
            if (ReadName(message, ref offset) is null || (offset += 4) > message.Length) return null;
        }
        var wanted = host.TrimEnd('.');
        for (var i = 0; i < records; i++)
        {
            var name = ReadName(message, ref offset);
            if (name is null || offset + 10 > message.Length) return null;
            var type = BinaryPrimitives.ReadUInt16BigEndian(message.AsSpan(offset));
            var recordClass = BinaryPrimitives.ReadUInt16BigEndian(message.AsSpan(offset + 2)) & 0x7fff;
            var length = BinaryPrimitives.ReadUInt16BigEndian(message.AsSpan(offset + 8));
            offset += 10;
            if (offset + length > message.Length) return null;
            if (type == 1 && recordClass == 1 && length == 4 && string.Equals(name, wanted, StringComparison.OrdinalIgnoreCase))
                return new IPAddress(message.AsSpan(offset, 4));
            offset += length;
        }
        return null;
    }

    /// <summary>A name at <paramref name="offset"/>, following compression pointers; moves past it. Null if malformed.</summary>
    private static string? ReadName(byte[] message, ref int offset)
    {
        var labels = new List<string>();
        var at = offset;
        var end = -1;
        for (var jumps = 0; jumps < 32;)
        {
            if (at >= message.Length) return null;
            var length = message[at];
            if (length == 0)
            {
                offset = end >= 0 ? end : at + 1;
                return string.Join('.', labels);
            }
            if ((length & 0xc0) == 0xc0)
            {
                if (at + 1 >= message.Length) return null;
                if (end < 0) end = at + 2;
                at = ((length & 0x3f) << 8) | message[at + 1];
                jumps++;
                continue;
            }
            if ((length & 0xc0) != 0 || at + 1 + length > message.Length) return null;
            labels.Add(Encoding.UTF8.GetString(message, at + 1, length));
            at += 1 + length;
        }
        return null;
    }
}

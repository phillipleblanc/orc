namespace Orc.Protocol;

/// <summary>Why a connection to a host failed, so callers can tell retrying from re-pairing. Each is an IOException.</summary>
public class HostConnectionException(string message, Exception? inner = null) : IOException(message, inner);

/// <summary>Nothing answered at the endpoint: the host is asleep, off this network, at another address, or not running Orc.</summary>
public sealed class HostUnreachableException(string message, Exception? inner = null) : HostConnectionException(message, inner);

/// <summary>The host refused this device's token: its grant was revoked, or it was never issued by this host.</summary>
public sealed class HostRefusedException(string message) : HostConnectionException(message);

/// <summary>The host could not prove it holds the key the pairing pinned: another machine, or a runtime that was reset.</summary>
public sealed class HostIdentityException(string message) : HostConnectionException(message);

/// <summary>The host speaks another version of the protocol than this app.</summary>
public sealed class HostIncompatibleException(string message) : HostConnectionException(message);

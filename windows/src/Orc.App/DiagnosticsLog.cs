using System.Text.Json.Nodes;
using Orc.Protocol;

namespace Orc.Win;

/// <summary>
/// With ORC_DIAGNOSTICS=1, what the terminal page reports about itself (buffer, mouse mode, display scale, what the
/// wheel produced), one JSON line each, in <c>%LOCALAPPDATA%\Orc\logs\terminal.log</c>. Kept under 1 MiB by starting over.
/// </summary>
internal static class DiagnosticsLog
{
    private const long MaxBytes = 1 << 20;
    private static readonly object Gate = new();

    public static string FilePath => Path.Combine(PairingStore.Directory, "logs", "terminal.log");

    public static void Append(JsonObject entry)
    {
        entry["at"] = DateTimeOffset.Now.ToString("O");
        var line = entry.ToJsonString() + Environment.NewLine;
        lock (Gate)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
                if (File.Exists(FilePath) && new FileInfo(FilePath).Length > MaxBytes) File.Delete(FilePath);
                File.AppendAllText(FilePath, line);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}

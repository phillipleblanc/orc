using System.Text.Json;
using System.Text.Json.Nodes;
using Orc.Protocol;

namespace Orc.Core;

/// <summary>This app's own preferences, such as which sidebar sections are folded, in <c>%LOCALAPPDATA%\Orc\settings.json</c>.</summary>
public static class LocalSettings
{
    private static readonly object Gate = new();

    private static string FilePath => Path.Combine(PairingStore.Directory, "settings.json");

    public static bool GetBool(string key, bool fallback)
    {
        var value = Read()[key];
        return value is JsonValue v && v.TryGetValue(out bool b) ? b : fallback;
    }

    public static long? GetLong(string key)
    {
        var value = Read()[key];
        return value is JsonValue v && v.TryGetValue(out long n) ? n : null;
    }

    public static string? GetString(string key) => Read()[key] is JsonValue v && v.TryGetValue(out string? s) ? s : null;

    public static void Set(string key, JsonNode? value)
    {
        lock (Gate)
        {
            try
            {
                var settings = Read();
                settings[key] = value;
                Directory.CreateDirectory(PairingStore.Directory);
                var temp = FilePath + ".tmp";
                File.WriteAllText(temp, settings.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
                File.Move(temp, FilePath, overwrite: true);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
    }

    private static JsonObject Read()
    {
        lock (Gate)
        {
            try { return File.Exists(FilePath) && JsonNode.Parse(File.ReadAllText(FilePath)) is JsonObject stored ? stored : new JsonObject(); }
            catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException) { return new JsonObject(); }
        }
    }
}

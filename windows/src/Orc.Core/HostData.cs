using System.Text.Json.Nodes;
using Orc.Protocol;

namespace Orc.Core;

/// <summary>A folder on the host and the folders in it, as <c>fs.list</c> reports them.</summary>
public sealed record FolderListing(string Path, IReadOnlyList<string> Folders, bool Truncated);

/// <summary>
/// What Orc.app reads from its own disk, for this PC (capability <c>orc.host-data.v1</c>, slim/frontend/src/host-data.ts):
/// files pasted or dropped into a terminal, folders to add as projects, and the New Session defaults.
/// </summary>
public static class HostData
{
    /// <summary>The largest attachment the host takes.</summary>
    public const int MaxAttachmentBytes = 12 << 20;

    /// <summary>Saves a pasted or dropped file on the host, in a folder of its own, and returns its path there.</summary>
    public static async Task<string> SaveAttachmentAsync(SessionCommands.Request request, string name, byte[] data)
    {
        if (data.Length > MaxAttachmentBytes) throw new InvalidOperationException($"{name} is larger than 12 MB, the most the host takes.");
        var result = await request("attachment.save", new JsonObject { ["name"] = name, ["data"] = Convert.ToBase64String(data) }, TimeSpan.FromSeconds(60));
        return result["path"]?.ToString() is { Length: > 0 } path ? path : throw new RpcException("invalid_result", "The host did not say where it saved the file.");
    }

    /// <summary>A path as a POSIX shell word, as Orc.app pastes dropped files (Sources/OrcKit/Models.swift, shellQuote).</summary>
    public static string ShellQuote(string value) => "'" + value.Replace("'", "'\"'\"'") + "'";

    /// <summary>The folders in a folder on the host; only folders in the host's home folder are listed.</summary>
    public static async Task<FolderListing> ListFoldersAsync(SessionCommands.Request request, string path)
    {
        var result = await request("fs.list", new JsonObject { ["path"] = path, ["directoriesOnly"] = true }, null);
        var folders = (result["entries"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .Where(e => e["directory"] is JsonValue d && d.TryGetValue(out bool directory) && directory)
            .Select(e => e["name"]?.ToString() ?? "").Where(n => n.Length > 0).ToList();
        return new FolderListing(result["path"]?.ToString() ?? path, folders, result["truncated"] is JsonValue t && t.TryGetValue(out bool truncated) && truncated);
    }

    /// <summary>The folder above <paramref name="path"/> on the host, or null at the root.</summary>
    public static string? ParentOf(string path)
    {
        var trimmed = path.TrimEnd('/');
        var at = trimmed.LastIndexOf('/');
        return at < 0 || trimmed.Length == 0 ? null : at == 0 ? "/" : trimmed[..at];
    }

    /// <summary>A folder inside <paramref name="path"/> on the host.</summary>
    public static string Child(string path, string name) => path.TrimEnd('/') + "/" + name;

    /// <summary>
    /// Registers a folder on the host as a project, as Orc.app's Add Project does, and optionally makes it the default
    /// project for new sessions there.
    /// </summary>
    public static async Task<Project> AddProjectAsync(SessionCommands.Request request, string path, bool makeDefault)
    {
        var result = await request("repo.add", new JsonObject { ["path"] = path }, TimeSpan.FromSeconds(30));
        var project = result["repo"] is JsonObject repo && Project.FromJson(repo) is { } added ? added
            : throw new RpcException("invalid_result", "The host did not return the added project.");
        if (makeDefault) await request("config.set", new JsonObject { ["defaultProject"] = "id:" + project.Id }, null);
        return project;
    }

    /// <summary>The host's New Session defaults, which Orc.app and <c>orc new</c> use there.</summary>
    public static async Task<SessionDefaults> DefaultsAsync(SessionCommands.Request request) =>
        SessionDefaults.FromHost(await request("config.get", null, null));
}

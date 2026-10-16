using System.Text.Json;
using System.Text.Json.Nodes;
using Orc.Protocol;

namespace Orc.Core;

/// <summary>What a new session runs, as Orc.app's New Session sheet offers it (SessionType).</summary>
public sealed record SessionKind(string Id, string Label, string? Command, bool TakesMcp)
{
    public static readonly IReadOnlyList<SessionKind> All =
    [
        new("pi", "Pi", "pi", true),
        new("codex", "Codex", "codex --no-daemon", true),
        new("claude", "Claude Code", "claude", true),
        new("durable", "Durable (experimental)", "durable", false),
        new("terminal", "Terminal", null, false),
        new("custom", "Custom command", null, false)
    ];

    public static SessionKind? Find(string? id) => All.FirstOrDefault(k => k.Id == id);
}

/// <summary>An optional MCP config of a project (`.mcp/NAME.json`) and the servers it names, or why it cannot be used.</summary>
public sealed record McpConfig(string Name, string Path, IReadOnlyList<string> Servers, string? Error);

/// <summary>
/// Creating, renaming, restarting and closing sessions with the runtime's terminal.* methods, as Orc.app's
/// SessionService does over its local socket.
/// </summary>
public static class SessionCommands
{
    private static readonly TimeSpan SlowTimeout = TimeSpan.FromSeconds(60);

    public delegate Task<JsonObject> Request(string method, JsonObject? parameters, TimeSpan? timeout);

    /// <summary>Starts a session in a project and returns its handle. Retrying with the same mutation id is safe.</summary>
    public static async Task<string> CreateAsync(Request request, string name, Project project, string? command,
        IReadOnlyCollection<string> mcp, TerminalSize size, string? mutationId = null)
    {
        var parameters = new JsonObject
        {
            ["title"] = name, ["worktree"] = "id:" + project.Id, ["clientMutationId"] = mutationId ?? Guid.NewGuid().ToString(),
            ["cols"] = size.Clamped.Cols, ["rows"] = size.Clamped.Rows
        };
        if (!string.IsNullOrEmpty(command)) parameters["command"] = command;
        if (mcp.Count > 0) parameters["mcp"] = new JsonArray(mcp.Select(m => (JsonNode)m).ToArray());
        var result = await request("terminal.create", parameters, SlowTimeout);
        return result["terminal"]?["handle"]?.ToString()
            ?? throw new InvalidOperationException("The host did not return the new session. Check the session list before trying again.");
    }

    /// <summary>Renames a session. Its handle stays; its name, and so its place in the hierarchy, changes.</summary>
    public static Task RenameAsync(Request request, string handle, string name) =>
        request("terminal.rename", new JsonObject { ["terminal"] = handle, ["title"] = name }, null);

    /// <summary>Ends the session and what runs in it. A closed agent session can be reopened on the host.</summary>
    public static Task CloseAsync(Request request, string handle) =>
        request("terminal.close", new JsonObject { ["terminal"] = handle }, null);

    /// <summary>Ends a session and starts it again under its name; an agent continues its conversation. Returns the new handle.</summary>
    public static async Task<string> RestartAsync(Request request, string handle)
    {
        var result = await request("terminal.restart", new JsonObject { ["terminal"] = handle }, SlowTimeout);
        return result["restart"]?["handle"]?.ToString()
            ?? throw new InvalidOperationException("The host did not return the restarted session. Check the session list before trying again.");
    }

    public static async Task<IReadOnlyList<McpConfig>> McpConfigsAsync(Request request, Project project)
    {
        var result = await request("mcp.list", new JsonObject { ["project"] = "id:" + project.Id }, null);
        return (result["configs"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(c => new McpConfig(
            c["name"]?.ToString() ?? "", c["path"]?.ToString() ?? "",
            (c["servers"] as JsonArray ?? new JsonArray()).Select(s => s?.ToString() ?? "").ToList(), c["error"]?.ToString())).ToList();
    }

    /// <summary>The projects a selector names (SessionCreationDefaults): <c>id:ID</c>, <c>path:PATH</c>, an absolute path, or a name.</summary>
    public static IReadOnlyList<Project> ProjectsMatching(string selector, IReadOnlyList<Project> projects) => projects.Where(p =>
        selector.StartsWith("id:") ? p.Id == selector[3..] || p.Id.StartsWith(selector[3..] + "::")
        : selector.StartsWith("path:") ? p.Path == selector[5..]
        : selector.StartsWith('/') ? p.Path == selector
        : p.Name == selector || Project.LastComponent(p.Path) == selector).ToList();
}

/// <summary>
/// Defaults for new sessions: <c>defaultSessionType</c> and <c>defaultProject</c> (a project selector). From a host with
/// host data they are the host's own (~/.config/orc/config.json, which Orc.app's Settings and <c>orc new</c> use), and
/// creating a session leaves them alone, as on the Mac. Otherwise they are this PC's, in
/// <c>%LOCALAPPDATA%\Orc\config.json</c> with the same keys, and remember the last session created; settings this app
/// does not know are kept.
/// </summary>
public sealed class SessionDefaults
{
    private readonly string file;
    private bool fromHost;

    public SessionDefaults(string? file = null) => this.file = file ?? Path.Combine(PairingStore.Directory, "config.json");

    /// <summary>The defaults in a <c>config.get</c> result.</summary>
    public static SessionDefaults FromHost(JsonObject config)
    {
        var defaults = new SessionDefaults { fromHost = true };
        if (SessionKind.Find(config["defaultSessionType"]?.ToString()) is { Id: not "custom" } kind)
        {
            defaults.Kind = kind.Id;
            defaults.HasKind = true;
        }
        if (config["defaultProject"] is JsonValue project && project.TryGetValue(out string? selector) && selector.Length > 0) defaults.Project = selector;
        return defaults;
    }

    public string Kind { get; private set; } = "codex";
    public string? Project { get; private set; }

    /// <summary>Whether a kind was saved; without one, callers may suggest a better guess than the built-in default.</summary>
    public bool HasKind { get; private set; }

    public static SessionDefaults Load(string? file = null)
    {
        var defaults = new SessionDefaults(file);
        try
        {
            if (File.Exists(defaults.file) && JsonNode.Parse(File.ReadAllText(defaults.file)) is JsonObject stored)
            {
                if (SessionKind.Find(stored["defaultSessionType"]?.ToString()) is { Id: not "custom" } kind)
                {
                    defaults.Kind = kind.Id;
                    defaults.HasKind = true;
                }
                if (stored["defaultProject"]?.ToString() is { Length: > 0 } project) defaults.Project = project;
            }
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException) { }
        return defaults;
    }

    /// <summary>Remembers the kind and project of a session just created, for the next one.</summary>
    public void Remember(SessionKind kind, Project project)
    {
        if (fromHost) return;
        if (kind.Id != "custom")
        {
            Kind = kind.Id;
            HasKind = true;
        }
        Project = "id:" + project.Id;
        try
        {
            var settings = File.Exists(file) && JsonNode.Parse(File.ReadAllText(file)) is JsonObject stored ? stored : new JsonObject();
            settings["defaultSessionType"] = Kind;
            settings["defaultProject"] = Project;
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            var temp = file + ".tmp";
            File.WriteAllText(temp, settings.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            File.Move(temp, file, overwrite: true);
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException) { }
    }

    /// <summary>The default project when it names exactly one of <paramref name="projects"/>.</summary>
    public Project? ProjectIn(IReadOnlyList<Project> projects) =>
        Project is { } selector && SessionCommands.ProjectsMatching(selector, projects) is [var only] ? only : null;
}

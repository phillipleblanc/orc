using System.Text.Json;
using System.Text.Json.Serialization;
using Orc.Protocol;

namespace Orc.Core;

/// <summary>
/// Where the person dragged sessions in the sidebar, as Orc.app keeps it (Sources/OrcKit/SessionSidebarOrder.swift):
/// session names in order. Sessions it does not name keep the host's order after those it does. Placement never
/// changes name-based parentage: a top-level session moves among top-level sessions, a child among its siblings.
/// </summary>
public sealed class SidebarOrder
{
    private readonly List<string> keys;

    public SidebarOrder(IEnumerable<string>? keys = null) => this.keys = keys?.ToList() ?? [];

    public IReadOnlyList<string> Keys => keys;

    /// <summary>A section's rows: each top-level session in this order, then its children in this order unless collapsed.</summary>
    public IReadOnlyList<SidebarRow> Rows(SessionHierarchy hierarchy, IReadOnlySet<string> collapsed)
    {
        var ranks = new Dictionary<string, int>();
        for (var i = 0; i < keys.Count; i++) ranks.TryAdd(keys[i], i);
        IEnumerable<T> Ordered<T>(IEnumerable<T> values, Func<T, SessionInfo> session) =>
            values.Select((value, index) => (value, index)).OrderBy(x => ranks.GetValueOrDefault(session(x.value).Name, int.MaxValue))
                .ThenBy(x => x.index).Select(x => x.value);
        return Ordered(hierarchy.Groups, g => g.Session).SelectMany(group =>
            new[] { new SidebarRow(group.Session, null, group.Children.Count > 0) }.Concat(collapsed.Contains(group.Session.Handle)
                ? Enumerable.Empty<SidebarRow>()
                : Ordered(group.Children, child => child).Select(child => new SidebarRow(child, group.Session.Handle, false)))).ToList();
    }

    /// <summary>
    /// Whether the row at <paramref name="index"/> of <paramref name="rows"/> (a section's rows, children of expanded
    /// parents included) can go before the row at <paramref name="destination"/>, or at the end: only between siblings.
    /// </summary>
    public static bool CanMove(int index, int destination, IReadOnlyList<SidebarRow> rows)
    {
        if (index < 0 || index >= rows.Count || destination < 0 || destination > rows.Count) return false;
        var row = rows[index];
        if (row.ParentHandle is null) return destination == rows.Count || rows[destination].ParentHandle is null;
        var siblings = Enumerable.Range(0, rows.Count).Where(i => rows[i].ParentHandle == row.ParentHandle).ToList();
        return destination >= siblings[0] && destination <= siblings[^1] + 1;
    }

    /// <summary>Moves the row at <paramref name="index"/> before the row at <paramref name="destination"/>; returns whether the order changed.</summary>
    public bool Move(int index, int destination, IReadOnlyList<SidebarRow> rows)
    {
        if (!CanMove(index, destination, rows)) return false;
        var row = rows[index];
        var siblings = rows.Where(r => r.ParentHandle == row.ParentHandle).Select(r => r.Session.Name).ToList();
        var anchor = rows.Skip(destination).FirstOrDefault(r => r.ParentHandle == row.ParentHandle)?.Session.Name;
        var key = row.Session.Name;
        var at = siblings.IndexOf(key);
        if (anchor == key || at < 0 || siblings.Skip(at + 1).FirstOrDefault() == anchor) return false;
        // Siblings the order does not name yet keep their place, so a partial list or a disconnect never loses placement.
        foreach (var sibling in siblings.Where(s => !keys.Contains(s))) keys.Add(sibling);
        keys.Remove(key);
        if (anchor is not null && keys.IndexOf(anchor) is var before and >= 0) keys.Insert(before, key);
        else keys.Add(key);
        return true;
    }

    /// <summary>Where the row at <paramref name="index"/> goes to move one place up or down among its siblings, if it can.</summary>
    public static int? Step(int index, int direction, IReadOnlyList<SidebarRow> rows)
    {
        if (index < 0 || index >= rows.Count) return null;
        var parent = rows[index].ParentHandle;
        var siblings = Enumerable.Range(0, rows.Count).Where(i => rows[i].ParentHandle == parent).ToList();
        var at = siblings.IndexOf(index);
        if (direction < 0) return at > 0 ? siblings[at - 1] : null;
        if (at >= siblings.Count - 1) return null;
        return at + 2 < siblings.Count ? siblings[at + 2] : parent is null ? rows.Count : siblings[^1] + 1;
    }

    /// <summary>A session was renamed: it keeps its place.</summary>
    public bool Rename(string name, string newName)
    {
        if (!keys.Contains(name)) return false;
        keys.RemoveAll(k => k == newName);
        keys[keys.IndexOf(name)] = newName;
        return true;
    }

    private sealed record Stored([property: JsonPropertyName("keys")] List<string> Keys);

    /// <summary>This PC's order for the host with <paramref name="pairing"/>'s key, in <c>%LOCALAPPDATA%\Orc\sidebar-order</c>.</summary>
    public static string FileFor(Pairing pairing) => Path.Combine(PairingStore.Directory, "sidebar-order", pairing.Fingerprint + ".json");

    public static SidebarOrder Load(string file)
    {
        try
        {
            if (File.Exists(file) && JsonSerializer.Deserialize<Stored>(File.ReadAllText(file)) is { Keys: { } stored }) return new SidebarOrder(stored);
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException) { }
        return new SidebarOrder();
    }

    /// <summary>Saves the order; false when it could not be written.</summary>
    public bool Save(string file)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            var temp = file + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(new Stored(keys)));
            File.Move(temp, file, overwrite: true);
            return true;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return false; }
    }
}

/// <summary>
/// Sessions whose notifications are muted, by name, as Orc.app keeps them (Sources/OrcKit/SessionMutes.swift): a muted
/// session posts no notification when its agent finishes, and counts on the taskbar badge only for an
/// <c>orc notify</c> message, which still shows. Kept in <c>%LOCALAPPDATA%\Orc\muted-sessions.json</c>.
/// </summary>
public sealed class SessionMutes
{
    private readonly HashSet<string> names;
    private readonly string file;

    private SessionMutes(string file, IEnumerable<string> names)
    {
        this.file = file;
        this.names = [.. names];
    }

    public bool IsMuted(string name) => names.Contains(name);

    public void Set(bool muted, string name)
    {
        if (muted ? names.Add(name) : names.Remove(name)) Save();
    }

    /// <summary>A muted session stays muted under its new name.</summary>
    public void Rename(string name, string newName)
    {
        if (!names.Remove(name)) return;
        names.Add(newName);
        Save();
    }

    /// <summary>Forgets names no running or recently closed session has, so a later session that reuses one does not start muted.</summary>
    public void Prune(IReadOnlySet<string> kept)
    {
        if (names.RemoveWhere(n => !kept.Contains(n)) > 0) Save();
    }

    private sealed record Stored([property: JsonPropertyName("names")] List<string> Names);

    public static SessionMutes Load(string? file = null)
    {
        file ??= Path.Combine(PairingStore.Directory, "muted-sessions.json");
        try
        {
            if (File.Exists(file) && JsonSerializer.Deserialize<Stored>(File.ReadAllText(file)) is { Names: { } stored }) return new SessionMutes(file, stored);
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException) { }
        return new SessionMutes(file, []);
    }

    private void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            var temp = file + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(new Stored([.. names.Order()])));
            File.Move(temp, file, overwrite: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }
}

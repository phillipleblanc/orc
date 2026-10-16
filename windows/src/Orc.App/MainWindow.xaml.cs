using System.Collections.ObjectModel;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Data;
using Microsoft.Web.WebView2.Core;
using Orc.Core;
using Orc.Protocol;
using Windows.ApplicationModel.DataTransfer;
using Windows.Graphics;

namespace Orc.Win;

/// <summary>
/// The sessions of the paired host in a sidebar by project, beside the selected session's terminal. The terminals of
/// the ten most recently shown sessions stay attached, so switching back is immediate and keeps their scrollback; a
/// hidden terminal does not resize its session (docs/app.md).
/// </summary>
public sealed partial class MainWindow : Window
{
    private const int MaxAttached = 10;
    private const string AppTitle = "Orc";

    private readonly CollectionViewSource groupsSource = new() { IsSourceGrouped = true };
    private readonly ObservableCollection<SessionGroup> groups = [];
    private readonly Dictionary<string, SessionRow> rows = [];
    private readonly Dictionary<string, Attached> attached = [];
    private readonly List<string> recent = [];
    private readonly CancellationTokenSource closing = new();
    private List<string> shape = [];
    private Pairing? pairing;
    private HostMonitor? monitor;
    private HostSnapshot? snapshot;
    private TerminalSize paneSize = new(120, 40);
    private bool pageReady;
    private bool applying;
    private string? visible;
    private string? pendingShow;
    private string? lingering;

    private sealed record Attached(SessionInfo Session, XtermSurface Surface, AttachController Controller);

    public MainWindow()
    {
        InitializeComponent();
        Title = AppTitle;
        AppWindow.Resize(new SizeInt32(1440, 900));
        groupsSource.Source = groups;
        SessionList.ItemsSource = groupsSource.View;
        Closed += (_, _) =>
        {
            closing.Cancel();
            foreach (var terminal in attached.Values) terminal.Controller.Stop();
        };
        _ = InitializeAsync();
    }

    private async Task InitializeAsync()
    {
        try { pairing = PairingStore.Load(); }
        catch (Exception error)
        {
            HostText.Text = "Not paired";
            StatusText.Text = error.Message;
        }

        await Web.EnsureCoreWebView2Async();
        var core = Web.CoreWebView2;
        // Terminal keys belong to the terminal, not the browser: Ctrl+R, Ctrl+F, Ctrl+P, F5 and the like.
        core.Settings.AreBrowserAcceleratorKeysEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.SetVirtualHostNameToFolderMapping("orc.local", Path.Combine(AppContext.BaseDirectory, "web"), CoreWebView2HostResourceAccessKind.Deny);
        core.WebMessageReceived += OnWebMessage;
        core.Navigate("https://orc.local/index.html");

        if (pairing is null) return;
        var host = pairing.EndpointUri.Host;
        HostText.Text = $"{host} · connecting…";
        monitor = new HostMonitor(pairing);
        monitor.Updated += update => DispatcherQueue.TryEnqueue(() => Apply(update));
        monitor.ConnectionChanged += state => DispatcherQueue.TryEnqueue(() => HostText.Text = state is null ? $"{host} · connected" : $"{host} · {state}");
        _ = Task.Run(() => monitor.RunAsync(closing.Token));
    }

    private void Apply(HostSnapshot update)
    {
        snapshot = update;
        var sections = SessionSections.Build(update.Sessions, update.Projects);
        var nextShape = sections.Select(s => s.Id + ":" + string.Join(",", s.Sessions.Select(x => x.Handle))).ToList();
        applying = true;
        try
        {
            if (!nextShape.SequenceEqual(shape))
            {
                // Sessions came, went or moved: rebuild the sections around the same row objects.
                groups.Clear();
                foreach (var section in sections)
                {
                    var group = new SessionGroup(section.Id);
                    foreach (var session in section.Sessions)
                    {
                        if (!rows.TryGetValue(session.Handle, out var row)) rows[session.Handle] = row = new SessionRow(session.Handle);
                        group.Add(row);
                    }
                    groups.Add(group);
                }
                foreach (var gone in rows.Keys.Except(update.Sessions.Select(s => s.Handle)).ToList()) rows.Remove(gone);
                shape = nextShape;
                if (visible is not null && rows.TryGetValue(visible, out var selected)) SessionList.SelectedItem = selected;
            }
            for (var i = 0; i < sections.Count; i++) groups[i].Title = $"{sections[i].Title}  {sections[i].Sessions.Count}";
            foreach (var session in update.Sessions) rows[session.Handle].Update(session, update.ActivityOf(session));
        }
        finally { applying = false; }

        // A session that ended or was replaced is no longer attached.
        var live = update.Sessions.Where(s => s.Connected).ToDictionary(s => s.Handle);
        foreach (var handle in attached.Keys.Where(h => !live.ContainsKey(h)).ToList()) attached[handle].Controller.Stop();
    }

    private void OnSessionSelected(object sender, SelectionChangedEventArgs e)
    {
        if (!applying && SessionList.SelectedItem is SessionRow row) Show(row.Handle);
    }

    private void Show(string handle)
    {
        if (!pageReady || pairing is null || snapshot is null)
        {
            pendingShow = handle;
            return;
        }
        var session = snapshot.Sessions.FirstOrDefault(s => s.Handle == handle);
        if (session is null || !session.Connected)
        {
            StatusText.Text = $"{session?.Name ?? handle} is not running.";
            return;
        }
        if (lingering is { } ended && ended != handle)
        {
            Page(new JsonObject { ["type"] = "dispose", ["id"] = ended });
            lingering = null;
        }

        var terminal = attached.GetValueOrDefault(handle) ?? Attach(session);
        recent.Remove(handle);
        recent.Add(handle);
        visible = handle;
        terminal.Surface.Post(new JsonObject { ["type"] = "show" });
        Web.Focus(FocusState.Programmatic);
        Title = $"{session.Name} · {AppTitle}";

        // Keep the ten most recently shown terminals attached.
        while (recent.Count > MaxAttached)
        {
            var oldest = recent[0];
            recent.RemoveAt(0);
            if (attached.TryGetValue(oldest, out var evicted)) evicted.Controller.Stop();
        }
    }

    private Attached Attach(SessionInfo session)
    {
        var surface = new XtermSurface(session.Handle, paneSize, Web, DispatcherQueue, message =>
        {
            if (visible == session.Handle) StatusText.Text = $"{session.Name}: {message}";
        });
        surface.Post(new JsonObject { ["type"] = "create" });
        var terminal = new Attached(session, surface, new AttachController(pairing!, session.Handle, session.IncarnationId, surface));
        attached[session.Handle] = terminal;
        StatusText.Text = $"Attaching to {session.Name}…";
        _ = RunAsync(terminal);
        return terminal;
    }

    private async Task RunAsync(Attached terminal)
    {
        var handle = terminal.Session.Handle;
        AttachExit exit = AttachExit.Detached;
        string? failure = null;
        try { exit = await Task.Run(() => terminal.Controller.RunAsync(closing.Token)); }
        catch (Exception error) { failure = error.Message; }
        if (closing.IsCancellationRequested) return;

        if (attached.GetValueOrDefault(handle) == terminal) attached.Remove(handle);
        recent.Remove(handle);
        var reason = failure ?? (exit == AttachExit.Ended ? "Session ended." : "Detached.");
        // After the terminal's last output: the surface's queue keeps the order.
        if (visible == handle)
        {
            // Leave its last screen up with a note until another session is shown.
            terminal.Surface.Post(new JsonObject { ["type"] = "ended", ["text"] = reason });
            lingering = handle;
            StatusText.Text = $"{terminal.Session.Name}: {reason}";
        }
        else terminal.Surface.Post(new JsonObject { ["type"] = "dispose" });
        monitor?.RefreshNow();
    }

    private void OnWebMessage(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (JsonNode.Parse(args.WebMessageAsJson) is not JsonObject message) return;
        var id = message["id"]?.ToString();
        var terminal = id is null ? null : attached.GetValueOrDefault(id);
        switch (message["type"]?.GetValue<string>())
        {
            case "ready":
                paneSize = ReadSize(message);
                SizeText.Text = $"{paneSize.Cols}×{paneSize.Rows}";
                pageReady = true;
                if (pendingShow is { } handle)
                {
                    pendingShow = null;
                    Show(handle);
                }
                break;
            case "shown":
            case "size":
                if (terminal is null || id != visible) break;
                paneSize = ReadSize(message);
                SizeText.Text = $"{paneSize.Cols}×{paneSize.Rows}";
                // Showing a terminal claims the session's size for this window, as resizing it does.
                if (terminal.Surface.SetSize(paneSize) || message["type"]?.ToString() == "shown") terminal.Controller.ViewportChanged();
                break;
            case "input":
                if (terminal is null || id != visible) break;
                var data = message["data"]?.GetValue<string>() ?? "";
                KeysText.Text = "sent " + Escape(data);
                terminal.Controller.SendInput(data);
                break;
            case "copy":
                var package = new DataPackage();
                package.SetText(message["text"]?.GetValue<string>() ?? "");
                Clipboard.SetContent(package);
                break;
            case "paste":
                if (terminal is not null) _ = PasteAsync(terminal.Surface);
                break;
        }
    }

    private static TerminalSize ReadSize(JsonObject message) => new(message["cols"]!.GetValue<int>(), message["rows"]!.GetValue<int>());

    private void Page(JsonObject message) => Web.CoreWebView2?.PostWebMessageAsJson(new JsonObject { ["type"] = "batch", ["items"] = new JsonArray(message) }.ToJsonString());

    private static async Task PasteAsync(XtermSurface surface)
    {
        var content = Clipboard.GetContent();
        if (!content.Contains(StandardDataFormats.Text)) return;
        // xterm.js wraps it in bracketed paste when the program asked for that.
        surface.Post(new JsonObject { ["type"] = "paste", ["text"] = await content.GetTextAsync() });
    }

    /// <summary>What a key sent, readable: ESC as \e and other controls escaped, so Shift+Enter shows as \e[13;2u.</summary>
    private static string Escape(string data)
    {
        if (data.Length > 24) return $"({data.Length} chars)";
        var text = new StringBuilder();
        foreach (var c in data)
        {
            text.Append(c switch
            {
                '\u001b' => "\\e",
                '\r' => "\\r",
                '\n' => "\\n",
                '\t' => "\\t",
                '\u007f' => "\\x7f",
                < ' ' => $"\\x{(int)c:x2}",
                _ => c.ToString()
            });
        }
        return text.ToString();
    }
}

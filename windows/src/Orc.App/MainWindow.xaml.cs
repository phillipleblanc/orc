using System.Collections.ObjectModel;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Data;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.Web.WebView2.Core;
using Orc.Core;
using Orc.Protocol;
using Windows.ApplicationModel.DataTransfer;
using Windows.Graphics;
using Windows.UI;

namespace Orc.Win;

/// <summary>
/// The sessions of the paired host in a sidebar by project, beside the selected session's terminal. The terminals of
/// the ten most recently shown sessions stay attached, so switching back is immediate and keeps their screens; a
/// hidden terminal does not resize its session (docs/app.md). Problems show in an InfoBar over the terminal.
/// </summary>
public sealed partial class MainWindow : Window
{
    private const int MaxAttached = 10;
    private const string AppTitle = "Orc";

    private readonly CollectionViewSource groupsSource = new() { IsSourceGrouped = true };
    private readonly ObservableCollection<SessionGroup> groups = [];
    private readonly Dictionary<string, SessionRow> rows = [];
    private readonly Dictionary<string, Attached> attached = [];
    private readonly Dictionary<string, Notice> notices = [];
    private readonly List<string> recent = [];
    private readonly CancellationTokenSource closing = new();
    private readonly bool diagnostics = Environment.GetEnvironmentVariable("ORC_DIAGNOSTICS") == "1";
    private List<string> shape = [];
    private Pairing? pairing;
    private HostMonitor? monitor;
    private HostSnapshot? snapshot;
    private TerminalSize paneSize = new(120, 40);
    private Notice? hostNotice;
    private bool pageReady;
    private bool applying;
    private string? visible;
    private string? pendingShow;
    private string? lingering;

    private sealed record Attached(SessionInfo Session, XtermSurface Surface, AttachController Controller);
    private sealed record Notice(InfoBarSeverity Severity, string Title, string Message);

    public MainWindow()
    {
        InitializeComponent();
        Title = AppTitle;
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        AppWindow.TitleBar.PreferredHeightOption = TitleBarHeightOption.Tall;
        var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico");
        if (File.Exists(icon)) AppWindow.SetIcon(icon);
        TitleIcon.Source = new BitmapImage(new Uri(Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.png")));
        if (MicaController.IsSupported()) SystemBackdrop = new MicaBackdrop();
        else Root.Background = (Brush)Application.Current.Resources["ApplicationPageBackgroundThemeBrush"];
        SizeForDisplay(1280, 820);
        // The terminal's background, so the pane never flashes white while the page loads.
        Web.DefaultBackgroundColor = Color.FromArgb(255, 0x0d, 0x11, 0x17);
        groupsSource.Source = groups;
        SessionList.ItemsSource = groupsSource.View;
        NoticeBar.Closed += (_, _) =>
        {
            if (visible is not null) notices.Remove(visible);
            else hostNotice = null;
        };
        Closed += (_, _) =>
        {
            closing.Cancel();
            foreach (var terminal in attached.Values) terminal.Controller.Stop();
        };
        _ = InitializeAsync();
    }

    private bool IsClosed => closing.IsCancellationRequested;

    /// <summary>A window of this many effective pixels at the display's scale, centered in its work area.</summary>
    private void SizeForDisplay(int width, int height)
    {
        var scale = GetDpiForWindow(WinRT.Interop.WindowNative.GetWindowHandle(this)) / 96.0;
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
        var w = Math.Min((int)(width * scale), area.Width * 9 / 10);
        var h = Math.Min((int)(height * scale), area.Height * 9 / 10);
        AppWindow.MoveAndResize(new RectInt32(area.X + (area.Width - w) / 2, area.Y + (area.Height - h) / 2, w, h));
    }

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(nint hwnd);

    private async Task InitializeAsync()
    {
        try { pairing = PairingStore.Load(); }
        catch (Exception error)
        {
            HostText.Text = "Not paired with a host";
            EmptyText.Text = "Pair with a host to see its sessions";
            hostNotice = new Notice(InfoBarSeverity.Informational, "Not paired", error.Message);
            ShowNotice();
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
        core.Navigate("https://orc.local/index.html" + (diagnostics ? "?diagnostics" : ""));

        if (pairing is null) return;
        var host = pairing.EndpointUri.Host;
        HostText.Text = $"Connecting to {host}…";
        monitor = new HostMonitor(pairing);
        monitor.Updated += update => DispatcherQueue.TryEnqueue(() => { if (!IsClosed) Apply(update); });
        monitor.ConnectionChanged += state => DispatcherQueue.TryEnqueue(() =>
        {
            if (IsClosed) return;
            HostText.Text = state is null ? host : $"Can't reach {host}";
            hostNotice = state is null ? null : new Notice(InfoBarSeverity.Warning, $"Can't reach {host}", state + " Retrying.");
            ShowNotice();
        });
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

        if (update.Sessions.Count == 0 && visible is null) EmptyText.Text = "No sessions on this host";
        else if (visible is null) EmptyText.Text = "Select a session";

        // A session that ended or was replaced is no longer attached.
        var live = update.Sessions.Where(s => s.Connected).Select(s => s.Handle).ToHashSet();
        foreach (var handle in attached.Keys.Where(h => !live.Contains(h)).ToList()) attached[handle].Controller.Stop();
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
        if (session is null || !session.Connected) return;
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
        Web.Visibility = Visibility.Visible;
        EmptyState.Visibility = Visibility.Collapsed;
        Web.Focus(FocusState.Programmatic);
        Title = $"{session.Name} – {AppTitle}";
        TitleText.Text = Title;
        ShowNotice();

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
        var handle = session.Handle;
        var surface = new XtermSurface(handle, paneSize, Web, DispatcherQueue,
            note: message => SetNotice(handle, new Notice(InfoBarSeverity.Warning, session.Name, message)),
            healthy: () => SetNotice(handle, null));
        surface.Post(new JsonObject { ["type"] = "create" });
        var terminal = new Attached(session, surface, new AttachController(pairing!, handle, session.IncarnationId, surface));
        attached[handle] = terminal;
        _ = RunAsync(terminal);
        return terminal;
    }

    private async Task RunAsync(Attached terminal)
    {
        var handle = terminal.Session.Handle;
        AttachExit exit = AttachExit.Detached;
        Exception? failure = null;
        try { exit = await Task.Run(() => terminal.Controller.RunAsync(closing.Token)); }
        catch (Exception error) { failure = error; }
        if (IsClosed) return;

        if (attached.GetValueOrDefault(handle) == terminal) attached.Remove(handle);
        recent.Remove(handle);
        // After the terminal's last output: the surface's queue keeps the order.
        if (visible == handle)
        {
            var reason = failure?.Message ?? (exit == AttachExit.Ended ? "The session ended." : "Detached from the session.");
            // Leave its last screen up with a note until another session is shown.
            terminal.Surface.Post(new JsonObject { ["type"] = "ended", ["text"] = reason });
            lingering = handle;
            SetNotice(handle, failure is null
                ? new Notice(InfoBarSeverity.Informational, terminal.Session.Name, reason)
                : new Notice(InfoBarSeverity.Error, $"Lost {terminal.Session.Name}", reason));
        }
        else
        {
            terminal.Surface.Post(new JsonObject { ["type"] = "dispose" });
            notices.Remove(handle);
        }
        monitor?.RefreshNow();
    }

    private void SetNotice(string handle, Notice? notice)
    {
        if (IsClosed) return;
        if (notice is null) notices.Remove(handle);
        else notices[handle] = notice;
        if (handle == visible) ShowNotice();
    }

    /// <summary>The shown terminal's notice, else the host's.</summary>
    private void ShowNotice()
    {
        var notice = (visible is null ? null : notices.GetValueOrDefault(visible)) ?? hostNotice;
        NoticeBar.IsOpen = notice is not null;
        if (notice is null) return;
        NoticeBar.Severity = notice.Severity;
        NoticeBar.Title = notice.Title;
        NoticeBar.Message = notice.Message;
    }

    private void OnWebMessage(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (IsClosed || JsonNode.Parse(args.WebMessageAsJson) is not JsonObject message) return;
        var id = message["id"]?.ToString();
        var terminal = id is null ? null : attached.GetValueOrDefault(id);
        switch (message["type"]?.GetValue<string>())
        {
            case "ready":
                paneSize = ReadSize(message);
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
                // Showing a terminal claims the session's size for this window, as resizing it does.
                if (terminal.Surface.SetSize(paneSize) || message["type"]?.ToString() == "shown") terminal.Controller.ViewportChanged();
                break;
            case "input":
                if (terminal is not null && id == visible) terminal.Controller.SendInput(message["data"]?.GetValue<string>() ?? "");
                break;
            case "copy":
                var package = new DataPackage();
                package.SetText(message["text"]?.GetValue<string>() ?? "");
                Clipboard.SetContent(package);
                break;
            case "paste":
                if (terminal is not null) _ = PasteAsync(terminal.Surface);
                break;
            case "diag":
                if (diagnostics) DiagnosticsLog.Append(message);
                break;
        }
    }

    private static TerminalSize ReadSize(JsonObject message) => new(message["cols"]!.GetValue<int>(), message["rows"]!.GetValue<int>());

    private void Page(JsonObject message)
    {
        if (!IsClosed) Web.CoreWebView2?.PostWebMessageAsJson(new JsonObject { ["type"] = "batch", ["items"] = new JsonArray(message) }.ToJsonString());
    }

    private static async Task PasteAsync(XtermSurface surface)
    {
        var content = Clipboard.GetContent();
        if (!content.Contains(StandardDataFormats.Text)) return;
        // xterm.js wraps it in bracketed paste when the program asked for that.
        surface.Post(new JsonObject { ["type"] = "paste", ["text"] = await content.GetTextAsync() });
    }
}

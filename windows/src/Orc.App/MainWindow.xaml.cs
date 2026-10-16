using System.Collections.ObjectModel;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Data;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.Web.WebView2.Core;
using Orc.Core;
using Orc.Protocol;
using Windows.ApplicationModel.DataTransfer;
using Windows.Graphics;
using Windows.System;
using Windows.UI;

namespace Orc.Win;

/// <summary>
/// The sessions of the paired host in a sidebar by project, children nested under their parents, beside the selected
/// session's terminal. The terminals of the ten most recently shown sessions stay attached, so switching back is
/// immediate and keeps their screens; a hidden terminal does not resize its session (docs/app.md). Sessions are
/// created, renamed, restarted and closed from the sidebar, as in Orc.app. Problems show in an InfoBar over the terminal.
/// </summary>
public sealed partial class MainWindow : Window
{
    private const int MaxAttached = 10;
    private const string AppTitle = "Orc";

    private readonly CollectionViewSource groupsSource = new() { IsSourceGrouped = true };
    private readonly ObservableCollection<SessionGroup> groups = [];
    private readonly Dictionary<string, SessionRow> rows = [];
    private readonly HashSet<string> listed = [];
    private readonly HashSet<string> collapsedParents = [];
    private readonly Dictionary<string, Attached> attached = [];
    private readonly Dictionary<string, Notice> notices = [];
    // Sessions this window closed or restarted: their terminals end without a "session ended" notice.
    private readonly HashSet<string> quietEnds = [];
    private readonly List<string> recent = [];
    private readonly CancellationTokenSource closing = new();
    private readonly bool diagnostics = Environment.GetEnvironmentVariable("ORC_DIAGNOSTICS") == "1";
    private readonly SessionDefaults defaults = SessionDefaults.Load();
    private List<string> shape = [];
    private Pairing? pairing;
    private HostMonitor? monitor;
    private HostSnapshot? snapshot;
    private TerminalSize paneSize = new(120, 40);
    private Notice? hostNotice;
    private bool pageReady;
    private bool applying;
    private bool dialogOpen;
    private string? visible;
    private string? pendingShow;
    private string? pendingSelect;
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

        var newSession = new KeyboardAccelerator { Key = VirtualKey.N, Modifiers = VirtualKeyModifiers.Control | VirtualKeyModifiers.Shift };
        newSession.Invoked += (sender, e) => { e.Handled = true; _ = NewSessionAsync(null); };
        Root.KeyboardAccelerators.Add(newSession);
        AddListAccelerator(VirtualKey.F2, row => _ = RenameAsync(row));
        AddListAccelerator(VirtualKey.Delete, row => _ = CloseAsync(row));

        // Start with the session list focused, not the first button (which would show its focus rectangle).
        Root.Loaded += (_, _) => SessionList.Focus(FocusState.Programmatic);
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

    private void AddListAccelerator(VirtualKey key, Action<SessionRow> action)
    {
        var accelerator = new KeyboardAccelerator { Key = key, ScopeOwner = SessionList };
        accelerator.Invoked += (_, e) =>
        {
            if (SessionList.SelectedItem is not SessionRow row) return;
            e.Handled = true;
            action(row);
        };
        SessionList.KeyboardAccelerators.Add(accelerator);
    }

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
            NewSessionButton.IsEnabled = state is null;
            hostNotice = state is null ? null : new Notice(InfoBarSeverity.Warning, $"Can't reach {host}", state + " Retrying.");
            ShowNotice();
        });
        _ = Task.Run(() => monitor.RunAsync(closing.Token));
    }

    private void Apply(HostSnapshot update)
    {
        snapshot = update;
        var sections = SessionSections.Build(update.Sessions, update.Projects);
        // A child about to be selected is shown even when its parent is collapsed.
        if (pendingSelect is { } wanted)
            foreach (var section in sections)
                if (section.Sessions.FirstOrDefault(s => s.Handle == wanted) is { } session && section.Hierarchy.ParentOf(session) is { } parent)
                    collapsedParents.Remove(parent.Handle);
        collapsedParents.RemoveWhere(handle => update.Sessions.All(s => s.Handle != handle));

        var layout = sections.Select(section => (Section: section, Rows: section.Hierarchy.Rows(collapsedParents))).ToList();
        var nextShape = layout.Select(l => l.Section.Id + ":" + string.Join(",", l.Rows.Select(r => r.Session.Handle))).ToList();
        applying = true;
        try
        {
            if (!nextShape.SequenceEqual(shape))
            {
                Reconcile(layout.Select(l => (l.Section.Id, l.Rows.Select(r => RowFor(r.Session.Handle)).ToList())).ToList());
                listed.Clear();
                listed.UnionWith(layout.SelectMany(l => l.Rows.Select(r => r.Session.Handle)));
                foreach (var gone in rows.Keys.Except(update.Sessions.Select(s => s.Handle)).ToList()) rows.Remove(gone);
                shape = nextShape;
                var selected = visible is not null && listed.Contains(visible) ? rows[visible] : null;
                if (SessionList.SelectedItem != selected) SessionList.SelectedItem = selected;
            }
            for (var i = 0; i < layout.Count; i++)
            {
                var (section, sectionRows) = layout[i];
                groups[i].Title = $"{section.Title}  {section.Sessions.Count}";
                foreach (var row in sectionRows)
                    rows[row.Session.Handle].Update(row.Session, update.ActivityOf(row.Session), section.Hierarchy, row, collapsedParents.Contains(row.Session.Handle));
            }
        }
        finally { applying = false; }

        if (visible is null) EmptyText.Text = update.Sessions.Count == 0 ? "No sessions on this host" : "Select a session";

        // A session that ended or was replaced is no longer attached.
        var live = update.Sessions.Where(s => s.Connected).Select(s => s.Handle).ToHashSet();
        foreach (var handle in attached.Keys.Where(h => !live.Contains(h)).ToList()) attached[handle].Controller.Stop();
        quietEnds.RemoveWhere(handle => !live.Contains(handle) && !attached.ContainsKey(handle));

        // A session this window just created or restarted is selected once it is listed.
        if (pendingSelect is { } select && listed.Contains(select) && live.Contains(select))
        {
            pendingSelect = null;
            SessionList.SelectedItem = rows[select];
            SessionList.ScrollIntoView(rows[select]);
        }
    }

    private SessionRow RowFor(string handle) => rows.TryGetValue(handle, out var row) ? row : rows[handle] = new SessionRow(handle);

    /// <summary>
    /// Brings the sections to <paramref name="layout"/> with the fewest changes, so focus, scroll position and
    /// selection survive sessions arriving, leaving, or a parent folding its children.
    /// </summary>
    private void Reconcile(List<(string Id, List<SessionRow> Rows)> layout)
    {
        var wanted = layout.ToDictionary(l => l.Id, l => l.Rows.ToHashSet());
        // First take rows out of sections they left, so no row is ever in two sections at once.
        for (var i = groups.Count - 1; i >= 0; i--)
        {
            if (!wanted.TryGetValue(groups[i].Id, out var keep)) { groups.RemoveAt(i); continue; }
            for (var j = groups[i].Count - 1; j >= 0; j--)
                if (!keep.Contains(groups[i][j])) groups[i].RemoveAt(j);
        }
        for (var i = 0; i < layout.Count; i++)
        {
            var (id, desired) = layout[i];
            var at = IndexOf(id);
            if (at < 0) groups.Insert(i, new SessionGroup(id));
            else if (at != i) { var group = groups[at]; groups.RemoveAt(at); groups.Insert(i, group); }
            var list = groups[i];
            for (var j = 0; j < desired.Count; j++)
            {
                var current = list.IndexOf(desired[j]);
                if (current == j) continue;
                if (current >= 0) list.RemoveAt(current);
                list.Insert(j, desired[j]);
            }
        }

        int IndexOf(string id)
        {
            for (var i = 0; i < groups.Count; i++) if (groups[i].Id == id) return i;
            return -1;
        }
    }

    private void OnSessionSelected(object sender, SelectionChangedEventArgs e)
    {
        if (!applying && SessionList.SelectedItem is SessionRow row) Show(row.Handle);
    }

    private void OnToggleChildren(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is not SessionRow row) return;
        if (!collapsedParents.Remove(row.Handle)) collapsedParents.Add(row.Handle);
        if (snapshot is not null) Apply(snapshot);
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

    /// <summary>Nothing selected: the empty state in the terminal's place.</summary>
    private void ShowEmpty()
    {
        visible = null;
        applying = true;
        SessionList.SelectedItem = null;
        applying = false;
        Title = AppTitle;
        TitleText.Text = AppTitle;
        EmptyText.Text = "Select a session";
        EmptyState.Visibility = Visibility.Visible;
        Web.Visibility = Visibility.Collapsed;
        ShowNotice();
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
        if (quietEnds.Remove(handle))
        {
            terminal.Surface.Post(new JsonObject { ["type"] = "dispose" });
            notices.Remove(handle);
            if (visible == handle) ShowEmpty();
        }
        else if (visible == handle)
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

    private void OnNewSessionClick(object sender, RoutedEventArgs e) => _ = NewSessionAsync(null);

    private async Task NewSessionAsync(SessionInfo? parent)
    {
        if (monitor is null || snapshot is null) return;
        // Until a default is saved, suggest what this host's sessions use: the shown session's project, and the
        // agent most of them run.
        var shown = snapshot.Sessions.FirstOrDefault(s => s.Handle == visible) ?? snapshot.Sessions.FirstOrDefault();
        var suggestedProject = snapshot.Projects.FirstOrDefault(p => p.Id == shown?.WorktreeId);
        var suggestedKind = snapshot.Sessions.Where(s => SessionKind.Find(s.Agent) is not null).GroupBy(s => s.Agent)
            .OrderByDescending(g => g.Count()).Select(g => g.Key).FirstOrDefault();
        var dialog = new NewSessionDialog(monitor.RequestAsync, snapshot.Projects, defaults, paneSize, parent, suggestedProject, suggestedKind);
        await ShowDialogAsync(dialog);
        if (dialog.CreatedHandle is not { } handle) return;
        pendingSelect = handle;
        monitor.RefreshNow();
    }

    private void OnSessionContextRequested(UIElement sender, ContextRequestedEventArgs args)
    {
        if (args.OriginalSource is not FrameworkElement target || target.DataContext is not SessionRow { Session: { } session } row) return;
        args.Handled = true;
        var menu = new MenuFlyout();
        if (row.CanCreateChild) menu.Items.Add(MenuItem("Create Child…", "", () => _ = NewSessionAsync(session)));
        menu.Items.Add(MenuItem("Rename Session…", "", () => _ = RenameAsync(row), "F2"));
        menu.Items.Add(MenuItem("Restart Session", "", () => _ = RestartAsync(row)));
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(MenuItem("Close Session…", "", () => _ = CloseAsync(row), "Del"));
        if (args.TryGetPosition(target, out var point)) menu.ShowAt(target, point);
        else menu.ShowAt(target);
    }

    private static MenuFlyoutItem MenuItem(string text, string glyph, Action action, string? shortcut = null)
    {
        var item = new MenuFlyoutItem { Text = text, Icon = new FontIcon { Glyph = glyph } };
        if (shortcut is not null) item.KeyboardAcceleratorTextOverride = shortcut;
        item.Click += (_, _) => action();
        return item;
    }

    /// <summary>Orc.app's Rename Session sheet: the full name, so a parent's name in front nests the session under it.</summary>
    private async Task RenameAsync(SessionRow row)
    {
        if (monitor is not { } host || row.Session is not { } session) return;
        var box = new TextBox { Header = "Name", Text = session.Name };
        var error = new InfoBar { Severity = InfoBarSeverity.Error, IsClosable = false, IsOpen = false };
        var dialog = new ContentDialog
        {
            Title = "Rename Session", PrimaryButtonText = "Rename", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Primary,
            Content = new StackPanel
            {
                Spacing = 12, MinWidth = 400,
                Children =
                {
                    new TextBlock
                    {
                        Text = "Use the full name. Starting it with another session's name and a hyphen nests it under that session.",
                        TextWrapping = TextWrapping.Wrap, Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"]
                    },
                    box, error
                }
            }
        };
        var saving = false;
        void Validate()
        {
            var name = box.Text.Trim();
            var problem = name.Length > 0 ? SessionNames.Problem(name) : null;
            box.Description = problem ?? "";
            dialog.IsPrimaryButtonEnabled = !saving && name.Length > 0 && problem is null && name != session.Name;
        }
        box.TextChanged += (_, _) => Validate();
        dialog.Opened += (_, _) => { box.Focus(FocusState.Programmatic); box.SelectAll(); };
        dialog.PrimaryButtonClick += async (_, args) =>
        {
            args.Cancel = true;
            saving = true;
            Validate();
            try
            {
                await SessionCommands.RenameAsync(host.RequestAsync, session.Handle, box.Text.Trim());
                dialog.Hide();
                host.RefreshNow();
            }
            catch (Exception failure)
            {
                error.Message = failure.Message;
                error.IsOpen = true;
            }
            finally
            {
                saving = false;
                Validate();
            }
        };
        Validate();
        await ShowDialogAsync(dialog);
    }

    /// <summary>Ends the session and starts it again under its name; asks first when its agent is working.</summary>
    private async Task RestartAsync(SessionRow row)
    {
        if (monitor is not { } host || row.Session is not { } session) return;
        if (row.Activity == AgentActivity.Active && await ShowDialogAsync(new ContentDialog
            {
                Title = $"Restart “{session.Name}”?",
                Content = "The agent is working. Restarting stops its current turn; it then continues its conversation.",
                PrimaryButtonText = "Restart Session", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Close
            }) != ContentDialogResult.Primary) return;
        quietEnds.Add(session.Handle);
        try
        {
            var restarted = await SessionCommands.RestartAsync(host.RequestAsync, session.Handle);
            if (visible == session.Handle || visible is null) pendingSelect = restarted;
            host.RefreshNow();
        }
        catch (Exception error)
        {
            quietEnds.Remove(session.Handle);
            await ShowErrorAsync("Could Not Restart Session", $"Could not restart {session.Name}: {error.Message}");
        }
    }

    private async Task CloseAsync(SessionRow row)
    {
        if (monitor is not { } host || row.Session is not { } session) return;
        if (await ShowDialogAsync(new ContentDialog
            {
                Title = $"Close “{session.Name}”?",
                Content = session.Agent is null ? "The terminal and everything running in it stop."
                    : "The agent stops. You can reopen it from Recently Closed in Orc on the host.",
                PrimaryButtonText = "Close Session", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Close
            }) != ContentDialogResult.Primary) return;
        quietEnds.Add(session.Handle);
        try
        {
            await SessionCommands.CloseAsync(host.RequestAsync, session.Handle);
            host.RefreshNow();
        }
        catch (Exception error)
        {
            quietEnds.Remove(session.Handle);
            await ShowErrorAsync("Could Not Close Session", $"Could not close {session.Name}: {error.Message}");
        }
    }

    private Task ShowErrorAsync(string title, string message) =>
        ShowDialogAsync(new ContentDialog { Title = title, Content = message, CloseButtonText = "OK", DefaultButton = ContentDialogButton.Close });

    /// <summary>Shows one dialog at a time; null when another is already open or the window closed.</summary>
    private async Task<ContentDialogResult?> ShowDialogAsync(ContentDialog dialog)
    {
        if (dialogOpen || IsClosed) return null;
        dialogOpen = true;
        try
        {
            dialog.XamlRoot = Content.XamlRoot;
            return await dialog.ShowAsync();
        }
        finally { dialogOpen = false; }
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
            case "command":
                // The window's shortcuts, pressed while the terminal has focus.
                if (message["name"]?.ToString() == "new-session") _ = NewSessionAsync(null);
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

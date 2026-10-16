using System.Collections.ObjectModel;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
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
/// created, renamed, restarted and closed from the sidebar, as in Orc.app. The host is paired, moved and forgotten on
/// the Hosts page; its connection state shows in the sidebar header, and problems in an InfoBar over the terminal.
/// </summary>
public sealed partial class MainWindow : Window
{
    private const int MaxAttached = 10;
    private const string AppTitle = "Orc";
    private static readonly TimeSpan PresenceInterval = TimeSpan.FromSeconds(2);
    private static readonly Color Green = Color.FromArgb(255, 0x3f, 0xb9, 0x50);
    private static readonly Color Red = Color.FromArgb(255, 0xf8, 0x51, 0x49);

    private readonly CollectionViewSource groupsSource = new() { IsSourceGrouped = true };
    private readonly ObservableCollection<SessionGroup> groups = [];
    private readonly Dictionary<string, SessionRow> rows = [];
    private readonly HashSet<string> listed = [];
    private readonly HashSet<string> collapsedParents = [];
    // Attached terminals by session handle; each attachment has its own page id, so a late end never touches its successor.
    private readonly Dictionary<string, Attached> attached = [];
    private readonly Dictionary<string, Notice> notices = [];
    // Attachments that end because this window closed, restarted or let go of their session: no "session ended" notice.
    private readonly HashSet<Attached> quietEnds = [];
    private readonly List<string> recent = [];
    private readonly CancellationTokenSource closing = new();
    private readonly bool diagnostics = Environment.GetEnvironmentVariable("ORC_DIAGNOSTICS") == "1";
    private readonly SessionDefaults defaults = SessionDefaults.Load();
    private List<string> shape = [];
    private Pairing? pairing;
    private HostMonitor? monitor;
    private CancellationTokenSource? hostStop;
    private HostSnapshot? snapshot;
    private TerminalSize paneSize = new(120, 40);
    private Notice? hostNotice;
    private Notice? shownNotice;
    private int pageIds;
    private bool pageReady;
    private bool applying;
    private bool dialogOpen;
    private bool minimized;
    private bool windowActive;
    private bool usageRead;
    private string? visible;
    private string? pendingShow;
    private string? pendingSelect;
    // The shown session's terminal that gave up while the host was away; reattached when the host is back.
    private string? failedTerminal;
    private Attached? lingering;

    private sealed record Attached(SessionInfo Session, string PageId, XtermSurface Surface, AttachController Controller);
    private sealed record Notice(InfoBarSeverity Severity, string Title, string Message, IReadOnlyList<(string Label, Action Run)>? Actions = null);

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

        Hosts.ShowDialog = ShowDialogAsync;
        Hosts.Paired += (paired, _) => Adopt(paired);
        Hosts.AddressChanged += Adopt;
        Hosts.ForgetRequested += () =>
        {
            StopHost();
            PairingStore.Forget();
            pairing = null;
            ShowHostState(null);
            OpenHosts();
        };
        Hosts.CloseRequested += CloseHosts;

        // Start with the session list focused, not the first button (which would show its focus rectangle).
        Root.Loaded += (_, _) => SessionList.Focus(FocusState.Programmatic);
        NoticeBar.Closed += (_, _) =>
        {
            if (shownNotice == hostNotice) hostNotice = null;
            else if (visible is not null) notices.Remove(visible);
            shownNotice = null;
        };
        // The shown terminal's session takes this window's size while the person is using it here (slim/README.md,
        // "Desktop viewers"): bringing the window forward is strong attention, minimizing hides the terminal, and input
        // anywhere on this PC while it is on screen is presence, reported every two seconds.
        Activated += (_, e) =>
        {
            windowActive = e.WindowActivationState != WindowActivationState.Deactivated;
            if (!windowActive) return;
            ReportViews(ViewAttention.Strong);
            RefreshUsage();
        };
        AppWindow.Changed += (_, _) =>
        {
            var now = AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized };
            if (now == minimized) return;
            minimized = now;
            ReportViews();
        };
        var presence = DispatcherQueue.CreateTimer();
        presence.Interval = PresenceInterval;
        presence.Tick += (_, _) =>
        {
            if (TerminalOnScreen && IdleTime < PresenceInterval) attached.GetValueOrDefault(visible!)?.Controller.ReportView(true, ViewAttention.Presence);
        };
        presence.Start();

        // Usage, as Orc.app reads it: when the host connects, when the window comes forward, and every fifteen minutes
        // while it is in front.
        Usage.Request = (method, parameters) =>
            (monitor ?? throw new HostUnreachableException("This PC isn't connected to the host right now.")).RequestAsync(method, parameters, TimeSpan.FromSeconds(60));
        var usageTimer = DispatcherQueue.CreateTimer();
        usageTimer.Interval = TimeSpan.FromMinutes(15);
        usageTimer.Tick += (_, _) => { if (windowActive) RefreshUsage(); };
        usageTimer.Start();

        Closed += (_, _) =>
        {
            closing.Cancel();
            presence.Stop();
            usageTimer.Stop();
            foreach (var terminal in attached.Values) terminal.Controller.Stop();
        };
        _ = InitializeAsync();
    }

    private bool IsClosed => closing.IsCancellationRequested;
    private bool HostConnected => monitor?.Status.IsConnected == true;

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

    [StructLayout(LayoutKind.Sequential)]
    private struct LastInputInfo
    {
        public uint Size;
        public uint Time;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetLastInputInfo(ref LastInputInfo info);

    /// <summary>How long since the last keyboard or pointer input anywhere on this PC.</summary>
    private static TimeSpan IdleTime
    {
        get
        {
            var info = new LastInputInfo { Size = (uint)Marshal.SizeOf<LastInputInfo>() };
            return GetLastInputInfo(ref info) ? TimeSpan.FromMilliseconds(unchecked((uint)Environment.TickCount - info.Time)) : TimeSpan.MaxValue;
        }
    }

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
        pairing = PairingStore.TryLoad();
        if (pairing is null)
        {
            // First run, or the saved host was forgotten: pairing is the only thing to do.
            ShowHostState(null);
            OpenHosts();
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

        if (pairing is not null) StartHost(pairing);
    }

    // ---- The host ----

    /// <summary>A pairing checked on the Hosts page: saved, connected, and the page closed.</summary>
    private void Adopt(Pairing next)
    {
        PairingStore.Save(next);
        StartHost(next);
        CloseHosts();
    }

    private void StartHost(Pairing next)
    {
        StopHost();
        pairing = next;
        var host = new HostMonitor(next);
        monitor = host;
        hostStop = CancellationTokenSource.CreateLinkedTokenSource(closing.Token);
        host.Updated += update => DispatcherQueue.TryEnqueue(() => { if (!IsClosed && monitor == host) Apply(update); });
        host.StatusChanged += status => DispatcherQueue.TryEnqueue(() => { if (!IsClosed && monitor == host) ShowHostState(status); });
        ShowHostState(host.Status);
        var token = hostStop.Token;
        _ = Task.Run(() => host.RunAsync(token));
    }

    /// <summary>Lets go of the host: its connection, its terminals and its sessions in the sidebar.</summary>
    private void StopHost()
    {
        hostStop?.Cancel();
        hostStop = null;
        monitor = null;
        snapshot = null;
        foreach (var terminal in attached.Values)
        {
            quietEnds.Add(terminal);
            terminal.Controller.Stop();
        }
        attached.Clear();
        recent.Clear();
        applying = true;
        groups.Clear();
        applying = false;
        rows.Clear();
        listed.Clear();
        shape = [];
        collapsedParents.Clear();
        notices.Clear();
        hostNotice = null;
        pendingSelect = null;
        failedTerminal = null;
        usageRead = false;
        Usage.Clear();
        ShowEmpty();
    }

    private void RetryHost() => monitor?.RetryNow();

    /// <summary>The connection state in the sidebar header and, when something is wrong, in the notice.</summary>
    private void ShowHostState(HostStatus? status)
    {
        var host = pairing?.EndpointUri.Host ?? "";
        var (text, color, busy) = status?.State switch
        {
            null => ("Not paired with a host", default(Color?), false),
            HostState.Connected => (host, Green, false),
            HostState.Connecting => ($"Connecting to {host}…", null, true),
            HostState.Reconnecting => ($"Reconnecting to {host}…", null, true),
            HostState.Unreachable => ($"Can't reach {host}", Red, false),
            HostState.Unauthorized => ($"{host} refused this PC", Red, false),
            _ => ($"{host} needs an update", Red, false)
        };
        HostText.Text = text;
        HostRing.IsActive = busy;
        HostRing.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        HostDot.Visibility = busy || color is null ? Visibility.Collapsed : Visibility.Visible;
        HostIndicator.Visibility = busy || color is not null ? Visibility.Visible : Visibility.Collapsed;
        if (color is { } fill) HostDot.Fill = new SolidColorBrush(fill);
        var connected = status?.IsConnected == true;
        NewSessionButton.IsEnabled = connected;
        // What the sidebar shows is the last known state while the host is away.
        SessionList.Opacity = connected || snapshot is null ? 1 : 0.5;

        hostNotice = status?.State switch
        {
            HostState.Reconnecting => new Notice(InfoBarSeverity.Warning, $"Reconnecting to {host}",
                status.Detail ?? "The connection dropped.", [("Retry now", RetryHost)]),
            HostState.Unreachable => new Notice(InfoBarSeverity.Error, $"Can't reach {host}",
                $"{status.Detail} {NextTry(status)}".Trim(), [("Retry now", RetryHost), ("Change address…", OpenHosts)]),
            HostState.Unauthorized => new Notice(InfoBarSeverity.Error, $"{host} refused this PC",
                status.Detail ?? "", [("Pair again…", PairAgain), ("Retry", RetryHost)]),
            HostState.Incompatible => new Notice(InfoBarSeverity.Error, $"Can't use {host}", status.Detail ?? "", [("Retry", RetryHost)]),
            _ => null
        };
        ShowNotice();
        if (Hosts.Visibility == Visibility.Visible) Hosts.UpdateStatus(status);
        if (connected && !usageRead)
        {
            usageRead = true;
            RefreshUsage();
        }
    }

    /// <summary>Reads usage from a host that serves it to this PC.</summary>
    private void RefreshUsage()
    {
        if (monitor?.Status is { IsConnected: true, Info: { } info } && info.Has(HostInfo.OwnerMethods)) _ = Usage.RefreshAsync();
    }

    private static string NextTry(HostStatus status) => status.NextTry is not { } next ? "Trying again now…"
        : (next - DateTimeOffset.Now).TotalSeconds < 60 ? $"Trying again in {Math.Max(1, (int)Math.Round((next - DateTimeOffset.Now).TotalSeconds))} seconds."
        : $"Trying again at {next.LocalDateTime:t}.";

    private void OnHostClick(object sender, RoutedEventArgs e) => OpenHosts();

    private void OpenHosts()
    {
        Hosts.ShowHost(pairing, monitor?.Status);
        Hosts.Visibility = Visibility.Visible;
        NoticeBar.IsOpen = false;
        // The page covers the terminal, so this window no longer sizes its session.
        ReportViews();
    }

    private void PairAgain()
    {
        OpenHosts();
        Hosts.BeginPairing();
    }

    private void CloseHosts()
    {
        if (pairing is null) return;
        Hosts.Visibility = Visibility.Collapsed;
        ShowNotice();
        ReportViews(ViewAttention.Strong);
        if (visible is not null) Web.Focus(FocusState.Programmatic);
        else SessionList.Focus(FocusState.Programmatic);
    }

    // ---- The sidebar ----

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
                    rows[row.Session.Handle].Update(row.Session, update.ActivityOf(row.Session), update.DetailOf(row.Session), section.Hierarchy, row,
                        collapsedParents.Contains(row.Session.Handle));
            }
        }
        finally { applying = false; }
        SessionList.Opacity = 1;

        if (visible is null) EmptyText.Text = update.Sessions.Count == 0 ? "No sessions on this host" : "Select a session";

        // A session that ended or was replaced is no longer attached.
        var live = update.Sessions.Where(s => s.Connected).Select(s => s.Handle).ToHashSet();
        foreach (var handle in attached.Keys.Where(h => !live.Contains(h)).ToList()) attached[handle].Controller.Stop();

        // The host is back: the shown session's terminal, if it gave up meanwhile, attaches again.
        if (failedTerminal is { } failed && failed == visible && live.Contains(failed) && !attached.ContainsKey(failed))
        {
            failedTerminal = null;
            Show(failed);
        }

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

    // ---- Terminals ----

    private void Show(string handle)
    {
        if (!pageReady || pairing is null || snapshot is null)
        {
            pendingShow = handle;
            return;
        }
        var session = snapshot.Sessions.FirstOrDefault(s => s.Handle == handle);
        if (session is null || !session.Connected) return;

        var terminal = attached.GetValueOrDefault(handle) ?? Attach(session);
        if (lingering is { } ended && ended != terminal)
        {
            ended.Surface.Post(new JsonObject { ["type"] = "dispose" });
            lingering = null;
        }
        recent.Remove(handle);
        recent.Add(handle);
        visible = handle;
        terminal.Surface.Post(new JsonObject { ["type"] = "show" });
        Web.Visibility = Visibility.Visible;
        EmptyState.Visibility = Visibility.Collapsed;
        if (Hosts.Visibility != Visibility.Visible) Web.Focus(FocusState.Programmatic);
        Title = $"{session.Name} – {AppTitle}";
        TitleText.Text = Title;
        ShowNotice();
        // Selecting a session is turning to it: the others are hidden, and this one takes its session's size.
        ReportViews(ViewAttention.Strong);

        // Keep the ten most recently shown terminals attached.
        while (recent.Count > MaxAttached)
        {
            var oldest = recent[0];
            recent.RemoveAt(0);
            if (attached.TryGetValue(oldest, out var evicted))
            {
                quietEnds.Add(evicted);
                evicted.Controller.Stop();
            }
        }
    }

    /// <summary>Nothing selected: the empty state in the terminal's place.</summary>
    private void ShowEmpty()
    {
        visible = null;
        if (lingering is { } ended)
        {
            ended.Surface.Post(new JsonObject { ["type"] = "dispose" });
            lingering = null;
        }
        applying = true;
        SessionList.SelectedItem = null;
        applying = false;
        Title = AppTitle;
        TitleText.Text = AppTitle;
        EmptyText.Text = pairing is null ? "Pair with a host to see its sessions" : "Select a session";
        EmptyState.Visibility = Visibility.Visible;
        Web.Visibility = Visibility.Collapsed;
        ShowNotice();
        ReportViews();
    }

    private Attached Attach(SessionInfo session)
    {
        var handle = session.Handle;
        var pageId = $"{handle}#{++pageIds}";
        var surface = new XtermSurface(pageId, paneSize, Web, DispatcherQueue,
            note: message => SetNotice(handle, new Notice(InfoBarSeverity.Warning, session.Name, message)),
            healthy: () => SetNotice(handle, null),
            resized: _ => { if (handle == visible) ShowOwner(); });
        surface.Post(new JsonObject { ["type"] = "create" });
        var controller = new AttachController(pairing!, handle, session.IncarnationId, surface);
        // Hidden until Show says otherwise, so a terminal attached behind another never sizes its session.
        controller.ReportView(false);
        var terminal = new Attached(session, pageId, surface, controller);
        attached[handle] = terminal;
        _ = RunAsync(terminal);
        return terminal;
    }

    /// <summary>The shown terminal is on screen: selected, not covered by the Hosts page, in a window that is not minimized.</summary>
    private bool TerminalOnScreen => visible is not null && attached.ContainsKey(visible) && Web.Visibility == Visibility.Visible
        && Hosts.Visibility != Visibility.Visible && !minimized && !IsClosed;

    /// <summary>
    /// Tells the host which of this window's terminals is on screen, with any attention the person just gave it; hosts
    /// without viewport ownership ignore it.
    /// </summary>
    private void ReportViews(ViewAttention? attention = null)
    {
        var onScreen = TerminalOnScreen;
        foreach (var terminal in attached.Values)
        {
            var shown = onScreen && terminal.Session.Handle == visible;
            terminal.Controller.ReportView(shown, shown ? attention : null);
        }
        ShowOwner();
    }

    /// <summary>Names the screen whose size the shown session has, while it is not this window.</summary>
    private void ShowOwner()
    {
        var pty = visible is not null && TerminalOnScreen ? attached.GetValueOrDefault(visible)?.Surface.Pty : null;
        if (pty is not { Owner: false, OwnerDevice: { } device })
        {
            OwnerNotice.Visibility = Visibility.Collapsed;
            return;
        }
        var name = DeviceName(device);
        OwnerNoticeText.Text = $"Sized for {name} · Fit here";
        ToolTipService.SetToolTip(OwnerNotice, $"This session is sized for {name}. Select to fit it to this window.");
        AutomationProperties.SetName(OwnerNotice, $"This session is sized for {name}. Fit it to this window.");
        OwnerNotice.Visibility = Visibility.Visible;
    }

    private void OnFitHere(object sender, RoutedEventArgs e)
    {
        if (visible is not null) attached.GetValueOrDefault(visible)?.Controller.ReportView(true, ViewAttention.Strong);
        Web.Focus(FocusState.Programmatic);
    }

    /// <summary>
    /// A device grant's name as people know it. Orc's own grant on the host was named "Orc" before it took the Mac's
    /// name, and the host's own `orc attach` connects as "this host": both are the host itself.
    /// </summary>
    private string DeviceName(string device)
    {
        if (device is not ("Orc" or "this host")) return device;
        var host = pairing?.EndpointUri.Host ?? "";
        if (host.Length == 0 || Uri.CheckHostName(host) is UriHostNameType.IPv4 or UriHostNameType.IPv6) return "the host";
        return host.EndsWith(".local", StringComparison.OrdinalIgnoreCase) ? host[..^".local".Length] : host;
    }

    private async Task RunAsync(Attached terminal)
    {
        var handle = terminal.Session.Handle;
        AttachExit exit = AttachExit.Detached;
        Exception? failure = null;
        try { exit = await Task.Run(() => terminal.Controller.RunAsync(closing.Token)); }
        catch (Exception error) { failure = error; }
        if (IsClosed) return;

        var current = attached.GetValueOrDefault(handle) == terminal;
        if (current)
        {
            attached.Remove(handle);
            recent.Remove(handle);
            ShowOwner();
        }
        // After the terminal's last output: the surface's queue keeps the order.
        if (quietEnds.Remove(terminal) || !current)
        {
            terminal.Surface.Post(new JsonObject { ["type"] = "dispose" });
            if (current && visible == handle) ShowEmpty();
        }
        else if (visible == handle)
        {
            var reason = failure?.Message ?? (exit == AttachExit.Ended ? "The session ended." : "Detached from the session.");
            // Leave its last screen up with a note until another session is shown, or the host is back.
            terminal.Surface.Post(new JsonObject { ["type"] = "ended", ["text"] = reason });
            lingering = terminal;
            if (failure is not null) failedTerminal = handle;
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

    // ---- Session commands ----

    private void OnNewSessionClick(object sender, RoutedEventArgs e) => _ = NewSessionAsync(null);

    private async Task NewSessionAsync(SessionInfo? parent)
    {
        if (monitor is null || snapshot is null || !HostConnected) return;
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
        monitor?.RefreshNow();
    }

    private void OnSessionContextRequested(UIElement sender, ContextRequestedEventArgs args)
    {
        if (args.OriginalSource is not FrameworkElement target || target.DataContext is not SessionRow { Session: { } session } row) return;
        args.Handled = true;
        var connected = HostConnected;
        var menu = new MenuFlyout();
        if (row.CanCreateChild) menu.Items.Add(MenuItem("Create Child…", "", () => _ = NewSessionAsync(session), enabled: connected));
        menu.Items.Add(MenuItem("Rename Session…", "", () => _ = RenameAsync(row), "F2", connected));
        menu.Items.Add(MenuItem("Restart Session", "", () => _ = RestartAsync(row), enabled: connected));
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(MenuItem("Close Session…", "", () => _ = CloseAsync(row), "Del", connected));
        if (args.TryGetPosition(target, out var point)) menu.ShowAt(target, point);
        else menu.ShowAt(target);
    }

    private static MenuFlyoutItem MenuItem(string text, string glyph, Action action, string? shortcut = null, bool enabled = true)
    {
        var item = new MenuFlyoutItem { Text = text, Icon = new FontIcon { Glyph = glyph }, IsEnabled = enabled };
        if (shortcut is not null) item.KeyboardAcceleratorTextOverride = shortcut;
        item.Click += (_, _) => action();
        return item;
    }

    /// <summary>Orc.app's Rename Session sheet: the full name, so a parent's name in front nests the session under it.</summary>
    private async Task RenameAsync(SessionRow row)
    {
        if (monitor is not { } host || !HostConnected || row.Session is not { } session) return;
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
        if (monitor is not { } host || !HostConnected || row.Session is not { } session) return;
        if (row.Activity == AgentActivity.Active && await ShowDialogAsync(new ContentDialog
            {
                Title = $"Restart “{session.Name}”?",
                Content = "The agent is working. Restarting stops its current turn; it then continues its conversation.",
                PrimaryButtonText = "Restart Session", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Close
            }) != ContentDialogResult.Primary) return;
        var terminal = attached.GetValueOrDefault(session.Handle);
        if (terminal is not null) quietEnds.Add(terminal);
        try
        {
            var restarted = await SessionCommands.RestartAsync(host.RequestAsync, session.Handle);
            if (visible == session.Handle || visible is null) pendingSelect = restarted;
            host.RefreshNow();
        }
        catch (Exception error)
        {
            if (terminal is not null) quietEnds.Remove(terminal);
            await ShowErrorAsync("Could Not Restart Session", $"Could not restart {session.Name}: {error.Message}");
        }
    }

    private async Task CloseAsync(SessionRow row)
    {
        if (monitor is not { } host || !HostConnected || row.Session is not { } session) return;
        if (await ShowDialogAsync(new ContentDialog
            {
                Title = $"Close “{session.Name}”?",
                Content = session.Agent is null ? "The terminal and everything running in it stop."
                    : "The agent stops. You can reopen it from Recently Closed in Orc on the host.",
                PrimaryButtonText = "Close Session", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Close
            }) != ContentDialogResult.Primary) return;
        var terminal = attached.GetValueOrDefault(session.Handle);
        if (terminal is not null) quietEnds.Add(terminal);
        try
        {
            await SessionCommands.CloseAsync(host.RequestAsync, session.Handle);
            host.RefreshNow();
        }
        catch (Exception error)
        {
            if (terminal is not null) quietEnds.Remove(terminal);
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

    // ---- Notices ----

    private void SetNotice(string handle, Notice? notice)
    {
        if (IsClosed) return;
        if (notice is null) notices.Remove(handle);
        else notices[handle] = notice;
        if (handle == visible) ShowNotice();
    }

    /// <summary>
    /// A host problem first, since it explains every terminal's; else the shown terminal's notice. Hidden while the
    /// Hosts page is open, which shows the host's state itself.
    /// </summary>
    private void ShowNotice()
    {
        var terminalNotice = visible is null ? null : notices.GetValueOrDefault(visible);
        var notice = Hosts.Visibility == Visibility.Visible ? null : hostNotice ?? terminalNotice;
        shownNotice = notice;
        NoticeBar.IsOpen = notice is not null;
        if (notice is null) return;
        NoticeBar.Severity = notice.Severity;
        NoticeBar.Title = notice.Title;
        NoticeBar.Message = notice.Message;
        if (notice.Actions is not { Count: > 0 } actions)
        {
            NoticeBar.Content = null;
            return;
        }
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 0, 0, 12) };
        foreach (var (label, run) in actions)
        {
            var button = new Button { Content = label };
            button.Click += (_, _) => run();
            buttons.Children.Add(button);
        }
        NoticeBar.Content = buttons;
    }

    // ---- The terminal page ----

    private void OnWebMessage(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (IsClosed || JsonNode.Parse(args.WebMessageAsJson) is not JsonObject message) return;
        var id = message["id"]?.ToString();
        var terminal = id is null ? null : attached.Values.FirstOrDefault(a => a.PageId == id);
        var shown = terminal is not null && terminal.Session.Handle == visible;
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
                if (!shown) break;
                paneSize = ReadSize(message);
                // The size that fits the pane: a host with viewport ownership gives it to the session while this window
                // owns it, and resizing the window is the person using it. Older hosts take every claim, so showing a
                // terminal claims the session's size for this window, as resizing it does.
                var resized = terminal!.Surface.SetSize(paneSize);
                if (resized || message["type"]?.ToString() == "shown") terminal.Controller.ViewportChanged();
                if (resized && message["type"]?.ToString() == "size") terminal.Controller.ReportView(TerminalOnScreen, ViewAttention.Strong);
                break;
            case "attention":
                if (shown && TerminalOnScreen) terminal!.Controller.ReportView(true, ViewAttention.Strong);
                break;
            case "input":
                if (shown) terminal!.Controller.SendInput(message["data"]?.GetValue<string>() ?? "");
                break;
            case "command":
                // The window's shortcuts, pressed while the terminal has focus.
                if (message["name"]?.ToString() == "new-session") _ = NewSessionAsync(null);
                break;
            case "copy":
                Copy(message["text"]?.GetValue<string>() ?? "");
                break;
            case "paste":
                if (shown) _ = PasteAsync(terminal!);
                break;
            case "menu":
                if (shown) ShowTerminalMenu(terminal!, message);
                break;
            case "diag":
                if (diagnostics) DiagnosticsLog.Append(message);
                break;
        }
    }

    private static TerminalSize ReadSize(JsonObject message) => new(message["cols"]!.GetValue<int>(), message["rows"]!.GetValue<int>());

    private static void Copy(string text)
    {
        if (text.Length == 0) return;
        var package = new DataPackage();
        package.SetText(text);
        Clipboard.SetContent(package);
        // Keep it on the clipboard after the app exits.
        Clipboard.Flush();
    }

    private async Task PasteAsync(Attached terminal)
    {
        var content = Clipboard.GetContent();
        if (content.Contains(StandardDataFormats.Text))
        {
            // xterm.js wraps it in bracketed paste when the program asked for that.
            terminal.Surface.Post(new JsonObject { ["type"] = "paste", ["text"] = await content.GetTextAsync() });
            return;
        }
        if (content.Contains(StandardDataFormats.Bitmap) || content.Contains(StandardDataFormats.StorageItems))
            SetNotice(terminal.Session.Handle, new Notice(InfoBarSeverity.Informational, "Can't paste that here yet",
                "Images and files on this PC can't be sent to the host's terminal yet. Text pastes work."));
    }

    /// <summary>The terminal's right-click menu: Copy, Paste, Select All.</summary>
    private void ShowTerminalMenu(Attached terminal, JsonObject message)
    {
        var selection = message["selection"]?.GetValue<string>() ?? "";
        var menu = new MenuFlyout();
        menu.Items.Add(MenuItem("Copy", "", () => Copy(selection), "Ctrl+C", selection.Length > 0));
        menu.Items.Add(MenuItem("Paste", "", () => _ = PasteAsync(terminal), "Ctrl+V"));
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(MenuItem("Select All", "", () => terminal.Surface.Post(new JsonObject { ["type"] = "select-all" })));
        var point = new Windows.Foundation.Point(message["x"]?.GetValue<double>() ?? 0, message["y"]?.GetValue<double>() ?? 0);
        menu.ShowAt(Web, point);
    }
}

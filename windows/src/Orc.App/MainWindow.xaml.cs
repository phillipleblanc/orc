using System.Collections.ObjectModel;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
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
using Windows.Foundation;
using Windows.Graphics;
using Windows.Graphics.Imaging;
using Windows.Storage;
using Windows.Storage.Streams;
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
    private readonly SessionMutes mutes = SessionMutes.Load();
    // Where sessions were dragged, for this host; and each section's rows as last laid out, which drags move within.
    private SidebarOrder order = new();
    /// <summary>Saves of the order under way, and when the last one ended: the host's order read before then may not have it.</summary>
    private int savingOrder;
    private DateTimeOffset orderSavedAt;
    private Dictionary<string, IReadOnlyList<SidebarRow>> sectionRows = [];
    private SessionRow? dragging;
    private (string Section, int Index, int Destination)? dropTarget;
    // Attached terminals by session handle; each attachment has its own page id, so a late end never touches its successor.
    private readonly Dictionary<string, Attached> attached = [];
    private readonly Dictionary<string, Notice> notices = [];
    // Attachments that end because this window closed, restarted or let go of their session: no "session ended" notice.
    private readonly HashSet<Attached> quietEnds = [];
    private readonly List<string> recent = [];
    private readonly CancellationTokenSource closing = new();
    private readonly bool diagnostics = Environment.GetEnvironmentVariable("ORC_DIAGNOSTICS") == "1";
    private readonly SessionDefaults defaults = SessionDefaults.Load();
    private readonly ReviewState review = ReviewState.Load();
    private readonly Notifier notifier;
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

    public MainWindow(Notifier notifier, string? openSession = null)
    {
        this.notifier = notifier;
        // A notification that launched Orc opens its session once the host lists it.
        pendingSelect = openSession;
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
        AddListAccelerator(VirtualKey.Up, row => MoveSession(row, -1), VirtualKeyModifiers.Menu);
        AddListAccelerator(VirtualKey.Down, row => MoveSession(row, 1), VirtualKeyModifiers.Menu);

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
            MarkShownRead();
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

        notifier.Opened += handle => DispatcherQueue.TryEnqueue(() => OpenFromNotification(handle));

        Closed += (_, _) =>
        {
            closing.Cancel();
            presence.Stop();
            usageTimer.Stop();
            notifier.Close();
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

    private void AddListAccelerator(VirtualKey key, Action<SessionRow> action, VirtualKeyModifiers modifiers = VirtualKeyModifiers.None)
    {
        var accelerator = new KeyboardAccelerator { Key = key, Modifiers = modifiers, ScopeOwner = SessionList };
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
        var host = new HostMonitor(next) { NotificationCursor = SavedCursor() };
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
        order = new SidebarOrder();
        orderSavedAt = DateTimeOffset.MinValue;
        sectionRows = [];
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
        // A turn that ends while the host is away is not inferred across the gap.
        if (!connected) review.ResetCycles();
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
        Review(update);
        if (update.Order is { } read && savingOrder == 0 && read.AskedAt > orderSavedAt) order = new SidebarOrder(read.Keys);
        var sections = SessionSections.Build(update.Sessions, update.Projects, order);
        // A child about to be selected is shown even when its parent is collapsed.
        if (pendingSelect is { } wanted)
            foreach (var section in sections)
                if (section.Sessions.FirstOrDefault(s => s.Handle == wanted) is { } session && section.Hierarchy.ParentOf(session) is { } parent)
                    collapsedParents.Remove(parent.Handle);
        collapsedParents.RemoveWhere(handle => update.Sessions.All(s => s.Handle != handle));

        var layout = sections.Select(section => (Section: section, Rows: order.Rows(section.Hierarchy, collapsedParents))).ToList();
        sectionRows = layout.ToDictionary(l => l.Section.Id, l => l.Rows);
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
                    rows[row.Session.Handle].Update(row.Session, ActivityOf(row.Session), mutes.IsMuted(row.Session.Name), update.DetailOf(row.Session),
                        section.Hierarchy, row, collapsedParents.Contains(row.Session.Handle));
            }
        }
        finally { applying = false; }
        SessionList.Opacity = 1;

        if (visible is null)
            EmptyText.Text = update.Projects.Count == 0 && update.Sessions.Count == 0 ? "Add a project to start agents and terminals in it."
                : update.Sessions.Count == 0 ? "No sessions on this host" : "Select a session";
        EmptyAction.Visibility = update.Projects.Count == 0 && update.Sessions.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

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

    // ---- Sidebar order ----

    /// <summary>The section a session's row is in, that section's rows, and the row's place among them.</summary>
    private (string Section, IReadOnlyList<SidebarRow> Rows, int Index)? Locate(string handle)
    {
        foreach (var (section, list) in sectionRows)
            for (var i = 0; i < list.Count; i++)
                if (list[i].Session.Handle == handle) return (section, list, i);
        return null;
    }

    private bool CanStep(SessionRow row, int direction) => Locate(row.Handle) is { } at && SidebarOrder.Step(at.Index, direction, at.Rows) is not null;

    /// <summary>Alt+Up and Alt+Down, and the menu's Move Up and Move Down: one place among the session's siblings.</summary>
    private void MoveSession(SessionRow row, int direction)
    {
        if (Locate(row.Handle) is not { } at || SidebarOrder.Step(at.Index, direction, at.Rows) is not { } destination) return;
        Reorder(at.Index, destination, at.Rows);
        if (SessionList.ContainerFromItem(row) is ListViewItem item) item.Focus(FocusState.Keyboard);
    }

    private void Reorder(int index, int destination, IReadOnlyList<SidebarRow> list)
    {
        if (snapshot is null || monitor is not { } host || !order.Move(index, destination, list)) return;
        _ = SaveOrderAsync(host, [.. order.Keys]);
        Apply(snapshot);
    }

    /// <summary>Saves the order on the host, which keeps it for every computer showing its sessions and for Rex's tabs.</summary>
    private async Task SaveOrderAsync(HostMonitor host, List<string> keys)
    {
        savingOrder++;
        try
        {
            await host.RequestAsync("session.order.set", new JsonObject { ["keys"] = new JsonArray([.. keys.Select(k => (JsonNode?)JsonValue.Create(k))]) });
        }
        catch (Exception failure)
        {
            if (monitor == host) SetNotice(visible ?? "", new Notice(InfoBarSeverity.Warning, "Couldn't save the session order", failure.Message));
        }
        finally
        {
            savingOrder--;
            orderSavedAt = DateTimeOffset.Now;
        }
    }

    private void OnDragStarting(object sender, DragItemsStartingEventArgs e)
    {
        if (e.Items.Count != 1 || e.Items[0] is not SessionRow row || Locate(row.Handle) is null)
        {
            e.Cancel = true;
            return;
        }
        dragging = row;
        e.Data.RequestedOperation = DataPackageOperation.Move;
        e.Data.SetText(row.Session?.Name ?? row.Handle);
    }

    private void OnDragOver(object sender, DragEventArgs e)
    {
        dropTarget = DropTargetAt(e.GetPosition(SessionListHost).Y);
        e.AcceptedOperation = dropTarget is null ? DataPackageOperation.None : DataPackageOperation.Move;
        e.DragUIOverride.IsCaptionVisible = false;
        e.DragUIOverride.IsGlyphVisible = false;
    }

    private void OnDrop(object sender, DragEventArgs e)
    {
        var target = dropTarget;
        EndDrag();
        if (target is { } t && sectionRows.TryGetValue(t.Section, out var list)) Reorder(t.Index, t.Destination, list);
    }

    private void OnDragLeave(object sender, DragEventArgs e)
    {
        dropTarget = null;
        DropLine.Visibility = Visibility.Collapsed;
    }

    private void OnDragCompleted(ListViewBase sender, DragItemsCompletedEventArgs args) => EndDrag();

    private void EndDrag()
    {
        dragging = null;
        dropTarget = null;
        DropLine.Visibility = Visibility.Collapsed;
    }

    /// <summary>
    /// Where the dragged session would go with the pointer at <paramref name="y"/>: between two of its siblings in its
    /// own project, as in Orc.app, with the insertion line drawn there. Null anywhere else, or where it already is.
    /// </summary>
    private (string Section, int Index, int Destination)? DropTargetAt(double y)
    {
        DropLine.Visibility = Visibility.Collapsed;
        if (dragging is null || Locate(dragging.Handle) is not { } source) return null;
        var (section, list, index) = source;
        var bounds = new List<(int Index, Rect Rect)>();
        for (var i = 0; i < list.Count; i++)
        {
            if (rows.GetValueOrDefault(list[i].Session.Handle) is not { } item || SessionList.ContainerFromItem(item) is not ListViewItem container
                || container.ActualHeight <= 0) continue;
            bounds.Add((i, container.TransformToVisual(SessionListHost).TransformBounds(new Rect(0, 0, container.ActualWidth, container.ActualHeight))));
        }
        if (bounds.Count == 0 || y < bounds[0].Rect.Top - 6 || y > bounds[^1].Rect.Bottom + 6) return null;
        var destination = bounds[^1].Index + 1;
        foreach (var (at, rect) in bounds)
        {
            if (y >= rect.Top + rect.Height / 2) continue;
            destination = at;
            break;
        }
        // Only a move that changes the order: between siblings, and not where it already is.
        if (!new SidebarOrder(order.Keys).Move(index, destination, list)) return null;
        var lineY = bounds.FirstOrDefault(b => b.Index == destination) is { Rect.Height: > 0 } next ? next.Rect.Top
            : bounds.LastOrDefault(b => b.Index < destination).Rect.Bottom;
        var indent = list[index].ParentHandle is null ? 12 : 34;
        DropLine.Width = Math.Max(0, bounds[0].Rect.Width - indent - 12);
        Canvas.SetLeft(DropLine, bounds[0].Rect.Left + indent);
        Canvas.SetTop(DropLine, lineY - 1);
        DropLine.Visibility = Visibility.Visible;
        return (section, index, destination);
    }

    private void OnToggleChildren(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is not SessionRow row) return;
        if (!collapsedParents.Remove(row.Handle)) collapsedParents.Add(row.Handle);
        if (snapshot is not null) Apply(snapshot);
    }

    // ---- Review and notifications ----

    /// <summary>A session's activity with this PC's review state over it: a finished turn or a notification not yet viewed.</summary>
    private AgentActivity ActivityOf(SessionInfo session) => review.ActivityOf(session, snapshot?.ActivityOf(session) ?? AgentActivity.Unknown);

    /// <summary>
    /// As Orc.app does on each refresh: notices agents that finished a turn and messages sessions sent, notifies, marks
    /// the session on screen read, and counts the sessions to review on the taskbar button.
    /// </summary>
    private void Review(HostSnapshot update)
    {
        var completed = review.Update(update.Sessions, update.ActivityOf);
        _ = PruneMutesAsync(update);
        foreach (var session in completed)
        {
            // Muted, or the person is looking at it here: nothing to tell them.
            if (mutes.IsMuted(session.Name) || (session.Handle == visible && windowActive && TerminalOnScreen)) continue;
            var project = Project.LastComponent(session.WorktreePath);
            if (session.Agent is null && session.Program?.Lead is { } program)
                notifier.Show(session.Name, $"{program.App ?? "Program"} is done", program.Msg ?? program.Title ?? $"Finished in {project}.", session.Handle);
            else
                notifier.Show(session.Name, "Agent is idle", $"Finished working in {project}.", session.Handle);
        }
        if (update.Notifications is { } batch)
        {
            foreach (var notification in batch.Notifications)
            {
                var session = update.Sessions.FirstOrDefault(s => s.Handle == notification.Handle);
                if (session is not null) review.MarkNotified(session);
                // Catching up after a long time away, only the recent ones are worth a banner; the rest show in the sidebar.
                if (batch.CatchingUp && DateTimeOffset.Now - notification.At > TimeSpan.FromHours(1)) continue;
                notifier.Show(session?.Name ?? notification.Session ?? "Orc", null, notification.Message, session?.Handle);
            }
            SaveCursor(batch.Cursor);
        }
        MarkShownRead(save: false);
        review.Save();
        UpdateBadge();
    }

    /// <summary>The session on screen, in the window in front, has been seen.</summary>
    private void MarkShownRead(bool save = true)
    {
        if (!windowActive || !TerminalOnScreen || snapshot?.Sessions.FirstOrDefault(s => s.Handle == visible) is not { } session || !review.MarkRead(session)) return;
        if (!save) return;
        review.Save();
        rows.GetValueOrDefault(session.Handle)?.SetActivity(ActivityOf(session), mutes.IsMuted(session.Name));
        UpdateBadge();
    }

    /// <summary>Sessions with something to review; a muted one only while it shows a notification.</summary>
    private void UpdateBadge() => notifier.SetBadge(snapshot?.Sessions.Count(s => ActivityOf(s) switch
    {
        AgentActivity.Notified => true,
        AgentActivity.Unread => !mutes.IsMuted(s.Name),
        _ => false
    }) ?? 0);

    private void SetMuted(SessionInfo session, bool muted)
    {
        mutes.Set(muted, session.Name);
        rows.GetValueOrDefault(session.Handle)?.SetActivity(ActivityOf(session), muted);
        UpdateBadge();
    }

    private DateTimeOffset mutesPrunedAt;
    private string mutesPrunedFor = "";

    /// <summary>
    /// As Orc.app does: forgets mutes of names no running or recently closed session has, so a later session that
    /// reuses a name does not start muted. Checked when the sessions change, at most every 30 seconds.
    /// </summary>
    private async Task PruneMutesAsync(HostSnapshot update)
    {
        var names = string.Join("\n", update.Sessions.Select(s => s.Name).Order());
        if (monitor is not { } host || (names == mutesPrunedFor && DateTimeOffset.Now - mutesPrunedAt < TimeSpan.FromSeconds(30))) return;
        mutesPrunedFor = names;
        mutesPrunedAt = DateTimeOffset.Now;
        try
        {
            var closed = await host.RequestAsync("history.list");
            var kept = update.Sessions.Select(s => s.Name).Concat((closed["sessions"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
                .Select(s => s["name"]?.ToString() ?? "")).ToHashSet();
            if (monitor == host) mutes.Prune(kept);
        }
        // Without the closed sessions, nothing is forgotten.
        catch (Exception error) when (error is RpcException or IOException or TimeoutException) { }
    }

    /// <summary>A notification was selected: Orc comes forward with its session.</summary>
    private void OpenFromNotification(string handle)
    {
        if (AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized } presenter) presenter.Restore();
        Activate();
        if (Hosts.Visibility == Visibility.Visible && pairing is not null) CloseHosts();
        if (rows.TryGetValue(handle, out var row) && listed.Contains(handle))
        {
            SessionList.SelectedItem = row;
            SessionList.ScrollIntoView(row);
        }
        else pendingSelect = handle;
    }

    private static NotificationCursor? SavedCursor() =>
        LocalSettings.GetString("notificationRuntime") is { Length: > 0 } runtime && LocalSettings.GetLong("notificationLatest") is { } latest
            ? new NotificationCursor(runtime, latest) : null;

    private static void SaveCursor(NotificationCursor cursor)
    {
        if (SavedCursor() == cursor) return;
        LocalSettings.Set("notificationRuntime", cursor.RuntimeId);
        LocalSettings.Set("notificationLatest", cursor.Latest);
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
        MarkShownRead();

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
        EmptyAction.Visibility = Visibility.Collapsed;
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

    private async Task NewSessionAsync(SessionInfo? parent, Project? added = null, string typedName = "")
    {
        if (monitor is not { } host || snapshot is null || !HostConnected) return;
        // The host's own defaults, as Orc.app's New Session uses them; this PC's for a host without host data.
        var sessionDefaults = defaults;
        if (host.Status.Info?.Has(HostInfo.HostData) == true)
        {
            try { sessionDefaults = await HostData.DefaultsAsync(host.RequestAsync); }
            catch (Exception error) when (error is RpcException or IOException or TimeoutException) { }
        }
        var projects = snapshot.Projects;
        if (added is not null)
        {
            // Just added: list the host's projects again rather than wait for the next refresh.
            try
            {
                var worktrees = await host.RequestAsync("worktree.list", new JsonObject { ["limit"] = 10000 });
                projects = (worktrees["worktrees"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(Project.FromJson).OfType<Project>().ToList();
            }
            catch (Exception error) when (error is RpcException or IOException or TimeoutException) { }
        }
        // Until a default is saved, suggest what this host's sessions use: the shown session's project, and the
        // agent most of them run.
        var shown = snapshot.Sessions.FirstOrDefault(s => s.Handle == visible) ?? snapshot.Sessions.FirstOrDefault();
        var suggestedProject = projects.FirstOrDefault(p => p.Id == shown?.WorktreeId);
        var suggestedKind = snapshot.Sessions.Where(s => SessionKind.Find(s.Agent) is not null).GroupBy(s => s.Agent)
            .OrderByDescending(g => g.Count()).Select(g => g.Key).FirstOrDefault();
        var dialog = new NewSessionDialog(host.RequestAsync, projects, sessionDefaults, paneSize, parent, suggestedProject, suggestedKind);
        if (added is not null) dialog.Restore(typedName, SessionCommands.ProjectsMatching("id:" + added.Id, projects).FirstOrDefault());
        await ShowDialogAsync(dialog);
        if (dialog.AddProjectRequested)
        {
            // One dialog at a time: Add Project, then New Session again with what was typed and the new project.
            var project = await AddProjectAsync();
            await NewSessionAsync(parent, project, dialog.TypedName);
            return;
        }
        if (dialog.CreatedHandle is not { } handle) return;
        pendingSelect = handle;
        monitor?.RefreshNow();
    }

    /// <summary>Orc.app's Add Project, for a folder on the host; returns the project added, if one was.</summary>
    private async Task<Project?> AddProjectAsync()
    {
        if (monitor is not { } host || !HostConnected) return null;
        var dialog = new AddProjectDialog(host.RequestAsync, browse: host.Status.Info?.Has(HostInfo.HostData) == true, StartFolder());
        await ShowDialogAsync(dialog);
        if (dialog.Added is not null) host.RefreshNow();
        return dialog.Added;
    }

    /// <summary>Where browsing for a project starts: the folder holding the shown session's project, or another project's.</summary>
    private string? StartFolder()
    {
        if (snapshot is null) return null;
        var shown = snapshot.Sessions.FirstOrDefault(s => s.Handle == visible);
        var path = snapshot.Projects.FirstOrDefault(p => p.Id == shown?.WorktreeId)?.Path ?? snapshot.Projects.FirstOrDefault()?.Path ?? shown?.WorktreePath;
        return path is { Length: > 0 } ? HostData.ParentOf(path) : null;
    }

    private void OnEmptyAction(object sender, RoutedEventArgs e) => _ = AddProjectAsync();

    private void OnSessionContextRequested(UIElement sender, ContextRequestedEventArgs args)
    {
        if (args.OriginalSource is not FrameworkElement target || target.DataContext is not SessionRow { Session: { } session } row) return;
        args.Handled = true;
        var connected = HostConnected;
        var menu = new MenuFlyout();
        if (row.CanCreateChild) menu.Items.Add(MenuItem("Create Child…", "", () => _ = NewSessionAsync(session), enabled: connected));
        menu.Items.Add(MenuItem("Rename Session…", "", () => _ = RenameAsync(row), "F2", connected));
        menu.Items.Add(MenuItem("Restart Session", "", () => _ = RestartAsync(row), enabled: connected));
        // As in Orc.app, an agent's notifications can be muted.
        if (session.Agent is not null)
            menu.Items.Add(row.Muted ? MenuItem("Unmute Notifications", "\uEA8F", () => SetMuted(session, false))
                : MenuItem("Mute Notifications", "\uE7ED", () => SetMuted(session, true)));
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(MenuItem("Move Up", "\uE74A", () => MoveSession(row, -1), "Alt+Up", CanStep(row, -1)));
        menu.Items.Add(MenuItem("Move Down", "\uE74B", () => MoveSession(row, 1), "Alt+Down", CanStep(row, 1)));
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
                var name = box.Text.Trim();
                await SessionCommands.RenameAsync(host.RequestAsync, session.Handle, name);
                // A mute goes with it; the host keeps its place in the order.
                mutes.Rename(session.Name, name);
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
            case "drop":
                if (shown) _ = DropAsync(terminal!, message);
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

    /// <summary>Files dropped on the terminal, which the page read; those it could not read are folders or too large.</summary>
    private Task DropAsync(Attached terminal, JsonObject message)
    {
        var files = (message["files"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .Select(f => (Name: f["name"]?.ToString() ?? "file", Data: f["data"]?.ToString() ?? ""))
            .Select(f => (f.Name, Read: (Func<Task<byte[]>>)(() => Task.FromResult(Convert.FromBase64String(f.Data))))).ToList();
        var names = (string key) => (message[key] as JsonArray ?? new JsonArray()).Select(n => n?.ToString() ?? "").Where(n => n.Length > 0);
        var skipped = names("folders").Select(n => $"{n} is a folder; paste or drop files.")
            .Concat(names("tooLarge").Select(n => $"{n} is larger than 12 MB, the most the host takes.")).ToList();
        return AttachAsync(terminal, files, skipped);
    }

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
        try
        {
            if (content.Contains(StandardDataFormats.Text))
            {
                // xterm.js wraps it in bracketed paste when the program asked for that.
                terminal.Surface.Post(new JsonObject { ["type"] = "paste", ["text"] = await content.GetTextAsync() });
                return;
            }
            if (content.Contains(StandardDataFormats.StorageItems))
            {
                var items = await content.GetStorageItemsAsync();
                var folders = items.Where(i => i is not StorageFile).Select(i => $"{i.Name} is a folder; paste or drop files.").ToList();
                var files = items.OfType<StorageFile>().Select(file => (file.Name, Read: (Func<Task<byte[]>>)(() => ReadAsync(file)))).ToList();
                await AttachAsync(terminal, files, folders);
                return;
            }
            if (content.Contains(StandardDataFormats.Bitmap))
            {
                var bitmap = await content.GetBitmapAsync();
                await AttachAsync(terminal, [($"image-{DateTime.Now:yyyyMMdd-HHmmss}.png", () => PngAsync(bitmap))], []);
            }
        }
        // The clipboard changed or was held by another app meanwhile.
        catch (COMException) { }
    }

    /// <summary>
    /// Files and images pasted or dropped into a terminal, as Orc.app drops them (Sources/OrcKit/TerminalFileDrop.swift):
    /// each is saved on the host, which has no access to this PC's disk, and its path there is pasted, shell-quoted and
    /// followed by a space, without pressing Enter. Agents such as Claude Code attach images pasted as paths.
    /// </summary>
    private async Task AttachAsync(Attached terminal, IReadOnlyList<(string Name, Func<Task<byte[]>> Read)> files, IReadOnlyList<string> skipped)
    {
        var handle = terminal.Session.Handle;
        if (monitor is not { } host || host.Status.Info?.Has(HostInfo.HostData) != true)
        {
            SetNotice(handle, new Notice(InfoBarSeverity.Informational, "Can't paste files here",
                "Update Orc on the host to paste or drop images and files into its terminals. Text pastes work."));
            return;
        }
        var problems = skipped.ToList();
        var paths = new List<string>();
        foreach (var (name, read) in files)
        {
            try { paths.Add(await HostData.SaveAttachmentAsync(host.RequestAsync, name, await read())); }
            // Too large to send.
            catch (InvalidOperationException error) { problems.Add(error.Message); }
            catch (Exception error) when (error is IOException or RpcException or TimeoutException or UnauthorizedAccessException or COMException or FormatException)
            {
                problems.Add($"Couldn't send {name} to the host: {error.Message}");
            }
        }
        if (paths.Count > 0 && attached.GetValueOrDefault(handle) == terminal)
            terminal.Surface.Post(new JsonObject { ["type"] = "paste", ["text"] = string.Concat(paths.Select(p => HostData.ShellQuote(p) + " ")) });
        SetNotice(handle, problems.Count == 0 ? null
            : new Notice(InfoBarSeverity.Warning, paths.Count > 0 ? "Some files weren't pasted" : "Nothing was pasted", string.Join(" ", problems)));
    }

    private static async Task<byte[]> ReadAsync(StorageFile file)
    {
        var properties = await file.GetBasicPropertiesAsync();
        // Not read at all when the host would refuse it.
        if (properties.Size > HostData.MaxAttachmentBytes) throw new InvalidOperationException($"{file.Name} is larger than 12 MB, the most the host takes.");
        var buffer = await FileIO.ReadBufferAsync(file);
        return buffer.ToArray();
    }

    /// <summary>An image on the clipboard, as PNG.</summary>
    private static async Task<byte[]> PngAsync(RandomAccessStreamReference bitmap)
    {
        using var source = await bitmap.OpenReadAsync();
        var decoder = await BitmapDecoder.CreateAsync(source);
        using var pixels = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
        using var output = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, output);
        encoder.SetSoftwareBitmap(pixels);
        await encoder.FlushAsync();
        var bytes = new byte[output.Size];
        using var reader = new DataReader(output.GetInputStreamAt(0));
        await reader.LoadAsync((uint)output.Size);
        reader.ReadBytes(bytes);
        return bytes;
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

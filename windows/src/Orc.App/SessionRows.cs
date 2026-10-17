using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Orc.Core;
using Windows.UI;

namespace Orc.Win;

/// <summary>A project's section in the sidebar.</summary>
[Microsoft.UI.Xaml.Data.Bindable]
public sealed class SessionGroup(string id) : ObservableCollection<SessionRow>
{
    private string title = "";

    public string Id { get; } = id;

    public string Title
    {
        get => title;
        set
        {
            if (title == value) return;
            title = value;
            OnPropertyChanged(new PropertyChangedEventArgs(nameof(Title)));
        }
    }
}

/// <summary>
/// A session in the sidebar, as Sources/OrcApp/SessionSidebarModel.swift shows it: its activity light, its name (a
/// child's without its parent's prefix, indented under the parent), and its agent with its status headline, or what a
/// reporting program says.
/// Green is idle, a yellow spinner active, orange with "!" needs attention, a blue bell something to review (a finished
/// turn or a notification), gray no agent, unavailable or offline.
/// </summary>
[Microsoft.UI.Xaml.Data.Bindable]
public sealed class SessionRow(string handle) : INotifyPropertyChanged
{
    private static readonly Brush Green = Solid(0x3f, 0xb9, 0x50);
    private static readonly Brush Orange = Solid(0xf0, 0x88, 0x3e);
    private static readonly Brush Gray = Solid(0x6e, 0x76, 0x81);

    private string name = "";
    private string detail = "";
    private AgentActivity activity = AgentActivity.Unknown;
    private bool muted;
    private bool isChild;
    private bool hasChildren;
    private bool collapsed;

    public event PropertyChangedEventHandler? PropertyChanged;

    public string Handle { get; } = handle;
    public SessionInfo? Session { get; private set; }
    public bool CanCreateChild { get; private set; }
    public AgentActivity Activity => activity;

    /// <summary>The name the sidebar shows: a child's suffix, or the full name.</summary>
    public string Name { get => name; private set => Set(ref name, value); }
    public string Detail { get => detail; private set => Set(ref detail, value); }

    public Thickness Indent => isChild ? new Thickness(22, 0, 0, 0) : new Thickness(0);
    public Visibility ChevronVisibility => hasChildren ? Visibility.Visible : Visibility.Collapsed;
    public string ChevronGlyph => collapsed ? "" : "";
    public string ChevronLabel => collapsed ? "Show child sessions" : "Hide child sessions";

    public bool IsActive => activity == AgentActivity.Active && !ShowsMuted;
    private bool HasBell => activity is AgentActivity.Unread or AgentActivity.Notified;
    /// <summary>A muted session shows a muted bell instead of its activity, unless it sent a notification (AgentActivityIndicator.swift).</summary>
    private bool ShowsMuted => muted && activity != AgentActivity.Notified;
    public bool Muted => muted;
    public Visibility RingVisibility => IsActive ? Visibility.Visible : Visibility.Collapsed;
    public Visibility DotVisibility => IsActive || HasBell || ShowsMuted ? Visibility.Collapsed : Visibility.Visible;
    public Visibility GlyphVisibility => activity == AgentActivity.NeedsAttention && !ShowsMuted ? Visibility.Visible : Visibility.Collapsed;
    /// <summary>A finished turn or a notification not yet viewed, as Orc.app's blue bell.</summary>
    public Visibility BellVisibility => HasBell && !ShowsMuted ? Visibility.Visible : Visibility.Collapsed;
    public Visibility MutedVisibility => ShowsMuted ? Visibility.Visible : Visibility.Collapsed;
    public Brush StatusBrush => activity switch
    {
        AgentActivity.Idle => Green,
        AgentActivity.NeedsAttention => Orange,
        _ => Gray
    };
    public string StatusLabel => muted ? $"Notifications muted · {activity.Label()}" : activity.Label();
    public string AccessibleName => $"{Session?.Name ?? name}, {StatusLabel}";

    public void Update(SessionInfo session, AgentActivity nextActivity, bool isMuted, string detail, SessionHierarchy hierarchy, SidebarRow row,
        bool isCollapsed)
    {
        Session = session;
        CanCreateChild = row.ParentHandle is null && hierarchy.CanCreateChild(session);
        Name = hierarchy.DisplayName(session);
        Detail = detail;
        if (isChild != (row.ParentHandle is not null)) { isChild = !isChild; Changed(nameof(Indent)); }
        if (hasChildren != row.HasChildren) { hasChildren = row.HasChildren; Changed(nameof(ChevronVisibility)); }
        if (collapsed != isCollapsed) { collapsed = isCollapsed; Changed(nameof(ChevronGlyph), nameof(ChevronLabel)); }
        SetActivity(nextActivity, isMuted);
        Changed(nameof(AccessibleName));
    }

    public void SetActivity(AgentActivity next, bool isMuted)
    {
        if (activity == next && muted == isMuted) return;
        activity = next;
        muted = isMuted;
        Changed(nameof(IsActive), nameof(RingVisibility), nameof(DotVisibility), nameof(GlyphVisibility), nameof(BellVisibility), nameof(MutedVisibility),
            nameof(StatusBrush), nameof(StatusLabel), nameof(AccessibleName));
    }

    private void Set(ref string field, string value, [CallerMemberName] string? property = null)
    {
        if (field == value) return;
        field = value;
        Changed(property!);
    }

    private void Changed(params string[] properties)
    {
        foreach (var property in properties) PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(property));
    }

    private static SolidColorBrush Solid(byte r, byte g, byte b) => new(Color.FromArgb(255, r, g, b));
}

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
/// A session in the sidebar: its activity light, name, and its agent with what a reporting program says, as
/// Sources/OrcApp/SessionSidebarModel.swift shows them. Green is idle, a yellow spinner active, orange with "!" needs
/// attention, gray no agent, unavailable or offline.
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

    public event PropertyChangedEventHandler? PropertyChanged;

    public string Handle { get; } = handle;
    public string Name { get => name; private set => Set(ref name, value); }
    public string Detail { get => detail; private set => Set(ref detail, value); }

    public bool IsActive => activity == AgentActivity.Active;
    public Visibility RingVisibility => IsActive ? Visibility.Visible : Visibility.Collapsed;
    public Visibility DotVisibility => IsActive ? Visibility.Collapsed : Visibility.Visible;
    public Visibility GlyphVisibility => activity == AgentActivity.NeedsAttention ? Visibility.Visible : Visibility.Collapsed;
    public Brush StatusBrush => activity switch
    {
        AgentActivity.Idle => Green,
        AgentActivity.NeedsAttention => Orange,
        _ => Gray
    };
    public string StatusLabel => activity.Label();
    public string AccessibleName => $"{Name}, {StatusLabel}";

    public void Update(SessionInfo session, AgentActivity next)
    {
        var renamed = Name != session.Name;
        Name = session.Name;
        Detail = session.Detail;
        if (activity == next)
        {
            if (renamed) PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(AccessibleName)));
            return;
        }
        activity = next;
        foreach (var property in new[] { nameof(IsActive), nameof(RingVisibility), nameof(DotVisibility), nameof(GlyphVisibility), nameof(StatusBrush), nameof(StatusLabel), nameof(AccessibleName) })
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(property));
    }

    private void Set(ref string field, string value, [CallerMemberName] string? property = null)
    {
        if (field == value) return;
        field = value;
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(property));
    }

    private static SolidColorBrush Solid(byte r, byte g, byte b) => new(Color.FromArgb(255, r, g, b));
}

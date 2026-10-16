using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Orc.Core;

namespace Orc.Win;

/// <summary>
/// The agents' subscription usage on the host (Sources/OrcApp/UsageSection.swift): each agent's plan, and per window
/// the share used and the time until it resets, in the caution color from 60 percent and the critical color from 80.
/// Folded, it shows each agent's window closest to its limit. The window decides when to read it; the host refetches
/// only usage that is minutes old.
/// </summary>
public sealed partial class UsagePanel : UserControl
{
    private const string ExpandedSetting = "usageExpanded";
    private readonly DispatcherTimer minute = new() { Interval = TimeSpan.FromMinutes(1) };
    private IReadOnlyList<ProviderUsage> providers = [];
    private bool expanded = LocalSettings.GetBool(ExpandedSetting, true);
    private bool fetching;

    /// <summary>A request to the host; set by the window.</summary>
    public Func<string, JsonObject?, Task<JsonObject>>? Request { get; set; }

    public UsagePanel()
    {
        InitializeComponent();
        Visibility = Visibility.Collapsed;
        // Reset countdowns tick by the minute.
        minute.Tick += (_, _) => Render();
        Loaded += (_, _) => minute.Start();
        Unloaded += (_, _) => minute.Stop();
        Render();
    }

    /// <summary>Reads usage from the host: fetched again there if it is old (<c>stale</c>) or regardless (<c>force</c>).</summary>
    public async Task RefreshAsync(string mode = "stale")
    {
        if (fetching || Request is not { } request) return;
        SetFetching(true);
        try
        {
            var result = await request("usage.read", new JsonObject { ["refresh"] = mode });
            providers = ProviderUsage.List(result);
            Render();
        }
        // A host that is away, or that does not serve usage, leaves what is shown.
        catch (Exception error) when (error is IOException or TimeoutException or Orc.Protocol.RpcException) { }
        finally { SetFetching(false); }
    }

    /// <summary>Another host, or none: nothing to show until it is read.</summary>
    public void Clear()
    {
        providers = [];
        Render();
    }

    private void OnToggle(object sender, RoutedEventArgs e)
    {
        expanded = !expanded;
        LocalSettings.Set(ExpandedSetting, expanded);
        Render();
    }

    private void OnRefresh(object sender, RoutedEventArgs e) => _ = RefreshAsync("force");

    private void SetFetching(bool on)
    {
        fetching = on;
        Fetching.IsActive = on;
        Fetching.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
        RefreshButton.Visibility = on ? Visibility.Collapsed : Visibility.Visible;
    }

    private void Render()
    {
        var visible = providers.Where(p => !p.Unavailable).ToList();
        Visibility = visible.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        Chevron.Glyph = expanded ? "" : "";
        SetName(Toggle, expanded ? "Hide usage" : "Show usage");
        Summary.Text = expanded ? "" : string.Join(" · ", visible.Where(p => p.Tightest is not null).Select(p => $"{p.Name} {p.Tightest!.Percent}%"));
        var updated = visible.Select(p => p.UpdatedAt).OfType<DateTimeOffset>().DefaultIfEmpty().Min();
        ToolTipService.SetToolTip(RefreshButton, updated == default ? "Refresh usage" : $"Refresh usage · Updated {Ago(updated)}");
        Providers.Visibility = expanded ? Visibility.Visible : Visibility.Collapsed;
        Providers.Children.Clear();
        if (!expanded) return;
        var now = DateTimeOffset.Now;
        foreach (var provider in visible) Providers.Children.Add(ProviderView(provider, now));
    }

    private static FrameworkElement ProviderView(ProviderUsage usage, DateTimeOffset now)
    {
        var panel = new StackPanel { Spacing = 4 };
        var header = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        header.Children.Add(new TextBlock { Text = usage.Name, Style = Resource<Style>("BodyStrongTextBlockStyle") });
        if (usage.Plan is { } plan) header.Children.Add(Caption(plan, VerticalAlignment.Center));
        if (usage.Status == "error" && usage.Windows.Count > 0)
        {
            var age = usage.UpdatedAt is { } at ? $" Showing usage from {Ago(at)}." : "";
            var warning = new FontIcon { Glyph = "", FontSize = 12, Foreground = Resource<Brush>("SystemFillColorCautionBrush"), VerticalAlignment = VerticalAlignment.Center };
            ToolTipService.SetToolTip(warning, $"Could not refresh: {usage.Error ?? "unknown error"}.{age}");
            header.Children.Add(warning);
        }
        if (usage.ResetCredits is > 0 and var credits)
            ToolTipService.SetToolTip(header, $"{usage.Name}{(usage.Plan is null ? "" : " " + usage.Plan)} · {credits} free rate-limit reset{(credits == 1 ? "" : "s")} available");
        panel.Children.Add(header);
        if (usage.Windows.Count == 0) panel.Children.Add(Caption(usage.Error ?? "No usage reported", wrap: true));
        foreach (var window in usage.Windows) panel.Children.Add(WindowRow(usage.Name, window, now));
        return panel;
    }

    private static FrameworkElement WindowRow(string provider, UsageWindow window, DateTimeOffset now)
    {
        var row = new Grid { ColumnSpacing = 8 };
        foreach (var width in new[] { new GridLength(56), new GridLength(1, GridUnitType.Star), new GridLength(36), new GridLength(48) })
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = width });
        var reset = window.ResetsAt is { } resets ? Insights.Duration(resets - now) : "";
        var bar = new ProgressBar { Value = window.UsedPercent, Maximum = 100, VerticalAlignment = VerticalAlignment.Center };
        var percent = Caption($"{window.Percent}%", VerticalAlignment.Center);
        percent.HorizontalAlignment = HorizontalAlignment.Right;
        if (window.Level != UsageLevel.Normal)
        {
            var color = Resource<Brush>(window.Level == UsageLevel.Critical ? "SystemFillColorCriticalBrush" : "SystemFillColorCautionBrush");
            bar.Foreground = color;
            percent.Foreground = color;
        }
        var resetText = Caption(reset, VerticalAlignment.Center);
        resetText.HorizontalAlignment = HorizontalAlignment.Right;
        resetText.Foreground = Resource<Brush>("TextFillColorTertiaryBrush");
        var label = Caption(window.Label, VerticalAlignment.Center);
        Grid.SetColumn(bar, 1);
        Grid.SetColumn(percent, 2);
        Grid.SetColumn(resetText, 3);
        row.Children.Add(label);
        row.Children.Add(bar);
        row.Children.Add(percent);
        row.Children.Add(resetText);
        var when = window.ResetsAt is not { } at ? null
            : at.LocalDateTime.Date == now.LocalDateTime.Date ? at.LocalDateTime.ToString("t") : at.LocalDateTime.ToString("ddd MMM d, t");
        ToolTipService.SetToolTip(row, when is null ? $"{window.Percent}% used" : $"{window.Percent}% used · resets in {reset}, {when}");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(row,
            $"{provider} {window.Label}: {window.Percent} percent used{(window.ResetsAt is null ? "" : $", resets in {reset}")}");
        return row;
    }

    private static TextBlock Caption(string text, VerticalAlignment alignment = VerticalAlignment.Top, bool wrap = false) => new()
    {
        Text = text, Style = Resource<Style>("CaptionTextBlockStyle"), Foreground = Resource<Brush>("TextFillColorSecondaryBrush"), VerticalAlignment = alignment,
        TextWrapping = wrap ? TextWrapping.Wrap : TextWrapping.NoWrap, TextTrimming = TextTrimming.CharacterEllipsis, MaxLines = wrap ? 3 : 1
    };

    private static string Ago(DateTimeOffset at)
    {
        var elapsed = DateTimeOffset.Now - at;
        return elapsed < TimeSpan.FromMinutes(1) ? "just now" : $"{Insights.Duration(elapsed)} ago";
    }

    private static T Resource<T>(string key) => (T)Application.Current.Resources[key];
    private static void SetName(UIElement element, string name) => Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(element, name);
}

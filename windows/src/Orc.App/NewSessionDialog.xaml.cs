using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Orc.Core;
using Orc.Protocol;

namespace Orc.Win;

/// <summary>
/// Orc.app's New Session sheet (CreateSessionView): a name, a project, and what to run, with the project's optional
/// MCP servers for agents that take them. Given a parent, it creates a child named `PARENT-SUFFIX` in the parent's
/// project, after checking that the parent can still have children.
/// </summary>
public sealed partial class NewSessionDialog : ContentDialog
{
    private readonly SessionCommands.Request request;
    private readonly IReadOnlyList<Project> projects;
    private readonly SessionDefaults defaults;
    private readonly SessionInfo? parent;
    private readonly TerminalSize size;
    private readonly string mutationId = Guid.NewGuid().ToString();
    private readonly HashSet<string> mcp = [];
    private int mcpLoad;
    private bool creating;

    /// <summary>The created session's handle, once it exists.</summary>
    public string? CreatedHandle { get; private set; }

    /// <summary>Closed to add a project; the window opens Add Project, then this dialog again with it.</summary>
    public bool AddProjectRequested { get; private set; }

    public NewSessionDialog(SessionCommands.Request request, IReadOnlyList<Project> projects, SessionDefaults defaults,
        TerminalSize size, SessionInfo? parent = null, Project? suggestedProject = null, string? suggestedKind = null)
    {
        InitializeComponent();
        this.request = request;
        this.projects = projects;
        this.defaults = defaults;
        this.size = size;
        this.parent = parent;

        if (parent is not null)
        {
            Title = "New Child Session";
            PrimaryButtonText = "Create Child";
            Description.Text = $"Create a session grouped under {parent.Name}.";
            NameBox.Header = "Child name";
            // A child is created in its parent's project.
            AddProjectLink.Visibility = Visibility.Collapsed;
        }
        ProjectBox.ItemsSource = projects.Select(p => $"{p.Name} — {p.Path}").ToList();
        if (projects.Count == 0) ShowError("The host has no projects yet. Add one to start sessions in it.");
        var project = parent is not null ? projects.FirstOrDefault(p => p.Id == parent.WorktreeId)
            : defaults.ProjectIn(projects) ?? suggestedProject ?? (projects.Count == 1 ? projects[0] : null);
        if (parent is not null && project is null) ShowError("The parent session's project is no longer registered. Choose another project.");
        ProjectBox.SelectedIndex = project is null ? -1 : projects.ToList().IndexOf(project);

        KindBox.ItemsSource = SessionKind.All.Select(k => k.Label).ToList();
        var kindId = defaults.HasKind ? defaults.Kind : suggestedKind ?? defaults.Kind;
        KindBox.SelectedIndex = SessionKind.All.ToList().FindIndex(k => k.Id == kindId) is var kind and >= 0 ? kind : 0;
        Opened += (_, _) => NameBox.Focus(FocusState.Programmatic);
        Validate();
    }

    private Project? SelectedProject => ProjectBox.SelectedIndex >= 0 ? projects[ProjectBox.SelectedIndex] : null;
    private SessionKind Kind => SessionKind.All[Math.Max(0, KindBox.SelectedIndex)];

    private string FullName => parent is null ? NameBox.Text.Trim() : $"{parent.Name}-{NameBox.Text.Trim()}";

    private void OnInputChanged(object sender, TextChangedEventArgs e) => Validate();

    private void OnAddProject(object sender, RoutedEventArgs e)
    {
        if (creating) return;
        AddProjectRequested = true;
        Hide();
    }

    /// <summary>What was typed, to fill in again when the dialog comes back after Add Project.</summary>
    public string TypedName => NameBox.Text;

    public void Restore(string name, Project? project)
    {
        NameBox.Text = name;
        if (project is not null && projects.ToList().IndexOf(project) is var index and >= 0) ProjectBox.SelectedIndex = index;
    }

    private void OnKindChanged(object sender, SelectionChangedEventArgs e)
    {
        CommandBox.Visibility = Kind.Id == "custom" ? Visibility.Visible : Visibility.Collapsed;
        _ = LoadMcpAsync();
        Validate();
    }

    private void OnProjectChanged(object sender, SelectionChangedEventArgs e)
    {
        if (SelectedProject is not null) ErrorBar.IsOpen = false;
        _ = LoadMcpAsync();
        Validate();
    }

    private async Task LoadMcpAsync()
    {
        var load = ++mcpLoad;
        mcp.Clear();
        McpList.Children.Clear();
        McpPanel.Visibility = Visibility.Collapsed;
        if (!Kind.TakesMcp || SelectedProject is not { } project) return;
        IReadOnlyList<McpConfig> configs;
        try { configs = await SessionCommands.McpConfigsAsync(request, project); }
        catch { return; }
        if (load != mcpLoad || configs.Count == 0) return;
        foreach (var config in configs)
        {
            var box = new CheckBox
            {
                IsEnabled = config.Error is null,
                Content = new StackPanel
                {
                    Children =
                    {
                        new TextBlock { Text = config.Name },
                        new TextBlock
                        {
                            Text = config.Error ?? string.Join(", ", config.Servers), Style = (Style)Application.Current.Resources["CaptionTextBlockStyle"],
                            Foreground = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources[config.Error is null ? "TextFillColorSecondaryBrush" : "SystemFillColorCautionBrush"]
                        }
                    }
                }
            };
            box.Checked += (_, _) => mcp.Add(config.Name);
            box.Unchecked += (_, _) => mcp.Remove(config.Name);
            McpList.Children.Add(box);
        }
        McpPanel.Visibility = Visibility.Visible;
    }

    private void Validate()
    {
        var typed = NameBox.Text.Trim().Length > 0;
        FullNameText.Visibility = parent is not null && typed ? Visibility.Visible : Visibility.Collapsed;
        FullNameText.Text = $"Full name: {FullName}";
        var problem = typed ? SessionNames.Problem(FullName) : null;
        NameBox.Description = problem ?? "";
        IsPrimaryButtonEnabled = !creating && typed && problem is null && SelectedProject is not null
            && (Kind.Id != "custom" || CommandBox.Text.Trim().Length > 0);
    }

    private async void OnCreate(ContentDialog sender, ContentDialogButtonClickEventArgs args)
    {
        // The dialog stays open until the session exists, so a failure can be corrected in place.
        args.Cancel = true;
        if (creating || SelectedProject is not { } project) return;
        creating = true;
        var label = PrimaryButtonText;
        PrimaryButtonText = "Creating…";
        Validate();
        ErrorBar.IsOpen = false;
        try
        {
            var name = FullName;
            if (parent is not null)
            {
                var list = await request("terminal.list", new JsonObject { ["limit"] = 10000 }, null);
                var live = (list["terminals"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(SessionInfo.FromJson).OfType<SessionInfo>().ToList();
                var current = live.FirstOrDefault(s => s.Handle == parent.Handle);
                if (current is null || !new SessionHierarchy(live).CanCreateChild(current))
                    throw new InvalidOperationException("This session can no longer have children, or its name is ambiguous. Rename it first.");
                name = SessionNames.ChildName(current, NameBox.Text);
            }
            var command = Kind.Id == "custom" ? CommandBox.Text.Trim() : Kind.Command;
            CreatedHandle = await SessionCommands.CreateAsync(request, name, project, command, Kind.TakesMcp ? mcp.Order().ToList() : [], size, mutationId);
            defaults.Remember(Kind, project);
            Hide();
        }
        catch (Exception error)
        {
            ShowError(error.Message);
        }
        finally
        {
            creating = false;
            PrimaryButtonText = label;
            Validate();
        }
    }

    private void ShowError(string message)
    {
        ErrorBar.Message = message;
        ErrorBar.IsOpen = true;
    }
}

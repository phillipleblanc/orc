using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Orc.Core;
using Orc.Protocol;
using Windows.System;

namespace Orc.Win;

/// <summary>
/// Orc.app's Add Project sheet (Sources/OrcApp/AddProjectView.swift) for a folder on the host: typed, or chosen by
/// browsing the host's folders (<c>fs.list</c>, which lists only its home folder), then registered with <c>repo.add</c>
/// and, as on the Mac, made the default project for new sessions unless that is turned off. A host without host data
/// cannot be browsed; its folder is typed.
/// </summary>
public sealed partial class AddProjectDialog : ContentDialog
{
    private readonly SessionCommands.Request request;
    private readonly bool browse;
    private int loads;
    private bool adding;

    /// <summary>The project added, once it is.</summary>
    public Project? Added { get; private set; }

    public AddProjectDialog(SessionCommands.Request request, bool browse, string? startFolder)
    {
        InitializeComponent();
        this.request = request;
        this.browse = browse;
        Browser.Visibility = browse ? Visibility.Visible : Visibility.Collapsed;
        UpButton.Visibility = browse ? Visibility.Visible : Visibility.Collapsed;
        Opened += (_, _) =>
        {
            PathBox.Focus(FocusState.Programmatic);
            if (browse && startFolder is not null) _ = OpenAsync(startFolder);
        };
        Validate();
    }

    private string Folder => PathBox.Text.Trim();

    private void OnPathChanged(object sender, TextChangedEventArgs e)
    {
        ErrorBar.IsOpen = false;
        Validate();
    }

    private void OnPathKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter || !browse || !Folder.StartsWith('/')) return;
        // Enter in the path opens it, rather than adding a folder that may be mistyped.
        e.Handled = true;
        _ = OpenAsync(Folder);
    }

    private void OnUp(object sender, RoutedEventArgs e)
    {
        if (HostData.ParentOf(Folder) is { } parent) _ = OpenAsync(parent);
    }

    private void OnFolderClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is string name) _ = OpenAsync(HostData.Child(Folder, name));
    }

    private async Task OpenAsync(string path)
    {
        var load = ++loads;
        ListingRing.IsActive = true;
        BrowserNote.Visibility = Visibility.Collapsed;
        try
        {
            var listing = await HostData.ListFoldersAsync(request, path);
            if (load != loads) return;
            PathBox.Text = listing.Path;
            PathBox.SelectionStart = PathBox.Text.Length;
            Validate();
            Folders.ItemsSource = listing.Folders;
            BrowserNote.Text = "No folders inside.";
            BrowserNote.Visibility = listing.Folders.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            if (listing.Truncated) ShowError("Showing the first 5,000 folders. Type the folder's path to go further.", InfoBarSeverity.Informational);
        }
        catch (Exception error) when (error is RpcException or IOException or TimeoutException)
        {
            if (load != loads) return;
            ShowError(error is RpcException { Code: "forbidden" } ? "Only folders in the host's home folder can be browsed." : error.Message);
        }
        finally
        {
            if (load == loads) ListingRing.IsActive = false;
            UpButton.IsEnabled = HostData.ParentOf(Folder) is not null;
        }
    }

    private void Validate() => IsPrimaryButtonEnabled = !adding && Folder.StartsWith('/');

    private async void OnAdd(ContentDialog sender, ContentDialogButtonClickEventArgs args)
    {
        // The dialog stays open until the project is added, so a failure can be corrected in place.
        args.Cancel = true;
        if (adding) return;
        adding = true;
        PrimaryButtonText = "Adding…";
        Validate();
        ErrorBar.IsOpen = false;
        try
        {
            Added = await HostData.AddProjectAsync(request, Folder, MakeDefault.IsChecked == true);
            Hide();
        }
        catch (Exception error) when (error is RpcException or IOException or TimeoutException)
        {
            ShowError(error.Message);
        }
        finally
        {
            adding = false;
            PrimaryButtonText = "Add Project";
            Validate();
        }
    }

    private void ShowError(string message, InfoBarSeverity severity = InfoBarSeverity.Error)
    {
        ErrorBar.Severity = severity;
        ErrorBar.Message = message;
        ErrorBar.IsOpen = true;
    }
}

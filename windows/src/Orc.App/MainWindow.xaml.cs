using System.Text;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using Orc.Protocol;
using Windows.ApplicationModel.DataTransfer;
using Windows.Graphics;

namespace Orc.Win;

/// <summary>
/// A session picker over one xterm.js terminal. It uses the host saved by `orcspike pair` and drives the spike's
/// AttachController through XtermSurface, so keys reach the runtime without ConPTY in between.
/// </summary>
public sealed partial class MainWindow : Window
{
    private const string AppTitle = "Orc for Windows (spike)";
    private Pairing? pairing;
    private XtermSurface? surface;
    private AttachController? controller;
    private List<JsonObject> terminals = [];
    private bool pageReady;

    public MainWindow()
    {
        InitializeComponent();
        Title = AppTitle;
        AppWindow.Resize(new SizeInt32(1280, 820));
        Closed += (_, _) => controller?.Stop();
        AttachButton.IsEnabled = false;
        _ = InitializeAsync();
    }

    private async Task InitializeAsync()
    {
        try
        {
            pairing = PairingStore.Load();
            HostText.Text = $"{pairing.Endpoint} · key {pairing.Fingerprint}";
        }
        catch (Exception error)
        {
            StatusText.Text = error.Message;
            RefreshButton.IsEnabled = false;
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
        surface = new XtermSurface(Web, DispatcherQueue, message => StatusText.Text = message);
        core.Navigate("https://orc.local/index.html");
        if (pairing is not null) await RefreshAsync();
    }

    private void OnWebMessage(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (JsonNode.Parse(args.WebMessageAsJson) is not JsonObject message || surface is null) return;
        switch (message["type"]?.GetValue<string>())
        {
            case "ready":
            case "size":
                var size = new TerminalSize(message["cols"]!.GetValue<int>(), message["rows"]!.GetValue<int>());
                SizeText.Text = $"{size.Cols}×{size.Rows}";
                pageReady = true;
                AttachButton.IsEnabled = pairing is not null;
                if (surface.SetSize(size)) controller?.ViewportChanged();
                break;
            case "input":
                var data = message["data"]?.GetValue<string>() ?? "";
                KeysText.Text = "sent " + Escape(data);
                controller?.SendInput(data);
                break;
            case "copy":
                var package = new DataPackage();
                package.SetText(message["text"]?.GetValue<string>() ?? "");
                Clipboard.SetContent(package);
                break;
            case "paste":
                _ = PasteAsync();
                break;
        }
    }

    private async Task PasteAsync()
    {
        var content = Clipboard.GetContent();
        if (!content.Contains(StandardDataFormats.Text) || surface is null) return;
        // xterm.js wraps it in bracketed paste when the program asked for that.
        surface.Post(new JsonObject { ["type"] = "paste", ["text"] = await content.GetTextAsync() });
    }

    private async void OnRefreshClick(object sender, RoutedEventArgs e) => await RefreshAsync();

    private async Task RefreshAsync()
    {
        try
        {
            StatusText.Text = "Listing sessions…";
            await using var connection = await RuntimeConnection.ConnectAsync(pairing!);
            var list = await connection.RequestAsync("terminal.list");
            terminals = (list["terminals"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
                .Where(t => t["connected"]?.GetValue<bool>() == true).ToList();
            var selected = Sessions.SelectedItem as string;
            Sessions.ItemsSource = terminals.Select(Name).ToList();
            Sessions.SelectedIndex = Math.Max(0, terminals.FindIndex(t => Name(t) == selected));
            StatusText.Text = $"{terminals.Count} running sessions on {pairing!.Endpoint}. Pick one and attach.";
        }
        catch (Exception error) { StatusText.Text = error.Message; }
    }

    private async void OnAttachClick(object sender, RoutedEventArgs e)
    {
        if (controller is not null)
        {
            controller.Stop();
            return;
        }
        if (pairing is null || surface is null || !pageReady || Sessions.SelectedIndex < 0 || Sessions.SelectedIndex >= terminals.Count) return;

        var target = terminals[Sessions.SelectedIndex];
        var name = Name(target);
        var readOnly = ReadOnlyBox.IsChecked == true;
        var attached = new AttachController(pairing, target["handle"]!.ToString(), target["incarnationId"]?.ToString(), surface, readOnly);
        controller = attached;
        AttachButton.Content = "Detach";
        Sessions.IsEnabled = ReadOnlyBox.IsEnabled = RefreshButton.IsEnabled = false;
        Title = $"{name} · {AppTitle}";
        StatusText.Text = $"Attaching to {name}{(readOnly ? " (read-only: no typing, no resizing)" : "")}…";
        surface.Post(new JsonObject { ["type"] = "clear" });
        surface.Post(new JsonObject { ["type"] = "focus" });
        Web.Focus(FocusState.Programmatic);

        AttachExit exit = AttachExit.Detached;
        string? failure = null;
        try { exit = await Task.Run(() => attached.RunAsync(CancellationToken.None)); }
        catch (Exception error) { failure = error.Message; }

        var echoes = attached.EchoSamples;
        controller = null;
        AttachButton.Content = "Attach";
        Sessions.IsEnabled = ReadOnlyBox.IsEnabled = RefreshButton.IsEnabled = true;
        Title = AppTitle;
        var summary = failure ?? (exit == AttachExit.Ended ? $"{name} ended." : $"Detached from {name}; it keeps running.");
        if (echoes.Count > 0) summary += $" Typing to echo: median {Median(echoes):F0} ms over {echoes.Count} bursts.";
        StatusText.Text = summary;
    }

    private static string Name(JsonObject terminal) =>
        terminal["title"]?.ToString() is { Length: > 0 } title ? title : terminal["handle"]?.ToString() ?? "?";

    private static double Median(IReadOnlyList<double> samples)
    {
        var sorted = samples.Order().ToArray();
        return sorted[sorted.Length / 2];
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

using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Orc.Core;
using Orc.Protocol;
using Windows.ApplicationModel.DataTransfer;
using Windows.System;
using Windows.UI;

namespace Orc.Win;

/// <summary>
/// The host this PC pairs with: its address, key and state, with changing its address, pairing again and forgetting
/// it; and pairing from a link, checked against the host before anything is saved.
/// </summary>
public sealed partial class HostsPage : UserControl
{
    private Pairing? pairing;
    private bool verifying;

    /// <summary>A link was checked against its host and can be saved.</summary>
    public event Action<Pairing, HostInfo>? Paired;
    /// <summary>The saved host answered at a new address, with the same key.</summary>
    public event Action<Pairing>? AddressChanged;
    public event Action? ForgetRequested;
    public event Action? CloseRequested;

    /// <summary>Shows a dialog over the window; set by the window, which allows one dialog at a time.</summary>
    public Func<ContentDialog, Task<ContentDialogResult?>> ShowDialog { get; set; } = _ => Task.FromResult<ContentDialogResult?>(null);

    public HostsPage()
    {
        InitializeComponent();
        var name = Environment.MachineName;
        PairStep.Text = $"1. In Orc on the Mac, choose Pair Device…, then Computer. Name it {name} and select Copy Link. Or run this in Terminal on the host:";
        CommandText.Text = HostPairing.HostCommand(name);
        LegacyCommandText.Text = HostPairing.LegacyHostCommand(name);
    }

    /// <summary>Shows the saved host, or only the pairing form when there is none.</summary>
    public void ShowHost(Pairing? saved, HostStatus? status)
    {
        pairing = saved;
        HostCard.Visibility = saved is null ? Visibility.Collapsed : Visibility.Visible;
        CloseButton.Visibility = saved is null ? Visibility.Collapsed : Visibility.Visible;
        if (saved is null)
        {
            ShowPairForm(replacing: false);
            return;
        }
        HostName.Text = saved.EndpointUri.Host;
        AddressText.Text = saved.Endpoint;
        KeyText.Text = saved.Fingerprint;
        UpdateStatus(status);
        if (!verifying && LinkBox.Password.Length == 0) PairForm.Visibility = Visibility.Collapsed;
    }

    public void UpdateStatus(HostStatus? status)
    {
        if (pairing is null) return;
        var (text, color, busy) = status?.State switch
        {
            HostState.Connected => ("Connected", Color.FromArgb(255, 0x3f, 0xb9, 0x50), false),
            HostState.Reconnecting => ("Reconnecting…", default, true),
            HostState.Unreachable => ("Can't reach it", Color.FromArgb(255, 0xf8, 0x51, 0x49), false),
            HostState.Unauthorized => ("Refused this PC", Color.FromArgb(255, 0xf8, 0x51, 0x49), false),
            HostState.Incompatible => ("Needs an update", Color.FromArgb(255, 0xf8, 0x51, 0x49), false),
            _ => ("Connecting…", default, true)
        };
        StateText.Text = text;
        StateRing.IsActive = busy;
        StateRing.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        StateDot.Visibility = busy ? Visibility.Collapsed : Visibility.Visible;
        StateDot.Fill = new SolidColorBrush(color);
        PlatformText.Text = status?.Info is { } info ? $"Orc on {info.PlatformName}, protocol {info.ProtocolVersion}" : "Not known until connected";
    }

    /// <summary>Opens the pairing form, for pairing again when the host refused this PC.</summary>
    public void BeginPairing() => ShowPairForm(replacing: pairing is not null);

    private void ShowPairForm(bool replacing)
    {
        PairForm.Visibility = Visibility.Visible;
        PairTitle.Text = replacing ? "Pair again" : "Pair with a host";
        CancelPairButton.Visibility = replacing ? Visibility.Visible : Visibility.Collapsed;
        PairError.IsOpen = false;
        LinkBox.Focus(FocusState.Programmatic);
    }

    private void OnPairAgain(object sender, RoutedEventArgs e) => ShowPairForm(replacing: true);

    private void OnCancelPair(object sender, RoutedEventArgs e)
    {
        LinkBox.Password = "";
        PairError.IsOpen = false;
        PairForm.Visibility = Visibility.Collapsed;
    }

    private void OnClose(object sender, RoutedEventArgs e) => CloseRequested?.Invoke();

    private void OnCopyCommand(object sender, RoutedEventArgs e) => Copy(CommandText.Text, CopyButton);

    private void OnCopyLegacyCommand(object sender, RoutedEventArgs e) => Copy(LegacyCommandText.Text, LegacyCopyButton);

    private void Copy(string text, Button button)
    {
        var package = new DataPackage();
        package.SetText(text);
        Clipboard.SetContent(package);
        button.Content = "Copied";
        _ = Task.Delay(TimeSpan.FromSeconds(2)).ContinueWith(_ => DispatcherQueue.TryEnqueue(() => button.Content = "Copy"));
    }

    private void OnLinkChanged(object sender, RoutedEventArgs e)
    {
        PairError.IsOpen = false;
        ConnectButton.IsEnabled = !verifying && LinkBox.Password.Trim().Length > 0;
    }

    private void OnLinkKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter || !ConnectButton.IsEnabled) return;
        e.Handled = true;
        OnConnect(sender, e);
    }

    private async void OnConnect(object sender, RoutedEventArgs e)
    {
        Pairing candidate;
        try { candidate = Pairing.Parse(LinkBox.Password); }
        catch (FormatException error)
        {
            ShowPairError(error.Message);
            return;
        }
        SetVerifying(true);
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            var info = await HostPairing.VerifyAsync(candidate, timeout.Token);
            LinkBox.Password = "";
            PairForm.Visibility = Visibility.Collapsed;
            Paired?.Invoke(candidate, info);
        }
        catch (Exception error) when (error is IOException or OperationCanceledException or RpcException or TimeoutException)
        {
            ShowPairError(error is OperationCanceledException ? $"{candidate.EndpointUri.Host} didn't answer in time." : error.Message);
        }
        finally { SetVerifying(false); }
    }

    private async void OnChangeAddress(object sender, RoutedEventArgs e)
    {
        if (pairing is not { } current) return;
        var box = new TextBox { Header = "Address", Text = current.EndpointUri.Port == 6768 ? current.EndpointUri.Host : $"{current.EndpointUri.Host}:{current.EndpointUri.Port}" };
        var error = new InfoBar { Severity = InfoBarSeverity.Error, IsClosable = false, IsOpen = false };
        var dialog = new ContentDialog
        {
            Title = "Change Address", PrimaryButtonText = "Connect", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Primary,
            Content = new StackPanel
            {
                Spacing = 12, MinWidth = 400,
                Children =
                {
                    new TextBlock
                    {
                        Text = "The host's IP address or name on this network, for example after it got a new address. This PC checks it is the same host before saving.",
                        TextWrapping = TextWrapping.Wrap, Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"]
                    },
                    box, error
                }
            }
        };
        void Validate() => dialog.IsPrimaryButtonEnabled = HostPairing.EndpointFrom(box.Text) is not null;
        box.TextChanged += (_, _) => { error.IsOpen = false; Validate(); };
        dialog.Opened += (_, _) => { box.Focus(FocusState.Programmatic); box.SelectAll(); };
        dialog.PrimaryButtonClick += async (_, args) =>
        {
            args.Cancel = true;
            if (HostPairing.EndpointFrom(box.Text) is not { } endpoint) return;
            dialog.IsPrimaryButtonEnabled = false;
            try
            {
                var moved = current.WithEndpoint(endpoint);
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                await HostPairing.VerifyAsync(moved, timeout.Token);
                dialog.Hide();
                AddressChanged?.Invoke(moved);
            }
            catch (Exception failure) when (failure is IOException or OperationCanceledException or RpcException or FormatException)
            {
                error.Message = failure is OperationCanceledException ? "Nothing answered there in time." : failure.Message;
                error.IsOpen = true;
                Validate();
            }
        };
        Validate();
        await ShowDialog(dialog);
    }

    private async void OnForget(object sender, RoutedEventArgs e)
    {
        if (pairing is null) return;
        var result = await ShowDialog(new ContentDialog
        {
            Title = $"Forget {pairing.EndpointUri.Host}?",
            Content = "This PC stops showing its sessions and deletes its pairing. The sessions keep running on the host. "
                + "To take this PC's access away on the host too, revoke it in Orc under Pair Device… › Computer Access, or with orc computers revoke.",
            PrimaryButtonText = "Forget Host", CloseButtonText = "Cancel", DefaultButton = ContentDialogButton.Close
        });
        if (result == ContentDialogResult.Primary) ForgetRequested?.Invoke();
    }

    private void SetVerifying(bool on)
    {
        verifying = on;
        Verifying.IsActive = on;
        LinkBox.IsEnabled = !on;
        ConnectButton.Content = on ? "Connecting…" : "Connect";
        ConnectButton.IsEnabled = !on && LinkBox.Password.Trim().Length > 0;
    }

    private void ShowPairError(string message)
    {
        PairError.Message = message;
        PairError.IsOpen = true;
    }
}

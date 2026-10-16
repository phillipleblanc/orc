using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace Orc.Win;

public partial class App : Application
{
    private MainWindow? window;

    public App() => InitializeComponent();

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        // Registered before anything else, so a notification selected while Orc was closed reaches this launch.
        var notifier = new Notifier();
        window = new MainWindow(notifier, Notifier.LaunchedFor(AppInstance.GetCurrent().GetActivatedEventArgs()));
        window.Activate();
    }
}

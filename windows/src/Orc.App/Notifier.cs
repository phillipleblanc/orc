using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;
using Microsoft.Windows.BadgeNotifications;

namespace Orc.Win;

/// <summary>
/// Windows notifications for the host's sessions, as Sources/OrcApp/IdleNotifications.swift posts them on the Mac: an
/// agent that finished its turn, and messages sessions send with <c>orc notify</c>; and the count of sessions with
/// something to review on the taskbar button. Selecting a notification opens its session. Windows' notification
/// settings decide whether and how they show.
/// </summary>
public sealed class Notifier
{
    private const string SessionArgument = "session";
    private readonly bool registered;
    private int? badge;

    /// <summary>A notification for this session was selected, on a background thread.</summary>
    public event Action<string>? Opened;

    public Notifier()
    {
        try
        {
            AppNotificationManager.Default.NotificationInvoked += (_, args) => Invoked(args.Arguments);
            var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.png");
            AppNotificationManager.Default.Register("Orc", new Uri(icon));
            registered = true;
        }
        // Notifications are unavailable (an older Windows, or policy): the app works without them.
        catch (Exception error) when (error is System.Runtime.InteropServices.COMException or UnauthorizedAccessException or ArgumentException) { }
    }

    /// <summary>The session a notification that launched this app was for, if one did.</summary>
    public static string? LaunchedFor(Microsoft.Windows.AppLifecycle.AppActivationArguments activation) =>
        activation.Kind == Microsoft.Windows.AppLifecycle.ExtendedActivationKind.AppNotification
        && activation.Data is AppNotificationActivatedEventArgs args && args.Arguments.TryGetValue(SessionArgument, out var handle) ? handle : null;

    public void Show(string title, string? subtitle, string body, string? handle)
    {
        if (!registered) return;
        var builder = new AppNotificationBuilder().AddText(title);
        if (subtitle is not null) builder.AddText(subtitle);
        builder.AddText(body);
        if (handle is not null) builder.AddArgument(SessionArgument, handle);
        var notification = builder.BuildNotification();
        // A session's notifications group together in the notification center.
        if (handle is not null) notification.Group = "orc-" + (handle.Length > 50 ? handle[..50] : handle);
        try { AppNotificationManager.Default.Show(notification); }
        catch (Exception error) when (error is System.Runtime.InteropServices.COMException) { }
    }

    /// <summary>The number of sessions with something to review, on the taskbar button; none clears it.</summary>
    public void SetBadge(int count)
    {
        if (!registered || badge == count) return;
        badge = count;
        try
        {
            if (count > 0) BadgeNotificationManager.Current.SetBadgeAsCount((uint)count);
            else BadgeNotificationManager.Current.ClearBadge();
        }
        catch (Exception error) when (error is System.Runtime.InteropServices.COMException or UnauthorizedAccessException) { }
    }

    /// <summary>Lets go of notification activation as the app exits; notifications already shown stay.</summary>
    public void Close()
    {
        if (!registered) return;
        try
        {
            BadgeNotificationManager.Current.ClearBadge();
            AppNotificationManager.Default.Unregister();
        }
        catch (Exception error) when (error is System.Runtime.InteropServices.COMException) { }
    }

    private void Invoked(IDictionary<string, string> arguments)
    {
        if (arguments.TryGetValue(SessionArgument, out var handle)) Opened?.Invoke(handle);
    }
}

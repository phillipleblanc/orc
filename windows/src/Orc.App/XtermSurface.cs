using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml.Controls;
using Orc.Protocol;

namespace Orc.Win;

/// <summary>
/// ITerminalSurface on one xterm.js terminal in the shared WebView2 page, addressed by its page id. Calls arrive on the
/// connection's thread; they are queued in order and posted as one batch per dispatcher turn, with consecutive output
/// merged. The page draws the terminal at its PTY's size, so the host's output always lays out as it was written;
/// <see cref="Size"/> is the size that fits the pane, which the PTY takes while this window owns the session.
/// </summary>
internal sealed class XtermSurface(string id, TerminalSize initial, WebView2 web, DispatcherQueue dispatcher, Action<string> note, Action healthy,
    Action<PtySize> resized) : ITerminalSurface
{
    private readonly object gate = new();
    private readonly JsonArray pending = [];
    private readonly MemoryStream output = new();
    private TerminalSize size = initial;
    private PtySize? pty;
    private bool scheduled;

    public string Id => id;

    public TerminalSize Size { get { lock (gate) return size; } }

    /// <summary>The PTY's size and owner, as last reported.</summary>
    public PtySize? Pty { get { lock (gate) return pty; } }

    /// <summary>The size that fits the pane; returns whether it changed.</summary>
    public bool SetSize(TerminalSize next)
    {
        lock (gate)
        {
            if (next == size) return false;
            size = next;
            return true;
        }
    }

    public void Reset(TerminalSnapshot snapshot)
    {
        lock (gate) pty = (pty ?? new PtySize(snapshot.Cols, snapshot.Rows)) with { Cols = snapshot.Cols, Rows = snapshot.Rows };
        Post(new JsonObject
        {
            ["type"] = "reset", ["data"] = Convert.ToBase64String(snapshot.Data), ["flags"] = snapshot.KittyKeyboardFlags,
            ["cols"] = snapshot.Cols, ["rows"] = snapshot.Rows
        });
        // A snapshot means the stream is up again, so any earlier warning no longer applies.
        dispatcher.TryEnqueue(() => healthy());
    }

    public void Resized(PtySize next)
    {
        lock (gate)
        {
            // An owner change without a resize keeps the size it had; only the page's layout follows the size.
            var sized = pty is null || pty.Cols != next.Cols || pty.Rows != next.Rows;
            pty = next;
            if (sized) Post(new JsonObject { ["type"] = "pty", ["cols"] = next.Cols, ["rows"] = next.Rows });
        }
        dispatcher.TryEnqueue(() => resized(next));
    }

    public void Write(ReadOnlySpan<byte> bytes)
    {
        lock (gate)
        {
            output.Write(bytes);
            Schedule();
        }
    }

    public void Note(string message) => dispatcher.TryEnqueue(() => note(message));

    /// <summary>Posts a message for this terminal after everything already queued for it.</summary>
    public void Post(JsonObject message)
    {
        message["id"] = id;
        lock (gate)
        {
            TakeOutput();
            pending.Add(message);
            Schedule();
        }
    }

    private void Schedule()
    {
        if (scheduled) return;
        scheduled = true;
        dispatcher.TryEnqueue(Flush);
    }

    private void TakeOutput()
    {
        if (output.Length == 0) return;
        pending.Add(new JsonObject { ["type"] = "output", ["id"] = id, ["data"] = Convert.ToBase64String(output.GetBuffer(), 0, (int)output.Length) });
        output.SetLength(0);
    }

    private void Flush()
    {
        string batch;
        lock (gate)
        {
            TakeOutput();
            scheduled = false;
            if (pending.Count == 0) return;
            batch = new JsonObject { ["type"] = "batch", ["items"] = pending.DeepClone() }.ToJsonString();
            pending.Clear();
        }
        // The window may have closed while this batch waited; its WebView2 is gone then.
        try { web.CoreWebView2?.PostWebMessageAsJson(batch); }
        catch (Exception error) when (error is COMException or ObjectDisposedException or InvalidOperationException) { }
    }
}

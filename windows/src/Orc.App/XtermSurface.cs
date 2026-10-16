using System.Text.Json.Nodes;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml.Controls;
using Orc.Protocol;

namespace Orc.Win;

/// <summary>
/// ITerminalSurface on xterm.js in WebView2. Calls arrive on the connection's thread; they are queued in order and
/// posted to the page as one batch per dispatcher turn, with consecutive output merged.
/// </summary>
internal sealed class XtermSurface(WebView2 web, DispatcherQueue dispatcher, Action<string> note) : ITerminalSurface
{
    private readonly object gate = new();
    private readonly JsonArray pending = [];
    private readonly MemoryStream output = new();
    private TerminalSize size = new(120, 40);
    private bool scheduled;

    public TerminalSize Size { get { lock (gate) return size; } }

    /// <summary>The page fitted the terminal to its pane; returns whether the size changed.</summary>
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
        lock (gate)
        {
            TakeOutput();
            pending.Add(new JsonObject
            {
                ["type"] = "reset", ["data"] = Convert.ToBase64String(snapshot.Data),
                ["flags"] = snapshot.KittyKeyboardFlags, ["cols"] = snapshot.Cols, ["rows"] = snapshot.Rows
            });
            Schedule();
        }
        var flags = snapshot.KittyKeyboardFlags is { } f ? $"kitty keyboard flags {f}" : "no kitty keyboard flags";
        Note(snapshot.IsScrollbackReplay
            ? $"Attached; scrollback loaded ({snapshot.Cols}×{snapshot.Rows} at the host, {flags})."
            : $"Attached ({snapshot.Cols}×{snapshot.Rows} at the host, {flags}); loading scrollback…");
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

    /// <summary>Posts a message after everything already queued.</summary>
    public void Post(JsonObject message)
    {
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
        pending.Add(new JsonObject { ["type"] = "output", ["data"] = Convert.ToBase64String(output.GetBuffer(), 0, (int)output.Length) });
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
        web.CoreWebView2?.PostWebMessageAsJson(batch);
    }
}

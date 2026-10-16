using System.Runtime.InteropServices;
using System.Text;
using Orc.Protocol;

namespace Orc.Spike;

/// <summary>
/// The Windows console in raw VT mode: keys arrive as VT sequences (UTF-16 from ReadConsoleW), output is interpreted as
/// VT. This is the Windows counterpart of `orc attach`'s cfmakeraw. Run it in Windows Terminal for best results.
/// </summary>
internal sealed unsafe partial class WindowsConsole : IDisposable
{
    private const int StdInput = -10, StdOutput = -11;
    private const uint EnableProcessedInput = 0x1, EnableLineInput = 0x2, EnableEchoInput = 0x4, EnableWindowInput = 0x8,
        EnableMouseInput = 0x10, EnableVirtualTerminalInput = 0x200;
    private const uint EnableProcessedOutput = 0x1, EnableVirtualTerminalProcessing = 0x4, DisableNewlineAutoReturn = 0x8;

    private readonly nint input = GetStdHandle(StdInput);
    private readonly nint output = GetStdHandle(StdOutput);
    private readonly uint savedInputMode, savedOutputMode, savedInputCodePage, savedOutputCodePage;
    private readonly Stream stdout;
    private bool restored;

    public WindowsConsole()
    {
        if (!GetConsoleMode(input, out savedInputMode) || !GetConsoleMode(output, out savedOutputMode))
            throw new InvalidOperationException("Attach needs an interactive console. Run it in Windows Terminal, not with redirected input or output.");
        savedInputCodePage = GetConsoleCP();
        savedOutputCodePage = GetConsoleOutputCP();
        SetConsoleCP(65001);
        SetConsoleOutputCP(65001);
        var inputMode = (savedInputMode & ~(EnableProcessedInput | EnableLineInput | EnableEchoInput | EnableWindowInput | EnableMouseInput))
            | EnableVirtualTerminalInput;
        if (!SetConsoleMode(input, inputMode)) throw new InvalidOperationException("Cannot enter raw VT input mode.");
        if (!SetConsoleMode(output, savedOutputMode | EnableProcessedOutput | EnableVirtualTerminalProcessing | DisableNewlineAutoReturn))
            throw new InvalidOperationException("This console does not support VT output. Use Windows Terminal.");
        Console.OutputEncoding = new UTF8Encoding(false);
        stdout = Console.OpenStandardOutput();
    }

    public TerminalSize Size => new(Math.Max(1, Console.WindowWidth), Math.Max(1, Console.WindowHeight));

    public void Write(ReadOnlySpan<byte> bytes)
    {
        stdout.Write(bytes);
        stdout.Flush();
    }

    public void Write(string text) => Write(Encoding.UTF8.GetBytes(text));

    /// <summary>Blocks for the next keystrokes; null when input closed.</summary>
    public string? Read()
    {
        var buffer = stackalloc char[4096];
        if (!ReadConsoleW(input, buffer, 4096, out var read, 0) || read == 0) return null;
        return new string(buffer, 0, (int)read);
    }

    public void Dispose()
    {
        if (restored) return;
        restored = true;
        SetConsoleMode(input, savedInputMode);
        SetConsoleMode(output, savedOutputMode);
        SetConsoleCP(savedInputCodePage);
        SetConsoleOutputCP(savedOutputCodePage);
    }

    [LibraryImport("kernel32.dll")] private static partial nint GetStdHandle(int handle);
    [LibraryImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static partial bool GetConsoleMode(nint handle, out uint mode);
    [LibraryImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static partial bool SetConsoleMode(nint handle, uint mode);
    [LibraryImport("kernel32.dll")] private static partial uint GetConsoleCP();
    [LibraryImport("kernel32.dll")] private static partial uint GetConsoleOutputCP();
    [LibraryImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static partial bool SetConsoleCP(uint codePage);
    [LibraryImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static partial bool SetConsoleOutputCP(uint codePage);
    [LibraryImport("kernel32.dll", EntryPoint = "ReadConsoleW")] [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool ReadConsoleW(nint handle, char* buffer, uint toRead, out uint read, nint control);
}

/// <summary>Keeps the scrollback snapshot of a read-only attach and draws nothing.</summary>
internal sealed class SnapshotSurface : ITerminalSurface
{
    public TaskCompletionSource<TerminalSnapshot> Scrollback { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TerminalSize Size => new(120, 40);
    public void Reset(TerminalSnapshot snapshot) { if (snapshot.IsScrollbackReplay) Scrollback.TrySetResult(snapshot); }
    public void Write(ReadOnlySpan<byte> output) { }
    public void Note(string message) { }
}

/// <summary>The spike's terminal surface: the console itself, cleared and replayed the way `orc attach` does it.</summary>
internal sealed class ConsoleSurface(WindowsConsole console) : ITerminalSurface
{
    private readonly Utf8Carry carry = new();

    public TerminalSize Size => console.Size;

    public void Reset(TerminalSnapshot snapshot)
    {
        carry.Clear();
        // A fresh snapshot may follow an alternate-screen app that exited during a disconnect; its replay selects the screen.
        console.Write("\e[?2026h\e[?1049l\e[0m\e[2J\e[H");
        console.Write(snapshot.Data);
        if (snapshot.KittyKeyboardFlags is { } flags) console.Write($"\e[={flags}u");
        console.Write("\e[?2026l");
    }

    public void Write(ReadOnlySpan<byte> output)
    {
        var complete = carry.Take(output);
        if (complete.Length > 0) console.Write(complete);
    }

    public void Note(string message) => console.Write($"\r\n[orc] {message}\r\n");
}

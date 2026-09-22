#!/usr/bin/env python3
"""Small real raw-mode TUI used by the PTY integration test. Ctrl-X exits."""
import os
import signal
import sys
import termios
import tty

original = termios.tcgetattr(0)
def size(*_):
    dimensions = os.get_terminal_size()
    print(f'\r\n__TUI_SIZE_{dimensions.lines}_{dimensions.columns}__', end='', flush=True)

try:
    tty.setraw(0)
    signal.signal(signal.SIGWINCH, size)
    sys.stdout.write('\x1b[?1049h\x1b[>3u\x1b[2J\x1b[H\x1b[?25l\x1b[?2004h\x1b[32m__TUI_READY__ 🌊 한글\x1b[0m\r\n')
    sys.stdout.flush()
    pending = b''
    while True:
        data = os.read(0, 4096)
        if not data or b'\x18' in data: break
        pending += data
        while b'\r' in pending:
            line, pending = pending.split(b'\r', 1)
            print('\r\n__TUI_INPUT_' + line.hex() + '__', end='', flush=True)
            size()
finally:
    sys.stdout.write('\x1b[<u\x1b[?2004l\x1b[?25h\x1b[?1049l\r\n__TUI_DONE__\r\n')
    sys.stdout.flush()
    termios.tcsetattr(0, termios.TCSANOW, original)

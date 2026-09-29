#!/usr/bin/env python3
"""Drives `orc attach NAME` in a PTY and reports each step as a JSON line.

usage: attach-driver.py ORC NAME
Waits for a line on stdin between the first input and the reconnect, so the caller can stop the runtime.
"""
import fcntl
import json
import os
import pty
import select
import struct
import sys
import termios
import time

orc, name = sys.argv[1], sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.execv(orc, [orc, 'attach', name])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
received = b''


def read_until(marker, timeout):
    global received
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return False
            received += chunk
            if marker in received:
                return True
    return False


def report(step, **fields):
    print(json.dumps({'step': step, **fields}), flush=True)


def type_marker(word):
    # The marker appears only in command output, never in the echoed command line.
    os.write(fd, f"printf 'ORC_%s_OK\\n' {word}\r".encode())


report('snapshot', ok=read_until(b'\x1b[?2026l', 20))
time.sleep(0.5)
received = b''
type_marker('ATTACH')
report('first-input', ok=read_until(b'ORC_ATTACH_OK', 20))
report('ready-for-restart')
sys.stdin.readline()
received = b''
report('reconnecting', ok=read_until(b'Reconnecting', 20))
report('resnapshot', ok=read_until(b'\x1b[?2026l', 60))
time.sleep(0.5)
received = b''
type_marker('AGAIN')
report('second-input', ok=read_until(b'ORC_AGAIN_OK', 20))
os.write(fd, b'\x1d')
_, status = os.waitpid(pid, 0)
report('detached', status=os.waitstatus_to_exitcode(status))

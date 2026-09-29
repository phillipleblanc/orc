#!/usr/bin/env python3
"""Sends a Primary Device Attributes query every 50 ms and records how many replies arrive.

usage: query-counter.py LOG SECONDS
"""
import json
import os
import select
import sys
import time
import tty

log, seconds = sys.argv[1], float(sys.argv[2])
tty.setraw(0)
sent = 0
received = b''


def record():
    with open(log + '.tmp', 'w') as file:
        json.dump({'sent': sent, 'replies': received.count(b'\x1b[?1;2c'), 'other': len(received.replace(b'\x1b[?1;2c', b''))}, file)
    os.rename(log + '.tmp', log)


def drain(duration):
    global received
    end = time.monotonic() + duration
    while True:
        ready, _, _ = select.select([0], [], [], max(0.0, end - time.monotonic()))
        if not ready:
            return
        received += os.read(0, 4096)


deadline = time.monotonic() + seconds
while time.monotonic() < deadline:
    os.write(1, b'\x1b[c')
    sent += 1
    drain(0.05)
    record()
drain(1.5)
record()
time.sleep(3600)

#!/usr/bin/env python3
"""Writes a seeded, randomized stream of terminal output that exercises emulator state, then idles.

usage: vt-stress.py SEED SECONDS
"""
import random
import sys
import time

seed, seconds = int(sys.argv[1]), float(sys.argv[2])
rng = random.Random(seed)
out = sys.stdout
ESC = '\x1b'
CSI = ESC + '['
WORDS = ['alpha', 'beta', 'gamma', '한글', '🌊', 'é', '漢字テスト', 'tab\there', 'δ', '┌─┐', '▓▒░']


def sgr():
    choice = rng.randrange(7)
    if choice == 0:
        return f'{CSI}{rng.choice([30, 31, 32, 33, 34, 35, 36, 37, 90, 97])}m'
    if choice == 1:
        return f'{CSI}38;5;{rng.randrange(256)}m'
    if choice == 2:
        return f'{CSI}38;2;{rng.randrange(256)};{rng.randrange(256)};{rng.randrange(256)}m'
    if choice == 3:
        return f'{CSI}48;2;{rng.randrange(256)};{rng.randrange(256)};{rng.randrange(256)}m'
    if choice == 4:
        return f'{CSI}{rng.choice([1, 2, 3, 4, 5, 7, 8, 9, 53, "4:3"])}m'
    if choice == 5:
        return f'{CSI}0m'
    return ''


def text():
    return ' '.join(rng.choice(WORDS) for _ in range(rng.randrange(1, 12)))


def action():
    kind = rng.randrange(20)
    if kind < 6:
        return sgr() + text() + ('\r\n' if rng.random() < 0.7 else '')
    if kind == 6:
        return f'{CSI}{rng.randrange(1, 40)};{rng.randrange(1, 120)}H' + sgr() + text()
    if kind == 7:
        return rng.choice([f'{CSI}K', f'{CSI}1K', f'{CSI}2K', f'{CSI}J', f'{CSI}1J', f'{CSI}{rng.randrange(1, 9)}X',
                           f'{CSI}{rng.randrange(1, 5)}@', f'{CSI}{rng.randrange(1, 5)}P', f'{CSI}{rng.randrange(1, 4)}L',
                           f'{CSI}{rng.randrange(1, 4)}M', f'{CSI}{rng.randrange(1, 5)}A', f'{CSI}{rng.randrange(1, 5)}B',
                           f'{CSI}{rng.randrange(1, 60)}G'])
    if kind == 8:
        top = rng.randrange(1, 10)
        return f'{CSI}{top};{top + rng.randrange(2, 12)}r' + ''.join(f'{text()}\r\n' for _ in range(rng.randrange(1, 6)))
    if kind == 9:
        return f'{CSI}r'
    if kind == 10:
        entering = rng.random() < 0.5
        frame = ''.join(f'{CSI}{row};{rng.randrange(1, 20)}H{sgr()}│ {text()} │' for row in range(1, rng.randrange(3, 12)))
        return (f'{CSI}?1049h{CSI}H{CSI}2J' + frame) if entering else f'{CSI}?1049l'
    if kind == 11:
        mode = rng.choice([1, 25, 7, 2004, 1000, 1002, 1003, 1006, 1004, 2026, 2031, 66])
        return f'{CSI}?{mode}{rng.choice("hl")}'
    if kind == 12:
        return rng.choice([f'{CSI}>{rng.randrange(0, 32)}u', f'{CSI}<u', f'{CSI}={rng.randrange(0, 32)};1u'])
    if kind == 13:
        return f'{CSI}{rng.randrange(0, 7)} q'
    if kind == 14:
        return rng.choice([f'{ESC}7', f'{ESC}8'])
    if kind == 15:
        return f'{ESC}]2;title {rng.randrange(1000)}\x07'
    if kind == 16:
        return sgr() + ('wrap-' * rng.randrange(20, 60)) + '\r\n'
    if kind == 17:
        return f'{CSI}4{rng.choice("hl")}' + text()
    if kind == 18:
        return f'{CSI}{rng.randrange(1, 30)}S' if rng.random() < 0.5 else f'{CSI}{rng.randrange(1, 30)}T'
    return f'{CSI}{rng.randrange(0, 3)}g\t{text()}'


deadline = time.monotonic() + seconds
while time.monotonic() < deadline:
    out.write(''.join(action() for _ in range(rng.randrange(1, 30))))
    out.flush()
    time.sleep(rng.choice([0, 0.001, 0.005, 0.02]))
out.write(f'{CSI}0m\r\nSTRESS-DONE {seed}\r\n')
out.flush()
time.sleep(3600)

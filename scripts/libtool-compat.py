#!/usr/bin/env python3
"""Preserve Zig archive members that Apple's libtool skips as unaligned.

Feed the Mach-O objects individually to Apple's archiver, which writes the
alignment and symbol index required by the current macOS linker.
"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

args = sys.argv[1:]
if len(args) < 4 or args[:2] != ['-static', '-o']:
    os.execv('/usr/bin/libtool', ['libtool', *args])
with tempfile.TemporaryDirectory(prefix='orc-libtool-') as temp:
    objects = []
    for source in args[3:]:
        data = Path(source).read_bytes()
        if not data.startswith(b'!<arch>\n'):
            objects.append(source)
            continue
        offset = 8
        while offset < len(data):
            header = data[offset:offset + 60]
            assert len(header) == 60 and header[-2:] == b'`\n', 'Invalid static archive header'
            length = int(header[48:58])
            body = data[offset + 60:offset + 60 + length]
            assert len(body) == length, 'Truncated static archive'
            name = header[:16].decode().strip()
            if name.startswith('#1/'):
                name_length = int(name[3:])
                name = body[:name_length].rstrip(b'\0').decode()
                body = body[name_length:]
            if not name.startswith('__.SYMDEF') and name not in ('/', '//', '/SYM64/'):
                path = Path(temp) / f'{len(objects):05d}.o'
                path.write_bytes(body)
                objects.append(str(path))
            offset += 60 + length + length % 2
    subprocess.run(['/usr/bin/libtool', '-static', '-o', args[2], *objects], check=True)

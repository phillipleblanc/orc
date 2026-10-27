#!/usr/bin/env python3
"""Carries connections to sockets in this machine to Orc on the Mac, over this process's standard streams.

Usage: bridge.py USER KIND=PATH...

Each connection to PATH becomes a channel of KIND. Frames carry the channels both ways: a 1-byte type
(1 open, 2 data, 3 end), a 4-byte channel number and a 4-byte payload length, big-endian, then the payload.
An open's payload is the kind. An end means its sender writes no more on that channel; a channel closes
once both sides have ended it. The bridge exits when its standard input closes.
"""
import asyncio
import os
import pwd
import struct
import sys

OPEN, DATA, END = 1, 2, 3
HEADER = struct.Struct('>BII')
CHUNK = 65536


class Bridge:
    def __init__(self, out):
        self.out = out
        self.channels = {}
        self.next_id = 1

    def send(self, kind, channel, payload=b''):
        self.out.write(HEADER.pack(kind, channel, len(payload)) + payload)

    async def accept(self, kind, reader, writer):
        channel = self.next_id
        self.next_id += 1
        state = {'writer': writer, 'local_ended': False, 'remote_ended': False}
        self.channels[channel] = state
        self.send(OPEN, channel, kind.encode())
        try:
            while True:
                data = await reader.read(CHUNK)
                if not data:
                    break
                self.send(DATA, channel, data)
                await self.out.drain()
        except (ConnectionError, OSError):
            pass
        state['local_ended'] = True
        self.send(END, channel)
        self.finish(channel)

    def receive(self, kind, channel, payload):
        state = self.channels.get(channel)
        if not state:
            return
        writer = state['writer']
        if kind == DATA:
            if not writer.is_closing():
                writer.write(payload)
        elif kind == END:
            state['remote_ended'] = True
            if writer.can_write_eof() and not writer.is_closing():
                try:
                    writer.write_eof()
                except OSError:
                    pass
            self.finish(channel)

    def finish(self, channel):
        state = self.channels.get(channel)
        if state and state['local_ended'] and state['remote_ended']:
            del self.channels[channel]
            state['writer'].close()


async def main():
    user = pwd.getpwnam(sys.argv[1])
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=1 << 24)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    transport, protocol = await loop.connect_write_pipe(asyncio.streams.FlowControlMixin, sys.stdout.buffer)
    out = asyncio.StreamWriter(transport, protocol, None, loop)
    bridge = Bridge(out)
    for spec in sys.argv[2:]:
        kind, path = spec.split('=', 1)
        os.makedirs(os.path.dirname(path), mode=0o755, exist_ok=True)
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        await asyncio.start_unix_server(lambda r, w, kind=kind: bridge.accept(kind, r, w), path)
        os.chown(path, user.pw_uid, user.pw_gid)
        os.chmod(path, 0o600)
    while True:
        try:
            header = await reader.readexactly(HEADER.size)
            kind, channel, length = HEADER.unpack(header)
            payload = await reader.readexactly(length) if length else b''
        except asyncio.IncompleteReadError:
            os._exit(0)
        bridge.receive(kind, channel, payload)


asyncio.run(main())

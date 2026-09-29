/**
 * Orca terminal stream frames: a 16-byte little-endian header `0x74, version 1, opcode, 0,
 * u32 streamId, u32 seq high, u32 seq low`, then the payload.
 */
export const Opcode = {
  Output: 1,
  SnapshotStart: 2,
  SnapshotChunk: 3,
  SnapshotEnd: 4,
  Resized: 5,
  Error: 6,
  Input: 7,
  Resize: 8,
  Subscribe: 9,
  Unsubscribe: 10,
  SnapshotRequest: 11,
  Metadata: 12,
  Ack: 13,
  ClaimViewport: 14,
  OutputSpan: 15,
  SetOutputPaused: 16,
  WriteUnavailable: 17
} as const

export type TerminalFrame = { opcode: number; streamId: number; seq: number; payload: Buffer }

export function encodeFrame(opcode: number, streamId: number, seq: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  const frame = Buffer.alloc(16 + payload.length)
  frame.writeUInt8(0x74, 0)
  frame.writeUInt8(1, 1)
  frame.writeUInt8(opcode, 2)
  frame.writeUInt32LE(streamId, 4)
  frame.writeUInt32LE(Math.floor(seq / 0x100000000), 8)
  frame.writeUInt32LE(seq >>> 0, 12)
  frame.set(payload, 16)
  return frame
}

export function decodeFrame(bytes: Buffer): TerminalFrame | null {
  if (bytes.length < 16 || bytes[0] !== 0x74 || bytes[1] !== 1) return null
  return {
    opcode: bytes[2],
    streamId: bytes.readUInt32LE(4),
    seq: bytes.readUInt32LE(8) * 0x100000000 + bytes.readUInt32LE(12),
    payload: bytes.subarray(16)
  }
}

export function jsonPayload(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value))
}

/** Splits text into UTF-8 payloads of at most `limit` bytes without splitting a code point. */
export function* textPayloads(text: string, limit = 64 * 1024): Generator<Buffer> {
  const bytes = Buffer.from(text, 'utf8')
  let start = 0
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + limit)
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    yield bytes.subarray(start, end)
    start = end
  }
}

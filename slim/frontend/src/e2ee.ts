import { randomBytes } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import nacl from 'tweetnacl'

export type ServerKeypair = { publicKey: Uint8Array; secretKey: Uint8Array }

/** The runtime's static Curve25519 identity, `<profile>/orca-e2ee-keypair.json`; clients pin its public key. */
export async function loadOrCreateKeypair(profile: string): Promise<ServerKeypair> {
  const path = join(profile, 'orca-e2ee-keypair.json')
  try {
    const stored = JSON.parse(await readFile(path, 'utf8')) as { v: number; publicKeyB64: string; secretKeyB64: string }
    return { publicKey: Buffer.from(stored.publicKeyB64, 'base64'), secretKey: Buffer.from(stored.secretKeyB64, 'base64') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const pair = nacl.box.keyPair()
  const record = { v: 1, publicKeyB64: Buffer.from(pair.publicKey).toString('base64'), secretKeyB64: Buffer.from(pair.secretKey).toString('base64') }
  await writeFile(`${path}.tmp`, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
  await rename(`${path}.tmp`, path)
  return pair
}

/**
 * Orca E2EE v1 framing: `nonce(24) || crypto_box_afternm(message)` with a fresh random nonce per
 * message. Text frames carry it base64 encoded; binary frames carry the raw bytes.
 */
export class E2EEChannel {
  private readonly shared: Uint8Array

  constructor(clientPublicKey: Uint8Array, serverSecretKey: Uint8Array) {
    this.shared = nacl.box.before(clientPublicKey, serverSecretKey)
  }

  seal(message: Uint8Array): Buffer {
    const nonce = randomBytes(nacl.box.nonceLength)
    return Buffer.concat([nonce, nacl.box.after(message, nonce, this.shared)])
  }

  open(bundle: Uint8Array): Buffer | null {
    if (bundle.length < nacl.box.nonceLength + nacl.box.overheadLength) return null
    const opened = nacl.box.open.after(bundle.subarray(nacl.box.nonceLength), bundle.subarray(0, nacl.box.nonceLength), this.shared)
    return opened ? Buffer.from(opened) : null
  }
}

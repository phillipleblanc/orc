import { networkInterfaces } from 'node:os'
import { pairingLink, type Devices } from './devices.ts'
import type { ServerKeypair } from './e2ee.ts'
import { RpcError, type Handlers } from './rpc-server.ts'
import type { WebSocketRpcServer } from './websocket-server.ts'

export type Address = { name: string; address: string }

/** This host's IPv4 addresses a phone could reach: LAN interfaces and Tailscale. */
export function reachableAddresses(): Address[] {
  const result: Address[] = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) result.push({ name, address: entry.address })
    }
  }
  return result
}

function isTailscale(address: string): boolean {
  const [first, second] = address.split('.').map(Number)
  return first === 100 && second >= 64 && second <= 127
}

/**
 * `orc.phone.*`, served only on the owner-authenticated local socket: phones never administer
 * pairing. Offers use mobile scope and a direct endpoint on the chosen address; the WebSocket
 * listens on every interface.
 */
export function phonePairingHandlers(options: { runtimeId: string; devices: Devices; keypair: ServerKeypair; websocket: WebSocketRpcServer }): Handlers {
  const { runtimeId, devices, keypair, websocket } = options
  const reply = (body: Record<string, unknown>) => ({ schemaVersion: 1, runtimeId, ...body })
  const phones = () => devices.all().filter((device) => device.scope === 'mobile')
  return {
    'orc.phone.status': () => {
      const interfaces = reachableAddresses()
      const preferred = interfaces.find((entry) => isTailscale(entry.address)) ?? interfaces[0]
      return reply({
        interfaces,
        defaultAddress: preferred?.address ?? null,
        devices: phones().map(({ deviceId, name, pairedAt, lastSeenAt }) => ({ deviceId, name, pairedAt, lastSeenAt }))
      })
    },

    'orc.phone.create': async (params) => {
      const address = typeof params.address === 'string' ? params.address : ''
      if (!reachableAddresses().some((entry) => entry.address === address)) throw new RpcError('invalid_argument', 'choose an address of this host')
      const unused = phones().filter((device) => device.lastSeenAt === 0)
      if (params.rotate === true) for (const device of unused) await devices.revoke(device.deviceId)
      const device = params.rotate === true || unused.length === 0 ? await devices.create('mobile', 'Phone') : unused[0]
      const endpoint = `ws://${address}:${websocket.port}`
      const publicKeyB64 = Buffer.from(keypair.publicKey).toString('base64')
      return reply({
        pairingUrl: pairingLink({ endpoint, deviceToken: device.token, publicKeyB64, scope: 'mobile', pairedDeviceId: device.deviceId }),
        endpoint, deviceId: device.deviceId, scope: 'mobile'
      })
    },

    'orc.phone.revoke': async (params) => {
      const deviceId = typeof params.deviceId === 'string' ? params.deviceId : ''
      const revoked = phones().some((device) => device.deviceId === deviceId) && await devices.revoke(deviceId)
      if (revoked) websocket.disconnectDevice(deviceId)
      return reply({ revoked })
    }
  }
}

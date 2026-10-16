import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { promisify } from 'node:util'
import { deviceKind, pairingLink, type Devices } from './devices.ts'
import type { ServerKeypair } from './e2ee.ts'
import { reachableAddresses } from './phone-pairing.ts'
import { RpcError, type Handlers } from './rpc-server.ts'
import type { WebSocketRpcServer } from './websocket-server.ts'

const MAX_NAME = 64

/** This host's names on the local network (`NAME.local`, by multicast DNS), which outlast its DHCP addresses. */
export async function localHostnames(): Promise<string[]> {
  let name = ''
  if (process.platform === 'darwin') {
    name = (await promisify(execFile)('/usr/sbin/scutil', ['--get', 'LocalHostName']).then((result) => result.stdout, () => '')).trim()
  }
  name ||= hostname().replace(/\.local$/, '').split('.')[0]
  return /^[A-Za-z0-9-]+$/.test(name) ? [`${name}.local`] : []
}

/**
 * `orc.desktop.*`, served only on the owner-authenticated local socket: computers never administer pairing. A
 * computer gets a runtime-scope grant of kind `desktop`, named after it, with a direct endpoint on one of this host's
 * addresses or local names. A computer's grant can do anything Orc.app can.
 */
export function desktopPairingHandlers(options: { runtimeId: string; devices: Devices; keypair: ServerKeypair; websocket: WebSocketRpcServer }): Handlers {
  const { runtimeId, devices, keypair, websocket } = options
  const reply = (body: Record<string, unknown>) => ({ schemaVersion: 1, runtimeId, ...body })
  const desktops = () => devices.all().filter((device) => deviceKind(device) === 'desktop')
  return {
    'orc.desktop.status': async () => {
      const interfaces = reachableAddresses()
      const hostnames = await localHostnames()
      const connected = websocket.connectedDevices()
      return reply({
        interfaces,
        hostnames,
        defaultAddress: hostnames[0] ?? interfaces[0]?.address ?? null,
        devices: desktops().map(({ deviceId, name, pairedAt, lastSeenAt }) => ({ deviceId, name, pairedAt, lastSeenAt, connected: connected.has(deviceId) }))
      })
    },

    'orc.desktop.create': async (params) => {
      const address = typeof params.address === 'string' ? params.address : ''
      if (!reachableAddresses().some((entry) => entry.address === address) && !(await localHostnames()).includes(address)) {
        throw new RpcError('invalid_argument', 'choose an address or local name of this host')
      }
      const name = typeof params.name === 'string' ? params.name.trim() : ''
      if (!name || name.length > MAX_NAME || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
        throw new RpcError('invalid_argument', `name the computer, in at most ${MAX_NAME} characters`)
      }
      // An unused grant for the same computer is offered again; rotating replaces it.
      const unused = desktops().filter((device) => device.lastSeenAt === 0 && device.name === name)
      if (params.rotate === true) for (const device of unused) await devices.revoke(device.deviceId)
      const device = params.rotate === true || unused.length === 0 ? await devices.create('runtime', name, 'desktop') : unused[0]
      const endpoint = `ws://${address}:${websocket.port}`
      const publicKeyB64 = Buffer.from(keypair.publicKey).toString('base64')
      return reply({
        pairingUrl: pairingLink({ endpoint, deviceToken: device.token, publicKeyB64, scope: 'runtime', pairedDeviceId: device.deviceId }),
        endpoint, deviceId: device.deviceId, name: device.name, scope: 'runtime'
      })
    },

    'orc.desktop.revoke': async (params) => {
      const deviceId = typeof params.deviceId === 'string' ? params.deviceId : ''
      const revoked = desktops().some((device) => device.deviceId === deviceId) && await devices.revoke(deviceId)
      if (revoked) websocket.disconnectDevice(deviceId)
      return reply({ revoked })
    }
  }
}

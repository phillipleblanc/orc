import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonFile } from './json-file.ts'

export type DeviceScope = 'runtime' | 'mobile'
export type Device = { deviceId: string; name: string; token: string; scope: DeviceScope; pairedAt: number; lastSeenAt: number }

/** Paired clients and their access tokens, `<profile>/orca-devices.json`. */
export class Devices {
  private readonly file: string
  private devices: Device[] = []

  constructor(profile: string) {
    this.file = join(profile, 'orca-devices.json')
  }

  async load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.file, 'utf8'))
      this.devices = Array.isArray(stored) ? stored : Array.isArray(stored.devices) ? stored.devices : []
    } catch {
      this.devices = []
    }
  }

  find(token: string): Device | undefined {
    const candidate = Buffer.from(token)
    return this.devices.find((device) => {
      const stored = Buffer.from(device.token)
      return stored.length === candidate.length && timingSafeEqual(stored, candidate)
    })
  }

  list(): Omit<Device, 'token'>[] {
    return this.devices.map(({ token: _token, ...device }) => device)
  }

  all(): Device[] {
    return [...this.devices]
  }

  async create(scope: DeviceScope, name: string): Promise<Device> {
    const device: Device = { deviceId: randomUUID(), name, token: randomBytes(24).toString('hex'), scope, pairedAt: Date.now(), lastSeenAt: 0 }
    this.devices.push(device)
    await this.save()
    return device
  }

  async revoke(deviceId: string): Promise<boolean> {
    const before = this.devices.length
    this.devices = this.devices.filter((device) => device.deviceId !== deviceId)
    await this.save()
    return this.devices.length !== before
  }

  async seen(device: Device): Promise<void> {
    device.lastSeenAt = Date.now()
    await this.save()
  }

  private async save(): Promise<void> {
    await writeJsonFile(this.file, { devices: this.devices })
  }
}

/** `orca://pair?code=<base64url(JSON)>`, the link format Orc and the mobile app accept. */
export function pairingLink(offer: { endpoint: string; deviceToken: string; publicKeyB64: string; scope: DeviceScope; pairedDeviceId?: string }): string {
  return `orca://pair?code=${Buffer.from(JSON.stringify({ v: 2, ...offer })).toString('base64url')}`
}

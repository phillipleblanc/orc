import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { RpcError, type Handlers } from './rpc-server.ts'

/** Advertised in `status.get` when the page is present; the Orca phone app shows a host without it as too old. */
export const MOBILE_WEB_BUNDLE_CAPABILITY = 'mobileWeb.bundle.v1'

// The Orca phone app's contract for a host-served page (src/shared/mobile-web-bundle in Orca).
const CHUNK_BYTES = 48 * 1024
const ENTRYPOINT = 'index.html'
const MAX_ASSET_BYTES = 10 << 20
const MAX_TOTAL_BYTES = 32 << 20
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8'
}
/** The app opens the page for its home screen and for any screen below it; the page draws a wide layout's sidebar too. */
const ROUTES = [
  { pathname: '/h/[hostId]', grants: [], optionalGrants: ['navigate', 'externalLink', 'haptics'], canOwnHostArea: true },
  { pathname: '/h/[hostId]/[...page]', grants: [], optionalGrants: ['navigate', 'externalLink', 'haptics'], canOwnHostArea: true }
]

type Asset = { path: string; sha256: string; byteLength: number; contentType: string }

/**
 * Orc's page for the Orca phone app, from `build/phone`: the app downloads it with `mobileWeb.bundle.manifest` and
 * `mobileWeb.bundle.chunk`, checks every file's hash, and runs it in a web view whose calls reach this runtime as the
 * phone's. The files are read once, when the frontend starts.
 */
export class PhonePage {
  private readonly files = new Map<string, Buffer>()
  private manifest: Record<string, unknown> | null = null

  static async load(directory: string, version: string): Promise<PhonePage> {
    const page = new PhonePage()
    const paths = await listFiles(directory).catch((): string[] => [])
    if (!paths.includes(ENTRYPOINT)) return page
    const assets: Asset[] = []
    for (const path of paths.sort()) {
      const type = CONTENT_TYPES[extname(path)]
      if (!type || path === 'manifest.json' || !path.split('/').every((segment) => PATH_SEGMENT.test(segment) && segment !== '.' && segment !== '..')) continue
      const bytes = await readFile(join(directory, path))
      if (bytes.length > MAX_ASSET_BYTES) continue
      page.files.set(path, bytes)
      assets.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, contentType: type })
    }
    const totalBytes = assets.reduce((sum, asset) => sum + asset.byteLength, 0)
    if (totalBytes > MAX_TOTAL_BYTES) return new PhonePage()
    page.manifest = {
      schemaVersion: 1,
      buildId: createHash('sha256').update(JSON.stringify(assets)).digest('hex'),
      desktopVersion: `Orc ${version}`.slice(0, 64),
      minCompatibleRuntimeProtocolVersion: 2,
      runtimeProtocolVersion: 3,
      pageVersion: 1,
      entrypoint: ENTRYPOINT,
      totalBytes,
      assets,
      routes: ROUTES
    }
    return page
  }

  get available(): boolean { return this.manifest !== null }

  handlers(): Handlers {
    return {
      'mobileWeb.bundle.manifest': () => {
        if (!this.manifest) throw new RpcError('invalid_argument', 'mobile_web_bundle_unavailable')
        return { manifest: this.manifest, chunkBytes: CHUNK_BYTES }
      },
      'mobileWeb.bundle.chunk': (params) => {
        const manifest = this.manifest
        if (!manifest) throw new RpcError('invalid_argument', 'mobile_web_bundle_unavailable')
        if (params.buildId !== manifest.buildId) throw new RpcError('invalid_argument', 'mobile_web_bundle_build_changed')
        const asset = (manifest.assets as Asset[]).find((candidate) => candidate.path === params.path)
        if (!asset) throw new RpcError('invalid_argument', 'mobile_web_bundle_asset_unknown')
        const offset = params.offset
        if (!Number.isInteger(offset) || offset < 0 || offset % CHUNK_BYTES !== 0 || (offset > 0 && offset >= asset.byteLength)) {
          throw new RpcError('invalid_argument', 'mobile_web_bundle_offset_invalid')
        }
        const data = this.files.get(asset.path)!.subarray(offset, offset + CHUNK_BYTES)
        return {
          buildId: manifest.buildId, path: asset.path, offset, assetByteLength: asset.byteLength, sha256: asset.sha256,
          eof: offset + CHUNK_BYTES >= asset.byteLength, dataBase64: data.toString('base64')
        }
      }
    }
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'))
}

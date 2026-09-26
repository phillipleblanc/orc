# Pinned Orca runtime builds

`orca.lock.json` pins the upstream macOS arm64 release and the inputs for an Orc-managed source build: source commit, dependency locks, Node, pnpm, Xcode/SDK versions, patches, packaging configuration, signing identity, and license provenance. Its `development-bundle` purpose does not qualify a runtime for public distribution. The normal build includes the complete signed runtime; the installer verifies both bundles without downloading anything.

## Source build

The build requires Python 3.12+, the Xcode/SDK version in the lock, and its Apple Development signing identity in the local keychain. Node and pnpm are fetched into the verified cache. Every build uses a fresh source extraction, applies checksum-verified patches without fuzz, runs the runtime tests and typecheck, and builds the complete upstream desktop, native, and mobile web resources. Dependency notices and Electron's Chromium notices are collected into the inner app before signing.

```sh
python3 scripts/build-orca-runtime.py
python3 scripts/build-orca-runtime.py --offline
bash scripts/build.sh --offline
python3 scripts/package-orc.py dist/Orc.app
python3 scripts/probe-orca-runtime.py dist/Orc.app \
  --report .build/orca-runtime/app-probe.json
```

Build logs and source trees are kept under `.build/orca-runtime/work/`. Completed runtimes are cached as archives with a receipt keyed by the locked inputs. The runtime builder's `--offline` reuses a completed archive after verifying its checksum, signing identity, sealed resources, and signed source provenance; it fails if the cache is missing or invalid and does not run dependency installers. The full Orc build additionally needs prepared Ghostty/libsodium dependencies and npm's verified offline cache. Changing any locked runtime build input requires another source build.

Dependency notices are collected under `desktop/` and `mobile/` without `node_modules` path components, which electron-builder excludes from extra resources. Packaging checks the complete collected file count before publishing the build receipt. Installation checks that count, the MIT/Electron notices, the recipe, and both app signatures.

The source runtime has the bundle identifier `dev.phillipleblanc.orc.runtime`. Its bundle name, packaged `productName`, and pre-ready Electron application name are all `Orc Runtime`, giving macOS safeStorage a separate Keychain service name. Electron helper names must match the bundle name. It is built with `LSUIElement` and sets the accessory activation policy before runtime initialization. It only accepts serve launches, disables desktop presentation, and exposes the existing manual-update status while rejecting updater mutations. Orc application updates own the runtime version.

A source runtime requires an explicit `ORCA_USER_DATA_PATH` and a regular `orc-runtime-profile.json` ownership file with schema version `1`, its bundle identifier, and the matching runtime version. Orc creates these only for an empty profile after verifying the bundle. Its default profile is `ORC_CONFIG_DIR/runtime` (normally `~/.config/orc/runtime`). Missing ownership, a version mismatch, or a conflicting `--user-data-dir` causes startup to fail. Existing Orca profiles require an explicit migration flow; a different signing identity cannot assume access to their encrypted state.

Orc resolves the inner app from its actual executable path, including symlinked CLIs. It authenticates a compatible running runtime before resolving a launch executable. Cold startup verifies signatures, sealed resources, architecture, version, and recipe before creating a profile. Fresh local access is captured through a private stdout pipe; stderr alone reaches `backend.log` during pairing. The readiness scope, runtime ID, endpoint, and public key must match the selected runtime before the owner-only, profile-bound connection is saved. An interrupted setup never causes Orc to restart a live runtime.

The resolved profile path must fit within 75 UTF-8 bytes to leave room for the runtime's macOS Unix socket names. Choose a shorter `ORC_CONFIG_DIR` or `ORCA_USER_DATA_PATH` if startup reports that the path is too long.

The phone patch adds `orc.phone.status`, `orc.phone.create`, and `orc.phone.revoke` only to authenticated local socket dispatch. These methods are absent from the WebSocket RPC registry; neither mobile grants nor remote runtime grants can administer pairing. Status returns addresses and mobile grant metadata without tokens. Creation validates an address on this host and calls the upstream mobile pairing implementation with `local-only` connection mode. Revocation calls the upstream mobile revoker, including active connection teardown. Replies include schema version and runtime identity; Orc validates the offer's mobile scope, device ID, endpoint, and server key before displaying it. Completion pushes are not dispatched by the upstream headless serve startup path.

The bundled CLI resolves its nearest enclosing app so nested helper paths work. Serve startup does not register an `orca` command globally; terminal children reach the runtime's own CLI through its bundled `Resources/bin` directory.

The Codex launch default is `codex --no-daemon`, including workers and resumes built from that default. Codex tool processes inherit that session's terminal environment. Explicit agent command overrides remain authoritative; structured Codex workers already start a dedicated `codex app-server` directly.

The locked signing identity is for local development. Developer ID signing, notarization, and clean-machine Gatekeeper validation are required for distribution.

## Upstream comparison

Use an Apple Silicon Mac with Xcode command-line tools, Python, and a signed Orc host that has no nested runtime:

```sh
python3 scripts/orca_runtime.py fetch
python3 scripts/orca_runtime.py --offline stage-spike \
  --host-app /absolute/path/to/unbundled/Orc.app \
  --output .build/orca-runtime/spike/Orc.app
python3 scripts/probe-orca-runtime.py .build/orca-runtime/spike/Orc.app \
  --report .build/orca-runtime/spike-report.json
```

Choose a new output directory and report name for each experiment. Staging refuses to overwrite or merge into an existing bundle. `--cache PATH` selects a cache directory. `--offline` prohibits downloads and requires each cached input to match its locked SHA-256. Corrupt cache entries fail verification even in online mode; remove the named entry explicitly before fetching it again. `fetch --source` caches the pinned source archive for source-build work.

Staging extracts the complete runtime archive and copies `Orca.app` into `Contents/Helpers/Orca.app`. It preserves frameworks, native modules, resources, and packaged notices. The MIT notice, lock, and runtime origin are included in Orc's resources. Version, architecture, strict recursive signature checks, and the Apple certificate requirement must pass before the candidate is staged. The outer Orc app is signed ad hoc for local experiments; the inner app keeps its verified signature. Both signatures are checked after packaging. Release archives, extracted source, app bundles, and measurements belong under ignored `.build/` directories or outside the repository.

## Probe and qualification

The probe verifies both bundles, then invokes the staged `orc status --json` with an explicit `ORCA_APP_EXECUTABLE` and fresh owner-only runtime and client directories. This exercises Orc's detached startup path, including automatic access for a source runtime. It waits for the first CLI to exit, then authenticates a second status request with an invalid executable override so a relaunch cannot disguise backend failure. For source builds, it also verifies that the live updater reports manual management and rejects check, download, and install requests. It verifies the runtime signature after shutdown. Cleanup sends SIGTERM only to the candidate processes recorded in the probe's private directories. If the probe fails or cleanup cannot confirm termination, it retains the private diagnostics and prints their path.

Activation policy is observed through NSWorkspace launch notifications, KVO, and five-millisecond polling. A regular activation policy fails the probe even if the app later becomes an accessory. The JSON report contains timings, size, activation-policy transitions, and lifecycle results; it excludes runtime metadata, credentials, and backend output. Policy values are `0` (regular), `1` (accessory), and `2` (prohibited). Exit codes are `0` for a passing probe, `1` for unmet behavior, and `2` for a probe error. A passing automated observation also needs visual cold-start checks for a transient Dock icon and the application switcher.

Runtime qualification follows the [bundled-runtime plan](../docs/bundled-orca-runtime-plan.md): serve must stay accessory from startup, runtime updates must be disabled, license coverage must be complete, and the profile/signing model must be established. `scripts/e2e-bundled.py` uses a disposable offline installation to exercise bootstrap, project registration, encrypted attachment, profile guards, and restarts. Fully disconnected operation, physical phone pairing, visual Dock checks, profile migration, and distribution signing/notarization require their separate acceptance tests. Editing or ad-hoc re-signing the downloaded Orca app cannot qualify it.

Run the packaging tests with:

```sh
python3 -m unittest discover -s scripts/tests -v
```

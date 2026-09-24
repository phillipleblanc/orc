# Bundle the Orca runtime with Orc

## Goal

An installed `Orc.app` and its `orc` CLI can list, create, rename, attach to, and chat with sessions without a separately installed `Orca.app`. The official Orca mobile app can pair with and control those sessions. The runtime remains upstream Orca, launched in `serve` mode; Orca's source and any separately installed Orca app remain unmodified.

The deliverable is a self-contained Orc application bundle. The source repository contains a version lock, packaging code, and license notices, but not a large release archive or unpacked Electron app. Building Orc stages the pinned runtime into the distributable app, and running Orc never downloads a runtime.

## Packaging boundary

The macOS `serve` entry point runs from Orca's Electron application bundle. Package the complete, signed upstream `Orca.app` inside `Orc.app/Contents/Helpers/Orca.app` for the first deliverable. Do not copy only `Contents/MacOS/Orca`: the executable needs its frameworks, native modules, and resources. Do not prune renderer or updater files without an upstream-supported headless artifact and an end-to-end proof that those files are unused.

`serve` means no Orca window, not necessarily an invisible macOS process. Upstream macOS builds can still show an Orca Dock icon in serve mode. Do not modify the signed inner app's `Info.plist` or re-sign it ad hoc to hide that icon; a truly accessory-mode process needs upstream support or a separately signed source build.

Add a runtime lock manifest with the upstream tag, source commit, macOS architecture, release-asset URL and SHA-256, expected bundle identifier and signing identity, and license provenance. A build script downloads or uses a cached copy of that exact asset, verifies its hash and signature, and stages it without modifying the inner bundle. Keep the staged archive outside version control. Fail the build when the pinned asset cannot be obtained or verified; support an explicit offline build from a verified cache.

Copy the inner app before signing Orc. Verify both signatures after packaging, including the inner app's sealed resources, and validate a distributed build through Gatekeeper/notarization on a clean Mac. Orc's current ad-hoc signing is adequate for local development; public binary distribution needs its own signing and notarization workflow. Include Orca's MIT notice and the packaged third-party notices in the distributable.

## Runtime selection and lifecycle

Keep the selected `ORCA_USER_DATA_PATH` profile and Orca runtime metadata as the authority for session identity, saved names, and phone pairing:

1. Authenticate and reuse an already-running runtime for that profile, whether started by a separately installed Orca app or the bundled copy.
2. If none is running, launch the bundled executable with the existing detached `serve` process path and startup lock. Resolve it from the actual Orc app bundle location for both the GUI and a symlinked CLI, not from the working directory.
3. Retain `ORCA_APP_EXECUTABLE` as an explicit development/test override. A separately installed Orca executable is not required for normal operation.
4. Leave the runtime running when Orc or its CLI exits. Never kill a live runtime to switch executable versions, and never replay a creation or input request whose result is uncertain.

Before a bundled version first opens an existing profile, check version and protocol compatibility, make a private rollback copy of the quiescent profile if a migration may occur, and refuse a known downgrade. Exercise the official Orca GUI opening while the bundled process owns the same profile: Orca's single-instance handoff must preserve the sessions and not unexpectedly replace the running binary. If that behavior cannot be made safe, use a separate Orc-managed profile with an explicit migration and phone re-pairing flow rather than silently splitting the session list.

Pin runtime upgrades to Orc releases tested with Orc's required `terminal.binary-stream.v1`, `terminal.multiplex.v1`, session, and native-chat APIs. A packaged runtime must not update or rewrite itself independently of an Orc update. Confirm that `serve` does not do so; if it does, use an upstream-supported disablement or a source-built pinned runtime before shipping.

## First-run access and mobile pairing

Orc's existing `connection.json` remains usable when it belongs to the selected profile. A fresh installation has no access link and no Orca Settings window, so bootstrap must mint one from the bundled runtime's documented `serve --json` pairing output. Capture the one-time result through a private pipe, verify its runtime scope, endpoint, and server key, then save it with the existing owner-only configuration permissions. Never print the link or write it to `backend.log`. Subsequent unattended starts can use `--serve-no-pairing` once access is configured.

A fresh profile also has no registered projects. Add project registration to Orc's app and CLI, backed by the bundled runtime's supported API or packaged Orca CLI. The configured default project must resolve to a registered project before `orc new` runs; offer an import path instead of assuming `spiceai-project` exists.

Provide a separate **Pair Phone** flow for the official Orca mobile app. Use Orca's documented `serve --mobile-pairing` behavior and a reachable LAN or Tailscale address; a loopback address is only suitable for Orc's local access link. Determine and test how to issue a new mobile grant while a runtime with live sessions is already running. Do not restart that runtime merely to display another QR code. If upstream has no supported live pairing operation, this is a release blocker for the promised mobile experience.

Check completion push notifications separately from phone pairing and interactive access. Upstream documents that its Linux headless server does not send completion pushes because that detector runs in the desktop renderer; verify macOS serve behavior and record any remaining limitation in user-facing setup documentation.

## Implementation sequence

1. **Packaging spike:** stage a pinned upstream macOS arm64 release inside a disposable Orc build. Prove `serve` starts from the nested path, both code signatures verify, no Orca desktop window opens, and the process survives Orc exiting. Inspect Dock behavior and record packaged size and startup time outside this plan.
2. **Build integration:** add the lock manifest, verified fetch/cache script, bundle copy, license collection, signing checks, and release artifact checks. Ensure `scripts/install.sh` installs the complete bundle and works offline.
3. **Bootstrap integration:** change `RuntimeStarter.resolveExecutable()`, first-run pairing, and project registration, preserving its existing concurrency lock, runtime-ID checks, startup backoff, and uncertainty handling. Show actionable errors for an absent, corrupt, incompatible, or untrusted bundled runtime.
4. **Phone setup:** add the mobile pairing UI/CLI path and verify the official phone app against the bundled host. Keep runtime access credentials and mobile device grants separate.
5. **Upgrade path:** pin a tested runtime update, validate profile migration/rollback and official Orca coexistence, then document how to update the lock and repeat the compatibility suite.

## Acceptance tests

- On a clean supported Apple Silicon Mac with no Orca installation and no network after installation, Orc can register a project, then `orc list`, `orc new`, `orc attach`, rename, notes, and the native app's terminal and chat views work. Sessions and names survive closing Orc, reopening it, and a controlled backend restart.
- Codex and Pi sessions report activity; their chat histories and Pi `/notes` and `/name` integrations work through the bundled runtime.
- The official mobile app pairs with the bundled host, lists the same named sessions, displays terminal/chat output, sends input, and reconnects after Orc's UI closes. New mobile pairing remains possible while other sessions are live.
- With a separately installed Orca already running, Orc reuses it without changing its app or session ownership. Launching the official GUI while a bundled runtime is running does not lose sessions or corrupt the profile.
- Concurrent CLI and GUI cold starts launch one backend. An invalid signature, hash, unsupported architecture, incompatible protocol, or unsafe profile downgrade fails before launching or mutating the profile.
- A clean-machine distributed install passes code-signature, Gatekeeper, and notarization checks; no secret appears in logs, command output, build artifacts, or the public repository.

## Upstream references

- [Orca `serve` and mobile pairing](https://www.onorca.dev/docs/remote-servers)
- [Headless server limitations](https://github.com/stablyai/orca/blob/main/docs/reference/headless-linux-server.md) and [macOS Dock behavior](https://github.com/stablyai/orca/issues/16061)
- [Orca build scripts](https://github.com/stablyai/orca/blob/main/package.json) and [macOS packaging configuration](https://github.com/stablyai/orca/blob/main/config/electron-builder.config.cjs)
- [Orca license](https://github.com/stablyai/orca/blob/main/LICENSE)

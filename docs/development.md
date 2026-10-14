# Development

## Build and install

Requires Apple Silicon, macOS 14+, Python 3.12+, npm, and Xcode with the macOS SDK. Install the Metal component if necessary:

```sh
xcodebuild -downloadComponent MetalToolchain
bash scripts/build.sh
bash scripts/install.sh
open /Applications/Orc.app
```

Build downloads checksum-pinned Zig 0.15.2, Ghostty 1.3.1, libsodium 1.0.22, and Node.js 24.21.0 into `.build/deps`, and installs the locked Markdown renderer dependencies in `WebMarkdown`. It builds libghostty and the session holder, bundles the runtime (Node.js, the frontend with its production dependencies, and the holder), and signs `dist/Orc.app` ad hoc. Installation verifies and atomically replaces the bundle at `/Applications/Orc.app`, links `~/.local/bin/orc`, and restarts the runtime frontend so the new version serves the existing sessions; sessions keep running. Reopen Orc to load the updated interface. Pi extensions are included in the app. Homebrew libraries and a system Node.js are not required at runtime.

Use `bash scripts/build.sh --offline` with prepared native dependencies and npm cache. `bash scripts/install.sh --offline` installs an existing bundle without building or downloading. `ORC_INSTALL_ROOT` selects an alternate installation root for testing, placing the app in `$ORC_INSTALL_ROOT/Applications` and user files under that same root. This development signing configuration is not a notarized public distribution.

For CLI-only development:

```sh
bash scripts/bootstrap-sodium.sh
ORC_CLI_ONLY=1 swift build --product orc
ORC_CLI_ONLY=1 swift test
```

The Ghostty build creates a private SDK overlay to normalize arm64e TBD entries for Zig 0.15 and repacks Zig archive members before Apple's `libtool` indexes them. It leaves Xcode's SDK untouched. Builds produce an arm64 application for this Mac; release signing/notarization and Intel builds are separate distribution work.

### App icon

The app icon's source is `Resources/AppIcon.icon`, an Icon Composer document with default and dark appearances; open it in Icon Composer, which comes with Xcode. The build compiles it with `actool`. After editing it, render the README's image:

```sh
"$(xcode-select -p)/../Applications/Icon Composer.app/Contents/Executables/ictool" "$PWD/Resources/AppIcon.icon" \
  --export-image --output-file "$PWD/Resources/AppIcon.png" --platform macOS --rendition Default --width 512 --height 512 --scale 1
```

## Architecture and compatibility

`OrcKit` contains session models, local RPC, NaCl-authenticated WebSocket streaming, and terminal attachment. Both frontends use the same session service. Each libghostty surface launches the app's bundled `orc attach` in a local PTY. Ghostty 1.3.1 rebuilds a new surface's configuration from its files when the configuration's light/dark state differs from the app's, which drops the surface's command, so Orc applies the configuration again whenever the appearance changes; libghostty handles rendering, input, selection, scrolling, and clipboard operations. The PTY belongs to the session's holder in the runtime, described in [slim/README.md](../slim/README.md).

The runtime speaks Orca's protocols so the Orca mobile app works unmodified; Orc requires its `terminal.binary-stream.v1`, `terminal.multiplex.v1`, and `orc.agents.v1` capabilities. These are internal protocols, not a stable third-party SDK. Ghostty's full embedding API is also pinned rather than assumed stable.

`ORC_CONFIG_DIR` selects Orc's configuration, credentials, and default runtime profile; `ORC_RUNTIME_DIR` selects another runtime profile. `ORC_RUNTIME_EXECUTABLE` is a development override for the runtime executable, which Orc starts with `--profile DIR`. The WebSocket endpoint follows the runtime's metadata, while the saved server public key pins its identity.

## Tests

`swift test` runs unit tests and skips live ones. `npm --prefix slim/frontend test` runs the runtime's suite; see [slim/README.md](../slim/README.md) for its opt-in agent tests. `python3 -m unittest discover -s scripts/tests` covers the build and install scripts.

Run `npm --prefix WebMarkdown ci` and `npm --prefix WebMarkdown test` for Markdown renderer tests. `npm --prefix WebMarkdown run build` bundles the Markdown view for native app development. Build these assets before `swift test` to exercise the Markdown windows with WebKit.

For the live suites, start a disposable runtime and point Orc at it with separate profiles:

```sh
export ORC_RUNTIME_DIR=/tmp/orc-e2e/runtime ORC_CONFIG_DIR=/tmp/orc-e2e/config
node slim/frontend/src/main.ts --profile "$ORC_RUNTIME_DIR" --port 0 &
python3 scripts/e2e.py
python3 scripts/e2e-new.py
ORC_LIVE_TESTS=1 ORC_TEST_WORKTREE="$PWD" swift test
```

The PTY suite creates and cleans up only its own sessions. It tests actual stream encryption, input, viewport changes, detach/reattach, concurrent read-only viewing, signal cleanup, and transport reconnection. Picker creation also exercises the installed Codex command without sending prompts. The creation suite additionally requires installed Claude and Pi commands. It starts each agent without sending prompts and checks defaults, project selection, names, validation, and cleanup. Never point these suites at your daily profile.

## Upstream

- [Ghostty source and embedding API](https://github.com/ghostty-org/ghostty/tree/v1.3.1)
- [libsodium](https://doc.libsodium.org/)
- [Node.js](https://nodejs.org/)

Upstream licenses are included in the built app's `Contents/Resources/licenses` directory, `Contents/Resources/MarkdownView/THIRD-PARTY-NOTICES.txt`, and the runtime's `frontend/node_modules`.

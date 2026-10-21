# Sessions

A session is an agent or a shell that Orc keeps running in the background. Sessions belong to Orc's bundled runtime in `Orc.app/Contents/Resources/Runtime` ([design](../slim/README.md)): a small holder process per session owns its program and PTY, and a restartable frontend serves the app, the CLI, and phones. Sessions keep running when Orc closes, when the CLI exits, and when Orc is updated.

Runtime state lives in `~/.config/orc/runtime` (or `ORC_CONFIG_DIR/runtime`; `ORC_RUNTIME_DIR` selects another profile). Orc starts the runtime when no frontend serves that profile, and concurrent clients coordinate startup per profile. Startup output goes to a private log under `~/.config/orc/runtimes/` (or `ORC_CONFIG_DIR`).

## Names

A session's name is its identity. Agents are messaged by name, and notes, board placement, and sidebar order follow the name. Names are 1–64 characters, without `/` or control characters, and cannot start with `.`.

Every session starts with `ORC_SESSION_NAME` (its name) and `ORC_RUNTIME_DIR` (its runtime profile), so `orc` run inside a session reaches the same runtime and identifies its caller.

## Child sessions

Right-click a top-level session and choose **Create Child…** to create a session in the parent's project. Enter `review` under `frontend` and the session is named `frontend-review`; Orc's sidebar shows it indented as `review`. Parents with children have a disclosure arrow. Grouping is derived from full names, so renaming an existing session to `frontend-review` groups it the same way, with no separate metadata. Nesting is limited to one level; a child cannot create children. The child dialog starts with your configured default agent, and its project can be changed before creation.

## Recently closed agents

Agent sessions closed in the last week can be reopened, resuming their conversations with their undelivered messages and wakes. In Orc, they are listed under **Recently Closed** below the sessions: click one to reopen it and attach, hover to see its last reply and screen, or choose **Reopen with New Name…** from its menu. **Reopen Closed Session** (⇧⌘T) reopens the most recent one. `orc attach`'s picker lists them after the running sessions.

```sh
orc history                    # Agent sessions closed in the last week, and recent conversations
orc reopen remove-dep          # Reopen one under its name and attach
orc reopen remove-dep --name remove-dep-2
```

Terminal sessions are not listed. A session that is reopened, or whose name is in use again, leaves the list.

## Restarting your Mac

A restart ends every session. The next time Orc or `orc` starts the runtime, the sessions that were running come back under the same names: agents continue their conversations with their queued messages and wakes, and shells start in the same directory. Sessions running any other command stay ended. Logging out without restarting does not restore sessions.

## Runtime access

The first time Orc starts or reaches a runtime, it requests its own access grant over the runtime's owner-only local socket and saves it in `~/.config/orc/connection.json` with owner-only permissions. The saved connection is bound to its runtime profile and server key.

## Permissions

The runtime runs as its own app, **Orc Runtime**, so macOS asks about Orc Runtime, not Orc, when a program in a session needs a permission. Allow it to find devices on your local network so that agents can reach model servers and other machines there. The choice applies to every session, whichever of Orc, `orc` or an agent started the runtime, and lasts across Orc updates. It is listed under Local Network in System Settings → Privacy & Security.

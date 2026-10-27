# Agents

Orc runs Codex, Claude Code and Pi, and its own experimental [durable agent](#durable-agents-experimental). Agents never stop to ask for approval: Codex launches with `--yolo`, which also turns off its sandbox, and Claude with `--dangerously-skip-permissions`. Codex sessions launch with `--no-daemon` so tool processes inherit their session's environment and identity; the installed Codex CLI must support that flag.

## Spawning and messaging agents

Agents are sessions addressed by name. An agent can spawn and message others:

```sh
orc agent spawn codex fix-ci --project my-project < brief.md
orc agent send fix-ci < followup.md
orc agent send fix-ci --when-idle < next-task.md
orc agent wait fix-ci
orc agent list
orc agent status fix-ci
orc close fix-ci
```

Spawn starts the agent in `--project` (or the current directory), waits until it is ready, and types the prompt exactly as given. Without an agent (`orc agent spawn fix-ci`), it starts the default agent, as `orc new` does. Send types a message that begins with a line naming the sender (`[from NAME]`, from the calling session's `ORC_SESSION_NAME`). A working agent reads it at its next step, after the tool call it is running; an idle agent starts a turn with it. With `--when-idle`, the message waits until the agent is idle and starts a turn of its own. Messages wait while the agent is at a permission prompt or dialog. Wait returns once the agent has finished everything sent to it. `orc close NAME` ends a session, agent or shell; a closed agent session can be [reopened](sessions.md#recently-closed-agents). Codex and Claude accept `--model` and `--effort`. See `orc agent --help`.

## Wakes

An agent can also have a message sent to itself later:

```sh
orc wake 30m "check the CI run"
orc wake pid 4242 "the build finished"
orc wake ./watch-ci.sh "CI finished"
orc wake list
orc wake cancel 1a2b3c4d
```

A wake's message begins with `[from wake]` and is sent as `orc agent send` sends one, so a working agent reads it at its next step. A timer's message defaults to `continue`; a process or script wake adds the exit status, and a script wake adds the end of the script's output. The script runs in the background right away, in the current directory with the session's environment. Wakes survive runtime restarts; ending the session removes them and stops their scripts. See `orc wake --help`.

## Notifications

A session can notify you itself, for example a loop that checks something and has found what it was waiting for:

```sh
orc notify "PR 14784 merged"
```

Orc shows the message as a notification titled with the session's name; clicking it opens the session. The session's status icon turns to the blue bell, over its working or idle state, and it counts in the Dock badge until you view the session; a prompt waiting for an answer still shows its orange mark. All of this happens even when the session is muted, since muting silences turn ends and `orc notify` is for when there is something to report. Run outside a session, the notification is titled Orc. While Orc is closed, the runtime keeps the newest 20 and Orc shows them when it opens; `orc notify` says when Orc is not open.

## Agent status

Orc keeps a short status of each agent session: its goal, its progress, what it is doing right now, its next three steps, and anything it is waiting on from you. A model you choose under Settings → **Agent Status** (one of Pi's scoped models; off until chosen) writes it from the agent's own transcript, starting from the agent's latest summary of its conversation, so the agent is never messaged and its context is untouched. A status is written about 20 seconds after an agent's turn ends or it stops for permission, and every 15 minutes while it works, when its transcript changed; automatic statuses for a session are at least 5 minutes apart, and one is written at a time.

The sidebar shows each agent's status headline after its agent, and the [Status panel](app.md#status-panel) shows the full status.

```sh
orc brief cayenne-caching-cdc            # The latest status
orc brief cayenne-caching-cdc --refresh  # Write a new one now and print it
orc brief cayenne-caching-cdc --clear-needs-you                  # Mark what it waits on from you as read
orc brief cayenne-caching-cdc --add-pr OWNER/REPO#123            # Link a pull request the status missed
orc brief cayenne-caching-cdc --remove-pr OWNER/REPO#124         # Unlink one it got wrong
orc brief --eval                         # Check the status model on sample statuses
```

`--clear-needs-you` does what marking the question read in Orc does: the status drops it, and later statuses don't ask it again. `--add-pr` and `--remove-pr` link and unlink [pull requests](#pull-requests), as `orc pr watch` and `orc pr unwatch` do.

Choosing a status model checks it first: Orc asks it for four sample statuses, from transcripts of an agent that opened a pull request, one that pushed to another, one asking you a question, and one at work, and grades each answer by fixed rules (a well-formed status with three next steps, the question noticed, the right pull requests reported and no others). Settings shows what it got wrong, with **Check Again**; `orc brief --eval [PROVIDER/MODEL]` runs the same checks from the terminal.

Statuses are kept in the runtime profile under `briefs/`, the model in `brief-settings.json`, and each model's checks in `brief-evals.json`.

## Pull requests

Writing an agent's status also links the GitHub pull requests the agent opened or pushes commits to: Orc asks the status model about every pull request the transcript names that is not linked yet, the model reports the agent's own, and Orc links each that is open and that you (as `gh` is signed in) opened. A pull request belongs to one agent; one that a coordinator and an agent it started both report goes to the latter. One you unlink from an agent is not linked to it again by its status, until you link it yourself. Orc then checks each linked pull request on GitHub every 3 minutes, without a model, until it is merged or closed.

Once the agent has been idle for 30 seconds with nothing queued, Orc sends it a message, as `orc agent send` does, about what is new: checks of the latest commit that failed, unresolved Copilot review comments, merge conflicts, and the pull request's removal from the merge queue (other than by merging, or by hand), so the agent can fix it and queue it again. It waits for the commit's other checks to finish first, or until a failure is 15 minutes old. Each finding is reported once, and a check once per commit, so an agent that leaves a check red is not told again until it pushes. Checks named under Settings → **Pull Requests** → **Ignored checks** (Attestation unless you change it; `*` matches anything) are never reported. A check that fails again after the agent was told about it on two commits in a row goes to you instead: the agent's session moves to **Needs You** in the overview, where **Ignore Check** adds it to the ignored checks and **Keep Telling Agent** reports it to the agent every time it fails.

The overview shows each agent's pull requests under it, with whether each is in the merge queue, and the status panel shows each in full, with when the agent was last told.

```sh
orc pr                                                         # Every agent's pull requests
orc pr fix-ci                                                  # One agent's
orc pr watch fix-ci https://github.com/OWNER/REPO/pull/123      # Link one yourself, from another agent if need be
orc pr unwatch fix-ci OWNER/REPO#123
```

Linked pull requests are kept in the session's directory and stay linked when a closed session is reopened; the ignored checks are kept in the runtime profile's `pull-request-settings.json`.

## Conversations

**Open…** (⌘K) in the app [opens past conversations](app.md#opening-conversations): recently closed agent sessions and every Codex, Claude and Pi conversation in the agents' own histories, including ones started outside Orc. From the terminal:

```sh
orc history cache flaky        # Closed sessions and conversations matching every word
orc history --all              # Include conversations outside registered projects
orc reopen 01a0f112-21e6       # Open a conversation by its id or the start of it
```

## Project MCP servers

Put MCP servers that only some agents need in the project's `.mcp/` folder, one `NAME.json` per set, in the `mcpServers` format Claude's `--mcp-config` and Pi's `mcp.json` use:

```json
{ "mcpServers": { "vanta": { "type": "http", "url": "https://…" } } }
```

No agent loads them until you turn one on: `orc agent spawn claude vanta-check --mcp vanta` or `orc new claude --mcp vanta` (several as `--mcp vanta,jira`), or tick it under **MCP servers** in the New Session sheet, which lists the project's configs. The servers are added to the agent's own, so its user-level servers stay available, and they stay on when the session is restarted or reopened. Claude reads the file with `--mcp-config`, Pi through Orc's extension, and Codex takes each server as `-c mcp_servers.…` settings, written as they are in the file (Codex does not expand `${VAR}`). Durable agents do not take MCP servers.

## Durable agents (experimental)

`orc new durable` or `orc agent spawn durable NAME` starts Orc's own agent, built on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable). It signs in with Pi's credentials (`pi /login`), uses Pi's default model unless given `--model PROVIDER/ID` (Pi's custom providers in `models.json` work too) and offers the models you scoped in Pi with `/scoped-models`, and keeps its conversation in a database, so it continues mid-turn after a crash or a restart.

Orc shows it in the **Workbench**, a chat in place of its terminal, with an inspector beside it for its status, usage, directory and context. A finished turn shows your prompt and the agent's answer, with its work folded behind one line ("Worked for 3m 43s"), its tool calls grouped into a sentence ("Ran 3 commands and read 5 files"), and a card listing the files it changed, whose **Open diff** shows the turn's changes beside the transcript. While the agent works, the turn shows how long it has been working and the calls running now. Ticks at the left edge, one per turn, preview each turn on hover and jump to it on click; a new turn stays near the top of the view while its answer fills the screen. The Workbench opens on the newest turns and loads older ones in the background and as you scroll up, and it keeps what it has shown, so it opens at once next time and fetches only what is new. Code and diffs are highlighted. Messages sent while it works steer it; `--when-idle` messages wait in its queue, where the Workbench can withdraw them.

On your phone, Orc's screens in the Orca app open it in the same chat, with its terminal a tap away ([phone](phone.md)). When an Orc update changes the durable agent, running durable agents restart on the new code at their next idle moment and continue their conversations.

## Agent integrations

In a Pi session started by Orc, run **`/notes`** to edit the session's note in nvim. Orc installs the Pi extension at `~/.pi/agent/extensions/orc-notes.ts`; existing Pi processes can load it with `/reload`. Notes are private text files named after their session in `~/.config/orc/notes/` (or `ORC_CONFIG_DIR/notes/`). The app refreshes an open note when nvim saves it.

The `orc-session-name.ts` Pi extension gives a Pi session its Orc session's name when it starts. Pi's `/name` does not rename the Orc session. Existing Pi processes can load it with `/reload`.

The app installer registers Claude Code `SessionStart` and `UserPromptSubmit` hooks in `~/.claude/settings.json` (or `CLAUDE_CONFIG_DIR`), preserving other hooks and settings. Inside an Orc session, they set Claude's title to the session's name using the documented [`hookSpecificOutput.sessionTitle`](https://code.claude.com/docs/en/hooks#sessionstart-decision-control) field, on startup, resume, fork, and each submitted prompt. A running program keeps the name its session had when it started. Claude sessions outside Orc are unaffected. This requires Claude Code 2.1.152 or later; restart existing Claude sessions after installing the hooks. The hook command is `orc hook claude-session-name` and reads Claude's hook JSON from stdin.

# The Orc app

## Main window

**Orc.app** shows the session list beside the selected session's embedded terminal; selecting another session switches the terminal to it. The window and the Session Overview take their colors from the terminal's theme, with the sidebar a shade darker, and the selected session's name heads the terminal. The buttons at the top of the sidebar hide the sidebar (**View › Hide Sidebar**, ⌃⌘S), which slides away, open the [Session Overview](#session-overview) and start a session; while the sidebar is hidden, its button is beside the session's name. With no session selected, the terminal's place offers to start a session or open a previous conversation, and the window keeps its size. The terminals of the ten most recently shown sessions stay attached in the background, so switching back to one is immediate and keeps its scrollback, scroll position and selection; a hidden terminal does not draw or resize its session. Sessions keep running either way.

**File › Quick Terminal** (⌘J), or the terminal button at the top right of the window, opens the selected session's quick terminal: your shell, in the folder the session started in, in a panel over the session's terminal. Drag the panel's top bar to move it and its edges to resize it; its ✕ closes it, as does exiting the shell. A session has one quick terminal, which keeps its shell, output and place while other sessions show, until you close it, the session ends or Orc quits. ⌘J moves the keyboard between the quick terminal and the session's own terminal, and showing a session gives the keyboard to its own terminal. Sessions on another Mac have no quick terminal.

**Host** shows another Mac's sessions instead, once it is paired with **Host › Connect to a Mac…** ([Pair a computer](computers.md#view-from-another-mac)); the session count at the bottom of the sidebar names it.

A session open on another computer as well, such as in Orc on another Mac or Orc for Windows, takes the size of the terminal you are using. Selecting the session, clicking, typing or scrolling in its terminal, or bringing its window to the front gives the session that terminal's size at once; using the other computer gives it that computer's size after a few seconds without use here. A terminal you are not looking at (hidden, minimized or covered) never resizes the session. While another computer sizes a session, its terminal here shows **Sized for NAME · click to fit here**.

Create a session with **⌘N**, or right-click a session and choose **Rename Session…** to rename it; its note moves with it. **Restart Session** in the same menu ends a session and starts it again under its name, so an agent that updated itself (or was updated) runs its current version: an agent session continues its conversation with its undelivered messages, wakes and pull requests, and a shell session starts a new shell in its folder. A session running another command cannot be restarted. Restarting a working agent asks first, since it stops the agent's current turn.

**Settings…** (⌘,) sets the default agent and project, saved at once to [`~/.config/orc/config.json`](cli.md#defaults); other settings in that file are kept. A configured project that is not registered is shown as such rather than changed.

## Session list

The session list has a section for each project with sessions, including temporarily disconnected ones, headed by the project's name; hover over it for its folder and number of sessions. Hover over a header and click the arrow at its end to collapse or expand the project; Orc remembers which are collapsed and expands a project when one of its sessions is selected, for example from a notification. A project is placed where its first session is in the sidebar order. Each row shows a tile for the session's program (Claude, Codex, Pi, a durable agent, a program that reports its status, or a terminal) and its name. Hover over a row for its agent and, for an agent with a [status](agents.md#agent-status), its headline; the selected session's headline also heads its terminal. Drag sidebar rows to rearrange sessions within their project. Parents move with their children; children can move within their parent. The runtime keeps the order, so it is the same for every Mac that shows these sessions, and [Rex's tabs](cli.md#rex) follow it.

A row's indicator, at its end, shows what an agent's hooks report when there is something to notice: a yellow spinner while it works, a blue bell for new output or a notification, and an orange exclamation mark when it needs attention. An idle agent shows none, unless it is muted, which shows its muted bell. A program that reports its status with [OSC 7501](https://www.superlogical.com/rex/docs/build/program-status), the Program Status Protocol, does the same for its session, even in a plain terminal session: working shows as active, blocked (waiting for permission, an answer or a sign-in) and failed as needing attention, and done as idle, with a notification when it finishes. The overview shows the program's name and message, as does its row's tooltip in the session list. A gray cross marks an offline session; hover over any row for its status. The list refreshes every two seconds. Reduce Motion keeps the active indicator yellow without spinning.

When an agent is waiting on something to happen, such as CI, a review or a reply, right-click it and choose **Mark as Waiting**. Its row shows a green **Waiting** label until the agent next starts working, or until you choose **Clear Waiting**; marking it also marks its new output read. An agent marked while it works keeps the label until its next turn starts. The runtime keeps the label with the session, so every Mac that shows these sessions shows it, and it stays when the session is restarted or reopened.

A ring at the bottom of the sidebar shows how much of each Claude and Codex subscription limit is used, filled to the agent's limit closest to being reached, with its share. Click it to see every limit: the five-hour session, the week, and weekly limits on one model, each with its share used and the time until it resets. Shares turn orange from 60% and red from 80%. An agent that is not installed, not signed in to a subscription, or at 0% of every limit is left out, here and in every other view of usage.

The runtime reads usage with the agents' own sign-ins: Claude Code's from the Keychain (or `.credentials.json` in its config directory), and Codex's through `codex app-server`, else the ChatGPT endpoint with `~/.codex/auth.json`. Neither sign-in is changed; an expired Claude sign-in recovers the next time `claude` runs. Usage is checked when Orc becomes active and every 15 minutes while it is, and refetched only once it is 5 minutes old; the refresh button fetches it now. After a failure, the last usage stays visible with a warning for 30 minutes, or a day when the provider rate limited the request.

## Session Overview

Open **Session Overview** with the grid button at the top of the sidebar or **⇧⌘O** to see what all your sessions are doing. It sorts them by what they need: **Needs You** (an agent at a permission prompt, a finished turn you have not read, an agent whose status says it waits on you, or a check of an agent's [pull request](agents.md#pull-requests) that failed again after the agent was told twice), then **Working**, then **Idle**. Each card is a session with the agents it spawned and its named children beneath it, in the lane of its most urgent member. A card shows its project at the top right and a short row for each session: its state and how long it has been in it, queued messages and its next wake, and for an agent its status headline, anything it waits on from you, and its pull requests.

Select a session, by clicking it or with ↑/↓ or j/k, to open its full status in its card. **Reply** sends an agent a message, as `orc agent send` does: Return sends it now, steering a working agent; ⌘Return sends it once the agent is idle. **Open**, or a double-click, shows the session in the main window. Return opens the selected session, R replies to it, S writes a new status for it, M marks it read (its new output and what its status says it waits on) and selects the next; a question you mark read is not raised again by its later statuses, unless they name something else it waits on. Esc closes it, and ? shows these shortcuts over the overview. The toolbar shows each agent's usage. Search narrows the overview to sessions whose name, project path, agent or status matches. Viewing the overview leaves unread output marked for review.

## Notifications

Orc sends a macOS notification when an agent it has observed working becomes idle. Click the notification to open that session. Monitoring continues while Orc is running, including with its window closed; quitting Orc stops monitoring. Allow notifications when prompted, or enable Orc in **System Settings → Notifications**. Notifications follow your macOS sound, banner, and Focus settings. Sessions already idle at launch do not trigger alerts, and repeated idle updates do not create duplicates.

Orc's Dock badge counts sessions showing the unread bell state. Viewing a session's attached terminal clears its alert and reduces the count; the badge disappears when none remain. Enable **Badge application icon** for Orc in System Settings → Notifications. Orc requests badge permission when it starts.

To silence an agent session, right-click it in the session list and choose **Mute Notifications**. A muted session posts no idle notifications, is left out of the Dock badge, and shows a muted bell instead of its activity light, except after it runs [`orc notify`](agents.md#notifications). Muting follows the session when it is renamed in Orc, reopened or restored; it is forgotten once no running or recently closed session has the name.

## Terminals

When Ghostty is installed, or you have a Ghostty configuration file, Orc's terminals use your Ghostty settings: theme, font, colors, padding and keybinds, from the same configuration files Ghostty reads. A theme with light and dark variants follows the system appearance. A `background-opacity` below 1 makes the terminal translucent, with your `background-blur`; the rest of the window stays opaque. Without Ghostty, terminals use Orc's defaults (Menlo 13, GitHub Dark).

Settings in `~/.config/orc/terminal.conf` (`ORC_CONFIG_DIR/terminal.conf`), in Ghostty's format, apply over those, so Orc's terminals can look different from Ghostty's without changing Ghostty. For example:

```
background-opacity = 1
theme = light:GitHub Light Default,dark:GitHub Dark Default
font-family = Menlo
font-size = 12
window-padding-x = 14
```

Either way, Orc keeps `confirm-close-surface = false` and `shell-integration = none`, which its terminals depend on. Ghostty's reload-configuration keybind reloads the settings in Orc too; otherwise they are read when Orc starts.

Click a local Markdown link in an attached terminal to open a separate Orc window. **Rendered** is selected by default; **Raw** shows the read-only source. **Reload file** reads changes saved on disk. Links to other Markdown files open their own windows, while web links use your browser. Relative links in a terminal resolve from the session's project folder; links inside a document resolve from that file's folder. The offline renderer does not execute embedded scripts or fetch remote images. Local images must be inside the document's folder. Markdown files must be UTF-8 and at most 4 MiB.

Dropping local files or images into an attached terminal pastes their quoted paths without pressing Enter. Dropped image data without a file path is saved as private PNG files under `ORC_CONFIG_DIR/attachments` (default `~/.config/orc/attachments`), up to 20 MiB per image. Keep these files while agents or resumed conversations may need them.

## Opening conversations

**Open…** (⌘K) searches recently closed agent sessions and every Codex, Claude and Pi conversation in the agents' own histories, including ones started outside Orc. Conversations in registered projects are searched unless **All projects** is checked. Every word typed must appear in the title, first prompt, last reply or folder. The preview shows the first prompt and last reply; ↵ opens the selection in a new session in its folder, resuming the conversation and named after its title, and ⌥↵ asks for a name first. A conversation that a running session already has open switches to that session instead, and one that belongs to a recently closed session reopens that session. Close a conversation that is open in another app or terminal before opening it in Orc. See also [Recently closed agents](sessions.md#recently-closed-agents).

# Slim runtime architecture

The runtime has two kinds of processes. A **holder** per session owns the PTY and the program running
in it, and nothing else. One **frontend** per profile owns every protocol, the terminal emulators and all
persistent state. The frontend can be stopped, crash or be replaced at any time; programs keep running
and the next frontend rebuilds its view of them from the holders.

## Processes

```mermaid
flowchart TB
    subgraph clients["Clients"]
        app["Orc.app"]
        cli["orc CLI"]
        phone["Orca mobile app"]
    end

    subgraph frontend["Frontend · Node · one per profile · restartable"]
        unix["Local RPC<br/>rpc.sock · NDJSON · auth token"]
        ws["WebSocket RPC<br/>E2EE v1 · device tokens"]
        methods["Methods<br/>terminal.* · session.tabs.* · worktree.*<br/>repo.* · agent.* · status.get"]
        mux["terminal.multiplex<br/>snapshots · output · viewport claims"]
        phoneStreams["Phone streams<br/>terminal.subscribe · session.tabs.subscribe<br/>nativeChat.subscribe · runtime.clientEvents"]
        catalog["Catalog<br/>workspaces · tabs · agent status"]
        pairing["Devices and pairing"]
        store["Session store<br/>create · discover · rename · retire"]
        sessions["Terminal session × N<br/>holder client · TerminalFeed<br/>xterm emulator · checkpoints"]
        agents["Agent directory<br/>status monitors · message queues"]
    end

    subgraph holders["Holders · Swift · one per session"]
        holderA["orc-holder<br/>PTY master · output ring · resize log"]
        holderB["orc-holder"]
    end

    programA["shell or agent"]
    programB["shell or agent"]

    app --> unix
    app --> ws
    cli --> unix
    cli --> ws
    phone --> ws
    unix --> methods
    unix --> pairing
    ws --> methods
    ws --> mux
    ws --> phoneStreams
    methods --> store
    methods --> agents
    methods --> catalog
    phoneStreams --> catalog
    phoneStreams --> sessions
    phoneStreams -- "reads" --> transcripts[("agent transcripts<br/>~/.claude · ~/.codex · Pi sessions")]
    catalog --> store
    catalog --> agents
    agents --> store
    agents -- "reads agent-events" --> events[("agent-events/UUID.jsonl")]
    store --> sessions
    mux --> sessions
    sessions -- "holder protocol<br/>sessions/NAME/sock" --> holderA
    sessions -- "holder protocol" --> holderB
    holderA -- "PTY" --> programA
    holderB -- "PTY" --> programB
    programA -. "status hooks append" .-> events
```

| | Holder | Frontend |
|---|---|---|
| Lifetime | The session | Until stopped or upgraded |
| Owns | PTY master, child process, untrimmed output, resize log | Names, metadata, emulators, checkpoints, projects, devices, keys |
| Parses terminal output | Never | Always, with `@xterm/headless` |
| Changes when | The holder protocol or PTY handling changes | Anything else changes |
| Stopping it | Ends that session | Ends nothing |

## State on disk

```mermaid
flowchart LR
    holderProcess(["holder"])
    frontendProcess(["frontend"])

    subgraph holderFiles["sessions/NAME/ · written by its holder"]
        sock["sock"]
        holderRecord["holder.json · exit.json"]
    end

    subgraph sessionFiles["sessions/NAME/ · written by the frontend"]
        meta["meta.json"]
        checkpoint["checkpoint.json"]
        queue["queue.json · wakes.json"]
    end

    agentProcess(["agent status hooks"])
    subgraph eventFiles["written by agents"]
        events["agent-events/UUID.jsonl"]
    end

    subgraph profileFiles["profile · written by the frontend"]
        runtime["orca-runtime.json · rpc.sock · frontend.lock"]
        identity["orca-e2ee-keypair.json · orca-devices.json"]
        projects["projects.json"]
        binaries["holders/HASH/orc-holder"]
        hookFiles["agent-hooks/HASH/<br/>orc-agent-hook · claude-settings.json · orc-agent-status.ts"]
        wakeLogs["wake-logs/ID.log · ID.exit"]
        ended["ended/NAME.TIME/"]
    end

    holderProcess --> holderFiles
    frontendProcess --> sessionFiles
    frontendProcess --> profileFiles
    agentProcess --> eventFiles
```

The session directory's name is the session's identity. A holder writes only its socket and its own
records, relative to a descriptor for the directory, so renaming the directory does not disturb it.

## Output and checkpoints

```mermaid
sequenceDiagram
    participant P as Program
    participant H as Holder
    participant S as Frontend session
    participant X as xterm emulator
    participant C as Client stream

    P->>H: PTY output
    H->>H: append to ring at offset N
    H->>S: output frame (N, bytes)
    S->>X: write through TerminalFeed
    X-->>S: parsed
    S->>C: Output frame (N, bytes)
    opt output contained a terminal query
        X-->>S: reply
        S->>H: input frame
        H->>P: reply on the PTY
    end

    Note over S: checkpoint after 1 s quiet, 5 s of output, or 1 MiB untrimmed
    S->>X: capture state at a sequence boundary
    S->>S: compress off the event loop, write checkpoint.json, rename
    S->>H: trim(offset)
    H->>H: drop output before offset
```

A checkpoint holds xterm's exact internal state for the build that wrote it, plus a serialized screen
with 500 rows of scrollback that any build can replay. Output after the checkpoint stays in the
holder's ring until the next checkpoint trims it.

## Agent status and messages

```mermaid
sequenceDiagram
    participant L as Sender (orc agent send)
    participant F as Frontend
    participant E as agent-events file
    participant H as Holder
    participant A as Agent

    L->>F: agent.send(to, text, from)
    F->>F: add to the agent's queue
    A->>E: Stop hook appends an event
    F->>E: read new events: idle
    F->>H: input: bracketed paste of "[from SENDER]" and the text, then Enter
    H->>A: typed on the PTY
    A->>E: UserPromptSubmit
    F->>E: read new events: working, delivery confirmed
    Note over F: the next queued message waits for idle
    A->>E: Stop
    L->>F: agent.wait resolves: done
```

Hooks and the Pi extension are supplied on the agent's command line when it starts, and write only to
the event file named by `ORC_AGENT_EVENTS`. The frontend derives each agent's state from that file, so
a frontend that starts later replays it and reaches the same state.

## Phones

```mermaid
sequenceDiagram
    participant U as orc pair-phone
    participant F as Frontend
    participant P as Orca mobile app
    participant H as Holder

    U->>F: orc.phone.create(address) over the local socket
    F->>F: issue a mobile device token for ws://address:6768
    F-->>U: orca://pair link, shown as a QR code
    P->>F: e2ee_hello, e2ee_auth(device token)
    F-->>P: e2ee_authenticated
    P->>F: status.get, worktree.ps, repo.list, runtime.clientEvents.subscribe
    P->>F: session.tabs.subscribe(workspace)
    F-->>P: snapshot, then updated on every change
    P->>F: terminal.subscribe(terminal, viewport)
    F->>H: resize to the phone's viewport
    F-->>P: subscribed(streamId), binary snapshot, binary output
    P->>F: terminal.send(text, enter)
    F->>H: input: text, then Enter 500 ms later
    P->>F: terminal.unsubscribe
    Note over F,H: 300 ms after the last phone leaves, the earlier size returns
```

A mobile device token reaches only the methods the Orca app uses. The app's chat view, served to phones
only, reads the agent's own transcript file, located from the session id and path its hooks reported,
and follows it as it grows.

## Frontend start

```mermaid
sequenceDiagram
    participant F as Frontend
    participant D as Session directories
    participant H as Holder
    participant C as Client

    F->>D: scan sessions/*
    loop every session
        F->>D: read meta.json and checkpoint.json
        F->>F: load emulator state (or the serialized screen from another xterm build)
        F->>H: hello, then attach(from = checkpoint offset)
        H-->>F: attach reply with headOffset
        H-->>F: retained output and resizes up to headOffset
        Note over F,H: replayed output is parsed but never answers queries
        H-->>F: live output from headOffset
    end
    F->>D: write orca-runtime.json
    C->>F: reconnect, subscribe
    F-->>C: snapshot from the emulator, then live output
```

A session whose holder no longer answers is retired to `ended/` as lost, or as exited when the holder
left `exit.json`.

## Upgrades

```mermaid
flowchart TB
    subgraph frontendUpgrade["Frontend or xterm upgrade"]
        stop["Stop the old frontend<br/>(checkpoints every session)"] --> start["Start the new frontend"]
        start --> same{"Same xterm build?"}
        same -- yes --> exact["Load exact state"]
        same -- no --> approximate["Replay the serialized screen once"]
    end

    subgraph holderUpgrade["Holder upgrade"]
        install["Install the new holder under holders/NEW_HASH"] --> newSessions["New sessions start on it"]
        install --> oldSessions["Existing sessions keep the binary they started with"]
    end
```

## Failure behavior

| Event | Effect |
|---|---|
| Frontend crashes or is killed | Programs keep running. The next frontend replays from each checkpoint plus the holder's retained output; clients reconnect and receive a fresh snapshot. |
| A program queries the terminal while no frontend runs | The query goes unanswered. |
| A holder crashes | Its program loses its terminal and the session ends; the frontend retires it as lost. |
| Untrimmed output exceeds the holder's ring | The oldest output is dropped; the next attach reports a gap. |
| A client reads too slowly | The holder disconnects it; the client reattaches from its last offset. |
| A session name is taken | Creation fails; names are unique per profile. |
| An agent runs while no frontend runs | Its hooks keep appending events; the next frontend replays them. Queued messages wait in `queue.json`. |
| A wake's condition is met while no frontend runs | The next frontend fires it. A wake script keeps running and records its exit status for that frontend. |
| A message cannot be confirmed within 20 s | The next queued message may be delivered; the agent reports an unconfirmed delivery. |
| An agent was started without Orc's hooks | It reports no agent state. |
| The frontend restarts while a phone is connected | The phone reconnects to the same port and resubscribes; its tab snapshots start a new publication epoch. |
| A phone stops viewing a terminal | The PTY takes the next viewing phone's size, or its size from before the first phone. A resize from elsewhere in the meantime stands. |

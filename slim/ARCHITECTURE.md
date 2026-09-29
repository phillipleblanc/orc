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
        methods["Methods<br/>terminal.* · session.tabs.listAll<br/>worktree.list · repo.add · status.get"]
        mux["terminal.multiplex<br/>snapshots · output · viewport claims"]
        pairing["Devices and pairing"]
        store["Session store<br/>create · discover · rename · retire"]
        sessions["Terminal session × N<br/>holder client · TerminalFeed<br/>xterm emulator · checkpoints"]
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
    methods --> store
    store --> sessions
    mux --> sessions
    sessions -- "holder protocol<br/>sessions/NAME/sock" --> holderA
    sessions -- "holder protocol" --> holderB
    holderA -- "PTY" --> programA
    holderB -- "PTY" --> programB
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
    end

    subgraph profileFiles["profile · written by the frontend"]
        runtime["orca-runtime.json · rpc.sock · frontend.lock"]
        identity["orca-e2ee-keypair.json · orca-devices.json"]
        projects["projects.json"]
        binaries["holders/HASH/orc-holder"]
        ended["ended/NAME.TIME/"]
    end

    holderProcess --> holderFiles
    frontendProcess --> sessionFiles
    frontendProcess --> profileFiles
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

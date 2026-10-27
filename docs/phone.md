# Pair a phone

The official Orca mobile app can view and type into Orc's sessions.

## On the phone

The app shows Orc's screens. The first lists your sessions by project, with the sessions waiting on you at the top. Tap a session to watch its terminal live, sized to fit the phone. Type in the box at the bottom to message an agent, or to run a command in a shell; the keys above it send Esc, Tab, the arrows, Ctrl-C and Return. An agent's screen also shows its brief: what it is doing and any question it has for you. A durable agent opens on its chat, as in the Workbench: send it messages, steer or queue them while it works, stop it, and open a turn's diff; **Terminal** switches to its terminal. On a tablet, the session list stays beside the session you open.

## Pair

In Orc, choose **Pair Device…** from the menu or click the devices icon below the session list, then **Phone**. Select your Mac's LAN or Tailscale address and click **Generate QR Code**. On the same Wi-Fi or Tailscale network, open the Orca mobile app, choose **Pair**, and scan the code. **Copy Link** provides the alternative paste-pair flow.

```sh
orc pair-phone                         # QR code, preferring Tailscale when available
orc phones                             # Addresses, paired phones, and pending grants
orc pair-phone --address 100.64.1.20   # Choose one of this Mac's listed addresses
orc pair-phone --relay relay.example   # Pair through a relay; see below
orc pair-phone --link                  # Private link for pasting into Orca Mobile
orc pair-phone --rotate                # Replace the unused code; paired phones keep access
orc phones revoke DEVICE_ID            # Disconnect and revoke that phone
```

`pair-phone` and `phones` accept `--json` for automation. Pairing output contains a credential; keep it private. Reopening pairing reuses an unused grant, while pairing another phone after a successful connection creates a separate grant. The app displays paired and pending grants under **Phone Access** and can revoke either. Creating, replacing, and revoking phone grants leave running sessions and Orc's local access intact. Grants persist across runtime restarts.

The runtime listens on port 6768 on every interface. Pairing does not use Orca Relay; both devices need a reachable private network path and the Mac must remain awake. Push notifications to the phone are not supported.

## Through a relay

A Mac that refuses incoming connections, such as one with its firewall set to block them all, can still reach a phone through a host both can reach. The Mac keeps an SSH tunnel open to that host, which listens on the same port and passes connections back over the tunnel:

```sh
ssh -N -R 0.0.0.0:6768:127.0.0.1:6768 relay.example    # The relay's sshd needs `GatewayPorts clientspecified`
orc pair-phone --relay relay.example
```

The relay carries only the encrypted connection: it never sees the phone's token or what the phone shows. Anything that can reach its port can try to pair, so let only your phone's network reach it. A phone paired directly must pair again to use a relay, and keep the tunnel running with something that restarts it, such as a launchd agent.

# Pair a computer

[Orc for Windows](../windows/README.md) (experimental) views and drives this Mac's sessions from another computer on the network.

In Orc, choose **Pair Device…** from the menu or click the devices icon below the session list, then **Computer**. Name the computer and choose how it reaches this Mac: the Mac's local name (`NAME.local`), which keeps working when its address changes, or one of its LAN or Tailscale addresses. **Copy Link** copies a private pairing link; paste it into the computer's Host page and connect.

```sh
orc pair-computer --name EPYC-WINDOWS                # The link and steps, at this Mac's local name
orc pair-computer --address 192.168.1.20 --link      # Only the link, at one of the Mac's addresses
orc pair-computer --name EPYC-WINDOWS --rotate       # Replace that computer's unused link
orc computers                                        # Addresses, paired computers, connected and last seen
orc computers revoke DEVICE_ID                       # Disconnect and revoke that computer
```

The link gives full control of this Mac's sessions: a paired computer can do whatever Orc can, except pair or revoke devices. Keep it private. Pairing a computer again under the same name reuses its unused link; once a computer has connected, pairing it again issues a new grant. **Computer Access** in the same sheet lists paired computers, whether each is connected and when it was last seen, and revokes them. `pair-computer` and `computers` accept `--json`.

A session open on both computers takes the size of the screen you are using; see [The Orc app](app.md#main-window).

The runtime listens on port 6768 on every interface. Both computers need a network path to each other, and the Mac must stay awake.

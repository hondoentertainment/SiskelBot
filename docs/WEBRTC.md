# WebRTC Screen Sharing

Phase 41.5 adds peer-to-peer screen sharing for pair-programming with agents.
This document covers the signaling architecture, the default STUN configuration,
and how to deploy a TURN server when peers cannot reach each other directly.

## Architecture

```
host browser  <--SDP/ICE-->  SiskelBot WebSocket  <--SDP/ICE-->  viewer browser
            \                                                     /
             ----------- direct WebRTC media stream --------------
```

- `lib/webrtc-signaling.js` is the in-memory signaling registry. It tracks
  rooms, participants, and relays SDP offers/answers and ICE candidates
  between sessions in the same room.
- `lib/realtime.js` wires the signaling registry into the existing WebSocket
  server. Hosts and viewers send `webrtc_offer`, `webrtc_answer`, and
  `webrtc_ice` messages over the same WebSocket they already use for
  presence/collaboration.
- `routes/screen-share.js` exposes a small REST API for room lifecycle:
  create, list, get, join, and delete.
- `client/js/screen-share.js` wraps `RTCPeerConnection` and
  `navigator.mediaDevices.getDisplayMedia` and is exposed on
  `window.SiskelScreenShare`.
- `client/screen-share.html` is a minimal pair-programming UI.

The signaling layer never proxies media. Once peers exchange SDP and ICE,
the video stream flows directly between browsers.

## STUN configuration

By default the client uses Google's public STUN servers:

```js
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
```

STUN is enough for most users behind ordinary home or office NATs. It
allows the peers to discover their public IP addresses and punch a UDP
hole through the NAT. There is no bandwidth cost on your servers because
STUN messages are tiny and the media flows peer-to-peer.

To override the STUN list, pass `iceServers` when constructing the client:

```js
const client = createScreenShareClient(wsManager, {
  iceServers: [
    { urls: 'stun:stun.example.com:3478' },
  ],
});
```

## When you need TURN

TURN (Traversal Using Relays around NAT) is required when peers are behind
symmetric NATs or strict corporate firewalls that block direct UDP. TURN
servers relay the media stream and consume bandwidth proportional to the
number of viewers and the bitrate of the screen capture.

Rules of thumb:

| Network situation | STUN only | TURN required |
|-------------------|-----------|---------------|
| Home WiFi ↔ home WiFi | yes | no |
| Office NAT ↔ home WiFi | usually yes | sometimes |
| Symmetric NAT (carrier-grade NAT, mobile data) | no | yes |
| Strict corporate firewall blocking UDP | no | yes (TCP/443) |

If a meaningful fraction of your users fall into the last two rows you
should run a TURN server.

## Coturn setup guide

[coturn](https://github.com/coturn/coturn) is the de facto open-source
TURN server. The following configuration runs it on a Linux host with
both UDP and TLS-over-TCP listeners.

### Install

```bash
sudo apt-get update
sudo apt-get install -y coturn
```

Edit `/etc/default/coturn` and set `TURNSERVER_ENABLED=1`.

### Configure

Replace the contents of `/etc/turnserver.conf`:

```ini
listening-port=3478
tls-listening-port=5349

# Public IP that clients can reach.
external-ip=203.0.113.10

# Long-term credentials. Generate a strong secret and rotate it.
lt-cred-mech
use-auth-secret
static-auth-secret=REPLACE_WITH_LONG_RANDOM_STRING

realm=siskelbot.example.com

# TLS certificates from Let's Encrypt or another CA.
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem

# Limit relay ports to a manageable range.
min-port=49152
max-port=65535

# Logging
log-file=/var/log/turnserver.log
verbose

# Disable insecure features.
no-multicast-peers
no-cli
no-tlsv1
no-tlsv1_1
```

Open the firewall:

```bash
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 49152:65535/udp
```

Start the service:

```bash
sudo systemctl enable --now coturn
```

### Generate short-lived credentials

For security you should mint short-lived TURN credentials per session
rather than embedding the static secret in the browser. The standard
mechanism is HMAC over `expires:username` (RFC 7635 / "TURN REST API"):

```js
import crypto from 'crypto';

function makeTurnCredential(secret, username, ttlSeconds) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const turnUsername = `${expires}:${username}`;
  const hmac = crypto.createHmac('sha1', secret);
  hmac.update(turnUsername);
  return {
    username: turnUsername,
    credential: hmac.digest('base64'),
    ttl: ttlSeconds,
  };
}
```

Expose these via an authenticated endpoint and pass them into
`createScreenShareClient` as the credential portion of `iceServers`:

```js
const cred = await fetch('/api/v1/screen-share/turn-credentials').then(r => r.json());
const client = createScreenShareClient(wsManager, {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349?transport=tcp'],
      username: cred.username,
      credential: cred.credential,
    },
  ],
});
```

### Bandwidth and capacity planning

Screen sharing at 1920x1080 / 15fps uses roughly 1-2 Mbps. Multiply by
the number of concurrent viewers when sizing your TURN server:

| Viewers | Bitrate per session | Bandwidth |
|---------|---------------------|-----------|
| 1 | ~1.5 Mbps | ~700 MB / hour |
| 5 | ~7.5 Mbps | ~3.5 GB / hour |
| 20 | ~30 Mbps | ~14 GB / hour |

A small `t3.medium` EC2 instance comfortably handles 5-10 concurrent
sessions. For larger deployments use a dedicated TURN cluster behind a
geographic load balancer.

## Security notes

- The signaling layer authenticates clients via the same one-time WebSocket
  token used by the rest of SiskelBot. Sessions are scoped to a single
  workspace, and only participants in the same room can exchange signals.
- Hosts can close their own room via `DELETE /api/v1/screen-share/rooms/:id`;
  admins can close any room.
- The browser always shows a "Stop sharing" indicator while a screen
  capture is active. Hosts cannot suppress it.
- TURN credentials should always be short-lived (5 - 30 minutes) and
  bound to an authenticated user, never embedded as a static secret in
  the client.

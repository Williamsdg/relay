# Relay

A reliability-first Xbox Remote Play client for macOS.

Relay talks the same protocol the official Xbox app uses to stream your own
console over the network, using your own Microsoft account. It exists because
the official client fails quietly: spinners that never resolve, sessions that
hang on a frozen frame, and re-authentication prompts that appear for no
visible reason.

## What it does differently

**Every connection step is named.** The connect flow is a state machine —
`requesting-session → provisioning → negotiating → connecting → streaming` —
and the UI shows which step you are on. A failure reports the step it died on
and the service's own error text, not "couldn't connect".

**It detects stalls that WebRTC reports as healthy.** The classic Remote Play
hang leaves the peer connection in the `connected` state while the console has
actually stopped sending frames. Relay watches `framesDecoded` rather than
connection state, so a stream that stops producing video is caught in seconds
and reconnected.

**Reconnects are automatic and bounded.** Drops tear the session fully down and
re-provision with exponential backoff, up to five attempts, instead of trying
to revive a dead peer connection. The attempt count is visible.

**You sign in once.** The proof key and MSA refresh token are stored in the
macOS Keychain via Electron's `safeStorage`. Subsequent launches complete the
whole token chain silently. A revoked token falls back to the sign-in screen
rather than presenting a broken session.

**There is a diagnostics panel.** Every HTTP call, retry, and state transition
is logged and copyable, so a failure can be diagnosed instead of guessed at.

## Requirements

- macOS (Apple silicon or Intel)
- Node 20+
- An Xbox with **Remote Features** enabled:
  Settings → Devices & connections → Remote features → Enable remote features
- The console set to **Instant-on** if you want to wake it remotely (a console
  in the `Off` power state cannot be woken and Relay marks it unavailable)

## Running it

```bash
npm install
npm run dev      # development, with hot reload
npm run build    # production build into out/
npm start        # run the production build
```

If Electron's binary fails to unpack (npm 11 defers install scripts), extract it
with `ditto`, which handles `.app` bundles correctly:

```bash
cd node_modules/electron
rm -rf dist && mkdir dist
ditto -xk ~/Library/Caches/electron/*/electron-*-darwin-*.zip dist/
printf 'Electron.app/Contents/MacOS/Electron' > path.txt
```

## Architecture

```
src/main/        Node side. Owns every credential and all REST traffic.
  auth/crypto    P-256 proof key + ES256 request signing
  auth/flow      the full device → SISU → XSTS token chain
  auth/browser   interactive Microsoft sign-in, captures the redirect code
  auth/store     Keychain-backed credential persistence
  xhome/client   console discovery, session lifecycle, SDP/ICE exchange
  http           timeouts + bounded retries with jittered backoff
src/preload/     the only bridge; hands the renderer capability, never tokens
src/renderer/    Chromium side. Owns WebRTC, gamepad input, and the UI.
  stream/packet      binary encoder for the input data channel
  stream/gamepad     Gamepad API → input frames, with deadzones
  stream/connection  peer connection, reconnect, and the stall watchdog
```

The split matters for two reasons. The xHome hosts send no CORS headers, so a
renderer-side fetch would be blocked outright. And keeping the streaming token
in the main process means the web context never holds a credential it could
leak.

## The protocol

Remote Play is not reachable with an ordinary Xbox Live token. The `gssv`
relying party requires a token carrying device and title claims, which only the
SISU flow issues:

1. Generate a P-256 proof key.
2. `device.auth.xboxlive.com/device/authenticate` → DeviceToken
3. `sisu.xboxlive.com/authenticate` → a Microsoft login URL (PKCE, S256)
4. User signs in; the redirect to `ms-xal-<appid>://auth` carries the code
5. `login.live.com/oauth20_token.srf` → access + refresh tokens
6. `sisu.xboxlive.com/authorize` → User, Title and Device tokens
7. `xsts.auth.xboxlive.com/xsts/authorize` for `http://gssv.xboxlive.com/`

Steps 2, 3, 6 and 7 must carry a `Signature` header. The signed byte stream is
Microsoft's documented signature policy (version 1, no extra headers):

```
<version: uint32 BE> 00 <windows filetime: uint64 BE> 00
<METHOD> 00 <path+query> 00 <Authorization or ""> 00 <body> 00
```

SHA-256 + ECDSA, signature in raw `r||s` form — DER is rejected. The header is
`base64(version || filetime || signature)`. Getting any byte wrong yields an
opaque 403, which is why `src/main/auth/crypto.ts` encodes it once.

Streaming then runs against a regional host:

```
POST /v2/login/user                          -> gsToken + region baseUri
GET  /v6/servers/home                        -> consoles
POST /v5/sessions/home/play                  -> sessionId
GET  /v5/sessions/home/:id/state             -> poll until "Provisioned"
GET  /v5/sessions/home/:id/configuration     -> keepalive interval
POST /v5/sessions/home/:id/sdp               -> offer  (answer via GET)
POST /v5/sessions/home/:id/ice               -> candidates (remote via GET)
DELETE /v5/sessions/home/:id                 -> stop
```

Neither the SDP nor the ICE POST returns its answer; both must be polled from
the matching GET.

### Input channel

Gamepad state goes over a WebRTC data channel as little-endian binary:

```
offset 0   uint16   report type bitmask
offset 2   uint32   sequence number
offset 6   float64  client timestamp
offset 14  uint8    frame count, then 23 bytes per controller:
           uint8    controller index
           uint16   button bitmask
           int16 ×4 thumb axes (Y inverted relative to the Gamepad API)
           uint16×2 triggers
           uint32   physical physicality mask
           uint32   virtual physicality mask
```

A 15-byte `ClientMetadata` handshake must be sent when the channel opens, or
the console ignores every frame that follows.

## Verification status

Verified here:

- **Request signing** — round-tripped against Microsoft's documented byte
  stream, including negative tests, and confirmed live: the real
  `device.auth.xboxlive.com` endpoint accepted a signed request and issued a
  device token, and SISU returned a valid login URL.
- **Input packet encoding** — asserted byte by byte against the wire format.
- **App startup** — builds clean, typechecks clean, launches, renders, and the
  preload bridge exposes the expected surface.

Not yet verified, because it needs a signed-in account and a real console:

- console discovery, session provisioning, SDP/ICE negotiation, the video path,
  controller input reaching a game, and the reconnect/stall paths under an
  actual drop.

The console-list call tries `/v6`, `/v5` and `/v4` in turn, since that path has
moved between service versions and I could not confirm which this account's
region serves.

## Legal note

Relay connects to your own console with your own Microsoft credentials, the
same way the official client does. It circumvents no protection and contains no
Microsoft code. It is not affiliated with or endorsed by Microsoft.

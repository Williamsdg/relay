# Playing away from home

Relay connects your Mac directly to your console. On your home network that is
trivial — both are on the same LAN. Away from home it is not, and this is the
single hardest part of remote play.

## Why it fails

Your console sits behind your home router's NAT. Your laptop sits behind
whatever NAT the coffee shop, hotel or cellular network uses. Neither has an
address the other can reach, so WebRTC tries to punch a hole through both using
STUN, which reports each side's public address.

That works when at least one NAT is predictable. It fails when either side uses
**symmetric NAT** — where the public port is different for every destination —
because the port STUN reported is not the port your console's packets arrive
on. Cellular carriers almost always use symmetric NAT, and so do many public
networks.

Relay's diagnostics show this plainly. A failing connection looks like:

```
local ICE candidates: host/v4×18 srflx/v4×3
Received 9 usable remote ICE candidate(s): host/v4×8 srflx/v4×1
ICE connection state: checking
ICE connection state: disconnected
```

Candidates are exchanged, checks run, nothing connects. No amount of client
code fixes that — the packets have nowhere to go.

## Three ways to fix it, best first

### 1. Open your home NAT (free, best latency)

This is what Microsoft intends, and it costs nothing.

- In your router's settings, enable **UPnP** (sometimes "NAT-PMP" or
  "automatic port forwarding").
- On the Xbox: **Settings → General → Network settings**. Under *Current
  network status* it should say **NAT type: Open**.
- If it says Moderate or Strict, the console cannot accept an inbound
  connection and remote play will keep failing.

Try this first. If the console's NAT is Open, its public candidate becomes
reachable and no relay is needed.

### 2. A VPN back to your home network (free, very reliable)

If you can reach your home LAN, the console looks local again and everything
behaves exactly as it does at home.

[Tailscale](https://tailscale.com) is the least painful way: install it on any
always-on machine at home (a spare Mac, a Raspberry Pi), enable
**subnet routing** for your home LAN, then install Tailscale on your laptop.
The console needs no changes and does not need to run anything.

This adds one WireGuard hop, which is usually a few milliseconds.

### 3. A TURN relay (always works, costs a little)

A TURN server is a machine with a public address that both ends *can* reach,
which forwards the stream. It works regardless of NAT, at the cost of an extra
hop and bandwidth.

Game streaming is bandwidth-hungry — roughly **7 GB per hour** at 1080p60 — so
metered TURN services get expensive fast. A small VPS with a generous transfer
allowance is far cheaper. Any $5/month instance with 1–2 TB of transfer covers
150–300 hours a month.

Install [coturn](https://github.com/coturn/coturn) on it:

```bash
sudo apt update && sudo apt install -y coturn
sudo sed -i 's/#TURNSERVER_ENABLED/TURNSERVER_ENABLED/' /etc/default/coturn
```

Then put this in `/etc/turnserver.conf`, substituting your own values:

```conf
listening-port=3478
# Also listen on TLS, which survives networks that block plain UDP.
tls-listening-port=5349

# The server's public address. On a cloud VM the interface usually holds a
# private address, so both are needed.
listening-ip=0.0.0.0
external-ip=YOUR.PUBLIC.IP.HERE

# Long-term credentials. Pick a real password.
lt-cred-mech
user=relay:CHOOSE_A_STRONG_PASSWORD
realm=relay.yourdomain.com

# Relay only; this is not an open proxy.
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255

# A wide port range for relayed media.
min-port=49152
max-port=65535
```

Open ports **3478/udp**, **3478/tcp**, **5349/tcp** and **49152-65535/udp** in
the VM's firewall, then:

```bash
sudo systemctl enable --now coturn
```

In Relay, open the console list and fill in **Relay server**:

- Server address: `turn:your.server.address:3478`
- Username: `relay`
- Password: the password you chose

Press **Test relay**. It asks the server for a relayed address and tells you
whether the credentials and ports actually work — worth doing before you rely
on it, because a mistyped password fails exactly like a network fault.

Tick **Always use the relay** to force traffic through it. That is slower than
a direct path, but it is the quickest way to confirm the relay itself is
sound. Untick it afterwards so Relay prefers a direct connection when one
exists and falls back to the relay when it does not.

### If UDP is blocked entirely

Some networks allow only TCP on port 443. Add `?transport=tcp` to the server
address (`turn:your.server:3478?transport=tcp`), or run coturn's TLS listener
on 443 and use `turns:your.server:443`.

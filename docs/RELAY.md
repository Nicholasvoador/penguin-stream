# Relays: when you need one and how to set it up

Most sessions never touch a relay. Penguin Stream connects peers **directly over UDP** using ICE hole punching.
That works through ordinary home routers and through most carrier-grade NATs (CGNAT), because they use
*endpoint-independent mapping*. Open the app's **Network** page to see which kind you have.

A relay is only needed when **both** sides are behind *symmetric* NATs (some mobile carriers, some corporate
networks) and neither has IPv6. Then traffic goes host ⇄ relay ⇄ viewer. It stays end-to-end encrypted; the relay
only sees ciphertext.

**Only one side needs a relay.** Configure it on the machine you usually share from. The people you invite set nothing up.

Pick a relay **close to you**: every packet takes the detour, so relay distance adds directly to latency.

## Option 1: Cloudflare Realtime TURN (free tier, recommended)

Anycast, so traffic enters Cloudflare at the nearest city (São Paulo for Brazil, for example). 1,000 GB/month free at the time of writing.

1. Log in to the Cloudflare dashboard → **Realtime** → **TURN Server** → **Create**.
2. Copy the **Turn Token ID** and the **API Token**.
3. In Penguin Stream: **Settings → Relay → Cloudflare (free)**, paste both, click **Save & test relay**.

The API token stays in your local settings file (owner-only permissions). Each session uses 24-hour credentials minted
from it; the token itself is never sent to the other peer.

## Option 2: a credentials URL

Any HTTPS endpoint that returns ICE servers as JSON, either `[{urls, username, credential}, …]` or
`{"iceServers": [...]}`. Metered.ca's free tier works:
`https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=YOUR_KEY`.

## Option 3: your own coturn (≈ 5 minutes on any VPS)

Use a VPS in the same region as you and your friends. On the server (Fedora/Debian/Ubuntu, public IPv4 required):

```sh
sudo podman run -d --name coturn --network host --restart=always docker.io/coturn/coturn \
  -n --log-file=stdout \
  --listening-port=3478 --min-port=49160 --max-port=49400 \
  --fingerprint --lt-cred-mech --realm=penguin \
  --user=penguin:CHOOSE-A-LONG-RANDOM-PASSWORD \
  --no-tls --no-dtls --no-tcp-relay \
  --denied-peer-ip=10.0.0.0-10.255.255.255 --denied-peer-ip=172.16.0.0-172.31.255.255 \
  --denied-peer-ip=192.168.0.0-192.168.255.255 --denied-peer-ip=127.0.0.0-127.255.255.255 \
  --total-quota=8 --user-quota=4
```

Open UDP 3478 and UDP 49160–49400 in the VPS firewall. Then in Penguin Stream: **Settings → Relay → My TURN server**:
server `turn:YOUR.VPS.IP:3478`, username `penguin`, and your password.

The `denied-peer-ip` lines stop the relay from being abused to reach private networks, and the quotas cap concurrent sessions.

## Notes

- The app relays over **UDP only**. It's the lowest-latency transport and the only one its ICE agent (libjuice) supports.
  Networks that block all outbound UDP can't be used.
- **Settings → Advanced → Relay only** forces all traffic through the relay, which hides your IP from the peer, at the cost of latency.
- The bundled `turn/` server in this repository is a test fixture for automated tests, not for public use.

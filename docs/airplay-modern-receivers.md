# AirPlay video casting on modern receivers (tvOS 17/18+): why it breaks, and the community fix that works

*Media Catcher engineering note — July 2026. Everything below was verified live
against an Apple TV 4K (gen 3, tvOS 18.6) and an LG webOS OLED (C2, AirTunes
377.40.00).*

## TL;DR

- **Stock [pyatv](https://github.com/postlund/pyatv) (≤ 0.18.0) cannot cast video
  to modern Apple TVs.** Every request returns `200 OK`, nothing ever renders.
- **The fix is the community PR
  [postlund/pyatv#2846](https://github.com/postlund/pyatv/pull/2846)**
  (`jlacivita:playurl-fixes`) — with it, `play_url()` works on tvOS 18.6,
  including live playback position over the event channel.
- Install it without git, pinned to the commit we verified:

  ```
  pip install https://github.com/jlacivita/pyatv/archive/8848ad3fd9ae46b8eb733bfc667b536a28f04c5a.tar.gz
  ```

- **LG webOS TVs are a different story:** their AirPlay receiver apparently never
  implemented URL-video playback at all
  ([pyatv#2393](https://github.com/postlund/pyatv/issues/2393)) — no client fix
  applies. Cast to them with **DLNA/UPnP** instead (which is what Media Catcher
  does; it works, with quirks documented at the end).

## The failure signatures (what you'll see with stock pyatv)

Searching for these is probably how you found this page.

**Apple TV, tvOS 17/18** (`Server: AirTunes/870.x`):

- `pyatv.exceptions.AuthenticationError: not authenticated` from `play_url` when
  unpaired (expected), **but also after successful pairing** if the Apple TV has
  *AirPlay → Require Password* enabled — that mode re-enforces the password at
  the RTSP stream layer, which pyatv can't satisfy for video. Pairing with the
  password as the PIN *succeeds* (`has_paired=True`) and still can't stream.
- With pairing fine and *Require Password* off: `POST /play` → `200 OK`,
  `POST /rate?value=1.000000` → `200 OK`, then
  `GET /playback-info` → **`500 Internal Server Error`** — and **nothing renders**.
  The tell is the `/play` response body: `{'streams': []}` — the receiver never
  actually created a video stream session. The 500 is a symptom of "no active
  playback", not the cause. (Upstream: [#2512](https://github.com/postlund/pyatv/issues/2512),
  [#2821](https://github.com/postlund/pyatv/issues/2821),
  [#2774](https://github.com/postlund/pyatv/issues/2774),
  [#2759](https://github.com/postlund/pyatv/issues/2759).)
- `connect()` may also fail with `AuthenticationError` inside
  `setup_remote_control` — that's the MRP-over-AirPlay tunnel, which needs a
  *Companion* pairing. On stock pyatv, disable it to get a usable connection:

  ```python
  settings = await storage.get_settings(config)
  settings.protocols.airplay.mrp_tunnel = MrpTunnel.Disable
  ```

**LG webOS** (`Server: AirTunes/377.x`):

- `POST /play` → `200 OK`, then `PUT /setProperty?isInterestedInDateRange` →
  **`501 Not Implemented`**, and nothing renders. Forcing the AirPlay v1 flow
  (`protocols.raop.protocol_version = AirPlayVersion.V1`) makes the TV drop the
  connection instead. The receiver only implements the audio / mirroring /
  photos subset of AirPlay 2 — there is nothing to fix client-side.

## Root cause

Apple reworked AirPlay 2 video: playback commands moved to binary-plist messages
on the `/command` endpoint, playback state moved from `GET /playback-info`
polling to the **encrypted event channel**, and the HAP verify sequence changed.
pyatv's video path still speaks the legacy AirPlay(v1)-era flow
(`POST /play` + `PUT /setProperty` + polling), which modern receivers accept
politely — status 200 — and ignore. pyatv's AirPlay 2 work so far covers audio
(RAOP) and remote control, not video.

## The fix that works: PR #2846

[postlund/pyatv#2846](https://github.com/postlund/pyatv/pull/2846) ("Fix
compatibility with latest AirPlay", by [@jlacivita](https://github.com/jlacivita))
rewrites exactly the broken pieces:

- the AirPlay 2 video play flow (`protocols/raop/protocols/airplayv2.py`) —
  plist commands instead of the legacy `POST /play` sequence;
- playback state via **event-channel `playbackState` messages**
  (`channels.py`), deleting the `/playback-info` polling that 500s;
- the updated HAP auth handshake (`auth/hap.py`);
- `User-Agent: AirPlay/870.14.1` and header fixes.

As of July 2026 the PR is **open, unreviewed since April 2026, and conflicted
with master** (`mergeable_state: dirty`) — so it isn't in any released pyatv.
The branch is based on a pyatv 0.16.1-era core; expect the settings/storage API
of that generation.

### Verified working recipe (tvOS 18.6)

```python
# pip install https://github.com/jlacivita/pyatv/archive/8848ad3fd9ae46b8eb733bfc667b536a28f04c5a.tar.gz
import asyncio, pyatv
from pyatv.const import Protocol
from pyatv.storage.file_storage import FileStorage

async def main():
    loop = asyncio.get_event_loop()
    storage = FileStorage("creds.json", loop)
    await storage.load()

    confs = await pyatv.scan(loop, identifier="<device id>", timeout=7, storage=storage)
    config = confs[0]

    # One-time pairing. Prerequisite on the Apple TV:
    #   Settings → AirPlay and HomeKit → Allow Access: "Anyone on the Same Network",
    #   and "Require Password" OFF (password mode blocks video streaming entirely).
    handler = await pyatv.pair(config, Protocol.AirPlay, loop, storage=storage)
    await handler.begin()                  # a 4-digit code appears on the TV
    handler.pin(input("code on TV: "))     # feed it promptly — the session times out
    await handler.finish()
    await handler.close()
    await storage.save()

    atv = await pyatv.connect(config, loop, storage=storage)   # default settings work
    asyncio.ensure_future(atv.stream.play_url("https://example.com/video.m3u8"))
    while True:
        await asyncio.sleep(2)
        playing = await atv.metadata.playing()
        print(playing.device_state, playing.position, playing.total_time)

asyncio.run(main())
```

Observed on tvOS 18.6: video renders, and `metadata.playing()` reports live
`DeviceState.Playing` with position/duration (fed by the event channel). No
`MrpTunnel` workaround was needed with the PR build. `remote_control.stop()`
works.

### Practical notes

- **Pin the commit.** The branch can rebase/vanish; the tarball URL above pins
  the SHA we verified (`8848ad3fd9ae46b8eb733bfc667b536a28f04c5a`). Re-verify
  before bumping.
- **No git required** — pip installs GitHub tarballs directly, which matters
  when provisioning end-user machines.
- **Pair promptly.** `handler.pin()` long after `begin()` fails with
  `PairingError('not connected to remote')` — the pair-setup session times out.
- **Track upstream.** When #2846 (or an equivalent) merges, switch back to PyPI
  releases.

## And LG TVs? Use DLNA

Since LG's AirPlay receiver can't do URL video at all, Media Catcher casts to
LG (and other smart TVs) over **DLNA/UPnP AVTransport**, verified on a webOS C2.
The quirks that cost us time, so you don't have to:

- **Bind SSDP M-SEARCH to the LAN interface explicitly** — with a VPN up, the
  multicast otherwise leaves through the tunnel and discovers nothing.
- The renderer **requires DIDL-Lite metadata** in `SetAVTransportURI` — an empty
  `CurrentURIMetaData` gets a SOAP fault.
- The TV **refuses `https://` sources** (fault `716 Resource not found` — it
  probes the URL first). Serve or proxy the media over plain local HTTP, with
  `Range` support and the `contentFeatures.dlna.org` header for seeking.
- The control endpoint returns **500 while the TV switches into its player app**
  (`CurrentTransportState: LG_TRANSITIONING`) — retry `SetAVTransportURI`/`Play`
  for a few seconds instead of giving up.
- First cast from a new source device: the TV shows a **one-time permission
  prompt** that must be accepted with the TV remote — until then, commands are
  accepted but nothing plays.
- `GetPositionInfo` gives real position/duration once playing — good enough to
  drive a full transport UI.

*(2022 LG C-series and newer also gained built-in Chromecast via the webOS 24
update — an alternative sender path we haven't productionized yet.)*

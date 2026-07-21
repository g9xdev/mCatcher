"""LegacyBackend — today's DLNA/UPnP + AirPlay(pyatv) casting behind the
CastBackend socket (Task C4).

Moved VERBATIM from mc_host.py: the DLNA/UPnP stack, the local media server
that feeds both protocols (DLNA renderers refuse https, and AirPlay reuses the
same server), and the AirPlay/pyatv stack. `LegacyBackend` at the bottom is a
thin binding layer onto those functions — the backend implements TRANSPORT
ONLY; the dispatcher (mchost/cast/__init__.py) owns protocol selection,
discovery coalescing, teardown ordering, reply correlation and error
normalization. Unsolicited events go through the `events` sink handed to the
constructor; user-visible failures are raised as CastError.

EVENT SINK: every UNSOLICITED message (poller status pushes, the pyatv
"installing" notice, playback errors) goes out through `_emit()`, which
resolves the module-level `_EVENTS` sink at CALL time. `LegacyBackend.__init__`
points `_EVENTS` at its own `self.events` via `set_events()`, so the moved
poller/callback bodies — which used to call the shim's send() directly — reach
whatever sink the dispatcher handed the backend (the resident's broadcast bus
from phase R on; `_h().send` by default). SOLICITED replies are NOT emitted
here at all: the dispatcher owns those (reqId correlation).

_CAST_SEEN OWNERSHIP: the ONE effective binding is the SHIM's
(`_h()._CAST_SEEN`) — the suite rebinds it there, so every read/write inside
this module goes through `_seen_cache()`, never through this module's own
global. The `_CAST_SEEN = {}` below exists ONLY to seed that shim binding at
import time; after import nothing here reads it, and rebinding
`mchost.cast.legacy._CAST_SEEN` has NO effect. Rebind the shim's.

Cross-module/patched names (send, _hlog, _console_python, _no_window,
_variant_key, and the shim-patched _cast_seen_devices/_CAST_SEEN) resolve
through the mc_host shim at CALL time (`_h().<name>`) so monkeypatched fakes
are always honored — the splitting-modules-under-monkeypatch rule; the warm-
discovery tests patch exactly those names on the shim. HERE comes from
mchost.tools (the same object the shim re-exports, never rebound).

State OWNED here: _DLNA (renderer/media-server registry), _CAST (the pyatv
session), _CAST_SEEN + _CAST_SEEN_TTL (the 90s recent-scan union) and the two
internal locks. The dicts are mutated in place and never rebound, so the
shim's re-exports of _DLNA/_CAST/_CAST_SEEN are the same objects — a
monkeypatch that REBINDS _CAST_SEEN on the shim is still honored, because
every read of it goes through _h().
"""
import os
import re
import subprocess
import sys
import threading
import time

from mchost.cast.backend import CastBackend, CastError
from mchost.tools import HERE


def _h():
    """Call-time shim lookup — see mchost/updates.py for the full rationale."""
    import mc_host
    return mc_host


# ---- the unsolicited-event sink -------------------------------------------
# The moved poller/callback bodies are module-level functions, so they cannot
# reach `self.events`. This indirection is that reach: LegacyBackend points it
# at its own sink on construction, and _emit() resolves it at CALL time, so a
# later rebind (phase R's broadcast bus) is honored by pollers already running.
def _default_events(msg):
    """Default sink: the shim's send(), looked up at call time."""
    _h().send(msg)


_EVENTS = _default_events


def set_events(fn):
    """Point the module's unsolicited-event sink at `fn` (None restores the
    shim-send default). Called by LegacyBackend.__init__."""
    global _EVENTS
    _EVENTS = fn or _default_events


def _emit(msg):
    """Send one UNSOLICITED event. Never used for solicited replies — those
    carry a reqId and belong to the dispatcher."""
    _EVENTS(msg)


# ==================== Casting — DLNA/UPnP (pure stdlib) ====================
# Validated live against an LG webOS OLED (C2): SSDP discover → SetAVTransportURI
# (DIDL-Lite metadata required) → Play → GetPositionInfo poller. Quirks handled:
# the M-SEARCH must be bound to the LAN interface (a VPN otherwise swallows it);
# LG refuses https:// sources (716) so media is always served/proxied over local
# HTTP; the control endpoint 500s while the TV switches apps (LG_TRANSITIONING),
# so SetURI/Play retry.
_DLNA = {"devices": {}, "ctrl": None, "rctrl": None, "poll": None,
         "server": None, "port": 0, "media": {}}


def _lan_ip(target="10.255.255.255"):
    """This PC's LAN-facing IP (UDP-connect trick; no packets are sent)."""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((target, 1900))
        return s.getsockname()[0]
    finally:
        s.close()


def _ssdp_discover(timeout=4):
    """M-SEARCH for DLNA MediaRenderers, bound to the LAN interface."""
    import socket
    lan = _lan_ip()
    msg = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\n"
           'MAN: "ssdp:discover"\r\nMX: 2\r\n'
           "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n").encode()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind((lan, 0))
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    try:
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(lan))
    except Exception:
        pass
    s.settimeout(timeout)
    try:
        s.sendto(msg, ("239.255.255.250", 1900))
        time.sleep(0.1)
        s.sendto(msg, ("239.255.255.250", 1900))   # SSDP is UDP; fire twice
    except Exception:
        pass
    locs = {}
    end = time.time() + timeout
    while time.time() < end:
        try:
            data, addr = s.recvfrom(8192)
        except Exception:
            break
        m = re.search(r"LOCATION:\s*(\S+)", data.decode("utf-8", "replace"), re.I)
        if m:
            locs[addr[0]] = m.group(1).strip()
    s.close()
    return locs


def _dlna_describe(loc, expect_host=None):
    """Fetch a device description; return {name, model, avCtrl, rcCtrl} or None.
    expect_host pins the fetch to the device that answered the SSDP query, so a
    hostile LAN peer can't point us at an arbitrary URL via its LOCATION header."""
    import urllib.request
    import urllib.parse
    import xml.etree.ElementTree as ET
    try:
        parsed = urllib.parse.urlparse(loc)
        if parsed.scheme not in ("http", "https"):
            return None
        if expect_host and parsed.hostname != expect_host:
            return None
        xmlsrc = urllib.request.urlopen(loc, timeout=4).read().decode("utf-8", "replace")
        root = ET.fromstring(xmlsrc)
        ns = {"u": "urn:schemas-upnp-org:device-1-0"}
        av = rc = None
        for svc in root.iter("{urn:schemas-upnp-org:device-1-0}service"):
            stype = svc.findtext("u:serviceType", default="", namespaces=ns)
            curl = svc.findtext("u:controlURL", default="", namespaces=ns)
            if "AVTransport" in stype:
                av = urllib.parse.urljoin(loc, curl) if curl else None
            elif "RenderingControl" in stype:
                rc = urllib.parse.urljoin(loc, curl) if curl else None
        if not av:
            return None
        return {"name": root.findtext(".//u:friendlyName", default="TV", namespaces=ns),
                "model": root.findtext(".//u:modelName", default="", namespaces=ns),
                "avCtrl": av, "rcCtrl": rc}
    except Exception:
        return None


def _dlna_soap(ctrl, service, action, inner, timeout=8):
    """One SOAP call. Returns (status, body); -1 on connection errors."""
    import urllib.request
    import urllib.error
    body = ('<?xml version="1.0" encoding="utf-8"?>'
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
            's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
            '<u:%s xmlns:u="urn:schemas-upnp-org:service:%s:1">%s</u:%s>'
            "</s:Body></s:Envelope>" % (action, service, inner, action)).encode()
    req = urllib.request.Request(ctrl, data=body, headers={
        "Content-Type": 'text/xml; charset="utf-8"',
        "SOAPACTION": '"urn:schemas-upnp-org:service:%s:1#%s"' % (service, action)})
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception:
            return e.code, ""
    except Exception as e:
        return -1, repr(e)


def _dlna_soap_retry(ctrl, service, action, inner, tries=8, delay=1.4):
    """Retry wrapper: LG 500s while switching into its player (LG_TRANSITIONING)."""
    st = body = None
    for _ in range(tries):
        st, body = _dlna_soap(ctrl, service, action, inner)
        if st == 200:
            return st, body
        time.sleep(delay)
    return st, body


# ---- local media server: serve files / proxy remote URLs over plain HTTP ----
# DLNA renderers (LG included) refuse https and need Range support for seeking.
_DLNA_SRV_LOCK = threading.Lock()


def _ensure_media_server():
    with _DLNA_SRV_LOCK:
        return _ensure_media_server_locked()


def _ensure_media_server_locked():
    if _DLNA["server"]:
        return _DLNA["port"]
    import http.server
    import socketserver
    import urllib.request

    class MediaHandler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):          # quiet
            pass

        def _entry(self):
            m = re.match(r"^/m/([0-9a-f]{32})$", self.path)
            return _DLNA["media"].get(m.group(1)) if m else None

        def _common_headers(self, ctype):
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            # DLNA contentFeatures: byte-seek allowed — some TVs ask before seeking.
            self.send_header("contentFeatures.dlna.org",
                             "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000")
            self.send_header("transferMode.dlna.org", "Streaming")

        def do_HEAD(self):
            self._serve(head=True)

        def do_GET(self):
            self._serve(head=False)

        def _serve(self, head):
            ent = self._entry()
            if not ent:
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            try:
                if "path" in ent:
                    self._serve_file(ent["path"], ent.get("ctype", "video/mp4"), head)
                else:
                    self._proxy(ent["url"], ent.get("ctype", "video/mp4"), head)
            except (ConnectionError, BrokenPipeError):
                pass   # player dropped the connection (seek/stop) — normal
            except Exception:
                # Never leave the TV's keep-alive connection hanging with no reply.
                try:
                    self.send_response(502)
                    self.send_header("Content-Length", "0")
                    self.send_header("Connection", "close")
                    self.end_headers()
                except Exception:
                    pass
                self.close_connection = True

        def _serve_file(self, path, ctype, head):
            size = os.path.getsize(path)
            rng = self.headers.get("Range")
            start, end = 0, size - 1
            if rng:
                m = re.match(r"bytes=(\d*)-(\d*)", rng)
                if m:
                    if m.group(1):
                        start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), size - 1)
                    if not m.group(1) and m.group(2):     # suffix range
                        start = max(0, size - int(m.group(2))); end = size - 1
            if rng and (start >= size or start > end):
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % size)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            length = max(0, end - start + 1)
            self.send_response(206 if rng else 200)
            self._common_headers(ctype)
            if rng:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.send_header("Content-Length", str(length))
            self.end_headers()
            if head:
                return
            with open(path, "rb") as f:
                f.seek(start)
                left = length
                while left > 0:
                    chunk = f.read(min(65536, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)

        def _proxy(self, url, ctype, head):
            import urllib.error
            req = urllib.request.Request(url, method="HEAD" if head else "GET")
            rng = self.headers.get("Range")
            if rng:
                req.add_header("Range", rng)
            try:
                up = urllib.request.urlopen(req, timeout=20)
            except urllib.error.HTTPError as e:
                # Forward the upstream failure instead of hanging the connection.
                self.send_response(e.code if 400 <= e.code < 600 else 502)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            with up:
                code = up.status
                self.send_response(code if code in (200, 206) else 200)
                self._common_headers(up.headers.get("Content-Type", ctype))
                have_len = bool(up.headers.get("Content-Length"))
                for h in ("Content-Length", "Content-Range"):
                    if up.headers.get(h):
                        self.send_header(h, up.headers[h])
                if not have_len:
                    # Chunked/unknown-length upstream: no Content-Length to relay, so
                    # end-of-body must be signalled by closing (keep-alive would hang).
                    self.send_header("Connection", "close")
                    self.close_connection = True
                self.end_headers()
                if head:
                    return
                while True:
                    chunk = up.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

    class Srv(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    srv = Srv(("0.0.0.0", 0), MediaHandler)
    _DLNA["server"] = srv
    _DLNA["port"] = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    _h()._hlog("info", "cast: media server on :%d" % _DLNA["port"])
    return _DLNA["port"]


def _dlna_media_url(source, device_ip=None):
    """Register a local path or remote URL; return (LAN URL the TV fetches, ctype)."""
    import uuid
    port = _ensure_media_server()
    token = uuid.uuid4().hex
    ctype = "video/mp4"
    low = source.lower()
    if low.endswith((".mkv", ".webm")):
        ctype = "video/webm" if low.endswith(".webm") else "video/x-matroska"
    elif low.endswith((".m4a", ".mp3", ".aac")):
        ctype = "audio/mp4" if not low.endswith(".mp3") else "audio/mpeg"
    entry = {"url": source, "ctype": ctype} if re.match(r"^https?://", source) \
        else {"path": source, "ctype": ctype}
    # A direct http:// URL could pass through, but proxying always works
    # (https, cookies, and CORS never reach the TV) — so always proxy.
    # Keep the most recent old token alive: if this new cast fails, the previous
    # session may still be streaming and must keep answering Range requests.
    media = dict(list(_DLNA["media"].items())[-1:])
    media[token] = entry
    _DLNA["media"] = media
    # Advertise the interface that actually routes to this TV (multi-homed PCs/VPNs).
    ip = _lan_ip(device_ip) if device_ip else _lan_ip()
    return "http://%s:%d/m/%s" % (ip, port, token), ctype


def _dlna_discover(timeout=5):
    devs = []
    for ip, loc in _ssdp_discover(timeout).items():
        d = _dlna_describe(loc, expect_host=ip)
        if not d:
            continue
        did = "dlna:" + ip
        _DLNA["devices"][did] = d
        devs.append({"id": did, "name": d["name"], "address": ip,
                     "model": d["model"], "protocol": "dlna", "paired": True,
                     "requiresPassword": False})
    return devs


def _hms(sec):
    sec = max(0, int(sec))
    return "%d:%02d:%02d" % (sec // 3600, (sec % 3600) // 60, sec % 60)


def _from_hms(s):
    try:
        parts = [float(p) for p in (s or "0").split(":")]
        while len(parts) < 3:
            parts.insert(0, 0)
        return int(parts[0] * 3600 + parts[1] * 60 + parts[2])
    except Exception:
        return 0


_DLNA_STATE = {"PLAYING": "playing", "PAUSED_PLAYBACK": "paused", "STOPPED": "idle",
               "TRANSITIONING": "loading", "LG_TRANSITIONING": "loading",
               "NO_MEDIA_PRESENT": "idle"}


def _dlna_status(ctrl):
    st1, body = _dlna_soap(ctrl, "AVTransport", "GetTransportInfo", "<InstanceID>0</InstanceID>")
    m = re.search(r"<CurrentTransportState>([^<]+)", body or "")
    state = _DLNA_STATE.get(m.group(1) if m else "", "playing")
    pos = dur = 0
    st2, body = _dlna_soap(ctrl, "AVTransport", "GetPositionInfo", "<InstanceID>0</InstanceID>")
    if st2 == 200 and body:
        pm = re.search(r"<RelTime>([^<]+)", body)
        dm = re.search(r"<TrackDuration>([^<]+)", body)
        pos = _from_hms(pm.group(1)) if pm else 0
        dur = _from_hms(dm.group(1)) if dm else 0
    if st1 != 200 and st2 != 200:
        # TV unreachable / gone — raise so the poller's miss counter can end the session
        raise RuntimeError("status unavailable (%s/%s)" % (st1, st2))
    return {"state": state, "position": pos, "duration": dur}


def _dlna_start(device_id, url, title):
    from xml.sax.saxutils import escape
    dev = _DLNA["devices"].get(device_id)
    if not dev:
        # devices dict is per-process; re-discover to heal after a host restart
        _dlna_discover()
        dev = _DLNA["devices"].get(device_id)
    if not dev:
        raise RuntimeError("Device not found on the network")
    ctrl = dev["avCtrl"]
    device_ip = device_id.split(":", 1)[1] if ":" in device_id else None
    serve, ctype = _dlna_media_url(url, device_ip)
    upnp_class = "object.item.audioItem.musicTrack" if ctype.startswith("audio/") \
        else "object.item.videoItem.movie"
    didl = ('<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" '
            'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" '
            'xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">'
            '<item id="0" parentID="-1" restricted="1"><dc:title>%s</dc:title>'
            "<upnp:class>%s</upnp:class>"
            '<res protocolInfo="http-get:*:%s:DLNA.ORG_OP=01;DLNA.ORG_CI=0;'
            'DLNA.ORG_FLAGS=01700000000000000000000000000000">%s</res>'
            "</item></DIDL-Lite>") % (escape(title or "Media Catcher"), upnp_class,
                                      ctype, escape(serve))
    _dlna_soap(ctrl, "AVTransport", "Stop", "<InstanceID>0</InstanceID>")   # clear any old session
    st, body = _dlna_soap_retry(ctrl, "AVTransport", "SetAVTransportURI",
        "<InstanceID>0</InstanceID><CurrentURI>%s</CurrentURI>"
        "<CurrentURIMetaData>%s</CurrentURIMetaData>" % (escape(serve), escape(didl)))
    if st != 200:
        m = re.search(r"<errorDescription>([^<]*)", body or "")
        raise RuntimeError("TV refused the video (%s)" % (m.group(1) if m else st))
    st, _b = _dlna_soap_retry(ctrl, "AVTransport", "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>")
    if st != 200:
        raise RuntimeError("TV accepted the video but wouldn't start (%s)" % st)
    # Only commit the session controls once the TV has actually accepted playback,
    # so a failed start can't hijack an in-flight session's control endpoints.
    _DLNA["ctrl"], _DLNA["rctrl"] = ctrl, dev.get("rcCtrl")


def _dlna_control(action, value=None):
    ctrl = _DLNA.get("ctrl")
    if not ctrl:
        raise RuntimeError("Not casting")
    if action in ("play", "resume"):
        _dlna_soap_retry(ctrl, "AVTransport", "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>", tries=3)
    elif action == "pause":
        _dlna_soap_retry(ctrl, "AVTransport", "Pause", "<InstanceID>0</InstanceID>", tries=3)
    elif action == "playpause":
        s = _dlna_status(ctrl)
        _dlna_control("pause" if s["state"] == "playing" else "play")
    elif action == "stop":
        _dlna_soap_retry(ctrl, "AVTransport", "Stop", "<InstanceID>0</InstanceID>", tries=3)
    elif action == "seek" and value is not None:
        _dlna_soap_retry(ctrl, "AVTransport", "Seek",
            "<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>%s</Target>" % _hms(value), tries=3)
    elif action == "volume" and value is not None and _DLNA.get("rctrl"):
        _dlna_soap(_DLNA["rctrl"], "RenderingControl", "SetVolume",
            "<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>%d</DesiredVolume>"
            % max(0, min(100, int(value))))


def _cast_session_ended(stop):
    """A poller loop has exited on its OWN terms (played to the end, startup
    timeout, or the device disappeared) — clear the session fields so the
    next admission check sees no live cast. Without this, `busy()` stayed
    true forever after a normal end-of-playback and phase R's drain/update
    admission would never reopen (review of 4d26f8a, Important 2).

    `stop` is the poller's own stop Event and is the session identity: if it
    is no longer the registered one, a re-cast (or an explicit stop, which
    nulls the field itself) already superseded us and owns those fields —
    touching them would clobber the NEW session. That guard is why this is
    inert on the explicit-stop and teardown paths."""
    if _CAST.get("poll") is not stop:
        return
    kind = _CAST.get("kind")
    _CAST["poll"] = None
    _CAST["kind"] = None
    if kind == "airplay":
        # Mirror the explicit-stop path (_cast_stop_active) so the pyatv
        # connection isn't left open on a finished session. DLNA gets no
        # such call on purpose: an end-of-playback Stop would be sent to a
        # TV the user may already have moved on to something else.
        try:
            _cast_run(_cast_teardown(), timeout=15)
        except Exception:
            pass


def _dlna_start_poller(device_id, device_name, title):
    _cast_stop_poller()
    stop = threading.Event()
    _CAST["poll"] = stop
    # Session identity: a dying poller (stopped mid-iteration by a re-cast) must
    # never poll the NEW session's control URL or clobber its status.
    _DLNA["gen"] = _DLNA.get("gen", 0) + 1
    gen = _DLNA["gen"]
    ctrl = _DLNA["ctrl"]

    def loop():
        misses = 0
        idles = 0
        ticks = 0
        while not stop.is_set() and _DLNA.get("gen") == gen:
            ticks += 1
            try:
                st = _dlna_status(ctrl)
                if stop.is_set() or _DLNA.get("gen") != gen:
                    break                       # superseded while we were polling
                # A brief STOPPED can appear while the TV's player is still starting
                # up — only treat idle as end-of-playback once it's stable and past
                # the startup window.
                if st["state"] == "idle":
                    idles += 1
                    if ticks <= 6 or idles < 2:
                        st["state"] = "loading" if ticks <= 6 else st["state"]
                else:
                    idles = 0
                st.update({"type": "cast-status", "id": device_id,
                           "device": device_name, "title": title, "protocol": "dlna"})
                _emit(st)
                misses = 0
                if st["state"] == "idle" and idles >= 2 and ticks > 6:
                    break        # played to the end (or stopped on the TV)
            except Exception:
                misses += 1
                if misses > 5:
                    if _DLNA.get("gen") == gen:   # only end OUR session, not a newer one
                        _emit({"type": "cast-status", "state": "idle"})   # TV gone
                    break
            stop.wait(1.0)
        _cast_session_ended(stop)
    threading.Thread(target=loop, daemon=True).start()


# ==================== Casting — AirPlay via pyatv ====================
# pyatv is self-installed on demand into HERE/pylibs (like ffmpeg/yt-dlp/deno). All
# pyatv work runs on ONE dedicated asyncio loop in a background thread; the sync
# command handlers submit coroutines to it and block for the result on a worker
# thread (never the main read loop). Pairing credentials persist via FileStorage.
_PYLIBS = os.path.join(HERE, "pylibs")
_CAST = {"loop": None, "thread": None, "atv": None, "device_id": None,
         "storage": None, "pairing": None, "poll": None, "play_task": None}


# AirPlay VIDEO is broken in released pyatv on modern receivers (tvOS 17/18+ / webOS);
# the fix is community PR postlund/pyatv#2846, pinned here to the exact commit we
# verified live against an Apple TV 4K (tvOS 18.6). See docs/airplay-modern-receivers.md.
_PYATV_SRC = ("https://github.com/jlacivita/pyatv/archive/"
              "8848ad3fd9ae46b8eb733bfc667b536a28f04c5a.tar.gz")


def ensure_pyatv():
    """Make pyatv (the pinned AirPlay-video fork) importable, installing it into
    HERE/pylibs on first use. Returns bool."""
    if _PYLIBS not in sys.path:
        sys.path.insert(0, _PYLIBS)
    try:
        import pyatv  # noqa: F401
        return True
    except Exception:
        pass
    py = _h()._console_python() or sys.executable
    try:
        os.makedirs(_PYLIBS, exist_ok=True)
        _h()._hlog("info", "casting: installing AirPlay support (pyatv fork, first run ~45 MB)…")
        _emit({"type": "cast-status", "state": "installing"})
        cf, si = _h()._no_window()
        r = subprocess.run([py, "-m", "pip", "install", "--target", _PYLIBS, _PYATV_SRC],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           creationflags=cf, startupinfo=si, timeout=600)
        if r.returncode != 0:
            _h()._hlog("error", "pyatv install failed: %s" % r.stdout.decode("utf-8", "replace")[-500:])
            return False
    except Exception as e:
        _h()._hlog("error", "pyatv install error: %s" % e)
        return False
    try:
        import importlib
        importlib.invalidate_caches()
        import pyatv  # noqa: F401
        _h()._hlog("info", "casting: pyatv ready")
        return True
    except Exception as e:
        _h()._hlog("error", "pyatv import failed after install: %s" % e)
        return False


def _cast_loop():
    if _CAST["loop"] is None:
        import asyncio
        loop = asyncio.new_event_loop()
        _CAST["loop"] = loop
        _CAST["thread"] = threading.Thread(target=loop.run_forever, daemon=True)
        _CAST["thread"].start()
    return _CAST["loop"]


def _cast_run(coro, timeout=40):
    """Submit a coroutine to the cast loop and block for its result (from a worker thread)."""
    import asyncio
    return asyncio.run_coroutine_threadsafe(coro, _cast_loop()).result(timeout)


async def _cast_storage():
    if _CAST["storage"] is None:
        from pyatv.storage.file_storage import FileStorage
        st = FileStorage(os.path.join(HERE, "cast_creds_%s.json" % _h()._variant_key()), _cast_loop())
        try:
            await st.load()
        except Exception:
            pass
        _CAST["storage"] = st
    return _CAST["storage"]


async def _find_config(device_id, timeout=6):
    import pyatv
    st = await _cast_storage()
    results = await pyatv.scan(_cast_loop(), identifier=device_id, timeout=timeout, storage=st)
    if not results:
        raise RuntimeError("Device not found on the network")
    return results[0]


# Recently-seen cast devices (address -> {"d": device, "ts": epoch}). SSDP (UDP
# multicast) and mDNS are both lossy, so a single scan often misses a device that
# was there last time; returning the union of the last ~90s of scans makes the
# picker stable instead of flickering between the DLNA and AirPlay TVs.
# SEED ONLY — the shim's re-export of this object is the single owner of the
# cache (see the module docstring). Nothing below reads this global; every
# access goes through _seen_cache(), so rebinding it HERE does nothing while
# rebinding it on the shim (which the suite does) is honored.
_CAST_SEEN = {}
_CAST_SEEN_TTL = 90
# _CAST_SEEN's own short lock (round-4 plan review I4): warm cache reads
# deliberately bypass the dispatcher's scan coalescing (they must not wait
# behind a live scan), so the dict itself needs guarding against read-prune
# vs scan-write races. The lock is internal; the DICT is reached through
# _seen_cache() (the shim's binding — the owner), never this module's global.
_CAST_SEEN_LOCK = threading.Lock()


def _seen_cache():
    """The ONE effective binding of the recent-scan cache: the shim's. Read at
    CALL time so a rebind there (the suite does exactly that) is honored."""
    return _h()._CAST_SEEN


def _cast_seen_devices(now=None):
    """The picker list from the recent-scan union cache ONLY — no network.
    Expired entries are pruned in passing. _CAST_SEEN_LOCK guards the prune
    (round-4 plan review I4): a warm request reads/prunes this dict while a
    concurrent scan (inside the dispatcher's coalesced scan, which the warm
    path deliberately does NOT wait on — the warm reply must not wait behind
    a 5s scan) writes it; two warm readers can also race deleting the same
    expired key.
    `now` lets _cast_merged_discover prune against the SAME timestamp it
    stamped results with (review of cf5403d, Minor 1: re-capturing time here
    could expire an entry the pre-extraction code retained)."""
    if now is None:
        now = time.time()
    out = []
    seen = _seen_cache()        # the shim's binding — the ONE effective owner
    with _CAST_SEEN_LOCK:
        for addr in list(seen):
            if now - seen[addr]["ts"] > _CAST_SEEN_TTL:
                del seen[addr]
                continue
            out.append(seen[addr]["d"])
    return out


def _is_apple_tv(d):
    return "apple tv" in ((d.get("model") or "") + " " + (d.get("name") or "")).lower()


def _cast_merged_discover(timeout=5):
    # Overlap the two scans (AirPlay on the cast loop, DLNA on this thread) so the
    # picker isn't the sum of both timeouts.
    import asyncio
    air_future = None
    if ensure_pyatv():
        try:
            air_future = asyncio.run_coroutine_threadsafe(_cast_discover(max(5, timeout)), _cast_loop())
        except Exception:
            air_future = None
    found = {}
    # DLNA first — preferred for any device that speaks BOTH (e.g. LG advertises DLNA
    # *and* AirPlay, but only its DLNA video actually works), keyed by device address.
    for d in _dlna_discover(timeout):
        found[d["address"]] = d
    if air_future is not None:
        try:
            for d in air_future.result(30):
                if d["address"] in found:
                    continue          # a DLNA renderer already covers this device
                if not _is_apple_tv(d):
                    continue          # non-Apple AirPlay video is unreliable/unsupported
                found[d["address"]] = d
        except Exception as e:
            _h()._hlog("warn", "cast: AirPlay scan failed: %s" % e)
    now = time.time()
    seen = _seen_cache()        # the shim's binding — the ONE effective owner
    with _CAST_SEEN_LOCK:
        for addr, d in found.items():
            seen[addr] = {"d": d, "ts": now}
    return _h()._cast_seen_devices(now)


async def _cast_discover(timeout=6):
    import pyatv
    from pyatv.const import Protocol
    st = await _cast_storage()
    results = await pyatv.scan(_cast_loop(), timeout=timeout, storage=st)
    out = []
    for a in results:
        svc = a.get_service(Protocol.AirPlay)
        if not svc:
            continue
        out.append({"id": a.identifier, "name": a.name, "address": str(a.address or ""),
                    "model": (str(a.device_info) if a.device_info else ""), "protocol": "airplay",
                    "paired": bool(getattr(svc, "credentials", None)),
                    "requiresPassword": bool(getattr(svc, "requires_password", False))})
    return out


async def _cast_pair_begin(device_id):
    import pyatv
    from pyatv.const import Protocol
    await _cast_pair_cancel()          # close any prior handler first (retry / re-begin)
    st = await _cast_storage()
    config = await _find_config(device_id)
    handler = await pyatv.pair(config, Protocol.AirPlay, _cast_loop(), storage=st)
    await handler.begin()
    _CAST["pairing"] = handler
    return bool(handler.device_provides_pin)


async def _cast_pair_cancel():
    handler = _CAST.get("pairing")
    if handler:
        try:
            await handler.close()
        except Exception:
            pass
    _CAST["pairing"] = None


async def _cast_pair_pin(pin):
    handler = _CAST.get("pairing")
    if not handler:
        raise RuntimeError("No pairing in progress")
    handler.pin(str(pin))
    await handler.finish()
    ok = bool(handler.has_paired)
    try:
        await handler.close()
    except Exception:
        pass
    if ok:
        await (await _cast_storage()).save()
    _CAST["pairing"] = None
    return ok


async def _cast_start(device_id, url):
    import asyncio, pyatv
    from pyatv.const import Protocol
    await _cast_teardown()
    st = await _cast_storage()
    config = await _find_config(device_id)
    svc = config.get_service(Protocol.AirPlay)
    if svc is not None and getattr(svc, "requires_password", False):
        # tvOS "Require Password" enforces the password at the stream layer, which pyatv
        # can't satisfy for video — pairing succeeds but play always 401s.
        raise RuntimeError("requires_password")
    # Serve/proxy the media over local HTTP so https, cookies, and referers are handled
    # host-side and the receiver just fetches a plain URL (same media server as DLNA).
    serve, _ct = _dlna_media_url(url, str(config.address) if getattr(config, "address", None) else None)
    # The pinned fork speaks modern AirPlay 2 video with default settings — no MRP-tunnel
    # workaround, and playback state comes from the event channel (no /playback-info 500).
    atv = await pyatv.connect(config, _cast_loop(), storage=st)
    _CAST["atv"] = atv
    _CAST["device_id"] = device_id
    _CAST["kind"] = "airplay"
    task = asyncio.ensure_future(atv.stream.play_url(serve))
    def _done(t):
        try:
            exc = t.exception()
        except Exception:
            exc = None
        if exc and not isinstance(exc, asyncio.CancelledError):
            # play_url returns when playback ends; a real error before that is worth showing.
            _emit({"type": "cast-error", "error": _cast_err(str(exc))})
    task.add_done_callback(_done)
    _CAST["play_task"] = task
    return True


async def _cast_status_once():
    atv = _CAST.get("atv")
    if not atv:
        return {"state": "idle"}
    pl = await atv.metadata.playing()
    raw = pl.device_state.name.lower() if pl.device_state else ""
    state = "idle" if raw in ("idle", "stopped", "") else ("playing" if raw == "seeking" else raw)
    return {"state": state, "position": pl.position or 0,
            "duration": pl.total_time or 0, "title": pl.title or ""}


async def _cast_control(action, value=None):
    atv = _CAST.get("atv")
    if not atv:
        raise RuntimeError("Not casting")
    rc = atv.remote_control
    if action == "playpause":
        await rc.play_pause()
    elif action == "play":
        await rc.play()
    elif action == "pause":
        await rc.pause()
    elif action == "stop":
        await rc.stop()
    elif action == "seek" and value is not None:
        await rc.set_position(int(value))
    elif action == "volume" and value is not None:
        await atv.audio.set_volume(float(value))
    return True


async def _cast_teardown():
    task = _CAST.get("play_task")
    if task and not task.done():
        task.cancel()
    _CAST["play_task"] = None
    atv = _CAST.get("atv")
    if atv:
        try:
            atv.close()
        except Exception:
            pass
    _CAST["atv"] = None
    _CAST["device_id"] = None
    _CAST["kind"] = None


def _cast_err(s):
    low = (s or "").lower()
    if "requires_password" in low:
        return ("Turn off “Require Password” on the Apple TV (Settings → AirPlay and HomeKit "
                "→ Allow Access) to cast — that mode blocks streaming. Then try again.")
    if "auth" in low or "credential" in low or "pair" in low or "pin" in low:
        return "This TV needs pairing — click Cast again and enter the code shown on the TV."
    if "not found" in low or "no device" in low:
        return "TV not found — make sure it's on and on the same network."
    if "connect" in low or "timeout" in low or "unreachable" in low:
        return "Couldn't reach the TV. Check it's awake and on the same Wi-Fi."
    return "Casting failed: " + (s or "")[:180]


def _cast_start_poller(device_id, device_name, title):
    _cast_stop_poller()
    stop = threading.Event()
    _CAST["poll"] = stop

    def loop():
        misses = 0
        idles = 0
        ticks = 0
        started = False       # has the stream ever actually played?
        while not stop.is_set():
            ticks += 1
            try:
                st = _cast_run(_cast_status_once(), timeout=10)
                if st["state"] in ("playing", "paused"):
                    started = True
                    idles = 0
                elif st["state"] == "idle":
                    idles += 1
                # Before playback truly begins the TV reports idle while buffering — show
                # "loading" instead, and never treat that startup idle as end-of-playback.
                out = dict(st)
                out["state"] = st["state"] if started else "loading"
                out.update({"type": "cast-status", "id": device_id,
                            "device": device_name, "title": title or st.get("title", ""),
                            "protocol": "airplay"})
                _emit(out)
                misses = 0
                if started and st["state"] == "idle" and idles >= 2:
                    break        # played, then stopped/ended
                if not started and ticks > 25:
                    _emit({"type": "cast-status", "state": "idle"})   # never started in ~25s
                    break
            except Exception:
                misses += 1
                if misses > 5:
                    _emit({"type": "cast-status", "state": "idle"})   # device gone
                    break
            stop.wait(1.0)
        _cast_session_ended(stop)
    threading.Thread(target=loop, daemon=True).start()


def _cast_stop_poller():
    if _CAST.get("poll"):
        _CAST["poll"].set()
        _CAST["poll"] = None


def _cast_stop_active():
    """Tear down whatever is currently casting (either protocol) before a new cast
    or an explicit stop. Without this, switching between an AirPlay TV and a DLNA TV
    orphaned the previous session and left control/stop routed at the wrong one."""
    _cast_stop_poller()
    if _CAST.get("kind") == "airplay":
        try:
            _cast_run(_cast_teardown(), timeout=15)
        except Exception:
            pass
    elif _DLNA.get("ctrl"):
        try:
            _dlna_control("stop")
        except Exception:
            pass
        _DLNA["ctrl"] = None
        _DLNA["rctrl"] = None
    _CAST["kind"] = None


class LegacyBackend(CastBackend):
    name = "legacy"

    def __init__(self, events):
        super().__init__(events)
        # The moved poller/callback bodies are module-level and cannot see
        # `self` — point the module sink at ours so THEIR unsolicited events
        # reach the dispatcher's sink too (phase R: the broadcast bus),
        # instead of the shim's raw send().
        set_events(self.events)

    def discover(self, timeout=5):
        # The union-of-recent-scans merge of the DLNA and AirPlay scans.
        return _h()._cast_merged_discover(timeout)

    def seen_devices(self):
        # Cache-only (no network) — the warm reply's source.
        return _h()._cast_seen_devices()

    def start(self, req):
        """The old handle_cast start arm, with the protocol TOLD to us
        (dispatcher-selected) instead of re-derived, and the CONTRACT order
        of backend.py enforced: dependency setup -> `loading` -> transport ->
        poller. The loading status must precede the TRANSPORT call, not just
        the poller (review of aedec78, Important 1): play_url's error
        callback and the DLNA start can both produce a cast event, so
        emitting loading afterwards let a failure reach the popup before it
        knew a cast had begun."""
        h = _h()
        did = req.get("id") or ""
        dname = req.get("device", "")
        title = req.get("title", "")
        if req.get("protocol") == "dlna":
            # No dependency setup for DLNA (pure stdlib) — loading goes first.
            self.events({"type": "cast-status", "state": "loading", "id": did,
                         "device": dname, "title": title, "protocol": "dlna"})
            h._dlna_start(did, req.get("url") or "", title)
            h._CAST["kind"] = "dlna"
            h._dlna_start_poller(did, dname, title)
        else:
            if not h.ensure_pyatv():                                   # setup
                raise CastError("Couldn't set up AirPlay support.")
            self.events({"type": "cast-status", "state": "loading", "id": did,
                         "device": dname, "title": title, "protocol": "airplay"})
            h._cast_run(h._cast_start(did, req.get("url") or ""), timeout=40)   # sets kind=airplay
            h._cast_start_poller(did, dname, title)

    def control(self, action, value=None):
        h = _h()
        if h._CAST.get("kind") == "airplay":
            h._cast_run(h._cast_control(action, value), timeout=15)
        else:
            h._dlna_control(action, value)

    def stop(self):
        # Tears down whichever protocol is live, plus the status poller.
        _h()._cast_stop_active()

    def pair_begin(self, device_id):
        h = _h()
        if not h.ensure_pyatv():
            raise CastError("Pairing needs AirPlay support — install failed.")
        return h._cast_run(h._cast_pair_begin(device_id), timeout=30)

    def pair_pin(self, pin):
        h = _h()
        return h._cast_run(h._cast_pair_pin(pin), timeout=30)

    def pair_cancel(self):
        h = _h()
        try:
            h._cast_run(h._cast_pair_cancel(), timeout=10)
        except Exception:
            pass

    def busy(self):
        """Is a cast session live? (Phase R feeds this to the resident-wide
        ActivityRegistry so a self-update can't swap code mid-playback.)"""
        cast = _h()._CAST
        return bool(cast.get("kind")) or bool(cast.get("poll"))

    def shutdown(self):
        """Process exit / backend swap: drop any pairing, then the session."""
        self.pair_cancel()
        try:
            self.stop()
        except Exception:
            pass

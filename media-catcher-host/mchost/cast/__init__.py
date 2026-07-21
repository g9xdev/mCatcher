"""The cast dispatcher — `handle_cast` and everything ABOVE the transport.

This package is the socket the casting implementations plug into (Task C4).
`backend.py` defines the CastBackend interface + `get_backend()`; `legacy.py`
is today's DLNA/AirPlay implementation. The split of duties:

  DISPATCHER (here)                      BACKEND (legacy.py, engine later)
  ---------------------------------      ---------------------------------
  worker thread + reqId correlation      device discovery / transport
  warm-discovery protocol (cached        session start / control / stop
    reply, ALWAYS a final:true update)   pairing transport
  discovery coalescing (one in-flight    protocol-specific pollers
    scan, result fanned out to ALL
    waiters — including ones past
    their bounded wait — round-3 I6)
  teardown-before-start ordering
  error normalization (CastError ->
    verbatim; anything else -> _cast_err)
  the events sink handed to the backend

Cross-module/patched names (send, _hlog, _cast_err) resolve through the
mc_host shim at CALL time (`_h().<name>`) so monkeypatched fakes are always
honored — the splitting-modules-under-monkeypatch rule.
"""
import threading

from mchost.cast.backend import CastBackend, CastError, get_backend   # noqa: F401


def _h():
    """Call-time shim lookup — see mchost/updates.py for the full rationale."""
    import mc_host
    return mc_host


# ---- discovery coalescing (plan v4, round-3 I6) ---------------------------
# Hover + click can both trigger discovery, and two concurrent legacy scans
# mutate _CAST_SEEN mid-iteration. This replaces the interim _DISCOVER_LOCK
# that lived in the shim: instead of merely serializing scans, a request that
# arrives while a scan is in flight ATTACHES to it and receives that scan's
# result (or its exception) — one network scan, N answers.
_SCAN_LOCK = threading.Lock()
_SCAN = {"current": None}
# How long a WARM request waits on an in-flight scan before handing its final
# over to the leader (see _coalesced_discover's `late`). A module constant so
# the suite can shrink it instead of sleeping through the real bound.
_WARM_WAIT = 8


class DiscoverBusy(Exception):
    """A bounded wait for the in-flight scan expired (warm requests only)."""


def _coalesced_discover(backend, timeout, wait=None, late=None):
    """One scan at a time, result fanned out. `wait` bounds how long a
    non-leader waits for the in-flight scan (None = wait indefinitely, which
    is what a plain — non-warm — discover did under the old lock).

    `late` makes the fan-out UNCONDITIONAL: a bounded waiter that runs out of
    time hands over `late(result, error)`, which the LEADER calls the moment
    its scan finishes, and then raises DiscoverBusy. Without it, a warm
    follower that timed out was relying on the leader publishing its own
    unsolicited final — which a PLAIN (non-warm) leader never does, since its
    only output is a reqId-correlated reply to ITS connection (review of
    aedec78, Important 3). Every attached waiter gets the leader's devices,
    or its exception, whatever kind the leader is."""
    with _SCAN_LOCK:
        scan = _SCAN["current"]
        leader = scan is None
        if leader:
            scan = _SCAN["current"] = {"done": threading.Event(), "result": None,
                                       "error": None, "late": []}
    if leader:
        try:
            scan["result"] = backend.discover(timeout)
        except BaseException as e:      # noqa: BLE001 — re-raised below
            scan["error"] = e
        finally:
            with _SCAN_LOCK:
                _SCAN["current"] = None
                # done is set UNDER the lock, and the late list drained with
                # it, so a waiter that loses the race between its expiring
                # wait and this completion can't attach to a finished scan
                # (it sees done and takes the result path instead).
                scan["done"].set()
                pending, scan["late"] = scan["late"], []
            for cb in pending:
                try:
                    cb(scan["result"], scan["error"])
                except Exception as e:      # a waiter must not kill the scan
                    _h()._hlog("warn", "cast: discovery fan-out failed: %s" % e)
    elif not scan["done"].wait(wait):
        with _SCAN_LOCK:
            if not scan["done"].is_set():
                if late is not None:
                    scan["late"].append(late)
                raise DiscoverBusy()
        # It completed inside that gap — fall through to its result.
    if scan["error"] is not None:
        raise scan["error"]
    return scan["result"]


def handle_cast(req):
    """Run a cast:* subcommand on a worker thread. Two protocols: DLNA/UPnP
    (pure stdlib, id prefix "dlna:") and AirPlay (via the pinned pyatv fork,
    any other id) — the backend implements both; this dispatcher owns the
    protocol-independent wire behavior. The popup pairs an AirPlay device
    (PIN) before casting if it isn't paired yet."""
    def worker():
        def send(msg):
            _h().send(msg)
        sub = req.get("sub")
        reqid = req.get("reqId")
        backend = get_backend()
        try:
            if sub == "discover":
                # Deterministic + stable: DLNA preferred over AirPlay per device,
                # AirPlay limited to Apple TVs, union of recent scans (see backend).
                if req.get("warm"):
                    cached = backend.seen_devices()
                    send({"type": "cast-devices", "reqId": reqid, "warm": True,
                          "devices": cached})
                    # ALWAYS send the completion update, even when the rescan
                    # THROWS (plan v4: an exception used to fall out to the
                    # generic cast-error while the warm reply had already
                    # consumed the picker's pending resolver — an empty picker
                    # then spun on "Scanning…" forever). final:true is the
                    # scan-complete signal; on error the devices payload is
                    # the cached list plus an "error" string.
                    def final(devices, error=None):
                        upd = {"type": "cast-devices-update", "devices": devices,
                               "final": True}
                        if error:
                            upd["error"] = error
                        send(upd)

                    def failed(e):
                        # Swallow, don't re-raise (review of 3eacdae, Important):
                        # the final+error update IS the failure signal; a
                        # re-raise ALSO emitted the worker's generic cast-error,
                        # which the extension treats as a SESSION error — it
                        # cleared castState and could dismiss an active pairing
                        # PIN dialog mid-entry.
                        _h()._hlog("warn", "cast: warm rescan failed: %s" % e)
                        final(cached, _h()._cast_err(str(e)))

                    def late(result, error):
                        # Runs on the LEADER's thread once its scan finishes:
                        # THIS request's final, delivered however long the scan
                        # took. Deferred, never dropped.
                        if error is not None:
                            failed(error)
                        else:
                            final(result)

                    try:
                        # Bounded wait: a scan in flight can run for 30s
                        # (AirPlay wait) or even 600s (first-run pyatv
                        # install) — this worker must not sit on it. Past the
                        # bound the final is handed to the leader (`late`)
                        # rather than answered from cache, because the leader
                        # may be a PLAIN discover whose only output is its own
                        # solicited reply (review of aedec78, Important 3).
                        fresh = _coalesced_discover(backend, req.get("timeout", 5),
                                                    wait=_WARM_WAIT, late=late)
                    except DiscoverBusy:
                        return                     # `late` sends this final
                    except Exception as e:
                        failed(e)
                    else:
                        final(fresh)
                    return
                devices = _coalesced_discover(backend, req.get("timeout", 5))
                send({"type": "cast-devices", "reqId": reqid, "devices": devices})
            elif sub == "start":
                # Teardown ordering is the DISPATCHER's call: whatever is
                # casting now (either protocol) dies before the new session
                # starts, or switching TVs orphans the old one and leaves
                # control/stop routed at the wrong device.
                backend.stop()
                # Protocol selection stays HERE (the "dlna:" id prefix is
                # wire protocol, not transport): the backend is told which
                # one to run, it does not re-derive the choice.
                did = req.get("id") or ""
                backend.start(dict(req, protocol="dlna" if did.startswith("dlna:")
                                   else "airplay"))
            elif sub == "control":
                backend.control(req.get("action"), req.get("value"))
            elif sub == "stop":
                backend.stop()
                send({"type": "cast-status", "state": "idle"})
            elif sub == "pairCancel":
                backend.pair_cancel()
            elif sub == "pair":
                needs = backend.pair_begin(req.get("id") or "")
                send({"type": "cast-pair", "reqId": reqid,
                      "id": req.get("id") or "", "needsPin": needs})
            elif sub == "pairPin":
                ok = backend.pair_pin(req.get("pin"))
                send({"type": "cast-paired", "reqId": reqid,
                      "id": req.get("id") or "", "ok": ok})
        except CastError as e:
            # Already user-facing (the backend authored it) — sent verbatim,
            # exactly as the old inline ensure_pyatv failures were.
            send({"type": "cast-error", "reqId": reqid, "error": str(e)})
        except Exception as e:
            send({"type": "cast-error", "reqId": reqid, "error": _h()._cast_err(str(e))})
    threading.Thread(target=worker, daemon=True).start()

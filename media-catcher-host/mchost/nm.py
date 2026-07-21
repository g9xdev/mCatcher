"""Native-messaging stdio framing (moved verbatim from mc_host.py — Task C1).

IN/OUT are owned HERE (single-ownership rule): init_io rebinds them in this
module's namespace, and send/read_message read them from here. The mc_host
shim re-exports the functions only — a shim copy of IN/OUT would go stale the
moment init_io ran.
"""
import json
import os
import struct
import threading

# ---- stdio (bound in init_io so importing this module has no side effects) ----
IN = None
OUT = None
_write_lock = threading.Lock()


def init_io():
    """Bind fd 0/1 in binary mode. Works under pythonw where sys.stdin is None."""
    global IN, OUT
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(0, os.O_BINARY)
        msvcrt.setmode(1, os.O_BINARY)
    IN = os.fdopen(0, "rb", 0)
    OUT = os.fdopen(1, "wb", 0)


def send(msg):
    data = json.dumps(msg).encode("utf-8")
    with _write_lock:
        OUT.write(struct.pack("@I", len(data)))
        OUT.write(data)
        OUT.flush()


def read_message():
    raw = IN.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("@I", raw)
    if length == 0:
        return {}
    data = IN.read(length)
    if len(data) < length:
        return None
    return json.loads(data.decode("utf-8"))

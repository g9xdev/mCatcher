"""Tool discovery + shared paths (moved verbatim from mc_host.py — Task C1)."""
import os
import re
import shutil
import tempfile

# ---- tool discovery ----
# mc_host.py derived HERE from its own location; this module lives one level
# down (mchost/), so HERE is the package's PARENT — the same host directory.
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def find_ffmpeg():
    exe = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    local = os.path.join(HERE, exe)
    if os.path.isfile(local):
        return local
    return shutil.which("ffmpeg")


FFMPEG = find_ffmpeg()
TMPDIR = os.path.join(tempfile.gettempdir(), "media-catcher")
os.makedirs(TMPDIR, exist_ok=True)


def downloads_dir():
    d = os.path.join(os.path.expanduser("~"), "Downloads")
    return d if os.path.isdir(d) else os.path.expanduser("~")


def sanitize(name):
    """A recording's display name, made into a filename stem.

    The caller supplies the stem and the HOST supplies the suffix (".mp4",
    " (partial).mp4"), so unlike a downloaded file's name there is nothing to
    refuse here -- refusing would lose a finished recording the user cannot
    get back. A Windows device name is coerced instead: a base of "con"
    produced "con.mp4", which is the console device in every directory, not a
    file. guard.neutralize_device_name owns that rule so the device list has
    one home.
    """
    from mchost import guard

    name = re.sub(r'[\\/:*?"<>|]+', "_", name or "recording").strip()
    return guard.neutralize_device_name(name[:120] or "recording")

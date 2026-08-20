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


# ---- BadApple ----
#
# The popup's third file action hands a finished download to BadApple, a
# separate player. WHICH PROGRAM RUNS IS DECIDED HERE and nowhere else.
#
# The extension names the file; it never names the program. That split is the
# whole security content of the feature: a command carrying an executable path
# is not "open this video in a player", it is "run this", which is the sandbox
# escape guard.refuse_open exists to close. So the candidates below are a fixed
# list compiled into the host — not a setting, not a config key, not a field on
# the message. Nothing the extension can write is read on this path.
#
# One candidate today: the per-user location BadApple's installer writes to.
# Adding another means editing this list, which is the intended way to extend
# it. test_boundary.py pins that a config file next to the host cannot answer
# the question instead.
def _badapple_candidates():
    local = os.environ.get("LOCALAPPDATA") or ""
    if not local:
        return []
    return [os.path.join(local, "Programs", "BadApple", "BadApple.App.exe")]


def find_badapple():
    """The installed BadApple executable, or None if it is not installed.

    Probed per call rather than cached at import (as FFMPEG is) so an install
    that happens while Firefox is already up is picked up by the next
    heartbeat, instead of staying "not installed" for the whole session.
    """
    for path in _badapple_candidates():
        if os.path.isfile(path):
            return path
    return None


# The folder the updater watches, and the reason it is not Downloads.
#
# _install_updates matches candidate packages on a filename prefix and then
# offers to hand them to the guardian. The only thing between a package and the
# guardian is a Yes/No dialog, shown to the one user who turned auto-update on
# and is therefore expecting one. While this folder defaulted to downloads_dir()
# any web page could put "media-catcher-host-9.9.9.zip" in front of that dialog
# with an ordinary drive-by download; the browser writes there unprompted, which
# is the whole vector.
#
# HERE is the host's own install directory. It is the right owner because the
# host already treats it as its private state: mc_config_*.json is written
# there, install.ps1 drops ffmpeg.exe there, and the guardian's host apply is an
# overlay write (McHostSafe.ApplyHostZip walks the zip's own entries) rather
# than a wipe, so a subfolder survives a host update. Nothing but the host and
# its installer writes into it.
def update_staging_dir():
    """The host-owned folder update packages are staged in, created if absent.

    Returns the path whether or not the mkdir succeeded — start_watch's own
    os.path.isdir check is what decides whether watching is possible, and
    github_stage_release makedirs again before it writes. A read-only install
    directory therefore degrades to "no local staging", not to a crash.
    """
    d = os.path.join(HERE, "updates")
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return d


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

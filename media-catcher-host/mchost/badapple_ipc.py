"""BadApple's single-instance IPC pipe: the one route a credential may take.

WHY THIS MODULE EXISTS, AND WHY IT IS NOT A COMMAND LINE
--------------------------------------------------------
`handle_badapple` has always started BadApple with `--beam <target>` on argv,
and for a beam that carries no sign-in that is still exactly right. A beam that
DOES carry one cannot go that way, and the reason is not style. Quoting
BadApple's own wire contract (docs/protocol/wire-contract.json, "ipc"):

    Do NOT launch it as `BadApple.App.exe --beam <target> --headers <token>`:
    argv is readable by every process running as this user
    (Win32_Process.CommandLine), which is the whole reason the credential field
    exists on this pipe and not on the command line. argv accepts
    `--beam <target>` and nothing else.

A command line is world-readable within the session for as long as the process
lives, and on Windows it survives in ETW traces and crash dumps besides. So a
credential goes down a pipe whose ACL names one user, and nothing else changes.

WHAT THIS MODULE DOES NOT DO
----------------------------
It does not log. Not the line, not the token, not the target. The line it
writes is the single most sensitive string this host ever composes, and there
is no diagnostic worth having that is worth a cookie in mc_host.log. BadApple's
own shell redacts this line positionally before writing it to shell.log
(BeamSource.ForLog) precisely because someone there learned this the hard way;
the cheapest way not to repeat it on this side is to never write the line down
at all. `send_beam` raises on failure and the CALLER answers the click with a
sentence that names no value.

THE FRAMING IS NOT A CIPHER
---------------------------
The token is base64 of a small JSON object. BadApple's contract is blunt about
what that buys -- "IT IS A FRAMING, NOT A CIPHER -- the token is exactly as
secret as the cookie inside it" -- and it exists because a cookie value may
legally contain spaces, semicolons and double quotes (RFC 6265), so the quoting
rule that makes the target one field does not hold for it. base64's alphabet
has neither whitespace nor quotes, so the value is always exactly one token
with no escaping for a second implementation to get wrong.
"""
import base64
import ctypes
import json
import os
import subprocess
import time
from ctypes import wintypes

# The flags, spelled as BadApple's SingleInstance.cs spells them. Their parser
# matches both with StringComparison.Ordinal -- case-SENSITIVE -- so these are
# not free to be prettied up.
BEAM_FLAG = "--beam"
HEADERS_FLAG = "--headers"

# ipc.transport.name: "\\.\pipe\badapple-cmd-<SessionId>, where <SessionId> is
# the writer's own Windows session id".
PIPE_PREFIX = r"\\.\pipe\badapple-cmd-"

# How long to wait for a BadApple we started ourselves to put its pipe up. A
# cold start on a spinning disk is seconds; this is not a latency budget, it is
# the point at which "it never came up" is the truer answer than "wait more".
LAUNCH_TIMEOUT_S = 20.0
_POLL_S = 0.1

_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
_GENERIC_WRITE = 0x40000000
_OPEN_EXISTING = 3
_ERROR_FILE_NOT_FOUND = 2
_ERROR_PIPE_BUSY = 231
_SE_KERNEL_OBJECT = 6
_OWNER_SECURITY_INFORMATION = 0x00000001
_TOKEN_QUERY = 0x0008
_TOKEN_USER = 1


class BeamPipeError(Exception):
    """The line could not be delivered. Carries no credential, by construction:
    every message raised below is a fixed English sentence."""


# ---------------------------------------------------------------------------
# The token and the line
#
# Pure functions, so the suite can assert them against BadApple's own worked
# examples byte for byte instead of against a second call to this code.
# ---------------------------------------------------------------------------

def encode_headers(canonical):
    """base64 of the UTF-8 JSON object BadApple will read back.

    `canonical` must already have passed guard.normalize_beam_headers: names in
    BadApple's casing, values plain strings. Separators are tightened to
    (",", ":") so the JSON matches the shape their contract worked through --
    {"Cookie":"sid=1"} -> eyJDb29raWUiOiJzaWQ9MSJ9 -- though only the DECODED
    object has to agree, since their side deserializes rather than compares.

    ensure_ascii stays on (the default): their decoder is UTF-8 and would read
    raw non-ASCII fine, but \\uXXXX keeps the token inside base64's assumptions
    about byte length and costs nothing.
    """
    blob = json.dumps(canonical, separators=(",", ":"), sort_keys=False)
    return base64.b64encode(blob.encode("utf-8")).decode("ascii")


def format_beam_command(target, token=None):
    """The one line this host writes to the pipe.

    ipc.line.grammar: `--beam "<target>" [--headers <token>]`.

    The target is ALWAYS quoted, including when there is no credential. Their
    parser accepts a bare target and reads it to the end of the line -- a
    Windows path may contain spaces and has no closing mark -- so only a quoted
    target has an end for a second field to follow. Quoting unconditionally
    means the shape does not change when a credential appears, which is one
    fewer thing to get right at the moment it matters. `"` cannot appear in a
    Windows path and does not appear in a URL, so nothing needs escaping.

    The token is written BARE and LAST. Terminal is not decoration: their log
    redaction cuts from the flag to the end of the line positionally, and that
    is what makes the cut total.
    """
    line = '%s "%s"' % (BEAM_FLAG, target)
    if token:
        line += " %s %s" % (HEADERS_FLAG, token)
    return line


def session_id():
    """This process's Windows session id.

    The pipe NAME is machine-global while CurrentUserOnly scopes only its ACL,
    so without this suffix a forward from one interactive session of a user
    could be delivered to another session's window.
    """
    sid = wintypes.DWORD()
    if not _kernel32().ProcessIdToSessionId(os.getpid(), ctypes.byref(sid)):
        raise BeamPipeError("This computer's session could not be identified.")
    return int(sid.value)


def pipe_name():
    return PIPE_PREFIX + str(session_id())


# ---------------------------------------------------------------------------
# Win32
# ---------------------------------------------------------------------------

_K32 = None
_A32 = None


def _kernel32():
    global _K32
    if _K32 is None:
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD,
                                  wintypes.HANDLE]
        k.CreateFileW.restype = wintypes.HANDLE
        k.WriteFile.argtypes = [wintypes.HANDLE, wintypes.LPCVOID, wintypes.DWORD,
                                ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
        k.WriteFile.restype = wintypes.BOOL
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        k.ProcessIdToSessionId.argtypes = [wintypes.DWORD,
                                           ctypes.POINTER(wintypes.DWORD)]
        k.ProcessIdToSessionId.restype = wintypes.BOOL
        k.LocalFree.argtypes = [wintypes.HANDLE]
        k.GetCurrentProcess.restype = wintypes.HANDLE
        _K32 = k
    return _K32


def _advapi32():
    global _A32
    if _A32 is None:
        a = ctypes.WinDLL("advapi32", use_last_error=True)
        a.GetSecurityInfo.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.DWORD,
                                      ctypes.POINTER(ctypes.c_void_p),
                                      ctypes.POINTER(ctypes.c_void_p),
                                      ctypes.POINTER(ctypes.c_void_p),
                                      ctypes.POINTER(ctypes.c_void_p),
                                      ctypes.POINTER(ctypes.c_void_p)]
        a.GetSecurityInfo.restype = wintypes.DWORD
        a.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                       ctypes.POINTER(wintypes.HANDLE)]
        a.OpenProcessToken.restype = wintypes.BOOL
        a.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                          wintypes.LPVOID, wintypes.DWORD,
                                          ctypes.POINTER(wintypes.DWORD)]
        a.GetTokenInformation.restype = wintypes.BOOL
        a.EqualSid.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        a.EqualSid.restype = wintypes.BOOL
        _A32 = a
    return _A32


def _current_user_sid_bytes():
    """This process's user SID, copied out as bytes.

    Copied rather than kept as a pointer because the buffer it lives in is
    freed when this returns, and a dangling PSID compared later is a comparison
    against whatever landed there next.
    """
    a = _advapi32()
    tok = wintypes.HANDLE()
    if not a.OpenProcessToken(_kernel32().GetCurrentProcess(), _TOKEN_QUERY,
                              ctypes.byref(tok)):
        raise BeamPipeError("This computer's user could not be identified.")
    try:
        need = wintypes.DWORD(0)
        a.GetTokenInformation(tok, _TOKEN_USER, None, 0, ctypes.byref(need))
        buf = ctypes.create_string_buffer(need.value)
        if not a.GetTokenInformation(tok, _TOKEN_USER, buf, need,
                                     ctypes.byref(need)):
            raise BeamPipeError("This computer's user could not be identified.")
        # TOKEN_USER is SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes; } -- the
        # SID itself sits elsewhere in the same buffer, reached by the pointer.
        psid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
        return _sid_bytes(psid)
    finally:
        _kernel32().CloseHandle(tok)


def _sid_bytes(psid):
    """A SID's own bytes. Length is 8 + 4 * SubAuthorityCount, and byte 1 of
    the structure IS SubAuthorityCount -- so the length is readable without
    GetLengthSid and without a second import."""
    count = ctypes.cast(psid, ctypes.POINTER(ctypes.c_ubyte))[1]
    return ctypes.string_at(psid, 8 + 4 * count)


def _pipe_owner_is_current_user(handle):
    """True when the process hosting this pipe runs as the user we do.

    This is what .NET's PipeOptions.CurrentUserOnly does on the CLIENT side,
    and the contract says a writer that skips it "is talking to a pipe it has
    not verified". The name is machine-global and the first process to create
    it owns it, so without this check a squatter could stand up
    `badapple-cmd-<our session>` and be handed the cookie.

    HONEST LIMIT, the same one .NET has: this proves the SERVER RUNS AS US. It
    does not prove the server is BadApple. Another program running as this user
    could still squat the name -- but such a program can already read the
    browser profile these cookies came from, so the check is drawn where it
    buys something rather than where it would look strongest.
    """
    a = _advapi32()
    owner = ctypes.c_void_p()
    sd = ctypes.c_void_p()
    rc = a.GetSecurityInfo(handle, _SE_KERNEL_OBJECT, _OWNER_SECURITY_INFORMATION,
                           ctypes.byref(owner), None, None, None, ctypes.byref(sd))
    if rc != 0 or not owner:
        return False
    try:
        return _sid_bytes(owner.value) == _current_user_sid_bytes()
    finally:
        if sd:
            _kernel32().LocalFree(sd)


def _open_pipe(name):
    """A write handle on the pipe, or None when nothing is hosting it yet.

    Raises only for a pipe that IS there and could not be used -- the caller
    distinguishes "not running" (launch it) from "running and unusable" (say
    so) on exactly that.
    """
    k = _kernel32()
    handle = k.CreateFileW(name, _GENERIC_WRITE, 0, None, _OPEN_EXISTING, 0, None)
    if handle == _INVALID_HANDLE_VALUE or handle is None:
        err = ctypes.get_last_error()
        if err in (_ERROR_FILE_NOT_FOUND, _ERROR_PIPE_BUSY):
            return None
        raise BeamPipeError("BadApple is running but would not accept the beam.")
    if not _pipe_owner_is_current_user(handle):
        k.CloseHandle(handle)
        # Deliberately not "verify failed" with detail: this is the branch a
        # squatter provokes, and it must not become a probe for what we check.
        raise BeamPipeError(
            "The BadApple connection on this computer could not be verified, "
            "so the sign-in was not sent.")
    return handle


def _write_line(handle, line):
    """One UTF-8 (no BOM) LF-terminated line, then done. `ipc.transport`."""
    k = _kernel32()
    payload = (line + "\n").encode("utf-8")
    written = wintypes.DWORD(0)
    ok = k.WriteFile(handle, payload, len(payload), ctypes.byref(written), None)
    if not ok or written.value != len(payload):
        raise BeamPipeError("The beam could not be handed to BadApple.")


def send_beam(app, target, token, timeout=LAUNCH_TIMEOUT_S):
    """Ask a running BadApple to beam `target`, carrying `token` if given.

    "Only a RUNNING BadApple hosts the pipe. If Connect fails, launch
    BadApple.App.exe with NO arguments, wait for the pipe, and then write."

    NO ARGUMENTS is the load-bearing half of that sentence. Launching it with
    `--beam <target>` and then also writing the pipe would beam twice;
    launching it with the credential on argv is the thing this whole module
    exists to avoid. So the launch is bare and the line carries everything.

    Raises BeamPipeError, whose message never contains the token or the target.
    """
    name = pipe_name()
    line = format_beam_command(target, token)

    handle = _open_pipe(name)
    if handle is None:
        _launch_bare(app)
        deadline = time.monotonic() + timeout
        while handle is None:
            if time.monotonic() >= deadline:
                raise BeamPipeError("BadApple did not start in time.")
            time.sleep(_POLL_S)
            handle = _open_pipe(name)
    try:
        _write_line(handle, line)
    finally:
        _kernel32().CloseHandle(handle)


def _launch_bare(app):
    # Imported here rather than at module scope: downloads imports THIS module,
    # so a top-level import back into it would be a cycle. By the time a beam
    # is sent, downloads is long since loaded.
    from mchost.downloads import _no_window

    cf, si = _no_window()
    try:
        subprocess.Popen([app], creationflags=cf, startupinfo=si)
    except Exception:
        # The reason is not forwarded: it is an OSError whose text names the
        # executable and nothing the user can act on, and the caller's sentence
        # is already the actionable one.
        raise BeamPipeError("BadApple failed to start.")

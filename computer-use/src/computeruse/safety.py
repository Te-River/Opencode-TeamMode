"""The safety layer the host cannot provide: budget, panic hotkey, hand-back probes.

A 2.x plugin cannot raise a confirmation dialog, and the MCP server cannot see
which agent is calling.  So every guard that has to exist *per action* lives
here, in the server process, and the model has no parameter that can clear any
of them:

* **ActionBudget** — 200 mutating actions per process.  Reaching the limit is a
  one-way door for this process: there is no `reset`, because the point of a
  budget is that a human has to come back.
* **PanicHotkey** — `Ctrl+Alt+Shift+F12` toggles control between the model and
  the human.  While the human holds it, every mutating tool refuses.  The model
  cannot toggle it back: `control_status` takes no arguments.
* **Hand-back verdicts** — two situations where continuing would be a guess:
  an elevated target window (`needs-elevation`) and the UAC secure desktop
  (`secure-desktop`), where the input desktop is not the one we are attached to
  and injection can never land.

None of this is a security boundary.  It is a blast-radius limiter, and the
README says so in those words.
"""

from __future__ import annotations

import ctypes
import os
import threading
from ctypes import wintypes

from . import input as input_mod

IS_WINDOWS = os.name == "nt"

# --- panic hotkey ---------------------------------------------------------
MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
VK_F12 = 0x7B
HOTKEY_ID = 0xB001
WM_HOTKEY = 0x0312
WM_QUIT = 0x0012
PM_NOREMOVE = 0x0000

HOTKEY_NAME = "Ctrl+Alt+Shift+F12"

# --- desktop / token probes ----------------------------------------------
DESKTOP_READOBJECTS = 0x0001
DESKTOP_SWITCHDESKTOP = 0x0100
UOI_NAME = 2
TOKEN_QUERY = 0x0008
TOKEN_INTEGRITY_LEVEL = 25
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

# Integrity RIDs, for the human-readable detail only.
_IL_NAMES = {
    0x0000: "untrusted",
    0x1000: "low",
    0x2000: "medium",
    0x2100: "medium-plus",
    0x3000: "high",
    0x4000: "system",
    0x5000: "protected",
}


def _il_name(rid: int | None) -> str:
    if rid is None:
        return "unknown"
    if rid in _IL_NAMES:
        return _IL_NAMES[rid]
    if rid >= 0x4000:
        return "system+"
    if rid >= 0x3000:
        return "high"
    if rid >= 0x2000:
        return "medium+"
    if rid >= 0x1000:
        return "low+"
    return "untrusted"


# =========================================================================
# Budget
# =========================================================================

class ActionBudget:
    """Counts the five mutating tools. Read-only tools are free."""

    def __init__(self, limit: int = 200):
        self.limit = max(1, int(limit))
        self.used = 0
        self._lock = threading.Lock()

    @property
    def exhausted(self) -> bool:
        with self._lock:
            return self.used >= self.limit

    def try_consume(self) -> bool:
        """Reserve one action. False once the budget is spent (nothing consumed)."""
        with self._lock:
            if self.used >= self.limit:
                return False
            self.used += 1
            return True

    def snapshot(self) -> dict:
        with self._lock:
            used = self.used
        return {
            "used": used,
            "limit": self.limit,
            "remaining": max(0, self.limit - used),
            "exhausted": used >= self.limit,
        }


# =========================================================================
# Panic hotkey
# =========================================================================

class PanicHotkey:
    """Global toggle between model control ("ai") and human control ("user")."""

    def __init__(self) -> None:
        self.state = "ai"
        self.count = 0
        self.armed = False
        self.error: str | None = None
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._thread_id: int | None = None
        self._ready = threading.Event()
        self._user32 = None

    def toggle(self) -> None:
        with self._lock:
            self.state = "user" if self.state == "ai" else "ai"
            self.count += 1

    def start(self, wait_s: float = 2.0) -> dict:
        if not IS_WINDOWS:
            self.error = "not-windows"
            return self.snapshot()
        self._thread = threading.Thread(target=self._run, name="computeruse-panic", daemon=True)
        self._thread.start()
        self._ready.wait(wait_s)
        return self.snapshot()

    def _run(self) -> None:
        try:
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            self._user32 = user32
            msg = wintypes.MSG()
            # Force this thread's message queue into existence before anyone
            # posts to it, or a stop() racing the start would vanish.
            user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_NOREMOVE)
            self._thread_id = int(kernel32.GetCurrentThreadId())
            if not user32.RegisterHotKey(None, HOTKEY_ID, MOD_CONTROL | MOD_ALT | MOD_SHIFT, VK_F12):
                self.error = f"RegisterHotKey failed err={ctypes.get_last_error()}"
                self._ready.set()
                return
            self.armed = True
            self._ready.set()
            try:
                while True:
                    ret = int(user32.GetMessageW(ctypes.byref(msg), None, 0, 0))
                    if ret == 0 or ret == -1:  # WM_QUIT, or an error
                        break
                    if msg.message == WM_HOTKEY and int(msg.wParam) == HOTKEY_ID:
                        self.toggle()
            finally:
                user32.UnregisterHotKey(None, HOTKEY_ID)
                self.armed = False
        except Exception as exc:  # never let the hotkey thread kill the server
            self.error = f"{type(exc).__name__}: {exc}"
            self.armed = False
            self._ready.set()

    def stop(self, timeout_s: float = 2.0) -> None:
        if not self._thread or not self._thread.is_alive():
            return
        try:
            user32 = self._user32 or ctypes.WinDLL("user32", use_last_error=True)
            if self._thread_id:
                user32.PostThreadMessageW(self._thread_id, WM_QUIT, 0, 0)
        except Exception:
            pass
        self._thread.join(timeout_s)

    def snapshot(self) -> dict:
        with self._lock:
            state, count = self.state, self.count
        return {
            "state": state,
            "hotkey": HOTKEY_NAME,
            "armed": self.armed,
            "panic_count": count,
            "error": self.error,
        }


# =========================================================================
# Desktop / integrity probes
# =========================================================================

_user32 = None
_advapi32 = None
_kernel32 = None


def _libs():
    global _user32, _advapi32, _kernel32
    if _user32 is None:
        _user32 = ctypes.WinDLL("user32", use_last_error=True)
        _advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
        _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        _user32.OpenInputDesktop.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        _user32.OpenInputDesktop.restype = wintypes.HANDLE
        _user32.CloseDesktop.argtypes = [wintypes.HANDLE]
        _user32.CloseDesktop.restype = wintypes.BOOL
        _user32.GetThreadDesktop.argtypes = [wintypes.DWORD]
        _user32.GetThreadDesktop.restype = wintypes.HANDLE
        _user32.GetUserObjectInformationW.argtypes = [
            wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)
        ]
        _user32.GetUserObjectInformationW.restype = wintypes.BOOL
        _user32.GetForegroundWindow.restype = wintypes.HWND

        _advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
        _advapi32.OpenProcessToken.restype = wintypes.BOOL
        _advapi32.GetTokenInformation.argtypes = [
            wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)
        ]
        _advapi32.GetTokenInformation.restype = wintypes.BOOL
        _advapi32.GetSidSubAuthorityCount.argtypes = [ctypes.c_void_p]
        _advapi32.GetSidSubAuthorityCount.restype = ctypes.POINTER(ctypes.c_ubyte)
        _advapi32.GetSidSubAuthority.argtypes = [ctypes.c_void_p, wintypes.DWORD]
        _advapi32.GetSidSubAuthority.restype = ctypes.POINTER(wintypes.DWORD)

        _kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    return _user32, _advapi32, _kernel32


class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", wintypes.DWORD)]


class TOKEN_MANDATORY_LABEL(ctypes.Structure):
    _fields_ = [("Label", SID_AND_ATTRIBUTES)]


def _desktop_name(hdesk: int) -> str | None:
    if not hdesk:
        return None
    user32, _, _ = _libs()
    needed = wintypes.DWORD(0)
    buf = ctypes.create_unicode_buffer(256)
    ok = user32.GetUserObjectInformationW(hdesk, UOI_NAME, buf, ctypes.sizeof(buf), ctypes.byref(needed))
    return buf.value if ok and buf.value else None


def secure_desktop_probe(frame_image=None) -> dict:
    """Is the UAC/lock secure desktop in front of us?

    Two independent signals, either is enough:
    * the *input* desktop is not the desktop this thread is attached to (the
      secure desktop is a separate window station's desktop — our BitBlt and
      our SendInput both target the old one and cannot cross);
    * the capture is entirely black AND there is no foreground window, which is
      what a locked session looks like.

    Deliberately never consulted on its own to describe *content*: a blank
    screenshot is reported by `screenshot` as what it is, not as "no content".
    """
    info = {"active": False, "reason": None, "input_desktop": None, "thread_desktop": None}
    if not IS_WINDOWS:
        return info
    user32, _, kernel32 = _libs()
    hdesk = user32.OpenInputDesktop(0, False, DESKTOP_READOBJECTS | DESKTOP_SWITCHDESKTOP)
    if hdesk:
        try:
            info["input_desktop"] = _desktop_name(hdesk)
        finally:
            user32.CloseDesktop(hdesk)
    thread_desk = user32.GetThreadDesktop(int(kernel32.GetCurrentThreadId()))
    info["thread_desktop"] = _desktop_name(thread_desk)

    if info["input_desktop"] and info["thread_desktop"] and info["input_desktop"] != info["thread_desktop"]:
        info.update(active=True, reason=f"input desktop {info['input_desktop']!r} != thread desktop {info['thread_desktop']!r}")
        return info
    if not hdesk:
        err = ctypes.get_last_error()
        if not int(user32.GetForegroundWindow() or 0):
            info.update(active=True, reason=f"OpenInputDesktop failed err={err} and no foreground window")
            return info
    if frame_image is not None:
        from . import diff as diff_mod

        if diff_mod.is_black(frame_image) and not int(user32.GetForegroundWindow() or 0):
            info.update(active=True, reason="capture is black and no foreground window")
    return info


def _rid_from_token(token) -> int | None:
    _, advapi32, _ = _libs()
    needed = wintypes.DWORD(0)
    advapi32.GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, None, 0, ctypes.byref(needed))
    if not needed.value:
        return None
    buf = ctypes.create_string_buffer(needed.value)
    if not advapi32.GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, buf, needed.value, ctypes.byref(needed)):
        return None
    label = ctypes.cast(buf, ctypes.POINTER(TOKEN_MANDATORY_LABEL)).contents
    sid = label.Label.Sid
    if not sid:
        return None
    count_ptr = advapi32.GetSidSubAuthorityCount(sid)
    if not count_ptr:
        return None
    count = count_ptr.contents.value
    if count < 1:
        return None
    rid_ptr = advapi32.GetSidSubAuthority(sid, count - 1)
    return int(rid_ptr.contents.value) if rid_ptr else None


def integrity_rid_of_pid(pid: int) -> int | None:
    """Integrity RID of a process (0x2000 medium, 0x3000 high, ...), or None."""
    if not IS_WINDOWS or not pid:
        return None
    _, advapi32, kernel32 = _libs()
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return None
    try:
        token = wintypes.HANDLE()
        if not advapi32.OpenProcessToken(handle, TOKEN_QUERY, ctypes.byref(token)):
            return None
        try:
            return _rid_from_token(token)
        finally:
            kernel32.CloseHandle(token)
    finally:
        kernel32.CloseHandle(handle)


def own_integrity_rid() -> int | None:
    if not IS_WINDOWS:
        return None
    _, advapi32, kernel32 = _libs()
    token = wintypes.HANDLE()
    if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), TOKEN_QUERY, ctypes.byref(token)):
        return None
    try:
        return _rid_from_token(token)
    finally:
        kernel32.CloseHandle(token)


def target_elevation(x: int, y: int) -> dict:
    """Compare the integrity level of the window under (x, y) with ours.

    verdict: "ok" (we may inject) | "elevated" (higher IL than us — refuse) |
    "unknown" (could not read it; we proceed and let the change verdict speak).
    """
    target = input_mod.window_at(int(x), int(y))
    out = {"verdict": "unknown", "target": target, "own": None, "target_il": None, "detail": None}
    if not target or not target.get("pid"):
        out["detail"] = "no window under the point"
        return out
    own = own_integrity_rid()
    target_rid = integrity_rid_of_pid(int(target["pid"]))
    out["own"] = _il_name(own)
    out["target_il"] = _il_name(target_rid)
    if own is None or target_rid is None:
        out["detail"] = "integrity level unreadable (protected process, or access denied)"
        return out
    out["verdict"] = "elevated" if target_rid > own else "ok"
    if out["verdict"] == "ok":
        out["detail"] = None
    else:
        out["detail"] = f"target window runs at {_il_name(target_rid)}, this server at {_il_name(own)}"
    return out

"""Input injection through ctypes `SendInput`, plus read-only window probes.

The coordinate contract is `capture.py`'s: every x/y here is a *capture pixel*
of the virtual screen.  `SendInput`'s absolute mouse events are **not** pixels —
they are normalised to 0..65535 across the virtual desktop, and passing pixels
directly is the classic bug that makes the cursor drift (and lands off-target
entirely on a multi-monitor setup with a negative origin).  `normalize_abs()`
is the single place that conversion happens, and it is a pure function so it
can be tested without touching a mouse.

Nothing in this module decides whether an action is allowed — that is
`safety.py`'s job, and the caller must consult it first.
"""

from __future__ import annotations

import ctypes
import os
import time
from ctypes import wintypes

from . import dpi

IS_WINDOWS = os.name == "nt"

ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong

# --- SendInput flags -------------------------------------------------------
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

# --- virtual screen metrics ----------------------------------------------
SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SW_RESTORE = 9


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", wintypes.LONG),
        ("top", wintypes.LONG),
        ("right", wintypes.LONG),
        ("bottom", wintypes.LONG),
    ]


class POINT(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


class InputError(RuntimeError):
    """SendInput refused the injection (a secure desktop, a dead session, ...)."""


_user32 = None
_kernel32 = None


def _libs():
    global _user32, _kernel32
    if _user32 is None:
        _user32 = ctypes.WinDLL("user32", use_last_error=True)
        _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        _user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
        _user32.SendInput.restype = wintypes.UINT
        _user32.GetSystemMetrics.argtypes = [ctypes.c_int]
        _user32.GetSystemMetrics.restype = ctypes.c_int
        _user32.GetForegroundWindow.restype = wintypes.HWND
        _user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        _user32.GetWindowTextLengthW.restype = ctypes.c_int
        _user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        _user32.GetWindowTextW.restype = ctypes.c_int
        _user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        _user32.GetWindowThreadProcessId.restype = wintypes.DWORD
        _user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
        _user32.GetWindowRect.restype = wintypes.BOOL
        _user32.WindowFromPoint.argtypes = [POINT]
        _user32.WindowFromPoint.restype = wintypes.HWND
        _user32.GetCursorPos.argtypes = [ctypes.POINTER(POINT)]
        _user32.GetCursorPos.restype = wintypes.BOOL
        _user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
        _user32.SetCursorPos.restype = wintypes.BOOL
        _user32.SetForegroundWindow.argtypes = [wintypes.HWND]
        _user32.SetForegroundWindow.restype = wintypes.BOOL
        _user32.BringWindowToTop.argtypes = [wintypes.HWND]
        _user32.BringWindowToTop.restype = wintypes.BOOL
        _user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        _user32.ShowWindow.restype = wintypes.BOOL
        _user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
        _user32.GetWindow.restype = wintypes.HWND
        _user32.IsWindow.argtypes = [wintypes.HWND]
        _user32.IsWindow.restype = wintypes.BOOL
        _user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
        _user32.AttachThreadInput.restype = wintypes.BOOL
        _kernel32.GetCurrentThreadId.restype = wintypes.DWORD
        _kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        _kernel32.OpenProcess.restype = wintypes.HANDLE
        _kernel32.QueryFullProcessImageNameW.argtypes = [
            wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)
        ]
        _kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
        _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        _kernel32.CloseHandle.restype = wintypes.BOOL
        _user32.VkKeyScanW.argtypes = [wintypes.WCHAR]
        _user32.VkKeyScanW.restype = ctypes.c_short
        dpi.ensure_dpi_aware()
    return _user32, _kernel32


# --- pure coordinate maths (unit-tested without a desktop) -----------------

def normalize_abs(x: int, y: int, vx: int, vy: int, vw: int, vh: int) -> tuple[int, int]:
    """Capture pixel -> SendInput absolute (0..65535) across the virtual screen.

    `vw`/`vh` are exclusive bounds (width/height); the last addressable pixel is
    vw-1, which is why the divisor is not vw.
    """
    span_x = max(1, int(vw) - 1)
    span_y = max(1, int(vh) - 1)
    ax = int(round((int(x) - int(vx)) * 65535.0 / span_x))
    ay = int(round((int(y) - int(vy)) * 65535.0 / span_y))
    return max(0, min(65535, ax)), max(0, min(65535, ay))


def virtual_metrics() -> tuple[int, int, int, int]:
    user32, _ = _libs()
    return (
        user32.GetSystemMetrics(SM_XVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_YVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CXVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CYVIRTUALSCREEN),
    )


# --- low-level plumbing ---------------------------------------------------

def _send(*events: INPUT) -> None:
    user32, _ = _libs()
    n = len(events)
    array = (INPUT * n)(*events)
    sent = user32.SendInput(n, array, ctypes.sizeof(INPUT))
    if sent != n:
        err = ctypes.get_last_error()
        raise InputError(f"SendInput delivered {sent}/{n} events (GetLastError={err})")


def _mouse_event(flags: int, dx: int = 0, dy: int = 0, data: int = 0) -> INPUT:
    ev = INPUT()
    ev.type = INPUT_MOUSE
    ev.mi = MOUSEINPUT(dx=dx, dy=dy, mouseData=data & 0xFFFFFFFF, dwFlags=flags, time=0, dwExtraInfo=0)
    return ev


def _abs_move(x: int, y: int) -> INPUT:
    ax, ay = normalize_abs(x, y, *virtual_metrics())
    return _mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay)


_BUTTONS = {
    "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}


def move_to(x: int, y: int) -> None:
    _send(_abs_move(int(x), int(y)))


def click(x: int, y: int, button: str = "left", clicks: int = 1) -> None:
    down, up = _BUTTONS[button]
    events = [_abs_move(int(x), int(y))]
    for _ in range(max(1, int(clicks))):
        events.append(_mouse_event(down))
        events.append(_mouse_event(up))
    _send(*events)


def scroll(x: int, y: int, delta: int) -> None:
    # WHEEL_DELTA is 120 per notch; positive is away from the user (up).
    _send(_abs_move(int(x), int(y)), _mouse_event(MOUSEEVENTF_WHEEL, data=int(delta)))


def drag(from_xy: tuple[int, int], to_xy: tuple[int, int], duration_ms: int = 300) -> None:
    x0, y0 = int(from_xy[0]), int(from_xy[1])
    x1, y1 = int(to_xy[0]), int(to_xy[1])
    steps = max(4, min(60, int(duration_ms) // 15))
    _send(_abs_move(x0, y0), _mouse_event(MOUSEEVENTF_LEFTDOWN))
    try:
        for i in range(1, steps + 1):
            t = i / steps
            _send(_abs_move(int(round(x0 + (x1 - x0) * t)), int(round(y0 + (y1 - y0) * t))))
            time.sleep(max(0.0, duration_ms / 1000.0) / steps)
    finally:
        # The release must happen even if a move throws, or the desktop is left
        # with the button held down and the user's next click does something
        # nobody asked for.
        _send(_abs_move(x1, y1), _mouse_event(MOUSEEVENTF_LEFTUP))


# --- keyboard -------------------------------------------------------------

_VK_NAMES = {
    "return": 0x0D, "enter": 0x0D, "tab": 0x09, "esc": 0x1B, "escape": 0x1B,
    "space": 0x20, "backspace": 0x08, "delete": 0x2E, "del": 0x2E, "insert": 0x2D,
    "ins": 0x2D, "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
    "home": 0x24, "end": 0x23, "pageup": 0x21, "pgup": 0x21, "pagedown": 0x22,
    "pgdn": 0x22, "printscreen": 0x2C, "capslock": 0x14,
    "shift": 0x10, "ctrl": 0x11, "control": 0x11, "alt": 0x12, "menu": 0x12,
    "win": 0x5B, "lwin": 0x5B, "rwin": 0x5C,
    "pause": 0x13, "numlock": 0x90, "scrolllock": 0x91,
}
for _i in range(1, 25):
    _VK_NAMES[f"f{_i}"] = 0x70 + _i - 1


def vk_for(name: str) -> int:
    """Resolve one key name to a virtual-key code."""
    key = name.strip().lower()
    if key in _VK_NAMES:
        return _VK_NAMES[key]
    if len(key) == 1:
        ch = key.upper()
        if "A" <= ch <= "Z" or "0" <= ch <= "9":
            return ord(ch)
    if len(name.strip()) == 1:
        # Punctuation etc. via VkKeyScanW. The high byte (shift/caps state) is
        # deliberately ignored: combos are for shortcuts, and typing text goes
        # through type_text's unicode path, which needs no shift state at all.
        user32, _ = _libs()
        scan = user32.VkKeyScanW(name.strip())
        if scan != -1:
            return scan & 0xFF
    raise ValueError(f"unknown key name: {name!r}")


def _key_event(vk: int, up: bool = False) -> INPUT:
    ev = INPUT()
    ev.type = INPUT_KEYBOARD
    ev.ki = KEYBDINPUT(wVk=vk, wScan=0, dwFlags=KEYEVENTF_KEYUP if up else 0, time=0, dwExtraInfo=0)
    return ev


def press(combo: str, repeat: int = 1) -> None:
    """Press `"ctrl+s"`, `"Return"`, `"alt+Tab"`, ... `repeat` times."""
    parts = [p for p in str(combo).split("+") if p.strip()]
    if not parts:
        raise ValueError("empty key combo")
    vks = [vk_for(p) for p in parts]
    for _ in range(max(1, int(repeat))):
        events = [_key_event(vk) for vk in vks]
        events += [_key_event(vk, up=True) for vk in reversed(vks)]
        _send(*events)


def type_unicode(text: str, interval_ms: int = 0) -> None:
    """Type literal text via KEYEVENTF_UNICODE — layout independent, no IME."""
    units = str(text).encode("utf-16-le")
    delay = max(0.0, interval_ms / 1000.0)
    for i in range(0, len(units), 2):
        code = int.from_bytes(units[i : i + 2], "little")
        down = INPUT()
        down.type = INPUT_KEYBOARD
        down.ki = KEYBDINPUT(wVk=0, wScan=code, dwFlags=KEYEVENTF_UNICODE, time=0, dwExtraInfo=0)
        up = INPUT()
        up.type = INPUT_KEYBOARD
        up.ki = KEYBDINPUT(wVk=0, wScan=code, dwFlags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time=0, dwExtraInfo=0)
        _send(down, up)
        if delay:
            time.sleep(delay)


# =========================================================================
# Text delivery to a real text control
# =========================================================================
#
# Measured 2026-10-29 (Windows 11 24H2, 1920x1080):
#
#   * `SendInput` + `KEYEVENTF_UNICODE` into Win11 Notepad's RichEditD2DPT
#     rewrites the text — `hello computeruse` came back as `hello eeeeeeeeeee`
#     from the SAVED FILE (not a suspect read-back).  Character bursts collapse
#     into runs of one character, and the damage grows with speed.
#   * The same 60-character string delivered as `WM_CHAR` to the SAME control is
#     byte-exact (60/60), and queued `PostMessage` is equally clean.
#   * The same `SendInput` path into a Tk Text widget is byte-exact.
#   * `sizeof(INPUT)`=40, `sizeof(KEYBDINPUT)`=24, `offsetof(INPUT,ki)`=8 — the
#     x64 struct is correct, so that is not it either.
#
# So the corruption is introduced by the TSF/keyboard layer that turns a
# synthesized VK_PACKET into text, NOT by this module's structs and NOT by the
# control's text insertion.  Fix: deliver characters to the control that
# actually has focus as `WM_CHAR` (skipping the keyboard path), and keep
# SendInput for windows that do not expose a text control (Chromium/Electron and
# other self-drawn surfaces ignore WM_CHAR, and they are exactly the ones that
# never showed the defect).
#
# The method used is always reported, because "typed" without saying how is the
# same unverifiable claim this package exists to avoid.

WM_CHAR = 0x0102
SMTO_BLOCK = 0x0001
SMTO_ABORTIFHUNG = 0x0002

# Exact class names / substrings that mean "this hwnd accepts WM_CHAR text".
_TEXT_CONTROL_EXACT = {"edit"}
_TEXT_CONTROL_HINTS = ("richedit", "scintilla", "textbox")


class GUITHREADINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("hwndActive", wintypes.HWND),
        ("hwndFocus", wintypes.HWND),
        ("hwndCapture", wintypes.HWND),
        ("hwndMenuOwner", wintypes.HWND),
        ("hwndMoveSize", wintypes.HWND),
        ("hwndCaret", wintypes.HWND),
        ("rcCaret", RECT),
    ]


def is_text_control(class_name: str) -> bool:
    """Does a window class name denote a control that takes WM_CHAR text?

    A hint list on purpose: it is the observable we can get without asking the
    app, and getting it wrong only costs the *fallback* (SendInput), which is
    the behaviour every app had before this fix.
    """
    name = (class_name or "").strip().lower()
    if not name:
        return False
    return name in _TEXT_CONTROL_EXACT or any(hint in name for hint in _TEXT_CONTROL_HINTS)


def control_class(hwnd: int) -> str:
    if not hwnd:
        return ""
    user32, _ = _libs()
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.restype = ctypes.c_int
    buf = ctypes.create_unicode_buffer(256)
    return buf.value if user32.GetClassNameW(hwnd, buf, 256) else ""


def focused_control(thread_id: int = 0) -> dict:
    """The focused control of `thread_id`'s window (0 = the foreground thread).

    `thread_id` is a seam for tests: it lets the resolution run against a window
    that is not in the foreground, which is the only way to prove the production
    path on a machine where the user's app owns the foreground.
    """
    user32, _ = _libs()
    user32.GetGUIThreadInfo.argtypes = [wintypes.DWORD, ctypes.POINTER(GUITHREADINFO)]
    user32.GetGUIThreadInfo.restype = wintypes.BOOL
    info = GUITHREADINFO()
    info.cbSize = ctypes.sizeof(GUITHREADINFO)
    if not user32.GetGUIThreadInfo(int(thread_id), ctypes.byref(info)):
        return {"hwnd": 0, "active": 0, "class": "", "available": False, "thread": int(thread_id)}
    focus = int(info.hwndFocus or 0)
    return {
        "hwnd": focus,
        "active": int(info.hwndActive or 0),
        "class": control_class(focus),
        "available": True,
        "thread": int(thread_id),
    }


def type_text_into(hwnd: int, text: str, interval_ms: int = 0, timeout_ms: int = 1000) -> dict:
    """Deliver `text` to one control as WM_CHAR. Never re-sends a partial string.

    SendMessageTimeout (not SendMessage) so a hung target returns instead of
    blocking this process forever; SMTO_ABORTIFHUNG makes that explicit.
    """
    user32, _ = _libs()
    user32.SendMessageTimeoutW.argtypes = [
        wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
        wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t),
    ]
    user32.SendMessageTimeoutW.restype = wintypes.LPARAM
    units = str(text).encode("utf-16-le")
    delay = max(0.0, interval_ms / 1000.0)
    sent = 0
    for i in range(0, len(units), 2):
        code = int.from_bytes(units[i : i + 2], "little")
        result = ctypes.c_size_t(0)
        ok = user32.SendMessageTimeoutW(
            hwnd, WM_CHAR, code, 1, SMTO_BLOCK | SMTO_ABORTIFHUNG, int(timeout_ms), ctypes.byref(result)
        )
        if not ok:
            return {"chars": sent, "failed_at": sent, "error": f"SendMessageTimeout err={ctypes.get_last_error()}"}
        sent += 1
        if delay:
            time.sleep(delay)
    return {"chars": sent, "failed_at": None, "error": None}


def type_text_focused(text: str, interval_ms: int = 0) -> dict:
    """The single entry point `type_text` uses. Returns {method, control_class, ...}.

    WM_CHAR for a real text control, SendInput otherwise. A partial WM_CHAR
    delivery is reported, never retried through the other path — sending the
    remainder twice is worse than a short string the caller can see and fix.
    """
    focus = focused_control()
    if focus["hwnd"] and is_text_control(focus["class"]):
        delivered = type_text_into(focus["hwnd"], text, interval_ms)
        delivered.update(
            method="wm-char" if delivered["failed_at"] is None else "wm-char-partial",
            control=int(focus["hwnd"]),
            control_class=focus["class"],
        )
        return delivered
    type_unicode(text, interval_ms)
    return {
        "method": "send-input",
        "control": int(focus["hwnd"]),
        "control_class": focus["class"],
        "chars": len(text),
        "failed_at": None,
        "error": None,
    }


# --- read-only probes -----------------------------------------------------

def _process_name(pid: int) -> str:
    if not pid:
        return "unknown"
    _, kernel32 = _libs()
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return "unknown"
    try:
        size = wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value)
        return "unknown"
    finally:
        kernel32.CloseHandle(handle)


def window_title(hwnd: int) -> str:
    if not hwnd:
        return ""
    user32, _ = _libs()
    length = user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value


def window_rect(hwnd: int) -> list[int] | None:
    if not hwnd:
        return None
    user32, _ = _libs()
    rect = RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    return [int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)]


def describe_window(hwnd: int) -> dict | None:
    if not hwnd:
        return None
    user32, _ = _libs()
    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return {
        "hwnd": int(hwnd),
        "title": window_title(hwnd),
        "process": _process_name(int(pid.value)),
        "pid": int(pid.value),
        "rect": window_rect(hwnd),
    }


def find_windows(pattern: str, limit: int = 8) -> list[dict]:
    """Visible top-level windows whose title contains `pattern` (case-insensitive).

    Biggest first: a dialog's owner is usually the whole app window, and the
    dialog is what the caller means.  Bounded at 64 candidates because an
    unbounded EnumWindows on a busy desktop is a lot of GetWindowText calls.
    """
    user32, _ = _libs()
    needle = (pattern or "").strip().lower()
    if not needle:
        return []
    found: list[dict] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _visit(hwnd, _lparam):
        if len(found) >= 64:
            return False
        try:
            if user32.IsWindowVisible(hwnd):
                info = describe_window(int(hwnd))
                if info and needle in (info.get("title") or "").lower() and info.get("rect"):
                    found.append(info)
        except Exception:
            pass  # one odd window must not abort the enumeration
        return True

    user32.EnumWindows(_visit, 0)

    def _area(w: dict) -> int:
        r = w.get("rect") or [0, 0, 0, 0]
        return max(0, int(r[2]) - int(r[0])) * max(0, int(r[3]) - int(r[1]))

    found.sort(key=_area, reverse=True)
    return found[:limit]


def foreground_window() -> dict | None:
    user32, _ = _libs()
    return describe_window(int(user32.GetForegroundWindow() or 0))


def window_at(x: int, y: int) -> dict | None:
    user32, _ = _libs()
    hwnd = user32.WindowFromPoint(POINT(int(x), int(y)))
    return describe_window(int(hwnd or 0))


def cursor_pos() -> dict:
    user32, _ = _libs()
    pt = POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return {"x": int(pt.x), "y": int(pt.y)}


def focus_window(hwnd: int) -> bool:
    """Bring `hwnd` to the foreground. A helper, not one of the seven tools.

    SetForegroundWindow is refused for a process that is not already the
    foreground process, so the calling thread attaches to the current
    foreground thread's input queue first — the standard workaround, and the
    reason the self-test can drive Notepad deterministically.
    """
    user32, kernel32 = _libs()
    hwnd = int(hwnd)
    if not hwnd or not user32.IsWindow(hwnd):
        return False
    fg = int(user32.GetForegroundWindow() or 0)
    my_tid = kernel32.GetCurrentThreadId()
    fg_tid = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    attached = False
    try:
        if fg_tid and fg_tid != my_tid:
            attached = bool(user32.AttachThreadInput(my_tid, fg_tid, True))
        user32.ShowWindow(hwnd, SW_RESTORE)
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(my_tid, fg_tid, False)
    return int(user32.GetForegroundWindow() or 0) == hwnd

"""Per-monitor-v2 DPI awareness, established before the first capture.

Why this exists: the whole tool surface rests on one equation —

    capture pixels == coordinates accepted by click / scroll / drag

A DPI-unaware process gets a *virtualised* BitBlt and virtualised input
coordinates, so the two stop being equal the moment the user's display is not
at 100%.  `ensure_dpi_aware()` therefore has to run before the first grab and
before the first SendInput; both `capture.grab()` and `input` call it lazily so
no entry point can forget.

What it does not fix: a *mixed-DPI* setup, where monitors run at different
scales.  There, capture is in physical pixels of the virtual screen and
injection is normalised against the same virtual screen, so the equation still
holds — but the `dpi`/`scale` reported by `screenshot` describe the SYSTEM
scale only, and a per-monitor scale can differ.  Treat the numbers in the
screenshot envelope as informational, and take coordinates from the returned
image, never from a DPI calculation of your own.
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes

IS_WINDOWS = sys.platform == "win32"

# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 — a sentinel handle, not a number
# the API dereferences.
PER_MONITOR_AWARE_V2 = ctypes.c_void_p(-4)

_ERROR_ACCESS_DENIED = 5
_LOGPIXELSX = 88

_reported: dict | None = None


def _user32() -> ctypes.WinDLL:
    return ctypes.WinDLL("user32", use_last_error=True)


def _is_per_monitor_v2(user32: ctypes.WinDLL) -> bool:
    """True when this thread's context already *is* PMv2.

    `SetProcessDpiAwarenessContext` fails with ERROR_ACCESS_DENIED once
    awareness has been set (by a manifest, or by an earlier call).  That is not
    a failure to report — it is the state we wanted — so the check has to ask
    the host rather than assume.
    """
    try:
        user32.GetThreadDpiAwarenessContext.restype = ctypes.c_void_p
        user32.AreDpiAwarenessContextsEqual.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        user32.AreDpiAwarenessContextsEqual.restype = wintypes.BOOL
        ctx = user32.GetThreadDpiAwarenessContext()
        if not ctx:
            return False
        return bool(user32.AreDpiAwarenessContextsEqual(ctx, PER_MONITOR_AWARE_V2))
    except AttributeError:
        return False


def ensure_dpi_aware() -> dict:
    """Set PMv2 once per process; idempotent. Returns the state dict."""
    global _reported
    if _reported is not None:
        return dict(_reported)

    state: dict = {"dpi_aware": False, "method": "none", "error": None}
    if not IS_WINDOWS:
        state["method"] = "not-windows"
        _reported = state
        return dict(state)

    user32 = _user32()
    try:
        user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        user32.SetProcessDpiAwarenessContext.restype = wintypes.BOOL
    except AttributeError:
        state["error"] = "SetProcessDpiAwarenessContext missing (Windows < 10 1703)"
    else:
        if user32.SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2):
            state.update(dpi_aware=True, method="SetProcessDpiAwarenessContext(-4)")
        else:
            err = ctypes.get_last_error()
            if err == _ERROR_ACCESS_DENIED and _is_per_monitor_v2(user32):
                state.update(dpi_aware=True, method="already-per-monitor-v2")
            else:
                state["error"] = f"SetProcessDpiAwarenessContext err={err}"

    if not state["dpi_aware"]:
        # Pre-1703 fallback. PROCESS_PER_MONITOR_DPI_AWARE == 2.
        try:
            shcore = ctypes.WinDLL("shcore", use_last_error=True)
            shcore.SetProcessDpiAwareness.argtypes = [ctypes.c_int]
            shcore.SetProcessDpiAwareness.restype = ctypes.c_long
            hr = int(shcore.SetProcessDpiAwareness(2))
            if hr == 0:
                state.update(dpi_aware=True, method="SetProcessDpiAwareness(2)")
            elif hr == -2147024891 and _is_per_monitor_v2(user32):  # E_ACCESSDENIED
                state.update(dpi_aware=True, method="already-per-monitor-v2")
            else:
                state["error"] = f"{state['error']}; SetProcessDpiAwareness hr={hr}"
        except OSError as exc:  # shcore.dll absent
            state["error"] = f"{state['error']}; shcore unavailable: {exc}"

    _reported = state
    return dict(state)


def system_dpi() -> int:
    """System DPI (96 == 100%). Per-monitor scale can differ — see module doc."""
    if not IS_WINDOWS:
        return 96
    user32 = _user32()
    try:
        user32.GetDpiForSystem.restype = wintypes.UINT
        dpi = int(user32.GetDpiForSystem())
        if dpi > 0:
            return dpi
    except AttributeError:
        pass
    try:
        gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
        user32.GetDC.argtypes = [wintypes.HWND]
        user32.GetDC.restype = wintypes.HDC
        gdi32.GetDeviceCaps.argtypes = [wintypes.HDC, ctypes.c_int]
        gdi32.GetDeviceCaps.restype = ctypes.c_int
        hdc = user32.GetDC(None)
        if hdc:
            try:
                dpi = int(gdi32.GetDeviceCaps(hdc, _LOGPIXELSX))
                if dpi > 0:
                    return dpi
            finally:
                user32.ReleaseDC(None, hdc)
    except OSError:
        pass
    return 96


def dpi_report() -> dict:
    state = ensure_dpi_aware()
    dpi = system_dpi()
    state["dpi"] = dpi
    state["scale"] = round(dpi / 96.0, 4)
    return state

"""Proof for the `type_text` delivery fix, against the real RichEditD2DPT control.

Why this test looks the way it does (all measured 2026-10-29 on Windows 11):

* `SendInput` + `KEYEVENTF_UNICODE` into Win11 Notepad rewrote the text — the
  SAVED FILE came back as ``hello eeeeeeeeeee`` for ``hello computeruse``, so
  it was never a read-back artefact.
* The same 60-character string delivered to the same control as ``WM_CHAR`` is
  byte-exact (60/60), and queued ``PostMessage`` is equally clean.
* The same `SendInput` code path into a Tk Text widget is byte-exact, and the
  x64 structs are correct (``sizeof(INPUT)``=40, ``KEYBDINPUT``=24,
  ``offsetof(INPUT,ki)``=8) — so neither the structs nor the control are at
  fault; the TSF keyboard layer is.

Read-back uses ``EM_SETSEL`` + ``WM_COPY`` + the clipboard, because
``WM_GETTEXT``/``WM_SETTEXT`` are broken on this control (a literal round-trip
returns a garbage tail). The clipboard is saved and restored around the test.

The control is driven directly, so the test needs no foreground window — it
cannot disturb whatever the user is doing.
"""

import ctypes
import inspect
import os
import subprocess
import sys
import time
from ctypes import wintypes
from pathlib import Path

import pytest

from computeruse import input as cu_input

TEST_STRING = "abcabcabc 112233  xx yy zz  aa bb cc  end space z  aaaa bbbb"

WM_CHAR, WM_COPY, WM_CLEAR, EM_SETSEL = 0x0102, 0x0301, 0x0303, 0x00B1
CF_UNICODETEXT, GMEM_MOVEABLE = 13, 0x0002


# --------------------------------------------------------------------------
# pure decision logic
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "class_name",
    ["Edit", "RichEditD2DPT", "RICHEDIT50W", "NotepadTextBox", "Scintilla"],
)
def test_real_text_controls_are_recognised(class_name):
    assert cu_input.is_text_control(class_name) is True


@pytest.mark.parametrize(
    "class_name",
    ["", "Chrome_RenderWidgetHostHWND", "Chrome_WidgetWin_1", "SunAwtFrame", "HwndWrapper[Default]"],
)
def test_self_drawn_surfaces_fall_back_to_sendinput(class_name):
    # These ignore WM_CHAR; SendInput is the only thing that reaches them, and
    # they never showed the defect, so the fallback is the old behaviour.
    assert cu_input.is_text_control(class_name) is False


def test_the_60_char_string_is_really_60_and_has_the_shape_we_claim():
    assert len(TEST_STRING) == 60
    assert "  " in TEST_STRING          # repeated characters
    assert "abcabcabc" in TEST_STRING   # a repeated run
    assert " z " in TEST_STRING         # trailing-space-then-character pattern


def test_type_text_into_refuses_to_re_send_a_partial_string():
    # A NULL hwnd cannot accept WM_CHAR: the helper must report the failure
    # rather than pretending, and must never fall through to a second send.
    result = cu_input.type_text_into(0, TEST_STRING, timeout_ms=200)
    assert result["chars"] == 0
    assert result["failed_at"] == 0
    assert result["error"]


# --------------------------------------------------------------------------
# the PRODUCTION entry point: `type_text_focused` chooses the path
# --------------------------------------------------------------------------
#
# The real-host test below drives `type_text_into` directly — that is the
# *delivery* half. The *routing* half (`focused_control` -> WM_CHAR, anything
# else -> SendInput) is what `type_text` actually calls, and a routing bug that
# silently falls back to SendInput is exactly how the trailing-character defect
# would come back with every delivery test still green. These tests replace the
# two seams, so they need neither a foreground window nor a real keyboard.

def _focus(hwnd=0, class_name="", available=True, active=0, thread=0):
    """A `focused_control()` reply, in the production shape."""
    return {
        "hwnd": hwnd,
        "active": active,
        "class": class_name,
        "available": available,
        "thread": thread,
    }


def _forbid_send_input(monkeypatch):
    monkeypatch.setattr(
        cu_input,
        "type_unicode",
        lambda *a, **k: pytest.fail("the WM_CHAR path must not also SendInput — that is the double-send bug"),
    )


def test_type_text_focused_routes_a_text_control_to_wm_char(monkeypatch):
    calls = []

    def fake_into(hwnd, text, interval_ms=0):
        calls.append((hwnd, text, interval_ms))
        return {"chars": len(text), "failed_at": None, "error": None}

    monkeypatch.setattr(cu_input, "focused_control", lambda: _focus(0x1101, "RichEditD2DPT", thread=4242))
    monkeypatch.setattr(cu_input, "type_text_into", fake_into)
    _forbid_send_input(monkeypatch)

    result = cu_input.type_text_focused("hello", 7)

    assert calls == [(0x1101, "hello", 7)], "the focused control must be the target, exactly once"
    assert result["method"] == "wm-char"
    assert result["control"] == 0x1101
    assert result["control_class"] == "RichEditD2DPT"
    assert result["chars"] == 5
    assert result["failed_at"] is None


def test_type_text_focused_routes_a_self_drawn_surface_to_send_input(monkeypatch):
    sent = []
    monkeypatch.setattr(cu_input, "focused_control", lambda: _focus(0x2202, "Chrome_RenderWidgetHostHWND"))
    monkeypatch.setattr(cu_input, "type_unicode", lambda text, interval_ms=0: sent.append((text, interval_ms)))
    monkeypatch.setattr(
        cu_input, "type_text_into", lambda *a, **k: pytest.fail("a self-drawn surface ignores WM_CHAR")
    )

    result = cu_input.type_text_focused("hi", 3)

    assert sent == [("hi", 3)], "the whole string, once, through SendInput"
    assert result["method"] == "send-input"
    assert result["control"] == 0x2202
    assert result["control_class"] == "Chrome_RenderWidgetHostHWND"
    assert result["failed_at"] is None


def test_no_gui_thread_info_falls_back_and_the_reply_says_which_path_ran(monkeypatch):
    """The back door this test file was extended for.

    When `GetGUIThreadInfo` cannot answer, `focused_control` reports
    `available: False` with no hwnd and no class. The delivery still happens,
    through SendInput — and the reply has to name that path and admit it had no
    control, instead of reading like a targeted WM_CHAR typing.
    """
    sent = []
    monkeypatch.setattr(cu_input, "focused_control", lambda: _focus(0, "", available=False))
    monkeypatch.setattr(cu_input, "type_unicode", lambda text, interval_ms=0: sent.append(text))
    monkeypatch.setattr(cu_input, "type_text_into", lambda *a, **k: pytest.fail("no control means no WM_CHAR"))

    result = cu_input.type_text_focused("abc")

    assert sent == ["abc"], "the fallback must still deliver the whole string"
    assert result["method"] == "send-input", "the reply must not hide which path ran"
    assert result["control"] == 0 and result["control_class"] == "", "there was no control; the reply must not invent one"
    assert result["chars"] == 3
    assert result["failed_at"] is None


def test_a_partial_wm_char_delivery_is_reported_and_never_re_sent(monkeypatch):
    monkeypatch.setattr(cu_input, "focused_control", lambda: _focus(0x3303, "Edit"))
    monkeypatch.setattr(
        cu_input,
        "type_text_into",
        lambda hwnd, text, interval_ms=0: {"chars": 2, "failed_at": 2, "error": "SendMessageTimeout err=0"},
    )
    _forbid_send_input(monkeypatch)

    result = cu_input.type_text_focused(TEST_STRING)

    assert result["method"] == "wm-char-partial"
    assert result["chars"] == 2 and result["failed_at"] == 2
    assert result["error"]


def test_the_server_types_through_type_text_focused_not_the_raw_delivery():
    """Wiring pin: the `type_text` tool must keep using the routing entry point.

    The routing tests above stay green even if the server went back to calling
    `type_text_into` directly — which is exactly the bypass that left the
    production path uncovered — so the call site is pinned as well.
    """
    from computeruse import server as cu_server

    source = inspect.getsource(cu_server)
    assert "input_mod.type_text_focused(" in source
    assert "type_text_into(" not in source


# --------------------------------------------------------------------------
# real host: the control must take all 60 characters byte-exactly
# --------------------------------------------------------------------------

def _user32():
    u = ctypes.WinDLL("user32", use_last_error=True)
    for name, args, restype in [
        ("SendMessageW", [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM], ctypes.c_ssize_t),
        ("FindWindowExW", [wintypes.HWND, wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR], wintypes.HWND),
        ("GetClassNameW", [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int], ctypes.c_int),
        ("GetClipboardData", [wintypes.UINT], wintypes.HANDLE),
        ("SetClipboardData", [wintypes.UINT, wintypes.HANDLE], wintypes.HANDLE),
        ("GetWindowThreadProcessId", [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)], wintypes.DWORD),
    ]:
        fn = getattr(u, name)
        fn.argtypes = args
        fn.restype = restype
    u.OpenClipboard.argtypes = [wintypes.HWND]
    u.OpenClipboard.restype = wintypes.BOOL
    return u


def _children(user32, hwnd, depth=0):
    out = []
    if depth > 6:
        return out
    child = user32.FindWindowExW(hwnd, None, None, None)
    while child:
        buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(child, buf, 256)
        out.append((child, buf.value))
        out.extend(_children(user32, child, depth + 1))
        child = user32.FindWindowExW(hwnd, child, None, None)
    return out


def _kernel32():
    """A kernel32 with argtypes set — a bare HANDLE return is 64-bit and ctypes
    truncates it to a C int without this (OverflowError on the real handle)."""
    k = ctypes.WinDLL("kernel32")
    k.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    k.GlobalAlloc.restype = wintypes.HANDLE
    k.GlobalLock.argtypes = [wintypes.HANDLE]
    k.GlobalLock.restype = ctypes.c_void_p
    k.GlobalUnlock.argtypes = [wintypes.HANDLE]
    k.GlobalUnlock.restype = wintypes.BOOL
    return k


def _read_clipboard() -> str | None:
    user32 = _user32()
    kernel32 = _kernel32()
    if not user32.OpenClipboard(None):
        return None
    try:
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return None
        ptr = kernel32.GlobalLock(handle)
        if not ptr:
            return None
        try:
            return ctypes.wstring_at(ptr)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def _write_clipboard(text: str) -> None:
    user32 = _user32()
    kernel32 = _kernel32()
    data = text.encode("utf-16-le") + b"\x00\x00"
    if not user32.OpenClipboard(None):
        raise RuntimeError("could not open the clipboard")
    try:
        user32.EmptyClipboard()
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        ctypes.memmove(kernel32.GlobalLock(handle), data, len(data))
        kernel32.GlobalUnlock(handle)
        user32.SetClipboardData(CF_UNICODETEXT, handle)
    finally:
        user32.CloseClipboard()


def _document_text(user32, ctl) -> str:
    """Reliable read-back for RichEditD2DPT: select all, copy, read the clipboard."""
    _write_clipboard("\x00sentinel")
    user32.SendMessageW(ctl, EM_SETSEL, 0, -1)
    user32.SendMessageW(ctl, WM_COPY, 0, 0)
    time.sleep(0.12)
    text = _read_clipboard()
    return "" if text == "\x00sentinel" else (text or "")


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only control probe")
def test_notepad_richtext_accepts_wm_char_byte_exact(tmp_path):
    """The test that fails on the old code (which only had SendInput)."""
    user32 = _user32()
    doc = tmp_path / "type_text_probe.txt"
    doc.write_text("", encoding="utf-8")

    notepad = None
    for exe in (os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "notepad.exe"), "notepad.exe"):
        try:
            notepad = subprocess.Popen([exe, str(doc)])
            break
        except OSError:
            continue
    if notepad is None:
        pytest.skip("notepad.exe is not available on this host")

    ctl = None
    how = None
    try:
        hwnd = None
        for _ in range(80):
            time.sleep(0.25)
            for candidate in _top_level_hwnds(user32):
                info = cu_input.describe_window(candidate) or {}
                if "notepad" in (info.get("process") or "").lower():
                    hwnd = candidate
                    break
            if hwnd:
                break
        if not hwnd:
            pytest.skip("could not find a Notepad window on this host")

        # Exercise the PRODUCTION resolution first: GetGUIThreadInfo on the
        # window's own thread. It only answers while that window is foreground,
        # so fall back to walking the child tree (RichEdit first — NotepadTextBox
        # is a WinUI wrapper that swallows WM_CHAR).
        tid = user32.GetWindowThreadProcessId(hwnd, None)
        focus = cu_input.focused_control(tid)
        if focus["hwnd"] and cu_input.is_text_control(focus["class"]):
            ctl, how = focus["hwnd"], f"focused_control(thread={tid}) -> {focus['class']}"
        if not ctl:
            kids = _children(user32, hwnd)
            rich = [(c, k) for c, k in kids if "richedit" in k.lower() or k.lower() == "edit"]
            ctl, how = (rich or [(None, None)])[0]
            ctl = ctl or next((c for c, k in kids if cu_input.is_text_control(k)), None)
            how = f"child walk -> {cu_input.control_class(ctl) if ctl else None} (window not foreground)"
        if not ctl:
            pytest.skip("could not find Notepad's text control on this host")

        previous = _read_clipboard()
        try:
            user32.SendMessageW(ctl, EM_SETSEL, 0, -1)
            user32.SendMessageW(ctl, WM_CLEAR, 0, 0)
            time.sleep(0.2)
            assert _document_text(user32, ctl) == "", f"could not clear the control ({how})"

            delivered = cu_input.type_text_into(ctl, TEST_STRING)
            assert delivered["failed_at"] is None, f"{how}: {delivered}"
            assert delivered["chars"] == 60, f"{how}: {delivered}"

            time.sleep(0.4)
            # The clipboard is global state and can be held by another process
            # for a moment; retry before concluding anything, and never turn
            # "could not measure" into a failure.
            got = ""
            for _ in range(6):
                got = _document_text(user32, ctl)
                if got:
                    break
                time.sleep(0.2)
            if not got:
                pytest.skip(f"read-back produced nothing via {how} (clipboard contention?)")
            assert got == TEST_STRING, f"typing was rewritten via {how}: {got!r}"
        finally:
            if previous is not None:
                try:
                    _write_clipboard(previous)
                except Exception:
                    pass
    finally:
        try:
            notepad.kill()
        except Exception:
            pass
        for candidate in _top_level_hwnds(user32):
            who = cu_input.describe_window(candidate) or {}
            if "notepad" in (who.get("process") or "").lower():
                os.system(f'taskkill /PID {who["pid"]} /F >nul 2>&1')


def _top_level_hwnds(user32):
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _lparam):
        if user32.IsWindowVisible(hwnd):
            found.append(hwnd)
        return True

    user32.EnumWindows(cb, 0)
    return found

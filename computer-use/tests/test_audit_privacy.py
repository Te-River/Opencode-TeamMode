"""The audit trail may not carry user content, and read-only tools are audited.

Both defects were found by an independent verifier on this machine (2026-10-30)
and each is pinned twice: once with the desktop faked (runs anywhere, fails on
the old code) and once against a real Notepad window (Windows only, skips rather
than fighting for the foreground).

P2 — a title is content.  After typing ``S3CRET-TYPED-TOKEN-abc987`` the
Notepad title became ``*S3CRET-… - Notepad`` and the NEXT ``click`` row wrote
``focus.title`` verbatim into ``actions.jsonl``; the ``type_text`` row itself was
clean.  Any window whose title mirrors what it shows has this shape (``*file.txt
- Notepad``, a browser tab, a terminal title), so every title — and the caller's
``expect_title`` — is now recorded as ``len`` + ``sha1_8``.

P3 — a screenshot wrote no row at all, while the README promised one row per
action.  The screenshot row carries the fingerprint, geometry, display and the
file names RELATIVE to the audit dir: no image, no absolute path.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import subprocess
import sys
import time
from ctypes import wintypes

import pytest
from PIL import Image

import computeruse.server as cu_server
from computeruse import input as cu_input
from computeruse.capture import Frame

MARKER = "MARKER-7f3a91-TYPED-TOKEN"
SHOT_SIZE = (320, 200)


# --------------------------------------------------------------------------
# harness: a server whose desktop is faked
# --------------------------------------------------------------------------

def make_server(tmp_path):
    server = cu_server.ComputerUseServer(
        budget=5, ttl_days=1, audit_root=str(tmp_path / "audit"), log=lambda _m: None
    )
    # Skip start(): DPI setup and the panic HOTKEY REGISTRATION are real machine
    # state, and this file's fakes never touch the real desktop.
    server._started = True
    return server


def _frame(sha1="0" * 40):
    return Frame(raw=b"", width=SHOT_SIZE[0], height=SHOT_SIZE[1], left=0, top=0, sha1=sha1)


def patch_shot(monkeypatch, server, colour=(10, 20, 30)):
    image = Image.new("RGB", SHOT_SIZE, colour)

    def shot(region=None, display=None):
        return _frame(), image.copy()

    monkeypatch.setattr(server, "_shot", shot)


def patch_desktop(monkeypatch, title, process="notepad.exe"):
    monkeypatch.setattr(
        cu_server.input_mod,
        "foreground_window",
        lambda: {"title": title, "process": process, "rect": [0, 0, 800, 600]},
    )
    monkeypatch.setattr(
        cu_server.safety, "secure_desktop_probe", lambda frame_image=None: {"active": False, "reason": None}
    )
    monkeypatch.setattr(
        cu_server.safety, "target_elevation", lambda x, y: {"verdict": "ok", "detail": None, "target": None}
    )


def rows_of(server):
    path = server.audit.rows_file
    if not path.exists():
        return [], ""
    raw = path.read_text(encoding="utf-8")
    return [json.loads(line) for line in raw.splitlines() if line.strip()], raw


def envelope_of(result):
    return json.loads(result["content"][0]["text"])


# --------------------------------------------------------------------------
# P2: no title, and no expect_title, reaches the trail
# --------------------------------------------------------------------------

def test_click_row_never_carries_the_window_title(tmp_path, monkeypatch):
    title = f"*{MARKER}.txt - 记事本"
    server = make_server(tmp_path)
    patch_desktop(monkeypatch, title)
    patch_shot(monkeypatch, server)
    monkeypatch.setattr(cu_server.input_mod, "click", lambda *a, **k: None)

    envelope = envelope_of(server.call_tool("click", {"x": 40, "y": 50, "settle_ms": 0}))
    rows, raw = rows_of(server)

    assert len(rows) == 1
    assert MARKER not in raw, "the window title reached actions.jsonl"
    focus = rows[0]["focus"]
    assert "title" not in focus
    assert focus["title_len"] == len(title)
    assert focus["title_sha1_8"] == hashlib.sha1(title.encode("utf-8")).hexdigest()[:8]
    assert focus["process"] == "notepad.exe"
    # The RETURN contract is untouched: the model still needs the title to retry.
    assert envelope["focus"]["title"] == title
    # ... and the verdict tuple is unchanged.
    assert {"before_sha1", "after_sha1", "changed_pixels_pct", "verdict"} <= set(envelope)


def test_type_text_row_keeps_neither_body_nor_expect_title(tmp_path, monkeypatch):
    title = f"*{MARKER}.txt - 记事本"
    body = f"{MARKER} typed by the audit test"
    expect = f"{MARKER}.txt"
    server = make_server(tmp_path)
    patch_desktop(monkeypatch, title)
    patch_shot(monkeypatch, server)
    monkeypatch.setattr(
        cu_server.input_mod,
        "type_text_focused",
        lambda text, interval=0: {"method": "wm-char", "control": 1, "control_class": "RichEditD2DPT",
                                  "chars": len(text), "failed_at": None},
    )

    envelope = envelope_of(server.call_tool("type_text", {"text": body, "expect_title": expect}))
    rows, raw = rows_of(server)

    assert envelope["ok"] is True
    assert MARKER not in raw
    echo = rows[0]["args_echo"]
    assert echo["text_len"] == len(body)
    assert echo["expect_title_len"] == len(expect)
    assert echo["expect_title_sha1_8"] == hashlib.sha1(expect.encode("utf-8")).hexdigest()[:8]
    assert "expect_title" not in echo
    assert "title" not in rows[0]["focus"]


def test_focus_mismatch_refusal_row_hides_the_title_too(tmp_path, monkeypatch):
    title = f"*{MARKER}.txt - 记事本"
    server = make_server(tmp_path)
    patch_desktop(monkeypatch, title)
    patch_shot(monkeypatch, server)

    envelope = envelope_of(
        server.call_tool("type_text", {"text": MARKER, "expect_title": "definitely-not-this-window"})
    )
    rows, raw = rows_of(server)

    assert envelope["refused"] == "focus-mismatch"
    assert envelope["focus"]["title"] == title  # the model needs it to recover
    assert MARKER not in raw
    assert "title" not in rows[0]["focus"]
    assert "expect_title" not in rows[0]["args_echo"]
    assert rows[0]["args_echo"]["expect_title_len"] == len("definitely-not-this-window")


# --------------------------------------------------------------------------
# P3: a screenshot writes exactly one row, and that row holds no image/path
# --------------------------------------------------------------------------

def test_screenshot_writes_exactly_one_row_per_call(tmp_path, monkeypatch):
    title = f"*{MARKER}.txt - 记事本"
    server = make_server(tmp_path)
    patch_desktop(monkeypatch, title)
    patch_shot(monkeypatch, server)
    monkeypatch.setattr(
        cu_server.dpi, "dpi_report", lambda: {"scale": 1.0, "dpi": 96, "dpi_aware": True, "method": "test"}
    )
    monkeypatch.setattr(cu_server.capture, "virtual_screen", lambda: {"x": 0, "y": 0, "w": 320, "h": 200})
    monkeypatch.setattr(cu_server.input_mod, "cursor_pos", lambda: {"x": 3, "y": 4})

    first = envelope_of(server.call_tool("screenshot", {}))
    second = envelope_of(server.call_tool("screenshot", {}))
    rows, raw = rows_of(server)

    assert len(rows) == 2, f"expected one row per screenshot, got {len(rows)}"
    assert [row["action"] for row in rows] == ["screenshot", "screenshot"]
    assert MARKER not in raw

    for row in rows:
        assert len(row["sha1"]) == 40
        assert (row["width"], row["height"]) == SHOT_SIZE
        assert row["display"] == 0
        assert row["scale"] == 1.0
        # Files are named relative to the audit dir: an absolute path would
        # print the user's folders into the trail for no reviewer benefit.
        assert row["shot"] == f"shots/{row['action_id']}.png"
        assert row["thumb"] == f"shots/{row['action_id']}-thumb.jpg"
        assert "title" not in row["active_window"]
        # No decoded image rides the row.
        assert "data" not in row and "image" not in row
        assert len(json.dumps(row, ensure_ascii=False)) < 1200

    # Return contract untouched.
    assert first["path"].endswith(".png")
    assert first["active_window"]["title"] == title
    assert second["audit"]["row"] == 2


# --------------------------------------------------------------------------
# the same two rules against a real Notepad window
# --------------------------------------------------------------------------

def _user32():
    return ctypes.WinDLL("user32", use_last_error=True)


def _top_level_hwnds(user32):
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _lparam):
        if user32.IsWindowVisible(hwnd):
            found.append(hwnd)
        return True

    user32.EnumWindows(cb, 0)
    return found


def _wait_for_title(needle, timeout=20.0):
    user32 = _user32()
    deadline = time.time() + timeout
    while time.time() < deadline:
        for hwnd in _top_level_hwnds(user32):
            info = cu_input.describe_window(hwnd) or {}
            if needle in (info.get("title") or ""):
                return hwnd
        time.sleep(0.25)
    return None


def _focus(hwnd, timeout=8.0):
    """Bring `hwnd` to the foreground, or report that we could not.

    Windows refuses ``SetForegroundWindow`` from a process the user is not
    interacting with ("foreground lock"), so this attaches to the current
    foreground thread for the call — the documented way through — and still
    gives up rather than fighting: the caller skips.
    """
    user32 = _user32()
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.AllowSetForegroundWindow(-1)  # ASFW_ANY
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    own_tid = kernel32.GetCurrentThreadId()
    deadline = time.time() + timeout
    while time.time() < deadline:
        fg = user32.GetForegroundWindow()
        fg_tid = user32.GetWindowThreadProcessId(fg, None)
        attached = False
        if fg_tid and fg_tid != own_tid:
            attached = bool(user32.AttachThreadInput(fg_tid, own_tid, True))
        try:
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
        finally:
            if attached:
                user32.AttachThreadInput(fg_tid, own_tid, False)
        time.sleep(0.2)
        if (cu_input.foreground_window() or {}).get("hwnd") == hwnd:
            return True
    return False


def _kill(hwnd):
    user32 = _user32()
    info = cu_input.describe_window(hwnd) or {}
    pid = info.get("pid")
    if pid:
        os.system(f"taskkill /PID {pid} /F >nul 2>&1")
    else:  # pragma: no cover - the window outlived its process lookup
        user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE


@pytest.mark.skipif(sys.platform != "win32", reason="needs a real Notepad window title")
def test_real_notepad_title_never_reaches_the_actions_file(tmp_path, monkeypatch):
    """Type a marker into Notepad, then click — nothing may leak the title.

    This is the only test in the suite that takes the foreground (``type_text``
    needs it); it skips instead of fighting for it, and it stubs the click's
    INJECTION so the user's pointer never moves.  What is under test is the row
    the click writes, built from the real (marker-bearing) window title.
    """
    doc = tmp_path / f"{MARKER}.txt"
    doc.write_text("", encoding="utf-8")

    proc = None
    for exe in (
        os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "notepad.exe"),
        "notepad.exe",
    ):
        try:
            proc = subprocess.Popen([exe, str(doc)])
            break
        except OSError:
            continue
    if proc is None:
        pytest.skip("notepad.exe is not available on this host")

    hwnd = None
    try:
        hwnd = _wait_for_title(MARKER)
        if not hwnd:
            pytest.skip("Notepad never opened a window named after the marker document")
        if not _focus(hwnd):
            pytest.skip("could not put Notepad in the foreground on this desktop")

        server = make_server(tmp_path)
        typed = envelope_of(
            server.call_tool("type_text", {"text": f"{MARKER} typed by the audit test", "expect_title": MARKER})
        )
        if typed.get("ok") is not True:
            pytest.skip(f"type_text did not run on this desktop: {typed.get('refused') or typed.get('injection_error')}")
        assert typed["delivery"]["method"] in {"wm-char", "send-input"}

        # The title has now become `*<marker>.txt - Notepad` — the exact shape
        # that leaked.  Stub only the injection: the title read is real.
        monkeypatch.setattr(cu_server.input_mod, "click", lambda *a, **k: None)
        rect = cu_input.window_rect(hwnd) or [0, 0, 400, 300]
        clicked = envelope_of(
            server.call_tool("click", {"x": rect[0] + 80, "y": rect[1] + 60, "settle_ms": 0})
        )
        if clicked.get("refused"):
            pytest.skip(f"click refused on this desktop: {clicked['refused']}")

        rows, raw = rows_of(server)
        assert MARKER not in raw, "the typed marker reached actions.jsonl"
        assert [row["action"] for row in rows][:2] == ["type_text", "click"]
        click_row = [row for row in rows if row["action"] == "click"][-1]
        assert "title" not in click_row["focus"]
        assert click_row["focus"]["title_len"] > 0
        type_row = [row for row in rows if row["action"] == "type_text"][-1]
        assert type_row["args_echo"]["text_len"] == len(f"{MARKER} typed by the audit test")
        assert "expect_title" not in type_row["args_echo"]
    finally:
        if hwnd:
            _kill(hwnd)
        try:
            proc.kill()
        except Exception:
            pass

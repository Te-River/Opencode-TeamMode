"""WINDOW SCOPE — `window:` is honoured in ONE place and nowhere else.

The defect this pins: without it every mutating call means "the whole desktop",
so an agent could click whatever happened to be on top.  With it, a call is
about ONE window: `screenshot` crops to it (reading must never steal focus), and
a mutating call focuses it and puts the previous foreground window back.
"""

import pytest

from computeruse import input as input_mod
from computeruse.server import TOOL_SPECS, ComputerUseServer, ToolFailure, _resolve_window


def _server(tmp_path):
    return ComputerUseServer(budget=5, ttl_days=1, audit_root=str(tmp_path), log=lambda _m: None)


def test_every_tool_accepts_a_window_argument():
    for spec in TOOL_SPECS:
        props = spec["inputSchema"]["properties"]
        assert "window" in props, spec["name"]
        assert props["window"]["type"] == "string"
        assert props["window"]["maxLength"] == 200


def test_resolver_names_the_missing_window_and_the_next_move():
    with pytest.raises(ToolFailure) as err:
        _resolve_window("zzz-no-such-window-title-zzz")
    assert "window-not-found" in str(err.value)
    assert "active_window" in str(err.value), "the refusal has to say what to do next"


def test_empty_window_argument_is_refused_before_touching_the_desktop():
    with pytest.raises(ToolFailure) as err:
        _resolve_window("   ")
    assert "window-empty" in str(err.value)


def test_find_windows_ignores_a_blank_needle():
    assert input_mod.find_windows("") == []
    assert input_mod.find_windows("   ") == []


def test_mutating_call_focuses_the_window_and_restores_the_previous_one(tmp_path, monkeypatch):
    focused = []
    monkeypatch.setattr(
        input_mod, "find_windows",
        lambda pattern, limit=8: [{"hwnd": 222, "title": "Target - Notepad", "rect": [10, 20, 410, 320]}],
    )
    monkeypatch.setattr(input_mod, "foreground_window", lambda: {"hwnd": 111, "title": "User window"})
    monkeypatch.setattr(input_mod, "focus_window", lambda hwnd: focused.append(int(hwnd)) or True)

    srv = _server(tmp_path)
    seen = {}
    monkeypatch.setattr(srv, "_dispatch_tool", lambda name, args: seen.update(name=name, args=args) or {"ok": True})

    srv.call_tool("click", {"x": 5, "y": 5, "window": "Notepad"})

    assert focused == [222, 111], f"focus the target, then put the user's window back: {focused}"
    assert "window" not in seen["args"], "the tool body never sees the window key"


def test_screenshot_crops_to_the_window_and_never_steals_focus(tmp_path, monkeypatch):
    focused = []
    monkeypatch.setattr(
        input_mod, "find_windows",
        lambda pattern, limit=8: [{"hwnd": 222, "title": "Target", "rect": [10, 20, 410, 320]}],
    )
    monkeypatch.setattr(input_mod, "focus_window", lambda hwnd: focused.append(int(hwnd)) or True)

    srv = _server(tmp_path)
    seen = {}
    monkeypatch.setattr(srv, "_dispatch_tool", lambda name, args: seen.update(name=name, args=args) or {"ok": True})

    srv.call_tool("screenshot", {"window": "Target", "display": 1, "include_image": False})

    assert seen["args"]["region"] == [10, 20, 410, 320]
    assert "display" not in seen["args"], "a window crop overrides the display selector"
    assert focused == [], "reading a window must not take the focus away"

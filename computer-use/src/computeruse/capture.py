"""Screen capture via mss, with the virtual-screen geometry spelled out.

The one contract everything else depends on: the coordinate space of a capture
IS the coordinate space of `click` / `scroll` / `drag`.  On a multi-monitor
setup the virtual screen origin can be **negative** (a monitor left of or above
the primary), so callers must never assume (0, 0) is the top-left of anything —
they must read `left`/`top` out of this module, which is what `input` normalises
against too.
"""

from __future__ import annotations

import atexit
import hashlib
import threading
from dataclasses import dataclass

from . import dpi

_lock = threading.Lock()
_sct = None


def _session():
    """One lazily created mss instance (it caches a DC; reuse is much faster)."""
    global _sct
    if _sct is None:
        import mss  # local import: keeps pure-function tests free of GDI

        dpi.ensure_dpi_aware()
        _sct = mss.mss()
        atexit.register(close)
    return _sct


def close() -> None:
    global _sct
    with _lock:
        if _sct is not None:
            try:
                _sct.close()
            except Exception:  # teardown must never raise
                pass
            _sct = None


def virtual_screen() -> dict:
    """Union of all monitors: {x, y, w, h} in physical pixels."""
    mon = _session().monitors[0]
    return {"x": int(mon["left"]), "y": int(mon["top"]), "w": int(mon["width"]), "h": int(mon["height"])}


def monitors() -> list[dict]:
    """One entry per physical monitor (index 1..N of mss), 0-based here."""
    out = []
    for mon in _session().monitors[1:]:
        out.append(
            {
                "x": int(mon["left"]),
                "y": int(mon["top"]),
                "w": int(mon["width"]),
                "h": int(mon["height"]),
            }
        )
    return out


@dataclass(frozen=True)
class Frame:
    """One captured frame. `sha1` is over the raw BGRA bytes, not the PNG."""

    raw: bytes
    width: int
    height: int
    left: int
    top: int
    sha1: str

    def to_image(self):
        from PIL import Image

        # mss hands back BGRA; "BGRX" drops the alpha byte in C rather than in
        # a Python loop.
        return Image.frombytes("RGB", (self.width, self.height), self.raw, "raw", "BGRX")


def _rect(region: list[int] | None, display: int | None) -> dict:
    if region is not None:
        l, t, r, b = (int(v) for v in region)
        if r <= l or b <= t:
            raise ValueError(f"region needs right>left and bottom>top, got {region}")
        return {"left": l, "top": t, "width": r - l, "height": b - t}
    if display is not None:
        mons = _session().monitors
        idx = int(display) + 1  # index 0 is the virtual screen; users count displays from 0
        if idx < 0 or idx >= len(mons):
            raise ValueError(f"display {display} out of range: {len(mons) - 1} display(s) present")
        mon = mons[idx]
        return {"left": int(mon["left"]), "top": int(mon["top"]), "width": int(mon["width"]), "height": int(mon["height"])}
    mon = _session().monitors[0]
    return {"left": int(mon["left"]), "top": int(mon["top"]), "width": int(mon["width"]), "height": int(mon["height"])}


def grab(region: list[int] | None = None, display: int | None = None) -> Frame:
    """Capture the virtual screen (default), one display, or an explicit region."""
    with _lock:
        sct = _session()
        rect = _rect(region, display)
        shot = sct.grab(rect)
        raw = bytes(shot.raw)
    return Frame(
        raw=raw,
        width=int(shot.width),
        height=int(shot.height),
        left=int(rect["left"]),
        top=int(rect["top"]),
        sha1=hashlib.sha1(raw).hexdigest(),
    )


def probe() -> dict:
    """Cheap health check for `--selftest`: does a grab actually work here?"""
    vs = virtual_screen()
    frame = grab()
    return {
        "virtual_screen": vs,
        "capture": {"width": frame.width, "height": frame.height, "sha1": frame.sha1, "bytes": len(frame.raw)},
        "monitors": monitors(),
    }

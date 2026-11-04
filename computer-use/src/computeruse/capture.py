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
import os
import threading
from dataclasses import dataclass

from . import dpi

_lock = threading.Lock()
_sct = None

# --- attached-image governance (defaults live at module top so they are readable
# --- from an installed wheel, where nobody opens a .py with a pager) -----------
#
# An attached JPEG is not a one-call cost: it rides the conversation and is
# re-sent on EVERY later turn. One exported session paid 2.67M cache-read tokens
# for exactly that. So attachments get their own per-process byte budget, and a
# frame identical to the one just attached is not attached a second time.
#
# `CU_IMAGE_BUDGET_BYTES`: total bytes of JPEG allowed to ride replies in this
# process. `0` or negative = no cap. 4 MiB ≈ 10 full-screen frames at the
# 400 KB/attachment ceiling, or ~35 typical small ones.
IMAGE_BUDGET_ENV = "CU_IMAGE_BUDGET_BYTES"
DEFAULT_IMAGE_BUDGET_BYTES = 4 * 1024 * 1024
# How many capture targets remember their last attached frame. Small on purpose:
# this is a dedupe memo, not a history of the user's screen.
DEDUPE_TARGET_CAP = 64


def image_budget_bytes(env=None) -> int:
    """The attached-image budget for THIS process, read from `CU_IMAGE_BUDGET_BYTES`.

    An unparseable value falls back to the DEFAULT rather than to no cap: a typo in
    an env var must not silently switch the governor off — that is the failure shape
    this package calls a lie.
    """
    source = os.environ if env is None else env
    raw = source.get(IMAGE_BUDGET_ENV)
    if raw is None or not str(raw).strip():
        return DEFAULT_IMAGE_BUDGET_BYTES
    try:
        value = int(str(raw).strip())
    except ValueError:
        return DEFAULT_IMAGE_BUDGET_BYTES
    return value if value > 0 else 0


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


class ImageLedger:
    """Per-process budget + repeat-frame memory for ATTACHED screenshot images.

    What it can and cannot do: it decides whether a COPY of the frame rides the
    reply.  The PNG on disk, its path and the frame `sha1` are the forensic face
    and are never touched from here — so "no image this time" is always a statement
    about the reply, never about what the screen looked like.

    State is in-process ONLY, like `ActionBudget` and the panic state.  Persisting
    it would open a second record of what the user's screen showed, which is the
    privacy face this package refuses to widen.

    The dedupe memory is keyed by capture target (the server builds the key from the
    frame rect + display + max_width), because "the same pixels in a different
    window" is not the same fact: one window must never silence another's image.
    """

    def __init__(self, budget_bytes: int | None = None):
        self.limit = image_budget_bytes() if budget_bytes is None else max(0, int(budget_bytes))
        self.attached = 0
        self.bytes_sent = 0
        self.deduped = 0
        self.skipped_budget = 0
        self._last_sha1: dict = {}

    # -- budget ------------------------------------------------------------
    @property
    def unlimited(self) -> bool:
        return self.limit <= 0

    @property
    def exhausted(self) -> bool:
        return not self.unlimited and self.bytes_sent >= self.limit

    def remaining_bytes(self) -> int:
        """-1 means no cap (`unlimited`), so a caller never reads it as a number."""
        return -1 if self.unlimited else self.limit - self.bytes_sent

    def affordable(self, nbytes: int) -> bool:
        """Would attaching `nbytes` stay inside the budget?  Charges nothing."""
        return self.unlimited or self.bytes_sent + int(nbytes) <= self.limit

    # -- dedupe ------------------------------------------------------------
    def is_repeat(self, key: str, sha1: str) -> bool:
        """Is this the frame we last ATTACHED for this exact target?"""
        return bool(sha1) and self._last_sha1.get(key) == sha1

    def last_sha1(self, key: str):
        return self._last_sha1.get(key)

    # -- bookkeeping -------------------------------------------------------
    def note_attached(self, key: str, sha1: str, nbytes: int) -> None:
        """Charge an attachment and remember its frame.

        Only an image that actually reached the reply may move these counters: a
        skipped frame costs nothing, and crediting it would make the budget lie
        about what the model was really sent.
        """
        self.attached += 1
        self.bytes_sent += int(nbytes)
        self._last_sha1[key] = sha1
        while len(self._last_sha1) > DEDUPE_TARGET_CAP:  # dicts keep insertion order
            self._last_sha1.pop(next(iter(self._last_sha1)))

    def note_deduped(self) -> None:
        self.deduped += 1

    def note_budget_skip(self) -> None:
        self.skipped_budget += 1

    def snapshot(self) -> dict:
        """The authoritative reading `control_status` reports."""
        return {
            "attached": self.attached,
            "bytes_sent": self.bytes_sent,
            "limit": self.limit,
            "unlimited": self.unlimited,
            "remaining": self.remaining_bytes(),
            "exhausted": self.exhausted,
            "deduped": self.deduped,
            "skipped_budget": self.skipped_budget,
            "tracked_targets": len(self._last_sha1),
        }


_image_ledger: ImageLedger | None = None


def image_ledger() -> ImageLedger:
    """THE ledger for this process — one MCP server per process, and the attachment
    budget is a per-process fact.  Tests (and a caller wanting a fresh budget) pass
    their own instance to `ComputerUseServer(image_ledger=...)`."""
    global _image_ledger
    with _lock:
        if _image_ledger is None:
            _image_ledger = ImageLedger()
        return _image_ledger

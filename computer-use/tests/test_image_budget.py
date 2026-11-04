"""Attached-image budget + repeat-frame dedupe, against a faked desktop.

Nothing here captures the real screen: `_shot` is stubbed the way
test_audit_privacy.py stubs it, because the subject is the LEDGER, and a live
grab would only make it slow and non-deterministic.

What these tests hold fixed: the PNG on disk, its path, the frame `sha1` and the
`changed` / `no-observable-change` verdict.  Those are the forensic face; the
ledger may only decide whether a COPY of the frame rides the reply.
"""

import hashlib
import json
from pathlib import Path

from computeruse import server as cu_server
from computeruse.capture import (
    DEFAULT_IMAGE_BUDGET_BYTES,
    IMAGE_BUDGET_ENV,
    Frame,
    ImageLedger,
    image_budget_bytes,
    image_ledger,
)

SHOT_SIZE = (320, 200)
RED = (200, 30, 30)
GREEN = (30, 200, 30)
BLUE = (30, 30, 200)


# --------------------------------------------------------------------------
# harness
# --------------------------------------------------------------------------

class Screen:
    """The desktop, replaced.  One mutable colour, so "the frame changed" is a
    fact this file controls instead of waiting on a live window.

    The frame's `sha1` is over the image bytes, exactly like the real
    `capture.Frame` hashes its raw BGRA: a content change moves the hash, and the
    dedupe judgement therefore rests on pixels, never on a timestamp.
    """

    def __init__(self, colour=RED):
        self.image = Image_new(colour)

    def set(self, colour):
        self.image = Image_new(colour)

    def shot(self, region=None, display=None):
        image = self.image
        left = top = 0
        width, height = image.width, image.height
        if region:
            left, top = int(region[0]), int(region[1])
            width = max(1, int(region[2]) - left)
            height = max(1, int(region[3]) - top)
        raw = image.tobytes()
        frame = Frame(
            raw=raw, width=width, height=height, left=left, top=top,
            sha1=hashlib.sha1(raw).hexdigest(),
        )
        return frame, image.copy()

    def install(self, monkeypatch, server):
        monkeypatch.setattr(server, "_shot", self.shot)


def Image_new(colour):
    from PIL import Image

    return Image.new("RGB", SHOT_SIZE, colour)


def make_server(tmp_path, ledger="__fresh__"):
    """`ledger="__fresh__"` → a private ledger for this test only;
    `ledger=None` → the production default, which is the process singleton."""
    if isinstance(ledger, str) and ledger == "__fresh__":
        ledger = ImageLedger()
    server = cu_server.ComputerUseServer(
        budget=5,
        ttl_days=1,
        audit_root=str(tmp_path / "audit"),
        log=lambda _m: None,
        image_ledger=ledger,
    )
    # start() sets DPI and REGISTERS THE REAL PANIC HOTKEY — machine state these
    # tests have no business touching.
    server._started = True
    return server


def patch_desktop(monkeypatch, server, screen):
    screen.install(monkeypatch, server)
    monkeypatch.setattr(
        cu_server.dpi, "dpi_report",
        lambda: {"scale": 1.0, "dpi": 96, "dpi_aware": True, "method": "test"},
    )
    monkeypatch.setattr(
        cu_server.capture, "virtual_screen",
        lambda: {"x": 0, "y": 0, "w": SHOT_SIZE[0], "h": SHOT_SIZE[1]},
    )
    monkeypatch.setattr(cu_server.input_mod, "cursor_pos", lambda: {"x": 1, "y": 2})
    monkeypatch.setattr(
        cu_server.input_mod, "foreground_window",
        lambda: {"title": "Fake Window", "process": "fake.exe", "rect": [0, 0, 64, 64]},
    )
    monkeypatch.setattr(
        cu_server.safety, "secure_desktop_probe",
        lambda frame_image=None: {"active": False, "reason": None},
    )
    monkeypatch.setattr(
        cu_server.safety, "target_elevation",
        lambda x, y: {"verdict": "ok", "detail": None, "target": None},
    )
    monkeypatch.setattr(cu_server.input_mod, "click", lambda *a, **k: None)
    monkeypatch.setattr(cu_server.input_mod, "type_text_focused", lambda *a, **k: {})


def body(result) -> dict:
    return json.loads(result["content"][0]["text"])


def images(result) -> list:
    return [part for part in result["content"] if part["type"] == "image"]


def rows(server):
    path = server.audit.rows_file
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


# --------------------------------------------------------------------------
# ② repeat-frame dedupe
# --------------------------------------------------------------------------

def test_an_identical_frame_is_not_attached_twice(tmp_path, monkeypatch):
    screen = Screen(RED)
    server = make_server(tmp_path)
    patch_desktop(monkeypatch, server, screen)

    first = server.call_tool("screenshot", {"include_image": True})
    second = server.call_tool("screenshot", {"include_image": True})
    a, b = body(first), body(second)

    assert len(images(first)) == 1, "the first frame the model asks to see must actually arrive"
    assert images(second) == [], "the same pixels must not ride the reply a second time"
    assert b["image_omitted_reason"] == "repeat-frame"
    assert "与上一帧相同，未重复附图" in b["image_omitted"]
    assert f"sha1={a['sha1']}" in b["image_omitted"], "the note names the frame it deduped against"

    assert server.images.deduped == 1
    assert server.images.attached == 1
    # A dedupe costs nothing, so it charges nothing: the budget counts bytes the
    # model really received, not calls the model made.
    assert server.images.bytes_sent == a["image"]["bytes"]


def test_dedupe_leaves_the_png_and_the_audit_untouched(tmp_path, monkeypatch):
    """③ — the forensic face does not move when the reply gets leaner."""
    screen = Screen(RED)
    server = make_server(tmp_path)
    patch_desktop(monkeypatch, server, screen)

    a = body(server.call_tool("screenshot", {"include_image": True}))
    b = body(server.call_tool("screenshot", {"include_image": True}))

    assert a["sha1"] == b["sha1"] == hashlib.sha1(screen.image.tobytes()).hexdigest()
    assert a["path"] != b["path"], "every screenshot still writes its own PNG"
    for text in (a, b):
        assert text["path"].endswith(".png")
        assert Path(text["path"]).exists()
        assert Path(text["thumb"]["path"]).exists()

    audit_rows = rows(server)
    assert [r["action"] for r in audit_rows] == ["screenshot", "screenshot"]
    assert [r["shot"] for r in audit_rows] == [f"shots/{r['action_id']}.png" for r in audit_rows]


def test_a_changed_frame_is_attached_again(tmp_path, monkeypatch):
    screen = Screen(RED)
    server = make_server(tmp_path)
    patch_desktop(monkeypatch, server, screen)

    assert len(images(server.call_tool("screenshot", {"include_image": True}))) == 1

    screen.set(GREEN)
    second = server.call_tool("screenshot", {"include_image": True})
    b = body(second)
    assert len(images(second)) == 1, "new pixels — the model gets to see them"
    assert "image" in b and "image_omitted" not in b
    assert server.images.attached == 2
    assert server.images.deduped == 0

    # and the frame right after it, unchanged again, is deduped against GREEN
    third = server.call_tool("screenshot", {"include_image": True})
    assert images(third) == []
    assert f"sha1={b['sha1']}" in body(third)["image_omitted"], "it names the frame it matched"
    assert server.images.deduped == 1


def test_dedupe_is_scoped_to_one_capture_target(tmp_path, monkeypatch):
    """Same pixels in a different crop are NOT the same fact — so both attach.

    A global last-frame cache would let window A silence window B's image, which
    is the overstatement this package exists to refuse.
    """
    screen = Screen(RED)
    server = make_server(tmp_path)
    patch_desktop(monkeypatch, server, screen)

    left_crop = server.call_tool("screenshot", {"include_image": True, "region": [0, 0, 100, 100]})
    right_crop = server.call_tool("screenshot", {"include_image": True, "region": [200, 0, 300, 100]})
    assert len(images(left_crop)) == 1
    assert len(images(right_crop)) == 1, "a different region is a different target"
    assert body(left_crop)["sha1"] == body(right_crop)["sha1"], "identical content, different target"

    # the same target, the same frame → deduped; another scale → a new request honoured
    assert images(server.call_tool("screenshot", {"include_image": True, "region": [0, 0, 100, 100]})) == []
    assert len(images(server.call_tool("screenshot", {"include_image": True, "region": [0, 0, 100, 100], "max_width": 640}))) == 1
    assert server.images.deduped == 1
    assert server.images.attached == 3


def test_no_attachment_requested_touches_nothing(tmp_path, monkeypatch):
    screen = Screen(RED)
    server = make_server(tmp_path)
    patch_desktop(monkeypatch, server, screen)

    for _ in range(3):
        result = server.call_tool("screenshot", {})
        assert images(result) == []
        assert "image_omitted" not in body(result), "include_image:false has nothing to explain"

    assert server.images.snapshot() == ImageLedger().snapshot(), "counters stay flat"


# --------------------------------------------------------------------------
# ① the per-process byte budget
# --------------------------------------------------------------------------

def test_a_tiny_budget_refuses_and_says_why_in_numbers(tmp_path, monkeypatch):
    ledger = ImageLedger(budget_bytes=1)
    screen = Screen(RED)
    server = make_server(tmp_path, ledger)
    patch_desktop(monkeypatch, server, screen)

    result = server.call_tool("screenshot", {"include_image": True})
    text = body(result)

    assert images(result) == []
    assert text["image_omitted_reason"] == "budget"
    note = text["image_omitted"]
    assert "未附图" in note and "预算" in note
    assert "上限 1 字节" in note and "已发 0 张 / 0 字节" in note
    # the anti-misattribution line: no image ≠ a blank screen
    assert "不表示画面空白" in note and "不表示屏幕没有变化" in note
    assert "blank" not in text, "a withheld attachment must not set the blank flag"
    assert "read" in note and "CU_IMAGE_BUDGET_BYTES" in note, "the note names the next moves"

    # ③ the forensic face survives it
    assert text["path"].endswith(".png") and Path(text["path"]).exists()
    assert text["sha1"] == hashlib.sha1(screen.image.tobytes()).hexdigest()

    assert ledger.attached == 0 and ledger.bytes_sent == 0
    assert ledger.skipped_budget == 1


def test_an_exhausted_budget_names_the_spent_total(tmp_path, monkeypatch):
    """Limit == exactly one frame's worth: the second frame hits the `已用完` line."""
    screen = Screen(RED)
    probe = make_server(tmp_path, ImageLedger(budget_bytes=0))
    patch_desktop(monkeypatch, probe, screen)
    one_frame = body(probe.call_tool("screenshot", {"include_image": True}))["image"]["bytes"]
    assert probe.images.unlimited is True and probe.images.bytes_sent == one_frame

    ledger = ImageLedger(budget_bytes=one_frame)
    server = make_server(tmp_path, ledger)
    patch_desktop(monkeypatch, server, screen)
    first = body(server.call_tool("screenshot", {"include_image": True}))
    screen.set(GREEN)
    second = body(server.call_tool("screenshot", {"include_image": True}))

    assert "image" in first and "image_omitted" not in first
    assert second["image_omitted_reason"] == "budget"
    assert "预算已用完" in second["image_omitted"]
    assert f"已发 1 张 / {one_frame} 字节" in second["image_omitted"]
    assert ledger.exhausted is True


def test_budget_zero_means_no_cap(tmp_path, monkeypatch):
    screen = Screen(RED)
    server = make_server(tmp_path, ImageLedger(budget_bytes=0))
    patch_desktop(monkeypatch, server, screen)

    for colour in (RED, GREEN, BLUE):
        screen.set(colour)
        assert len(images(server.call_tool("screenshot", {"include_image": True}))) == 1

    snap = server.images.snapshot()
    assert snap["unlimited"] is True and snap["remaining"] == -1 and snap["exhausted"] is False
    assert snap["attached"] == 3


def test_budget_default_and_env_are_read_from_the_module(tmp_path, monkeypatch):
    assert DEFAULT_IMAGE_BUDGET_BYTES == 4 * 1024 * 1024, "the shipped default, spelled out"
    assert image_budget_bytes({}) == DEFAULT_IMAGE_BUDGET_BYTES
    assert image_budget_bytes({IMAGE_BUDGET_ENV: "0"}) == 0
    assert image_budget_bytes({IMAGE_BUDGET_ENV: "-3"}) == 0
    assert image_budget_bytes({IMAGE_BUDGET_ENV: "12345"}) == 12345
    # a typo falls back to the DEFAULT, never to no-cap: silently switching the
    # governor off is the failure shape this package calls a lie.
    assert image_budget_bytes({IMAGE_BUDGET_ENV: "lots"}) == DEFAULT_IMAGE_BUDGET_BYTES

    monkeypatch.setenv(IMAGE_BUDGET_ENV, "8192")
    assert ImageLedger().limit == 8192
    monkeypatch.delenv(IMAGE_BUDGET_ENV, raising=False)
    assert ImageLedger().limit == DEFAULT_IMAGE_BUDGET_BYTES


def test_the_ledger_is_one_per_process(tmp_path, monkeypatch):
    """Two servers in one process share the budget — that is what 进程内 means."""
    monkeypatch.delenv(IMAGE_BUDGET_ENV, raising=False)
    shared = image_ledger()
    assert image_ledger() is shared, "the accessor hands back one instance"
    a = make_server(tmp_path, ledger=None)
    b = make_server(tmp_path / "other", ledger=None)
    assert a.images is shared and b.images is shared
    assert shared.limit == image_budget_bytes(), "the singleton carries today's env reading"


# --------------------------------------------------------------------------
# ④ control_status, and the defensive read of another module's API
# --------------------------------------------------------------------------

class TrailStub:
    """Forwards everything to the real `AuditTrail`, but answers `usage()` in one
    of the shapes the server has to survive.

    audit.py belongs to another agent right now, so this file must not assume
    whether `usage()` exists yet — each face is created here instead.
    """

    MISSING = object()

    def __init__(self, trail, usage):
        self._trail = trail
        self._usage = usage

    def __getattr__(self, name):
        if name == "usage":
            if self._usage is TrailStub.MISSING:
                raise AttributeError(name)  # the method is simply not there
            return self._usage
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._trail, name)


def test_control_status_reports_attachment_counters(tmp_path, monkeypatch):
    ledger = ImageLedger(budget_bytes=64 * 1024)
    screen = Screen(RED)
    server = make_server(tmp_path, ledger)
    patch_desktop(monkeypatch, server, screen)

    body(server.call_tool("screenshot", {"include_image": True}))  # attach
    body(server.call_tool("screenshot", {"include_image": True}))  # dedupe
    payload = body(server.call_tool("control_status", {}))

    assert payload["image_attachments"] == ledger.snapshot()
    snap = payload["image_attachments"]
    for key in ("attached", "bytes_sent", "limit", "deduped", "skipped_budget", "exhausted"):
        assert key in snap, key
    assert snap["attached"] == 1 and snap["deduped"] == 1
    assert snap["bytes_sent"] > 0 and snap["limit"] == 64 * 1024


def test_control_status_survives_a_missing_audit_usage(tmp_path):
    """audit.py is another agent's file; `usage()` may or may not exist yet.

    Either way the read-only authoritative budget reading answers — it never
    raises, and an absent number is never printed as a zero.
    """
    server = make_server(tmp_path)
    server.audit = TrailStub(server.audit, TrailStub.MISSING)
    payload = body(server.call_tool("control_status", {}))
    assert payload["audit_usage"]["available"] is False
    assert "audit usage: unavailable" in payload["audit_usage"]["note"]
    # the stub forwards, so the rest of the read-only answer is intact
    assert payload["audit_dir"] and payload["image_attachments"]["attached"] == 0


def test_control_status_survives_a_throwing_or_nonsense_usage(tmp_path):
    server = make_server(tmp_path)
    audit = server.audit

    def boom():
        raise RuntimeError("audit exploded")

    server.audit = TrailStub(audit, boom)
    payload = body(server.call_tool("control_status", {}))
    assert payload["audit_usage"]["available"] is False
    assert "audit usage: unavailable" in payload["audit_usage"]["note"]
    assert "RuntimeError" in payload["audit_usage"]["note"]

    server.audit = TrailStub(audit, lambda: "not an object")
    assert body(server.call_tool("control_status", {}))["audit_usage"]["available"] is False

    keys = ("bytes", "cap_bytes", "ttl_days", "evicted_runs", "evicted_bytes")

    server.audit = TrailStub(audit, lambda: {k: i + 1 for i, k in enumerate(keys)})
    ok = body(server.call_tool("control_status", {}))["audit_usage"]
    assert ok["available"] is True
    assert [ok[k] for k in keys] == [1, 2, 3, 4, 5]

    # a partial or non-numeric answer is reported as None, never as a zero
    server.audit = TrailStub(audit, lambda: {"bytes": "lots"})
    partial = body(server.call_tool("control_status", {}))["audit_usage"]
    assert partial["available"] is True
    assert partial["bytes"] is None and partial["cap_bytes"] is None


# --------------------------------------------------------------------------
# ③ the verdict comes from pixels, never from the attachment decision
# --------------------------------------------------------------------------

def test_verdict_is_pixels_not_attachment(tmp_path, monkeypatch):
    """With EVERY attachment refused by the budget, click still reads the screen."""
    ledger = ImageLedger(budget_bytes=1)
    screen = Screen(RED)
    server = make_server(tmp_path, ledger)
    patch_desktop(monkeypatch, server, screen)

    no_image = body(server.call_tool("screenshot", {"include_image": True}))
    assert no_image["image_omitted_reason"] == "budget", "the budget really is spent-and-refusing"

    moved = {"clicked": False}

    def click(*_a, **_k):
        moved["clicked"] = True
        screen.set(GREEN)

    monkeypatch.setattr(cu_server.input_mod, "click", click)
    changed = body(server.call_tool("click", {"x": 10, "y": 10, "settle_ms": 0}))
    assert moved["clicked"] is True
    assert changed["verdict"] == "changed"
    assert changed["before_sha1"] != changed["after_sha1"]
    assert changed["changed_pixels_pct"] >= changed["noise_floor_pct"]

    still = body(server.call_tool("click", {"x": 10, "y": 10, "settle_ms": 0}))
    assert still["verdict"] == "no-observable-change"
    assert still["before_sha1"] == still["after_sha1"]
    assert still["hint"], "a no-change answer still names the next move"

    # A mutating call never attaches and never charges the image budget.
    assert ledger.attached == 0 and ledger.bytes_sent == 0 and ledger.skipped_budget == 1


def test_no_attachment_decision_reaches_the_audit_row(tmp_path, monkeypatch):
    """The row is the forensic record: dedupe/budget change nothing in it."""
    screen = Screen(RED)
    server = make_server(tmp_path, ImageLedger(budget_bytes=1))
    patch_desktop(monkeypatch, server, screen)

    body(server.call_tool("screenshot", {"include_image": True}))  # skipped: budget
    body(server.call_tool("screenshot", {}))  # never asked for an image

    audit_rows = rows(server)
    assert len(audit_rows) == 2
    for row in audit_rows:
        assert len(row["sha1"]) == 40
        assert row["shot"] == f"shots/{row['action_id']}.png"
        assert "data" not in row and "image" not in row

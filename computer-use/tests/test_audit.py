"""Audit trail shape, the content-redaction rules, and the TTL sweep."""

import hashlib
import json
from datetime import date

from computeruse.audit import AuditTrail, redact_args, redact_focus


def make_trail(tmp_path, **kwargs):
    kwargs.setdefault("today", date(2026, 1, 10))
    return AuditTrail(root=tmp_path, ttl_days=2, sid="abcd1234", **kwargs)


def test_type_text_content_is_never_recorded():
    args = {"text": "hunter2-very-secret", "expect_title": "Notepad", "interval_ms": 0}
    safe = redact_args("type_text", args)
    assert "text" not in safe
    assert "hunter2" not in json.dumps(safe)
    assert safe["text_len"] == len("hunter2-very-secret")
    assert len(safe["text_sha1_8"]) == 8
    # A window title mirrors its content (`*hunter2 - Notepad` the moment the
    # marker is typed), so the caller's copy of it is fingerprinted too.
    assert "expect_title" not in safe
    assert safe["expect_title_len"] == len("Notepad")
    assert safe["expect_title_sha1_8"] == hashlib.sha1(b"Notepad").hexdigest()[:8]


def test_title_fingerprint_survives_a_second_redaction():
    once = redact_args("type_text", {"text": "x", "expect_title": "Notepad"})
    twice = redact_args("type_text", once)
    assert twice["expect_title_len"] == once["expect_title_len"]
    assert twice["expect_title_sha1_8"] == once["expect_title_sha1_8"]


def test_redact_focus_keeps_the_process_and_fingerprints_the_title():
    safe = redact_focus({"title": "*hunter2 - Notepad", "process": "notepad.exe"})
    assert safe["process"] == "notepad.exe"
    assert "title" not in safe
    assert safe["title_len"] == len("*hunter2 - Notepad")
    assert "hunter2" not in json.dumps(safe)


def test_redact_focus_passes_an_absent_focus_through():
    assert redact_focus(None) is None
    assert redact_focus({}) == {}


def test_redact_args_is_idempotent():
    # The server sometimes hands an already-redacted echo to the audit row;
    # re-redacting must not silently reset text_len to 0 (that shipped once).
    once = redact_args("type_text", {"text": "hello computeruse", "expect_title": "Notepad"})
    twice = redact_args("type_text", once)
    assert twice["text_len"] == len("hello computeruse")
    assert twice["text_sha1_8"] == once["text_sha1_8"]


def test_other_actions_keep_their_arguments():
    args = {"x": 10, "y": 20, "button": "left", "clicks": 1}
    assert redact_args("click", args) == args


def test_long_values_are_truncated():
    safe = redact_args("click", {"keys": "x" * 500})
    assert len(safe["keys"]) < 500
    assert "500 chars" in safe["keys"]


def test_rows_are_one_json_object_per_line(tmp_path):
    trail = make_trail(tmp_path)
    trail.append({"action": "click", "verdict": "changed"})
    trail.append({"action": "key", "refused": "focus-mismatch"})
    lines = trail.rows_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2
    assert [json.loads(line)["action"] for line in lines] == ["click", "key"]


def test_append_reports_the_row_number_and_file(tmp_path):
    trail = make_trail(tmp_path)
    first = trail.append({"action": "click"})
    second = trail.append({"action": "click"})
    assert first["row"] == 1 and second["row"] == 2
    assert first["file"].endswith("actions.jsonl")
    assert "2026-01-10" in first["file"] and "abcd1234" in first["file"]


def test_action_ids_increment_per_process(tmp_path):
    trail = make_trail(tmp_path)
    assert [trail.next_action_id() for _ in range(3)] == ["a0001", "a0002", "a0003"]


def test_sweep_drops_expired_days_and_keeps_everything_else(tmp_path):
    old = tmp_path / "2026-01-01"
    recent = tmp_path / "2026-01-09"
    foreign = tmp_path / "not-a-date"
    for path in (old, recent, foreign):
        path.mkdir()
        (path / "x.txt").write_text("x", encoding="utf-8")

    trail = make_trail(tmp_path)  # ttl 2 days from 2026-01-10 -> cutoff 2026-01-08
    result = trail.sweep()

    assert not old.exists()
    assert recent.exists()
    assert foreign.exists()  # never deleted: we cannot name it
    assert result["removed"] == 1
    assert result["removed_dirs"] == ["2026-01-01"]
    assert result["bytes"] > 0


def test_frames_and_shots_land_in_the_expected_places(tmp_path):
    from PIL import Image

    trail = make_trail(tmp_path)
    image = Image.new("RGB", (1920, 1080), (10, 20, 30))
    frame = trail.save_frame(image, "a0001", "before")
    shot = trail.save_shot(image, "a0001")
    assert frame.endswith("frames/a0001-before.jpg") or frame.endswith("frames\\a0001-before.jpg")
    assert shot.endswith("a0001.png")
    # JPEG frames are downscaled to 960 wide so 200 actions stay ~20-40 MB.
    with Image.open(frame) as opened:
        assert opened.width == 960

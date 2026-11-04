"""Audit trail shape, the content-redaction rules, the TTL sweep and the size cap."""

import hashlib
import json
import os
from datetime import date
from pathlib import Path

from computeruse import audit as audit_mod
from computeruse.audit import AuditTrail, redact_args, redact_focus, resolve_max_bytes

CAP_MARKER = "CAP-MARKER-4d1f-TYPED-TOKEN"


def make_trail(tmp_path, **kwargs):
    kwargs.setdefault("today", date(2026, 1, 10))
    kwargs.setdefault("ttl_days", 2)
    kwargs.setdefault("sid", "abcd1234")
    return AuditTrail(root=tmp_path, **kwargs)


def dir_bytes(path) -> int:
    total = 0
    for base, _dirs, files in os.walk(path):
        for name in files:
            total += os.path.getsize(os.path.join(base, name))
    return total


def write_run(root, day: str, sid: str, payload: int) -> Path:
    """A run directory as the trail leaves it: JSONL rows plus a frame."""
    run = Path(root) / day / sid
    (run / "frames").mkdir(parents=True, exist_ok=True)
    (run / "actions.jsonl").write_bytes(b'{"action":"click"}\n')
    (run / "frames" / "a0001-before.jpg").write_bytes(b"0" * payload)
    return run


def fill_live_run(trail, payload: int) -> Path:
    """Write one real row through the trail, then pad it with a frame-sized blob."""
    trail.append({"action": "click", "verdict": "changed"})
    (trail.action_dir / "blob.bin").write_bytes(b"0" * payload)
    return trail.action_dir



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


# =========================================================================
# the total-bytes cap: a volume rule the TTL cannot express
# (measured on a real machine: 27 MB of trail inside a 7-day TTL)
# =========================================================================


def test_default_cap_is_64_mib_and_the_env_moves_it(tmp_path, monkeypatch):
    monkeypatch.delenv(audit_mod.MAX_BYTES_ENV, raising=False)
    assert audit_mod.DEFAULT_MAX_BYTES == 64 * 1024 * 1024
    assert AuditTrail(root=tmp_path).max_bytes == audit_mod.DEFAULT_MAX_BYTES
    monkeypatch.setenv(audit_mod.MAX_BYTES_ENV, "0")
    assert AuditTrail(root=tmp_path).max_bytes == 0  # 0 = no cap, the pre-cap behaviour
    monkeypatch.setenv(audit_mod.MAX_BYTES_ENV, " 12345 ")
    assert AuditTrail(root=tmp_path).max_bytes == 12345
    # A typo falls back to the default rather than to "unbounded": the only
    # size bound must not be switchable off by a mistyped value. `cap_bytes`
    # in usage() always reports whichever number actually won.
    monkeypatch.setenv(audit_mod.MAX_BYTES_ENV, "64MB")
    assert resolve_max_bytes(env={}) == audit_mod.DEFAULT_MAX_BYTES
    assert AuditTrail(root=tmp_path).max_bytes == audit_mod.DEFAULT_MAX_BYTES
    assert resolve_max_bytes(env={audit_mod.MAX_BYTES_ENV: "0"}) == 0
    assert resolve_max_bytes(10, env={audit_mod.MAX_BYTES_ENV: "0"}) == 10  # arg wins


def test_cap_evicts_oldest_runs_and_spares_the_active_run(tmp_path):
    oldest = write_run(tmp_path, "2026-01-05", "run00001", 4000)
    middle = write_run(tmp_path, "2026-01-06", "run00002", 4000)
    newest = write_run(tmp_path, "2026-01-08", "run00003", 4000)
    freed_expect = dir_bytes(oldest) + dir_bytes(middle)

    trail = make_trail(tmp_path, ttl_days=30, max_bytes=9000)
    live = fill_live_run(trail, 4000)
    result = trail.sweep()

    # 4 runs x ~4019 bytes under a 9000-byte cap: two oldest must go, no more.
    assert not oldest.exists() and not middle.exists()
    assert newest.exists(), "the cap evicted a NEWER run before an older one"
    assert live.exists() and (live / "blob.bin").exists()
    assert result["evicted"] == ["2026-01-05/run00001", "2026-01-06/run00002"]
    assert result["evicted_runs"] == 2
    assert result["evicted_bytes"] == freed_expect
    assert result["over_cap"] is False
    assert "cap met" in result["cap_reason"]
    assert result["bytes"] <= 9000 == result["cap_bytes"]
    assert result["emptied_days"] == ["2026-01-05", "2026-01-06"]
    usage = trail.usage()
    assert usage["evicted_runs"] == 2 and usage["evicted_bytes"] == freed_expect
    assert usage["over_cap"] == 0 and usage["bytes"] <= 9000


def test_the_active_run_survives_even_when_it_is_the_oldest_one(tmp_path):
    """The protection is by identity, not by position in the age order."""
    older = write_run(tmp_path, "2026-01-05", "run00001", 4000)
    newer = write_run(tmp_path, "2026-01-06", "run00002", 4000)

    trail = make_trail(tmp_path, ttl_days=30, today=date(2026, 1, 2), max_bytes=5000)
    live = fill_live_run(trail, 4000)  # its DAY (2026-01-02) sorts first
    result = trail.sweep()

    assert live.exists() and (live / "blob.bin").exists()
    assert not older.exists() and not newer.exists()
    assert result["evicted"] == ["2026-01-05/run00001", "2026-01-06/run00002"]
    assert result["over_cap"] is False
    assert dir_bytes(live) <= 5000


def test_cap_zero_is_the_pre_cap_behaviour(tmp_path):
    runs = [write_run(tmp_path, day, sid, 4000)
            for day, sid in (("2026-01-05", "run00001"), ("2026-01-06", "run00002"))]
    trail = make_trail(tmp_path, ttl_days=30, max_bytes=0)
    live = fill_live_run(trail, 4000)
    before = trail.total_bytes()
    result = trail.sweep()

    assert all(path.exists() for path in runs), "max_bytes=0 must not delete anything"
    assert result["cap_bytes"] == 0
    assert result["evicted_runs"] == 0 and result["evicted"] == []
    assert result["over_cap"] is False  # an unbounded trail is not "over"
    assert "no cap" in result["cap_reason"]
    assert result["bytes"] == before == trail.total_bytes()
    usage = trail.usage()
    assert usage["cap_bytes"] == 0 and usage["over_cap"] == 0
    assert usage["bytes"] == before and usage["evicted_runs"] == 0


def test_a_run_that_refuses_to_delete_is_reported_as_not_reclaimed(tmp_path, monkeypatch):
    sticky = write_run(tmp_path, "2026-01-05", "sticky", 4000)
    trail = make_trail(tmp_path, ttl_days=30, max_bytes=5000)
    live = fill_live_run(trail, 4000)
    real = audit_mod._force_remove
    # An OS-level "you may not delete this" (a lock, a permission): the sweep
    # must neither raise nor count those bytes as reclaimed.
    monkeypatch.setattr(
        audit_mod, "_force_remove", lambda path: real(path) if path.name != "sticky" else False
    )
    result = trail.sweep()

    assert sticky.exists() and live.exists()
    assert result["evicted_runs"] == 0 and result["evicted_bytes"] == 0
    assert result["evict_failed"] == 1 and result["evict_failed_runs"] == ["2026-01-05/sticky"]
    assert result["over_cap"] is True
    assert "NOT met" in result["cap_reason"], result["cap_reason"]
    # bytes > cap_bytes with evicted_runs == 0 IS the evidence, in the numbers.
    usage = trail.usage()
    assert usage["over_cap"] == 1 and usage["evicted_runs"] == 0 and usage["evict_failures"] == 1
    assert usage["bytes"] == trail.total_bytes() > 5000


def test_partial_eviction_counts_only_the_bytes_that_actually_left(tmp_path, monkeypatch):
    sticky = write_run(tmp_path, "2026-01-05", "sticky", 4000)
    gone = write_run(tmp_path, "2026-01-06", "removable", 4000)
    gone_bytes = dir_bytes(gone)
    trail = make_trail(tmp_path, ttl_days=30, max_bytes=6000)
    fill_live_run(trail, 4000)
    real = audit_mod._force_remove
    monkeypatch.setattr(
        audit_mod, "_force_remove", lambda path: real(path) if path.name != "sticky" else False
    )
    result = trail.sweep()

    assert sticky.exists() and not gone.exists()
    assert result["evicted_runs"] == 1 and result["evicted_bytes"] == gone_bytes
    assert result["evict_failed"] == 1
    assert result["over_cap"] is True and "refused" in result["cap_reason"]
    usage = trail.usage()
    assert usage["evicted_bytes"] == gone_bytes
    assert usage["bytes"] == trail.total_bytes() > 6000
    assert usage["evicted_runs"] == 1 and usage["evict_failures"] == 1


def test_ttl_runs_first_so_the_cap_never_pays_for_an_expired_day(tmp_path):
    expired_a = write_run(tmp_path, "2026-01-02", "run00001", 1900)
    expired_b = write_run(tmp_path, "2026-01-03", "run00002", 1900)
    recent = write_run(tmp_path, "2026-01-09", "run00009", 1500)

    trail = make_trail(tmp_path, ttl_days=2, max_bytes=4000)  # cutoff 2026-01-08
    live = fill_live_run(trail, 1500)
    result = trail.sweep()

    assert not expired_a.exists() and not expired_b.exists()
    assert recent.exists() and live.exists()
    assert result["removed"] == 2
    assert result["removed_dirs"] == ["2026-01-02", "2026-01-03"]
    # The TTL pass alone brought the trail under the cap: the cap spent nothing.
    assert result["evicted_runs"] == 0 and result["evicted"] == []
    assert result["over_cap"] is False and result["bytes"] <= 4000


def test_the_cap_bites_on_the_write_path_not_only_at_shutdown(tmp_path):
    stale = write_run(tmp_path, "2026-01-05", "run00001", 4000)
    trail = make_trail(tmp_path, ttl_days=30, max_bytes=3000,
                      maintain_every_rows=1, maintain_min_seconds=0)

    trail.append({"action": "click", "verdict": "changed"})  # no sweep() call anywhere

    assert not stale.exists(), "the cap was only enforced by an explicit sweep()"
    assert trail.usage()["evicted_runs"] == 1
    assert (trail.rows_file.exists() and trail.rows_file.read_bytes().count(b"\n") == 1)


def test_the_write_path_sweep_is_throttled_not_per_row(tmp_path):
    stale = write_run(tmp_path, "2026-01-05", "run00001", 4000)
    trail = make_trail(tmp_path, ttl_days=30, max_bytes=3000)  # default knobs: 20 rows
    before = trail.total_bytes()

    for _ in range(3):
        trail.append({"action": "click"})

    # Over the cap after the very first row, and still nothing was reclaimed:
    # a full directory walk per row is the wrong cure for a volume problem.
    assert stale.exists()
    assert trail._rows_since_maintain == 3
    assert trail.last_sweep["at"] is None, "a 3-row burst triggered a directory walk"
    assert trail.usage()["evicted_runs"] == 0
    assert trail.usage()["bytes"] > before
    assert trail.usage()["over_cap"] == 1  # and the over-cap state says so plainly


def test_usage_reports_the_contract_and_never_raises(tmp_path):
    trail = make_trail(tmp_path, ttl_days=3, max_bytes=1234)
    expected = {"bytes", "cap_bytes", "ttl_days", "evicted_runs", "evicted_bytes"}
    usage = trail.usage()
    assert expected <= set(usage)
    # The contract the server consumes: every value is a plain int, never a bool.
    assert all(isinstance(value, int) and not isinstance(value, bool) for value in usage.values())
    assert usage["cap_bytes"] == 1234 and usage["ttl_days"] == 3
    assert usage["bytes"] == 0 and usage["runs"] == 0  # a root that was never written
    fill_live_run(trail, 500)
    usage = trail.usage()
    assert usage["bytes"] == trail.total_bytes() > 0
    assert usage["runs"] == 1 and usage["evicted_runs"] == 0


def test_eviction_leaks_neither_content_nor_absolute_paths(tmp_path):
    """The cap does not get to rewrite the privacy rules.

    Same 口径 as test_audit_privacy: the trail keeps a length + sha1_8 and
    file names RELATIVE to the audit dir.  The sweep reply and usage() are new
    strings this rule now binds too.
    """
    write_run(tmp_path, "2026-01-05", "run00001", 4000)
    write_run(tmp_path, "2026-01-06", "run00002", 4000)
    trail = make_trail(tmp_path, ttl_days=30, max_bytes=3000)
    title = f"*{CAP_MARKER}.txt - Notepad"
    trail.append(
        {
            "action": "type_text",
            "args_echo": redact_args("type_text", {"text": CAP_MARKER, "expect_title": title}),
            "focus": redact_focus({"title": title, "process": "notepad.exe"}),
        }
    )
    result = trail.sweep()

    for base, _dirs, files in os.walk(tmp_path):
        for name in files:
            raw = (Path(base) / name).read_bytes()
            assert CAP_MARKER.encode() not in raw, f"{name} carries typed content"
    dumped = json.dumps(result) + json.dumps(trail.usage()) + json.dumps(trail.last_sweep)
    assert CAP_MARKER not in dumped
    assert str(tmp_path) not in dumped, "the sweep reply prints absolute paths"
    row = json.loads(trail.rows_file.read_text(encoding="utf-8").splitlines()[0])
    assert row["args_echo"]["text_len"] == len(CAP_MARKER)
    assert "text" not in row["args_echo"] and "title" not in row["focus"]


def test_a_root_that_cannot_be_walked_is_named_not_reported_as_clean(tmp_path):
    """`start()` and the write path both call `sweep()`: it may not throw.

    A root that is a regular file is the pathological face of the rule the cap
    lives by: bytes nobody measured are not a clean bill of health.
    """
    blocked = tmp_path / "audit-is-a-file"
    blocked.write_text("not a directory", encoding="utf-8")
    trail = AuditTrail(
        root=blocked, ttl_days=7, sid="ffff0000", today=date(2026, 1, 10), max_bytes=10
    )

    usage = trail.usage()  # read-only: it answers, it does not raise
    assert usage["scan_errors"] >= 1

    result = trail.sweep()  # must not raise, and must not say "all clean"
    assert result["removed"] == 0
    assert result["ttl_error"], result
    assert "NotADirectoryError" in result["ttl_error"]
    assert "read error" in result["cap_reason"], result["cap_reason"]
    assert result["bytes"] == 0  # only what could be read, and the reason says so

"""Audit trail: one JSON row per action, two small frames, and a TTL sweep.

Two hard rules, both from the design and both load-bearing:

1. **Nothing typed, and nothing that mirrors what was typed, is ever recorded.**
   `type_text` content can be a password or a token, so the row keeps
   `text_len` and an 8-character hash prefix — enough to correlate two rows,
   useless as a leak.  The same rule covers every OTHER field that can carry
   user content: a window title mirrors the page/document it shows
   (`*S3CRET-… - Notepad` right after typing, a browser tab, a terminal
   title), so titles and the caller-supplied `expect_title` are recorded as a
   hash + length too — never as text.  `redact_args()` and `redact_focus()` are
   the single places those two rules live, and tests pin them.
2. **The server is its own sweeper.**  The plugin never touches this directory,
   so nothing else would ever delete it.  `sweep()` runs at start-up and at
   shutdown — and, throttled, on the write path — and drops whole
   day-directories older than the TTL; it never deletes anything it cannot
   name as a `YYYY-MM-DD` directory.
3. **Age alone does not bound the size.**  A high-frequency session grows the
   trail *inside* its own TTL window (measured on a real machine: 27 MB with a
   7-day TTL), so `sweep()` also enforces a total-bytes cap
   (`CU_AUDIT_MAX_BYTES`, default 64 MiB, `0` = no cap) by evicting whole RUN
   directories, oldest-first.  The unit is a run — a half-deleted
   `actions.jsonl` is worse than no reclaim — and the run this process is
   still writing is never a candidate.  What the cap could not do is REPORTED:
   `usage()` answers with the live bytes, the live cap and the cumulative
   eviction counters, so `bytes > cap_bytes` next to `evicted_runs == 0` is
   the evidence that the trail is over its cap and nothing was reclaimable —
   never a silent "cleaned up".

Layout (per the dispatch)::

    <root>/<yyyy-mm-dd>/<sid8>/actions.jsonl
    <root>/<yyyy-mm-dd>/<sid8>/frames/<action_id>-before.jpg
    <root>/<yyyy-mm-dd>/<sid8>/frames/<action_id>-after.jpg
    <root>/<yyyy-mm-dd>/<sid8>/shots/<action_id>.png
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
import stat
import time
from datetime import date, datetime, timedelta
from pathlib import Path

DEFAULT_TTL_DAYS = 7
DEFAULT_MAX_BYTES = 64 * 1024 * 1024  # 64 MiB — the cap is a volume rule, the TTL is not
MAX_BYTES_ENV = "CU_AUDIT_MAX_BYTES"
# Write-path housekeeping throttle: one directory walk per this many new rows,
# and never more often than this many seconds (both are test seams at 0/1).
MAINTAIN_EVERY_ROWS = 20
MAINTAIN_MIN_SECONDS = 60
FRAME_MAX_WIDTH = 960
FRAME_QUALITY = 60
_DAY_FORMAT = "%Y-%m-%d"


def parse_day(name: str) -> date | None:
    """A directory is ours to delete only if it names a day."""
    try:
        return datetime.strptime(name, _DAY_FORMAT).date()
    except ValueError:
        return None


def resolve_max_bytes(value: int | None = None, env: dict | None = None) -> int:
    """The effective cap in bytes: argument > `CU_AUDIT_MAX_BYTES` > 64 MiB.

    `0` means "no cap" (the pre-cap behaviour, kept as a supported setting).
    A value that does not parse falls back to the default rather than to 0:
    a typo in the environment must not silently disable the only size bound,
    and `usage()["cap_bytes"]` always reports whichever number won.
    """
    if value is not None:
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return DEFAULT_MAX_BYTES
    raw = (os.environ if env is None else env).get(MAX_BYTES_ENV)
    if raw is None or not str(raw).strip():
        return DEFAULT_MAX_BYTES
    try:
        return max(0, int(str(raw).strip()))
    except ValueError:
        return DEFAULT_MAX_BYTES


def default_root() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_CACHE_HOME")
    if base:
        return Path(base) / "te-river" / "computeruse" / "audit"
    return Path.home() / ".te-river" / "computeruse" / "audit"


def _truncate(value, limit: int = 200):
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + f"…({len(value)} chars)"
    return value


def sha1_8(value: str) -> str:
    """8 hex chars: enough to correlate two rows, useless as a leak."""
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:8] if value else ""


def fingerprint(value) -> dict:
    """What the audit may keep about an identifier: its length and a hash."""
    text = "" if value is None else str(value)
    return {"len": len(text), "sha1_8": sha1_8(text)}


# Tool arguments whose value can be user content.  `expect_title` is the
# caller's copy of a window title, so it is exactly as sensitive as one.
TITLE_FIELDS = ("expect_title",)
_HIDDEN_FIELDS = ("text",) + TITLE_FIELDS


def redact_args(action: str, args: dict) -> dict:
    """The audit-safe echo of a tool's arguments.

    `type_text` loses its body entirely and any `expect_title` loses its text
    (see `TITLE_FIELDS`); everything else is kept (truncated) so a human
    reviewer can reproduce the action.

    Idempotent: callers pass an already-redacted echo in some paths, and
    re-redacting must not reset `text_len` to 0 (it did once — the row then said
    "0 chars" about a 17-character action) or drop a title fingerprint.
    """
    args = dict(args or {})
    safe = {k: _truncate(v) for k, v in args.items() if k not in _HIDDEN_FIELDS}
    for field in TITLE_FIELDS:
        if field in args:
            fp = fingerprint(args.get(field))
            safe[f"{field}_len"] = fp["len"]
            safe[f"{field}_sha1_8"] = fp["sha1_8"]
    if action == "type_text":
        if "text" in args:
            text = str(args.get("text") or "")
            safe["text_len"] = len(text)
            safe["text_sha1_8"] = sha1_8(text)
        else:
            safe.setdefault("text_len", 0)
            safe.setdefault("text_sha1_8", "")
    return safe


def redact_focus(focus: dict | None) -> dict | None:
    """The audit-safe copy of a `focus` / `active_window` block.

    The process name is kept (it is what makes a row reproducible and carries no
    content); the title becomes `title_len` + `title_sha1_8`.  `rect` is geometry
    and survives when present.
    """
    if not focus:
        return focus
    title = fingerprint(focus.get("title"))
    safe = {
        "process": focus.get("process"),
        "title_len": title["len"],
        "title_sha1_8": title["sha1_8"],
    }
    if "rect" in focus:
        safe["rect"] = focus.get("rect")
    return safe


def _force_remove(path: Path) -> bool:
    """rmtree that survives Windows read-only files and a transient lock."""
    def _on_error(func, target, _exc_info):
        try:
            os.chmod(target, stat.S_IWRITE)
            func(target)
        except Exception:
            pass

    for attempt in range(2):
        shutil.rmtree(path, onerror=_on_error)
        if not path.exists():
            return True
        time.sleep(0.05 * (attempt + 1))
    return not path.exists()


class AuditTrail:
    def __init__(
        self,
        root: Path | str | None = None,
        ttl_days: int = DEFAULT_TTL_DAYS,
        sid: str | None = None,
        clock=time.time,
        today: date | None = None,
        max_bytes: int | None = None,
        maintain_every_rows: int = MAINTAIN_EVERY_ROWS,
        maintain_min_seconds: float = MAINTAIN_MIN_SECONDS,
    ):
        self.root = Path(root) if root is not None else default_root()
        self.ttl_days = max(0, int(ttl_days))
        self.sid = sid or secrets.token_hex(4)
        self.clock = clock
        self._today = today
        self._seq = 0
        self.last_sweep: dict = {"at": None, "removed": 0}
        self._rows = 0
        # -- total-bytes cap -------------------------------------------------
        self.max_bytes = resolve_max_bytes(max_bytes)
        self.maintain_every_rows = max(0, int(maintain_every_rows))
        self.maintain_min_seconds = max(0.0, float(maintain_min_seconds))
        self._evicted_runs = 0
        self._evicted_bytes = 0
        self._evict_failures = 0
        self._scan_errors = 0
        self._rows_since_maintain = 0
        self._last_maintain_at: float | None = None
        # `usage` is bound per-instance on purpose.  The consumer (`server.py`'s
        # `control_status`) has to be able to say "this audit module does not
        # report a footprint at all" — and a CLASS-level method cannot be
        # removed from an instance, so a degradation test would have no way to
        # simulate the absence.  The call shape is unchanged: `trail.usage()`.
        self.usage = self._usage_snapshot

    # -- paths -------------------------------------------------------------
    def day(self) -> date:
        return self._today or datetime.fromtimestamp(self.clock()).date()

    @property
    def action_dir(self) -> Path:
        return self.root / self.day().strftime(_DAY_FORMAT) / self.sid

    @property
    def rows_file(self) -> Path:
        return self.action_dir / "actions.jsonl"

    def next_action_id(self) -> str:
        self._seq += 1
        return f"a{self._seq:04d}"

    # -- writes ------------------------------------------------------------
    def _ensure(self, sub: str | None = None) -> Path:
        path = self.action_dir / sub if sub else self.action_dir
        path.mkdir(parents=True, exist_ok=True)
        return path

    def append(self, row: dict) -> dict:
        """Append one row; returns {row: <1-based line>, file: <abs path>}."""
        target = self._ensure()
        line = target / "actions.jsonl"
        try:
            with line.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
                fh.flush()
                os.fsync(fh.fileno())
            self._rows += 1
            # Housekeeping rides the WRITE path (throttled), not only start-up
            # and shutdown: a session that runs for hours must hit its own cap
            # while it runs.  It cannot cost us the row — see _maybe_maintain.
            self._rows_since_maintain += 1
            self._maybe_maintain()
            return {"row": self._rows, "file": str(line)}
        except OSError as exc:
            # An audit failure must be visible in the reply, never swallowed —
            # an unaudited action is exactly the thing this file exists to stop.
            return {"row": None, "file": None, "error": f"{type(exc).__name__}: {exc}"}

    def save_frame(self, image, action_id: str, kind: str) -> str | None:
        try:
            path = self._ensure("frames") / f"{action_id}-{kind}.jpg"
            img = image.convert("RGB")
            if img.width > FRAME_MAX_WIDTH:
                ratio = FRAME_MAX_WIDTH / float(img.width)
                img = img.resize((FRAME_MAX_WIDTH, max(1, int(img.height * ratio))), _resample())
            img.save(path, "JPEG", quality=FRAME_QUALITY, optimize=True)
            return str(path)
        except Exception:
            return None

    def save_shot(self, image, action_id: str) -> str | None:
        try:
            path = self._ensure("shots") / f"{action_id}.png"
            image.save(path, "PNG")
            return str(path)
        except Exception:
            return None

    def save_thumb(self, image, action_id: str) -> str | None:
        try:
            path = self._ensure("shots") / f"{action_id}-thumb.jpg"
            image.convert("RGB").save(path, "JPEG", quality=FRAME_QUALITY, optimize=True)
            return str(path)
        except Exception:
            return None

    # -- maintenance -------------------------------------------------------
    def total_bytes(self) -> int:
        total = 0
        for base, _dirs, files in os.walk(self.root):
            for name in files:
                try:
                    total += os.path.getsize(os.path.join(base, name))
                except OSError:
                    pass
        return total

    @staticmethod
    def _file_bytes(path: Path) -> tuple[int, int]:
        try:
            return int(path.stat().st_size), 0
        except OSError:
            return 0, 1

    @staticmethod
    def _tree_bytes(path: Path) -> tuple[int, int]:
        total = 0
        errors = 0
        for base, _dirs, files in os.walk(path):
            for name in files:
                try:
                    total += os.path.getsize(os.path.join(base, name))
                except OSError:
                    errors += 1
        return total, errors

    def _rel_name(self, path: Path) -> str:
        """How a run is reported: `<day>/<sid>`, never an absolute path.

        The trail's own privacy rule (a row keeps file names relative to the
        audit dir) applies to the sweep reply too — an absolute path would
        print the user's folders into a status line for no reviewer benefit.
        """
        return f"{path.parent.name}/{path.name}"

    def _live_run(self) -> str:
        return os.path.normcase(str(self.action_dir.resolve()))

    def _scan(self) -> tuple[list[dict], int, int]:
        """ONE walk of the root: (run dirs oldest-first, total bytes, error count).

        Sizes are attributed per RUN directory (`<root>/<day>/<sid>`), because a
        run is the eviction unit.  Anything the walk cannot name as a run — a
        loose file at the root, a directory that is not a `YYYY-MM-DD`, a file
        sitting directly in a day directory — is counted into the total but
        never offered for eviction: we do not delete what we cannot describe.
        """
        runs: list[dict] = []
        total = 0
        errors = 0
        if not self.root.exists():
            return runs, total, errors
        try:
            day_entries = sorted(self.root.iterdir(), key=lambda p: str(p).lower())
        except OSError:
            self._scan_errors += 1
            return runs, total, errors + 1

        for day_dir in day_entries:
            if not day_dir.is_dir():
                size, err = self._file_bytes(day_dir)
                total += size
                errors += err
                continue
            stamp = parse_day(day_dir.name)
            if stamp is None:
                size, err = self._tree_bytes(day_dir)
                total += size
                errors += err
                continue
            try:
                children = sorted(day_dir.iterdir(), key=lambda p: str(p).lower())
            except OSError:
                errors += 1
                continue
            for child in children:
                if child.is_dir():
                    size, err = self._tree_bytes(child)
                    total += size
                    errors += err
                    try:
                        mtime = float(child.stat().st_mtime)
                    except OSError:
                        mtime = 0.0
                        errors += 1
                    runs.append(
                        {"path": child, "day": stamp, "bytes": size, "mtime": mtime}
                    )
                else:
                    size, err = self._file_bytes(child)
                    total += size
                    errors += err

        # Oldest first: the day the directory lives in is the load-bearing key
        # (a filesystem mtime is a real clock and a copied tree resets it), the
        # mtime only breaks ties inside one day.
        runs.sort(key=lambda run: (run["day"], run["mtime"], str(run["path"]).lower()))
        self._scan_errors += errors
        return runs, total, errors

    def _enforce_cap(self, cap: int, runs: list[dict], total: int, unreadable: int = 0) -> dict:
        """Evict whole run dirs, oldest-first, until the trail fits `cap`.

        The run THIS process is still writing is skipped: the action that
        triggered the sweep must not audit its own deletion.  A run that will
        not delete is counted and named — a failed removal may never be added
        to `evicted_bytes`, because "reclaimed" is a claim about bytes that are
        actually gone.
        """
        evicted: list[str] = []
        failed: list[str] = []
        emptied: list[str] = []
        freed = 0
        remaining = total
        unmanaged = total - sum(int(run["bytes"]) for run in runs)
        live_bytes = 0

        if cap > 0 and total > cap:
            live = self._live_run()
            live_bytes = next(
                (
                    int(run["bytes"])
                    for run in runs
                    if os.path.normcase(str(run["path"].resolve())) == live
                ),
                0,
            )
            touched: list[Path] = []
            for run in runs:
                if remaining <= cap:
                    break
                path = run["path"]
                if os.path.normcase(str(path.resolve())) == live:
                    continue
                if _force_remove(path):
                    evicted.append(self._rel_name(path))
                    freed += int(run["bytes"])
                    remaining -= int(run["bytes"])
                    touched.append(path.parent)
                else:
                    failed.append(self._rel_name(path))
            self._evicted_runs += len(evicted)
            self._evicted_bytes += freed
            self._evict_failures += len(failed)
            # An emptied day directory is a shell we named ourselves; `rmdir`
            # refuses a non-empty one, so it cannot take anything but a shell.
            for day_dir in touched:
                if not day_dir.exists():
                    continue
                try:
                    if not any(day_dir.iterdir()):
                        day_dir.rmdir()
                        emptied.append(day_dir.name)
                except OSError:
                    pass

        over = cap > 0 and remaining > cap
        if cap <= 0:
            reason = "no cap set (CU_AUDIT_MAX_BYTES=0)"
        elif not over:
            reason = f"cap met: {remaining} bytes <= {cap}"
            if unreadable:
                # "Nothing needed evicting" is only a pass if the tree could be
                # read at all; a partial walk must not read as a clean bill.
                reason += (
                    f" — on what could be read; {unreadable} read error(s) mean the real "
                    "footprint may be larger than the number above"
                )
        elif unmanaged + live_bytes >= cap:
            reason = (
                f"cap NOT met: {remaining} bytes > {cap}; the {unmanaged + live_bytes} bytes "
                "left are the ACTIVE run plus bytes we cannot name as ours, and neither is evictable"
            )
        else:
            reason = (
                f"cap NOT met: {remaining} bytes > {cap}; {len(failed)} run(s) refused to be "
                "removed and everything else already went"
            )

        return {
            "cap_bytes": cap,
            "bytes_before": total,
            "bytes_after": remaining,
            "evicted_runs": len(evicted),
            "evicted_bytes": freed,
            "evicted": evicted,
            "failed": failed,
            "emptied_days": emptied,
            "over_cap": over,
            "reason": reason,
        }

    def sweep(self) -> dict:
        """Drop expired day-directories (TTL), then enforce the total-bytes cap.

        TTL runs FIRST and the two passes share ONE walk: a day the age rule
        already condemns must not be paid for with a cap eviction, and the cap
        must never re-add what TTL deleted.  Cost stays O(runs) per sweep.
        """
        cap = int(self.max_bytes)
        removed: list[str] = []
        ttl_error = ""
        cutoff = self.day() - timedelta(days=self.ttl_days)
        try:
            if self.root.exists():
                for entry in sorted(self.root.iterdir()):
                    if not entry.is_dir():
                        continue
                    stamp = parse_day(entry.name)
                    if stamp is None:
                        continue  # not ours to delete
                    if stamp < cutoff and _force_remove(entry):
                        removed.append(entry.name)
        except OSError as exc:
            # A root we cannot walk — it is a regular file, or the volume went
            # away — must not take the server down: `start()` sweeps before the
            # first action and the write path sweeps too.  The failure is
            # NAMED in the reply, never folded into "0 removed, all clean".
            ttl_error = f"{type(exc).__name__}: {exc}"
            self._scan_errors += 1

        runs, total, errors = self._scan()
        cap_result = self._enforce_cap(cap, runs, total, errors + (1 if ttl_error else 0))
        self._rows_since_maintain = 0
        self._last_maintain_at = self.clock()

        self.last_sweep = {
            "at": datetime.now().isoformat(timespec="seconds"),
            "removed": len(removed),
            "removed_dirs": removed,
            "ttl_error": ttl_error,
            "kept_days": self.ttl_days,
            "bytes": cap_result["bytes_after"],
            # per-pass cap numbers, with the process totals beside them so a
            # reader cannot mistake one for the other
            "cap_bytes": cap_result["cap_bytes"],
            "bytes_before": cap_result["bytes_before"],
            "evicted_runs": cap_result["evicted_runs"],
            "evicted_bytes": cap_result["evicted_bytes"],
            "evicted": cap_result["evicted"],
            "evict_failed": len(cap_result["failed"]),
            "evict_failed_runs": cap_result["failed"],
            "emptied_days": cap_result["emptied_days"],
            "over_cap": cap_result["over_cap"],
            "cap_reason": cap_result["reason"],
            "evicted_runs_total": self._evicted_runs,
            "evicted_bytes_total": self._evicted_bytes,
        }
        return dict(self.last_sweep)

    def _maybe_maintain(self) -> None:
        """Throttled sweep on the write path — see `append()`.

        Fires after `maintain_every_rows` new rows AND `maintain_min_seconds`
        of the trail's clock, so a full directory walk is never per-row.  It
        may not throw into `append()`: losing an audit row to housekeeping is
        the opposite of why this file exists, so anything that goes wrong is
        counted in `scan_errors` instead.
        """
        if self.max_bytes <= 0 or self.maintain_every_rows <= 0:
            return
        if self._rows_since_maintain < self.maintain_every_rows:
            return
        try:
            now = float(self.clock())
        except Exception:
            self._scan_errors += 1
            return
        if (
            self._last_maintain_at is not None
            and now - self._last_maintain_at < self.maintain_min_seconds
        ):
            return
        try:
            self.sweep()
        except Exception:  # pragma: no cover - defensive
            self._scan_errors += 1

    def _usage_snapshot(self) -> dict:
        """The audit footprint, read-only, for the server's `control_status`.

        Published on the instance under the name `usage` (see `__init__`).

        Public contract — these keys are always present and always ints:
        ``bytes`` (root footprint incl. frames), ``cap_bytes`` (0 = no cap),
        ``ttl_days``, ``evicted_runs`` and ``evicted_bytes``.  The two eviction
        numbers are CUMULATIVE for THIS process; `sweep()`'s reply carries the
        per-pass numbers beside its `_total` twins, so the two are never
        confused.  Extra int keys are additive and honest: ``runs`` (run dirs
        on disk), ``evict_failures`` (runs a removal refused), ``scan_errors``
        (walk/stat failures) and ``over_cap`` (1 while ``bytes > cap_bytes``).

        Never raises and never claims a reclaim it did not do: a failed walk
        only ever UNDER-counts ``bytes`` and says so in ``scan_errors``.
        """
        cap = int(self.max_bytes)
        runs: list[dict] = []
        total = 0
        try:
            runs, total, _ = self._scan()
        except Exception:  # pragma: no cover - defensive: a status read cannot break
            self._scan_errors += 1
        return {
            "bytes": int(total),
            "cap_bytes": int(cap),
            "ttl_days": int(self.ttl_days),
            "evicted_runs": int(self._evicted_runs),
            "evicted_bytes": int(self._evicted_bytes),
            "runs": int(len(runs)),
            "evict_failures": int(self._evict_failures),
            "scan_errors": int(self._scan_errors),
            "over_cap": 1 if cap > 0 and total > cap else 0,
        }


def _resample():
    from PIL import Image

    try:
        return Image.Resampling.LANCZOS
    except AttributeError:  # pragma: no cover
        return Image.LANCZOS

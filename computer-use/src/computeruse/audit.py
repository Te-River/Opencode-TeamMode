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
   shutdown and drops whole day-directories older than the TTL; it never
   deletes anything it cannot name as a `YYYY-MM-DD` directory.

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
FRAME_MAX_WIDTH = 960
FRAME_QUALITY = 60
_DAY_FORMAT = "%Y-%m-%d"


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
    ):
        self.root = Path(root) if root is not None else default_root()
        self.ttl_days = max(0, int(ttl_days))
        self.sid = sid or secrets.token_hex(4)
        self.clock = clock
        self._today = today
        self._seq = 0
        self.last_sweep: dict = {"at": None, "removed": 0}
        self._rows = 0

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

    def sweep(self) -> dict:
        """Drop day-directories older than the TTL. Never touches other names."""
        removed: list[str] = []
        cutoff = self.day() - timedelta(days=self.ttl_days)
        if self.root.exists():
            for entry in sorted(self.root.iterdir()):
                if not entry.is_dir():
                    continue
                try:
                    stamp = datetime.strptime(entry.name, _DAY_FORMAT).date()
                except ValueError:
                    continue  # not ours to delete
                if stamp < cutoff and _force_remove(entry):
                    removed.append(entry.name)
        self.last_sweep = {
            "at": datetime.now().isoformat(timespec="seconds"),
            "removed": len(removed),
            "removed_dirs": removed,
            "kept_days": self.ttl_days,
            "bytes": self.total_bytes(),
        }
        return dict(self.last_sweep)


def _resample():
    from PIL import Image

    try:
        return Image.Resampling.LANCZOS
    except AttributeError:  # pragma: no cover
        return Image.LANCZOS

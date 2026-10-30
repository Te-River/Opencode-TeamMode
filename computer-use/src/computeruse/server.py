"""MCP stdio server: 7 tools, one place where every reply is assembled.

Transport: newline-delimited JSON-RPC 2.0 over stdio — one JSON object per line
in, one per line out.  **stdout carries protocol bytes only.**  A dependency
that prints once corrupts the stream, so `serve()` captures the real stdout
buffer and then rebinds `sys.stdout` to stderr; everything the server wants to
say goes to stderr or into the audit directory.

The reply discipline is the product.  A mutating tool answers with
`before_sha1` / `after_sha1` / `changed_pixels_pct` / `verdict`, and
`verdict: "no-observable-change"` is a successful call (`ok: true`) that names
the next move — it is never an error and never the word "clicked".  Refusals
carry `refused` and no `verdict`, because a refusal did not measure anything.
"""

from __future__ import annotations

import base64
import io
import json
import platform
import sys
import time
import traceback
from datetime import datetime

from . import SERVER_NAME, __version__, audit as audit_mod, capture, diff, dpi, input as input_mod, safety

DEFAULT_BUDGET = 200
DEFAULT_TTL_DAYS = 7

IMAGE_QUALITY = 70
IMAGE_MAX_BYTES = 400 * 1024
THUMB_MAX_WIDTH = 640
PROTOCOL_VERSIONS = ("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25")
NEWEST_PROTOCOL = PROTOCOL_VERSIONS[-1]

HINT_NO_CHANGE = (
    "屏幕没有可观测变化。先重新 screenshot 确认焦点窗口与坐标，再换坐标、改用 key，"
    "或把 settle_ms 调大后重试。"
)
HINT_BUDGET = (
    "动作预算已用尽（{used}/{limit}）。只读工具仍可用；恢复的唯一方式是让人重启本 MCP 服务器"
    "（或改 --budget 后重跑安装器），本进程内不会重置。"
)
HINT_FOCUS = (
    "焦点窗口标题不含 expect_title，未注入任何输入。先 screenshot 读 active_window.title，"
    "再把它的子串作为 expect_title 重试。"
)
HINT_ELEVATION = "目标窗口的完整性级别高于本进程，注入不会落地。请人类接管，或换一个非提权目标。"
HINT_SECURE = "UAC/锁屏安全桌面正开着：只有 Windows 进程能访问它，抓屏与注入都到不了。只能由人类回答。"
HINT_USER_CONTROL = (
    "人类已通过急停热键收回控制权（state=user）。只有人类再按一次 Ctrl+Alt+Shift+F12 才能交回；"
    "本工具没有解除参数。"
)


class ToolFailure(Exception):
    """A real failure (bad args, capture unavailable) — reported as isError."""


# =========================================================================
# Tool surface
# =========================================================================

_OBJECT = "object"

TOOL_SPECS: list[dict] = [
    {
        "name": "screenshot",
        "description": (
            "Capture the desktop → PNG path + sha1 + active window; click/scroll/drag use THESE pixels. "
            "include_image:false by default — an attached JPEG is re-sent on every later turn, so pass "
            "true only if your model reads images AND you must SEE the layout. Path + sha1 are enough "
            "to confirm an action landed."
        ),
        "inputSchema": {
            "type": _OBJECT,
            "additionalProperties": False,
            "properties": {
                "display": {"type": "integer", "minimum": 0, "description": "0-based display index; omit for all displays"},
                "region": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "minItems": 4,
                    "maxItems": 4,
                    "description": "[left, top, right, bottom] in virtual-screen pixels; overrides display",
                },
                "include_image": {"type": "boolean", "default": False},
                "max_width": {"type": "integer", "minimum": 320, "maximum": 3840, "default": 1280},
            },
        },
    },
    {
        "name": "click",
        "description": (
            "Click at capture pixel (x,y) → before/after sha1 + verdict. 'no-observable-change' is not "
            "an error: the screen did not move, so re-screenshot or change the target; do not repeat "
            "the same click."
        ),
        "inputSchema": {
            "type": _OBJECT,
            "additionalProperties": False,
            "required": ["x", "y"],
            "properties": {
                "x": {"type": "integer"},
                "y": {"type": "integer"},
                "button": {"type": "string", "enum": ["left", "right", "middle"], "default": "left"},
                "clicks": {"type": "integer", "enum": [1, 2], "default": 1},
                "settle_ms": {"type": "integer", "minimum": 0, "maximum": 2000, "default": 250},
            },
        },
    },
    {
        "name": "type_text",
        "description": (
            "Type text into the focused control; expect_title (substring of the window title) is "
            "REQUIRED — on mismatch nothing is typed and the call is refused with focus-mismatch. "
            "Screenshot first and pass the active window title you saw; the text is never echoed back."
        ),
        "inputSchema": {
            "type": _OBJECT,
            "additionalProperties": False,
            "required": ["text", "expect_title"],
            "properties": {
                "text": {"type": "string", "minLength": 1, "maxLength": 4000},
                "expect_title": {"type": "string", "minLength": 1, "maxLength": 200},
                "interval_ms": {"type": "integer", "minimum": 0, "maximum": 200, "default": 0},
            },
        },
    },
    {
        "name": "key",
        "description": (
            "Press a key combo in the focused window ('ctrl+s', 'alt+Tab'); expect_title REQUIRED, "
            "checked exactly like type_text. Prefer it over type_text for shortcuts."
        ),
        "inputSchema": {
            "type": _OBJECT,
            "additionalProperties": False,
            "required": ["keys", "expect_title"],
            "properties": {
                "keys": {"type": "string", "minLength": 1, "maxLength": 64},
                "expect_title": {"type": "string", "minLength": 1, "maxLength": 200},
                "repeat": {"type": "integer", "minimum": 1, "maximum": 10, "default": 1},
            },
        },
    },
    {
        "name": "scroll",
        "description": (
            "Wheel at capture pixel (x,y); delta 120 = one notch, positive scrolls up. Same verdict "
            "shape as click."
        ),
        "inputSchema": {
            "type": _OBJECT,
            "additionalProperties": False,
            "required": ["x", "y", "delta"],
            "properties": {
                "x": {"type": "integer"},
                "y": {"type": "integer"},
                "delta": {"type": "integer", "minimum": -1200, "maximum": 1200},
                "settle_ms": {"type": "integer", "minimum": 0, "maximum": 2000, "default": 250},
            },
        },
    },
    {
        "name": "drag",
        "description": (
            "Drag with the left button from [x,y] to [x,y]; both are capture pixels. Same verdict "
            "shape as click."
        ),
        "inputSchema": {
            "type": _OBJECT,
            "additionalProperties": False,
            "required": ["from", "to"],
            "properties": {
                "from": {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2},
                "to": {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2},
                "duration_ms": {"type": "integer", "minimum": 50, "maximum": 2000, "default": 300},
                "settle_ms": {"type": "integer", "minimum": 0, "maximum": 2000, "default": 250},
            },
        },
    },
    {
        "name": "control_status",
        "description": (
            "Budget + panic + audit path. Read-only, no arguments; the ONLY authoritative budget "
            "reading, and the first call when you are unsure what state the desktop is in."
        ),
        "inputSchema": {"type": _OBJECT, "additionalProperties": False, "properties": {}},
    },
]

MUTATING = {"click", "type_text", "key", "scroll", "drag"}


# =========================================================================
# Argument validation (additionalProperties:false has to be enforced HERE —
# an MCP client forwards whatever the model sent, it does not police it)
# =========================================================================

def validate(schema: dict, value, path: str = "args") -> list[str]:
    errors: list[str] = []
    expected = schema.get("type")
    if expected == "object":
        if not isinstance(value, dict):
            return [f"{path}: expected object"]
        props = schema.get("properties") or {}
        for key in value:
            if schema.get("additionalProperties") is False and key not in props:
                errors.append(f"{path}.{key}: unknown field")
        for key in schema.get("required") or []:
            if key not in value:
                errors.append(f"{path}.{key}: required")
        for key, sub in props.items():
            if key in value:
                errors.extend(validate(sub, value[key], f"{path}.{key}"))
        return errors
    if expected == "array":
        if not isinstance(value, list):
            return [f"{path}: expected array"]
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: needs >= {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{path}: needs <= {schema['maxItems']} items")
        item_schema = schema.get("items")
        if item_schema:
            for i, item in enumerate(value):
                errors.extend(validate(item_schema, item, f"{path}[{i}]"))
        return errors
    if expected == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            return [f"{path}: expected integer"]
    elif expected == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return [f"{path}: expected number"]
    elif expected == "string":
        if not isinstance(value, str):
            return [f"{path}: expected string"]
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: needs >= {schema['minLength']} chars")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(f"{path}: needs <= {schema['maxLength']} chars")
    elif expected == "boolean":
        if not isinstance(value, bool):
            return [f"{path}: expected boolean"]

    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: must be one of {schema['enum']}")
    if expected in ("integer", "number") and isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: needs >= {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}: needs <= {schema['maximum']}")
    return errors


# =========================================================================
# Small image helpers
# =========================================================================

def _resample():
    from PIL import Image

    try:
        return Image.Resampling.LANCZOS
    except AttributeError:  # pragma: no cover
        return Image.LANCZOS


def fit_width(image, max_width: int):
    if image.width <= max_width:
        return image
    ratio = max_width / float(image.width)
    return image.resize((int(max_width), max(1, int(round(image.height * ratio)))), _resample())


def encode_jpeg(image, max_width: int, quality: int = IMAGE_QUALITY, limit: int = IMAGE_MAX_BYTES):
    """Downscale + re-encode until the JPEG fits `limit`. Returns (bytes|None, detail)."""
    img = fit_width(image.convert("RGB"), max_width)
    for q in (quality, 60, 50, 40, 35):
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=q, optimize=True)
        data = buf.getvalue()
        if len(data) <= limit:
            return data, {"width": img.width, "height": img.height, "quality": q, "bytes": len(data)}
        for width in (960, 800, 640, 480, 320):
            if img.width <= width:
                continue
            smaller = fit_width(img, width)
            small_buf = io.BytesIO()
            smaller.save(small_buf, "JPEG", quality=q, optimize=True)
            small = small_buf.getvalue()
            if len(small) <= limit:
                return small, {"width": smaller.width, "height": smaller.height, "quality": q, "bytes": len(small)}
    return None, {"reason": "could not get under the byte limit even at 320px"}


def _one_line(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _active_window() -> dict | None:
    win = input_mod.foreground_window()
    if not win:
        return None
    return {"title": win["title"], "process": win["process"], "rect": win["rect"]}


# =========================================================================
# Server
# =========================================================================

def _stderr_log(message: str) -> None:
    try:
        sys.stderr.write(f"[computeruse] {message}\n")
        sys.stderr.flush()
    except Exception:
        pass


class ComputerUseServer:
    def __init__(
        self,
        budget: int = DEFAULT_BUDGET,
        ttl_days: int = DEFAULT_TTL_DAYS,
        audit_root: str | None = None,
        log=_stderr_log,
    ):
        self.budget = safety.ActionBudget(budget)
        self.panic = safety.PanicHotkey()
        self.audit = audit_mod.AuditTrail(root=audit_root, ttl_days=ttl_days)
        self._log = log
        self._started = False

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        if self._started:
            return
        state = dpi.ensure_dpi_aware()
        self._log(f"start sid={self.audit.sid} dpi_aware={state['dpi_aware']} method={state['method']}")
        if not state["dpi_aware"]:
            self._log(f"WARNING dpi awareness not set: {state['error']}")
        hotkey = self.panic.start()
        if not hotkey["armed"]:
            self._log(f"WARNING panic hotkey not armed: {hotkey['error']}")
        self.audit.sweep()
        self._log(f"audit dir={self.audit.action_dir}")
        self._started = True

    def shutdown(self) -> None:
        self.panic.stop()
        sweep = self.audit.sweep()
        self._log(f"shutdown budget={self.budget.used}/{self.budget.limit} sweep_removed={sweep['removed']}")
        capture.close()

    # -- capture -----------------------------------------------------------
    def _shot(self, region=None, display=None):
        frame = capture.grab(region=region, display=display)
        return frame, frame.to_image()

    def _budget_block(self) -> dict:
        return {k: self.budget.snapshot()[k] for k in ("used", "limit", "exhausted")}

    # -- refusals ----------------------------------------------------------
    def _refuse(self, action: str, refused: str, args_echo: dict, hint: str, extra: dict | None = None, redact_from: dict | None = None) -> dict:
        envelope = {
            "ok": False,
            "refused": refused,
            "action": action,
            "action_id": None,
            "args_echo": args_echo,
            "budget": self._budget_block(),
            "hint": hint,
        }
        if extra:
            envelope.update(extra)
        self.audit.append(
            {
                "ts": datetime.now().isoformat(timespec="milliseconds"),
                "action_id": None,
                "action": action,
                "args_echo": audit_mod.redact_args(action, redact_from if redact_from is not None else args_echo),
                "before_sha1": None,
                "after_sha1": None,
                "changed_pixels_pct": None,
                "refused": refused,
                # A refusal answers the model with the live title (it needs it
                # to retry); the ROW keeps only the fingerprint, because that
                # title is the window's content as often as it is its name.
                "focus": audit_mod.redact_focus((extra or {}).get("focus")),
                "duration_ms": 0,
                "budget_used": self.budget.snapshot()["used"],
            }
        )
        return envelope

    # -- the mutating pipeline --------------------------------------------
    def _mutate(
        self,
        *,
        action: str,
        args_echo: dict,
        inject,
        settle_ms: int,
        display: int | None = None,
        region: list[int] | None = None,
        expect_title: str | None = None,
        elevation_xy: tuple[int, int] | None = None,
        redact_from: dict | None = None,
    ) -> dict:
        started = time.perf_counter()

        # 1) human holds the panic toggle
        if self.panic.state != "ai":
            return self._refuse(action, "user-took-control", args_echo, HINT_USER_CONTROL, {"state": self.panic.snapshot()})

        # 2) the input desktop is not ours (UAC / lock screen)
        probe = safety.secure_desktop_probe()
        if probe["active"]:
            return self._refuse(action, "secure-desktop", args_echo, HINT_SECURE, {"detail": probe["reason"]})

        # 3) first frame — as early as the pre-checks allow
        first_frame, first_img = self._shot(region, display)
        if diff.is_black(first_img):
            # A second, frame-based secure-desktop signal. Checked BEFORE the
            # budget is charged so a locked session never burns the user's
            # 200 actions.
            black_probe = safety.secure_desktop_probe(frame_image=first_img)
            if black_probe["active"]:
                return self._refuse(action, "secure-desktop", args_echo, HINT_SECURE, {"detail": black_probe["reason"]})

        # 4) elevated target window
        if elevation_xy is not None:
            elevation = safety.target_elevation(*elevation_xy)
            if elevation["verdict"] == "elevated":
                return self._refuse(
                    action,
                    "needs-elevation",
                    args_echo,
                    HINT_ELEVATION,
                    {"detail": elevation["detail"], "target": elevation["target"]},
                )

        # 5) focus gate — the cheapest way to stop "typed into the wrong window"
        focus = input_mod.foreground_window()
        if expect_title is not None:
            title = (focus or {}).get("title") or ""
            if expect_title.casefold() not in title.casefold():
                return self._refuse(
                    action,
                    "focus-mismatch",
                    args_echo,
                    HINT_FOCUS,
                    {"focus": {"title": title, "process": (focus or {}).get("process")}, "expect_title": expect_title},
                    redact_from=redact_from,
                )

        # 6) the frame the change is measured FROM, plus this desktop's idle
        #    noise floor: two consecutive captures with nothing injected between
        #    them. Sampled per action because a live desktop is never static.
        before_frame, before_img = self._shot(region, display)
        baseline = diff.compare(first_img, before_img)
        floor = diff.noise_floor(baseline["changed_pixels_pct"])

        # 7) budget — consumed before the injection, never after
        if not self.budget.try_consume():
            snapshot = self.budget.snapshot()
            return self._refuse(action, "budget-exhausted", args_echo, HINT_BUDGET.format(**snapshot), {"budget": snapshot})

        # 8) inject
        action_id = self.audit.next_action_id()
        injection_error = None
        try:
            inject()
        except Exception as exc:
            injection_error = f"{type(exc).__name__}: {exc}"

        # 9) settle, then the after-frame
        if settle_ms:
            time.sleep(settle_ms / 1000.0)
        after_frame, after_img = self._shot(region, display)

        comparison = diff.compare(before_img, after_img)
        verdict = diff.verdict(comparison["changed_pixels_pct"], floor)

        frames = {
            "before": self.audit.save_frame(before_img, action_id, "before"),
            "after": self.audit.save_frame(after_img, action_id, "after"),
        }

        duration_ms = int(round((time.perf_counter() - started) * 1000))
        audit_info = self.audit.append(
            {
                "ts": datetime.now().isoformat(timespec="milliseconds"),
                "action_id": action_id,
                "action": action,
                "args_echo": audit_mod.redact_args(action, redact_from if redact_from is not None else args_echo),
                "before_sha1": before_frame.sha1,
                "after_sha1": after_frame.sha1,
                "changed_pixels_pct": comparison["changed_pixels_pct"],
                "baseline_pct": baseline["changed_pixels_pct"],
                "noise_floor_pct": floor,
                "verdict": verdict,
                "focus": audit_mod.redact_focus(focus),
                "duration_ms": duration_ms,
                "budget_used": self.budget.snapshot()["used"],
                "frames": frames,
                "injection_error": injection_error,
            }
        )

        envelope = {
            "ok": injection_error is None,
            "action_id": action_id,
            "action": action,
            "args_echo": args_echo,
            "before_sha1": before_frame.sha1,
            "after_sha1": after_frame.sha1,
            "changed_pixels_pct": comparison["changed_pixels_pct"],
            # The verdict's own evidence: what this desktop does when nothing
            # happens, and the bar the change had to clear.
            "baseline_pct": baseline["changed_pixels_pct"],
            "noise_floor_pct": floor,
            "verdict": verdict,
            "target": {
                "rect": [
                    before_frame.left,
                    before_frame.top,
                    before_frame.left + before_frame.width,
                    before_frame.top + before_frame.height,
                ],
                "display": int(display or 0),
            },
            "focus": {"title": (focus or {}).get("title"), "process": (focus or {}).get("process")},
            "budget": self._budget_block(),
            "settle_ms": settle_ms,
            "duration_ms": duration_ms,
            "audit": audit_info,
            "hint": HINT_NO_CHANGE if verdict == "no-observable-change" else None,
        }
        if injection_error:
            envelope["ok"] = False
            envelope["injection_error"] = injection_error
            envelope["hint"] = "注入失败，什么都没有发生：" + injection_error
        return envelope

    # -- tools -------------------------------------------------------------
    def _screenshot(self, args: dict) -> dict:
        region = args.get("region")
        display = args.get("display")
        include_image = bool(args.get("include_image", False))
        max_width = int(args.get("max_width", 1280))

        frame, image = self._shot(region, display)
        action_id = self.audit.next_action_id()
        png_path = self.audit.save_shot(image, action_id)

        thumb_image = fit_width(image, THUMB_MAX_WIDTH)
        thumb_path = self.audit.save_thumb(thumb_image, action_id)

        report = dpi.dpi_report()
        active = _active_window()
        text = {
            "ok": True,
            "path": png_path,
            "sha1": frame.sha1,
            "width": frame.width,
            "height": frame.height,
            "rect": [frame.left, frame.top, frame.left + frame.width, frame.top + frame.height],
            "scale": report["scale"],
            "dpi": report["dpi"],
            "virtual_screen": capture.virtual_screen(),
            "active_window": active,
            "cursor": input_mod.cursor_pos(),
            "thumb": {"path": thumb_path, "width": thumb_image.width, "height": thumb_image.height} if thumb_path else None,
            "display": int(display or 0),
        }

        if diff.is_black(image):
            # Never let a black frame read as "the window was empty": say which
            # mechanism is responsible.
            probe = safety.secure_desktop_probe(frame_image=image)
            text["blank"] = True
            text["blank_reason"] = (
                f"整帧全黑，且安全桌面探测命中（{probe['reason']}）：抓屏到不了那个桌面。"
                if probe["active"]
                else "整帧全黑，但安全桌面探测未命中：会话可能已锁定，或该显示器关闭。"
            )

        # Read-only is not unaudited: the tool that can put a whole screen on
        # disk writes a row like every mutating tool.  The row names its files
        # RELATIVE to the audit dir (an absolute path would name the user's
        # folders for no reviewer benefit), never carries the decoded image, and
        # fingerprints the window title like every other row.
        audit_info = self.audit.append(
            {
                "ts": datetime.now().isoformat(timespec="milliseconds"),
                "action_id": action_id,
                "action": "screenshot",
                "args_echo": audit_mod.redact_args(
                    "screenshot",
                    {"region": region, "display": display, "include_image": include_image, "max_width": max_width},
                ),
                "sha1": frame.sha1,
                "width": frame.width,
                "height": frame.height,
                "rect": [frame.left, frame.top, frame.left + frame.width, frame.top + frame.height],
                "display": int(display or 0),
                "scale": report["scale"],
                "dpi": report["dpi"],
                "shot": f"shots/{action_id}.png" if png_path else None,
                "thumb": f"shots/{action_id}-thumb.jpg" if thumb_path else None,
                "blank": bool(text.get("blank", False)),
                "active_window": audit_mod.redact_focus(active),
                "budget_used": self.budget.snapshot()["used"],
            }
        )
        text["audit"] = audit_info

        content = [{"type": "text", "text": _one_line(text)}]
        if include_image:
            data, detail = encode_jpeg(image, max_width)
            if data is None:
                text["image_omitted"] = f"超过 {IMAGE_MAX_BYTES} 字节，用 read 打开 thumb 路径"
                content[0]["text"] = _one_line(text)
            else:
                text["image"] = detail
                content[0]["text"] = _one_line(text)
                content.append({"type": "image", "data": base64.b64encode(data).decode("ascii"), "mimeType": "image/jpeg"})
        return {"content": content, "isError": False}

    def _control_status(self, _args: dict) -> dict:
        report = dpi.dpi_report()
        probe = safety.secure_desktop_probe()
        budget = self.budget.snapshot()
        panic = self.panic.snapshot()
        if panic["state"] != "ai":
            verdict = "user-took-control"
        elif budget["exhausted"]:
            verdict = "budget-exhausted"
        else:
            verdict = "ready"
        import mss
        from PIL import __version__ as pillow_version

        text = {
            "ok": True,
            "state": panic["state"],
            "verdict": verdict,
            "panic_hotkey": panic["hotkey"],
            "panic_armed": panic["armed"],
            "panic_count": panic["panic_count"],
            "panic_error": panic["error"],
            "budget": budget,
            "audit_dir": str(self.audit.action_dir),
            "audit_bytes": self.audit.total_bytes(),
            "last_sweep": self.audit.last_sweep,
            "secure_desktop": probe["active"],
            "runtime": {
                "python": platform.python_version(),
                "mss": getattr(mss, "__version__", "unknown"),
                "pillow": pillow_version,
                "dpi_aware": report["dpi_aware"],
                "dpi": report["dpi"],
                "scale": report["scale"],
                "dpi_method": report["method"],
            },
            "session": self.audit.sid,
            "version": __version__,
        }
        return {"content": [{"type": "text", "text": _one_line(text)}], "isError": False}

    def call_tool(self, name: str, args: dict) -> dict:
        spec = next((t for t in TOOL_SPECS if t["name"] == name), None)
        if spec is None:
            raise ToolFailure(f"unknown tool: {name}")
        errors = validate(spec["inputSchema"], args)
        if errors:
            raise ToolFailure("; ".join(errors))

        self.start()

        if name == "screenshot":
            return self._screenshot(args)
        if name == "control_status":
            return self._control_status(args)

        settle_ms = int(args.get("settle_ms", 250))
        if name == "click":
            x, y = int(args["x"]), int(args["y"])
            button = args.get("button", "left")
            clicks = int(args.get("clicks", 1))
            envelope = self._mutate(
                action="click",
                args_echo={"x": x, "y": y, "button": button, "clicks": clicks},
                inject=lambda: input_mod.click(x, y, button, clicks),
                settle_ms=settle_ms,
                elevation_xy=(x, y),
                redact_from=args,
            )
        elif name == "type_text":
            text_value = args["text"]
            expect = args["expect_title"]
            interval = int(args.get("interval_ms", 0))
            delivery: dict = {}
            envelope = self._mutate(
                action="type_text",
                # The text itself is never echoed: it is a password as often as
                # it is prose, and 4000 chars of it would also be a token bomb.
                args_echo={"text_len": len(text_value), "expect_title": expect, "interval_ms": interval},
                inject=lambda: delivery.update(input_mod.type_text_focused(text_value, interval)),
                settle_ms=settle_ms,
                expect_title=expect,
                redact_from=args,
            )
            # Which delivery path actually ran, and into what. "typed" without
            # this is the unverifiable claim this package exists to avoid.
            if delivery:
                envelope["delivery"] = delivery
            return {"content": [{"type": "text", "text": _one_line(envelope)}], "isError": False}
        elif name == "key":
            keys = args["keys"]
            expect = args["expect_title"]
            repeat = int(args.get("repeat", 1))
            input_mod.vk_for(keys.split("+")[-1].strip() or keys)  # fail fast on an unknown key name
            envelope = self._mutate(
                action="key",
                args_echo={"keys": keys, "expect_title": expect, "repeat": repeat},
                inject=lambda: input_mod.press(keys, repeat),
                settle_ms=settle_ms,
                expect_title=expect,
                redact_from=args,
            )
        elif name == "scroll":
            x, y = int(args["x"]), int(args["y"])
            delta = int(args["delta"])
            envelope = self._mutate(
                action="scroll",
                args_echo={"x": x, "y": y, "delta": delta},
                inject=lambda: input_mod.scroll(x, y, delta),
                settle_ms=settle_ms,
                elevation_xy=(x, y),
                redact_from=args,
            )
        elif name == "drag":
            frm = [int(v) for v in args["from"]]
            to = [int(v) for v in args["to"]]
            duration = int(args.get("duration_ms", 300))
            envelope = self._mutate(
                action="drag",
                args_echo={"from": frm, "to": to, "duration_ms": duration},
                inject=lambda: input_mod.drag((frm[0], frm[1]), (to[0], to[1]), duration),
                settle_ms=settle_ms,
                elevation_xy=(frm[0], frm[1]),
                redact_from=args,
            )
        else:  # pragma: no cover - MUTATING and TOOL_SPECS are kept in sync
            raise ToolFailure(f"unhandled tool: {name}")

        return {"content": [{"type": "text", "text": _one_line(envelope)}], "isError": False}

    # -- JSON-RPC ----------------------------------------------------------
    def handle(self, message: dict) -> dict | None:
        if not isinstance(message, dict):
            return _error_response(None, -32600, "invalid request: not an object")
        method = message.get("method")
        request_id = message.get("id")
        is_notification = "id" not in message
        params = message.get("params") or {}

        if is_notification:
            # notifications/initialized, notifications/cancelled, ... : never answered
            return None

        try:
            if method == "initialize":
                params = params if isinstance(params, dict) else {}
                client = params.get("clientInfo") or {}
                self._log(f"initialize client={client.get('name')} version={client.get('version')} protocol={params.get('protocolVersion')}")
                wanted = params.get("protocolVersion")
                protocol = wanted if wanted in PROTOCOL_VERSIONS else NEWEST_PROTOCOL
                return _result(
                    request_id,
                    {
                        "protocolVersion": protocol,
                        "capabilities": {"tools": {"listChanged": False}},
                        "serverInfo": {"name": SERVER_NAME, "version": __version__},
                        "instructions": (
                            "7 tools, all under tools['computeruse']. Start with screenshot(): it returns "
                            "the PNG path, sha1 and the active window, and ITS pixel space is the coordinate "
                            "space for click / scroll / drag. type_text and key REQUIRE expect_title (a "
                            "substring of the foreground window title) — a mismatch refuses and types "
                            "nothing. Every mutating call answers verdict 'changed' or "
                            "'no-observable-change'; the latter means the screen did not move (not a "
                            "failure), so change the target instead of repeating it. include_image:true "
                            "attaches a JPEG that is re-sent on every later turn — use it only when you must "
                            "SEE the layout. control_status() reports the budget (200 mutating actions per "
                            "process), the panic state and the audit path."
                        ),
                    },
                )
            if method == "ping":
                return _result(request_id, {})
            if method == "tools/list":
                return _result(request_id, {"tools": TOOL_SPECS})
            if method == "tools/call":
                if not isinstance(params, dict):
                    return _error_response(request_id, -32602, "invalid params")
                name = params.get("name")
                arguments = params.get("arguments") or {}
                if not isinstance(name, str):
                    return _error_response(request_id, -32602, "params.name must be a string")
                if not isinstance(arguments, dict):
                    return _error_response(request_id, -32602, "params.arguments must be an object")
                try:
                    result = self.call_tool(name, arguments)
                except ToolFailure as exc:
                    return _result(
                        request_id, {"content": [{"type": "text", "text": f"error: {exc}"}], "isError": True}
                    )
                return _result(request_id, result)
            if method in ("resources/list", "prompts/list", "resources/templates/list"):
                return _error_response(request_id, -32601, f"method not supported: {method}")
            return _error_response(request_id, -32601, f"method not found: {method}")
        except ToolFailure as exc:
            return _error_response(request_id, -32603, str(exc))
        except Exception as exc:  # never let one bad call take the server down
            self._log(f"unhandled error in {method}: {type(exc).__name__}: {exc}")
            self._log(traceback.format_exc())
            return _error_response(request_id, -32603, f"{type(exc).__name__}: {exc}")


def _result(request_id, result) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error_response(request_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def serve(server: ComputerUseServer, stdin=None, stdout=None) -> int:
    """Read newline-delimited JSON-RPC from stdin, answer on stdout."""
    in_stream = stdin if stdin is not None else getattr(sys.stdin, "buffer", None)
    out_stream = stdout if stdout is not None else getattr(sys.stdout, "buffer", None)
    if in_stream is None or out_stream is None:
        raise SystemExit("computeruse: stdio is not available")

    # Any stray print from a dependency must not corrupt the protocol stream.
    try:
        sys.stdout = sys.stderr
    except Exception:
        pass

    while True:
        raw = in_stream.readline()
        if not raw:  # EOF on both bytes and text streams
            break
        line = raw if isinstance(raw, str) else raw.decode("utf-8", "replace")
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            response = _error_response(None, -32700, f"parse error: {exc}")
        else:
            try:
                response = server.handle(message)
            except Exception as exc:  # handle() is defensive; this is belt and braces
                server._log(f"handle() raised {type(exc).__name__}: {exc}")
                response = _error_response(message.get("id") if isinstance(message, dict) else None, -32603, str(exc))
        if response is None:
            continue
        out_stream.write((json.dumps(response, ensure_ascii=False) + "\n").encode("utf-8"))
        out_stream.flush()
    return 0

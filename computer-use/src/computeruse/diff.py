"""`changed_pixels_pct` — the whole point of the change envelope.

Two frames differ or they do not; "the mouse event was delivered" is not the
same fact as "something changed on screen" (a click on an unrendered SPA button
is a delivered event and a no-op).  This module only measures; the *verdict*
threshold lives here too so the two fields in the envelope can never disagree.

Method, per the design: 1/4 box downscale -> greyscale -> per-pixel absolute
difference -> count bins above `channel_threshold` straight out of Pillow's C
histogram.  No per-pixel Python loop, so a 1920x1080 pair costs ~10 ms.

`MIN_VISIBLE_PCT` is the resolution limit of the report, not a judgement call:
`changed_pixels_pct` is rounded to 2 decimals, so a difference smaller than
0.01% is not representable.  We derive the verdict from the same rounded number
the caller sees — a `changed_pixels_pct: 0.0` next to `verdict: "changed"`
would be two fields contradicting each other in one message.

**The noise floor is measured, not assumed.**  A live desktop is never static:
measured on this machine, two back-to-back captures of an idle screen differ by
0.01–0.05% (a playing/animating region), so a fixed 0.01% threshold would report
`changed` for a no-op click.  The server therefore samples the floor on every
action (`baseline_pct` = two consecutive captures, no injection between them)
and the verdict has to clear `max(MIN_VISIBLE_PCT, 2*baseline + 0.01)`.
`verdict()` takes that floor as a parameter and the envelope reports it, so the
line the verdict was drawn at is visible to the caller instead of implied.
"""

from __future__ import annotations

from PIL import Image, ImageChops

DOWNSCALE = 4
CHANNEL_THRESHOLD = 8
MIN_VISIBLE_PCT = 0.01

try:  # Pillow >= 9.1
    _BOX = Image.Resampling.BOX
except AttributeError:  # pragma: no cover - older Pillow
    _BOX = Image.BOX


def compare(
    before: Image.Image,
    after: Image.Image,
    *,
    downscale: int = DOWNSCALE,
    channel_threshold: int = CHANNEL_THRESHOLD,
) -> dict:
    """Return {changed_pixels_pct, changed_pixels, total_pixels, grid}."""
    downscale = max(1, int(downscale))
    w = max(1, before.width // downscale)
    h = max(1, before.height // downscale)
    ga = before.convert("L").resize((w, h), _BOX)
    gb = after.convert("L").resize((w, h), _BOX)
    if gb.size != ga.size:  # a resize race (window moved mid-capture) is still a change
        gb = gb.resize(ga.size, _BOX)

    hist = ImageChops.difference(ga, gb).histogram()  # 256 bins, C speed
    # hist[i] == number of pixels whose difference is exactly i.  "Above the
    # threshold" means i > channel_threshold, i.e. bins 9..255 for the default.
    changed = int(sum(hist[channel_threshold + 1 :]))
    total = w * h
    pct = round(changed * 100.0 / total, 2) if total else 0.0
    return {"changed_pixels_pct": pct, "changed_pixels": changed, "total_pixels": total, "grid": [w, h]}


def noise_floor(baseline_pct: float) -> float:
    """The percentage an action must clear to count as a visible change.

    Twice the measured idle baseline, plus one reporting unit, floored at the
    smallest representable percentage.  Reported in the envelope so the verdict
    is a claim with its own evidence attached.
    """
    return max(MIN_VISIBLE_PCT, round(float(baseline_pct) * 2.0 + MIN_VISIBLE_PCT, 2))


def verdict(changed_pixels_pct: float, floor: float | None = None) -> str:
    """'changed' | 'no-observable-change', against `floor` (default: the minimum).

    Rounded first on purpose: `compare()` already reports a 2-decimal value, and
    a raw 0.005 would otherwise compare below the threshold while rounding to
    the 0.01 we print — two fields contradicting each other in one message.
    """
    threshold = MIN_VISIBLE_PCT if floor is None else max(MIN_VISIBLE_PCT, round(float(floor), 2))
    return "changed" if round(float(changed_pixels_pct), 2) >= threshold else "no-observable-change"


def is_black(image: Image.Image, *, threshold: int = 6) -> bool:
    """True when every channel of every pixel is essentially black.

    Used only to tell "the secure desktop is up / the session is locked" apart
    from "the window really is empty" — never to claim a site had no content.
    """
    extrema = image.convert("RGB").getextrema()
    return all(hi <= threshold for _lo, hi in extrema)

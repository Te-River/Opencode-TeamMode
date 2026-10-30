"""Pure-function tests for the change metric. No screen, no mouse."""

from PIL import Image

from computeruse import diff


def solid(size=(640, 480), value=128):
    return Image.new("RGB", size, (value, value, value))


def test_identical_frames_are_no_observable_change():
    a = solid()
    b = solid()
    result = diff.compare(a, b)
    assert result["changed_pixels_pct"] == 0.0
    assert result["changed_pixels"] == 0
    assert diff.verdict(result["changed_pixels_pct"]) == "no-observable-change"


def test_a_visible_block_is_a_change():
    a = solid()
    b = a.copy()
    b.paste((0, 0, 0), (100, 100, 400, 350))
    result = diff.compare(a, b)
    assert result["changed_pixels_pct"] > 5.0
    assert diff.verdict(result["changed_pixels_pct"]) == "changed"


def test_a_sub_threshold_difference_is_not_a_change():
    # A uniform 4-level shift is below the per-pixel threshold of 8: invisible
    # to this metric by design, and reported as exactly that.
    a = solid(value=128)
    b = solid(value=132)
    result = diff.compare(a, b)
    assert result["changed_pixels_pct"] == 0.0
    assert diff.verdict(result["changed_pixels_pct"]) == "no-observable-change"


def test_noise_floor_scales_with_the_measured_baseline():
    # A live desktop is never static: the verdict has to clear the noise the
    # desktop itself produces, not a fixed number.
    assert diff.noise_floor(0.0) == diff.MIN_VISIBLE_PCT
    assert diff.noise_floor(0.02) == 0.05
    assert diff.noise_floor(0.05) == 0.11
    assert diff.verdict(0.03, diff.noise_floor(0.02)) == "no-observable-change"
    assert diff.verdict(0.06, diff.noise_floor(0.02)) == "changed"


def test_verdict_and_reported_pct_can_never_disagree():
    # The verdict is derived from the rounded number the caller sees, so a
    # 0.0 next to "changed" is impossible.
    for pct in (0.0, 0.001, 0.004, 0.005, 0.009, 0.01, 0.5, 100.0):
        assert (diff.verdict(pct) == "changed") == (round(pct, 2) >= diff.MIN_VISIBLE_PCT)


def test_pct_is_rounded_to_two_decimals():
    a = solid((1000, 1000))
    b = a.copy()
    b.paste((0, 0, 0), (0, 0, 1, 1))
    assert diff.compare(a, b)["changed_pixels_pct"] == round(diff.compare(a, b)["changed_pixels_pct"], 2)


def test_size_mismatch_counts_as_a_change():
    a = solid((640, 480))
    b = solid((641, 481))
    result = diff.compare(a, b)
    assert "changed_pixels_pct" in result
    assert result["total_pixels"] > 0


def test_grid_is_a_quarter_of_the_frame():
    result = diff.compare(solid((640, 480)), solid((640, 480)))
    assert result["grid"] == [160, 120]


def test_is_black():
    assert diff.is_black(Image.new("RGB", (8, 8), (0, 0, 0)))
    assert not diff.is_black(Image.new("RGB", (8, 8), (128, 128, 128)))

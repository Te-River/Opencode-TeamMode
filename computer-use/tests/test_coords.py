"""Coordinate normalisation — the classic drift bug, tested as pure maths."""

import pytest

from computeruse.input import normalize_abs
from computeruse import input as input_mod
from computeruse import diff
from PIL import Image


def test_origin_maps_to_zero():
    assert normalize_abs(0, 0, 0, 0, 1920, 1080) == (0, 0)


def test_last_pixel_maps_to_max():
    assert normalize_abs(1919, 1079, 0, 0, 1920, 1080) == (65535, 65535)


def test_centre_is_about_half():
    ax, ay = normalize_abs(960, 540, 0, 0, 1920, 1080)
    assert 32000 <= ax <= 33200
    assert 32000 <= ay <= 33200


def test_negative_origin_is_honoured():
    # A monitor to the LEFT of the primary: the virtual screen starts at -1920.
    ax, ay = normalize_abs(-1920, 0, -1920, 0, 3840, 1080)
    assert (ax, ay) == (0, 0)
    ax_right, _ = normalize_abs(1919, 0, -1920, 0, 3840, 1080)
    assert ax_right == 65535


def test_outside_the_virtual_screen_clamps_instead_of_going_negative():
    ax, ay = normalize_abs(-5000, -5000, 0, 0, 1920, 1080)
    assert (ax, ay) == (0, 0)
    ax, ay = normalize_abs(99999, 99999, 0, 0, 1920, 1080)
    assert (ax, ay) == (65535, 65535)


def test_degenerate_size_does_not_divide_by_zero():
    ax, ay = normalize_abs(10, 10, 0, 0, 1, 1)
    assert 0 <= ax <= 65535 and 0 <= ay <= 65535


def test_vk_names_resolve():
    assert input_mod.vk_for("Return") == 0x0D
    assert input_mod.vk_for("ctrl") == 0x11
    assert input_mod.vk_for("F12") == 0x7B
    assert input_mod.vk_for("a") == 0x41
    assert input_mod.vk_for("0") == 0x30
    with pytest.raises(ValueError):
        input_mod.vk_for("definitely-not-a-key")


def test_black_frame_helper_is_not_a_content_claim():
    assert diff.is_black(Image.new("RGB", (4, 4), (1, 1, 1)))
    assert not diff.is_black(Image.new("RGB", (4, 4), (200, 200, 200)))

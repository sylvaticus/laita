#!/usr/bin/env python3
"""
Regenerate browser/icons/icon-*.png from the LAITA logo.

The logo is a wide wordmark, which is illegible once squeezed into a 16px square, so the
icon is the pencil from the middle of it - the one element that is distinctive on its own.
It is rotated 45 degrees because an upright pencil is a thin sliver in a square frame and
wastes most of the canvas; on the diagonal it fills the square and still reads at 16px.

    python3 tools/make-icons.py

Needs Pillow. Re-run it if the logo changes; the PNGs are committed so that neither users
nor CI need Python to build.
"""
import pathlib
import numpy as np
from PIL import Image, ImageChops, ImageFilter

HERE = pathlib.Path(__file__).resolve().parent.parent
LOGO = HERE.parent / "assets" / "imgs" / "laita_logo.png"
OUT = HERE / "icons"
# A halo wide enough to survive at each size. Browser toolbars come in both light and
# dark, and the pencil is drawn with a dark outline that vanishes on black, so the mark
# is given a light outline of its own. It has to be added at the final size: added to the
# master and scaled down, a one-pixel halo at 16px would be a grey blur.
SIZES = {16: 1, 32: 2, 48: 2, 96: 3, 128: 4}
HALO = (255, 255, 255, 235)
# The pencil is found rather than hardcoded: the logo has already been redrawn once, and
# fixed coordinates silently crop the wrong letter when it is.
ANGLE = 45
PADDING = 1.10                      # a little air so the tip is not flush to the edge


def resize_premultiplied(im, size):
    """
    Resize without letting transparent pixels bleed their colour in.

    Pillow interpolates the R, G and B of fully transparent pixels along with the rest,
    so a vivid orange next to cleared pixels drifts towards whatever those pixels happen
    to hold - measured here as (242,140,0) turning into (183,128,52), a noticeably
    greyer pencil. Multiplying colour by alpha before resizing and dividing it back out
    afterwards is the standard cure.
    """
    a = np.asarray(im, dtype=np.float64)
    rgb, alpha = a[..., :3], a[..., 3:4] / 255.0
    pre = Image.fromarray(np.concatenate([rgb * alpha, alpha * 255], axis=2).astype(np.uint8),
                          "RGBA").resize(size, Image.LANCZOS)
    b = np.asarray(pre, dtype=np.float64)
    al = np.clip(b[..., 3:4] / 255.0, 1e-6, 1.0)
    out = np.concatenate([np.clip(b[..., :3] / al, 0, 255), b[..., 3:4]], axis=2)
    return Image.fromarray(out.astype(np.uint8), "RGBA")


def find_pencil(logo):
    """
    Locate the pencil - the "I" of LAITA - by looking for ink columns.

    The wordmark separates into runs of non-empty columns, one per glyph (sometimes two
    glyphs merge). The pencil is the one that is much taller than it is wide, which no
    letter in LAITA is, so the tallest aspect ratio wins.
    """
    a = np.asarray(logo)
    ink = (a[..., 3] > 40) & ~np.all(a[..., :3] > 235, axis=-1)
    cols = ink.any(axis=0)

    runs, start = [], None
    for x, filled in enumerate(cols):
        if filled and start is None:
            start = x
        elif not filled and start is not None:
            if x - start > 20:
                runs.append((start, x))
            start = None
    if start is not None:
        runs.append((start, len(cols)))
    if not runs:
        raise SystemExit("no glyphs found in the logo")

    def box(x0, x1):
        ys = np.where(ink[:, x0:x1].any(axis=1))[0]
        return x0, int(ys[0]), x1, int(ys[-1]) + 1

    boxes = [box(*r) for r in runs]
    pencil = max(boxes, key=lambda b: (b[3] - b[1]) / (b[2] - b[0]))
    if (pencil[3] - pencil[1]) / (pencil[2] - pencil[0]) < 2.0:
        raise SystemExit(f"no tall narrow glyph found; runs were {boxes}")
    return pencil


def main() -> None:
    logo = Image.open(LOGO).convert("RGBA")

    # the logo background is ~6% opaque rather than transparent; left alone it shows as a
    # faint square behind the icon on a light toolbar
    # The artwork is not only hazy where it should be empty, it is only ~85% opaque
    # where it should be solid, which on a dark toolbar reads as a dull pencil. Clear the
    # haze and push the rest to fully opaque.
    logo.putalpha(logo.getchannel("A").point(lambda v: 0 if v < 40 else min(255, int(v * 1.3))))

    box = find_pencil(logo)
    print(f"  pencil found at {box} in a {logo.width}x{logo.height} logo")
    pencil = logo.crop(box).rotate(ANGLE, resample=Image.BICUBIC, expand=True)
    pencil = pencil.crop(pencil.getchannel("A").getbbox())

    side = int(max(pencil.size) * PADDING)
    master = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    master.paste(pencil, ((side - pencil.width) // 2, (side - pencil.height) // 2), pencil)

    OUT.mkdir(exist_ok=True)
    for size, halo in SIZES.items():
        inner = resize_premultiplied(master, (size - 2 * halo, size - 2 * halo))

        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        canvas.paste(inner, (halo, halo), inner)

        # The halo must be a ring *around* the shape, not a light layer underneath it:
        # underneath, the artwork's anti-aliased edges blend into it and the whole mark
        # goes pale on a light background. Dilate the alpha, subtract the original, and
        # what is left is only the new border.
        alpha = canvas.getchannel("A")
        spread = alpha.filter(ImageFilter.MaxFilter(2 * halo + 1)).point(lambda v: min(v * 3, 255))
        ring = ImageChops.subtract(spread, alpha)

        outline = Image.new("RGBA", (size, size), HALO[:3] + (0,))
        outline.putalpha(ring.point(lambda v: v * HALO[3] // 255))
        outline.alpha_composite(canvas)

        outline.save(OUT / f"icon-{size}.png")
        print(f"  wrote icons/icon-{size}.png (halo {halo}px)")


if __name__ == "__main__":
    main()

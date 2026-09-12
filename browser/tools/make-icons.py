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
PENCIL_BOX = (904, 38, 1101, 843)   # the "I" of LAITA, in the 1950x873 logo
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


def main() -> None:
    logo = Image.open(LOGO).convert("RGBA")
    if logo.size != (1950, 873):
        raise SystemExit(f"logo is {logo.size}, expected (1950, 873); recheck PENCIL_BOX")

    # the logo background is ~6% opaque rather than transparent; left alone it shows as a
    # faint square behind the icon on a light toolbar
    # The artwork is not only hazy where it should be empty, it is only ~85% opaque
    # where it should be solid, which on a dark toolbar reads as a dull pencil. Clear the
    # haze and push the rest to fully opaque.
    logo.putalpha(logo.getchannel("A").point(lambda v: 0 if v < 40 else min(255, int(v * 1.3))))

    pencil = logo.crop(PENCIL_BOX).rotate(ANGLE, resample=Image.BICUBIC, expand=True)
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

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
from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent.parent
LOGO = HERE.parent / "assets" / "imgs" / "laita_logo.png"
OUT = HERE / "icons"
SIZES = (16, 32, 48, 96, 128)
PENCIL_BOX = (904, 38, 1101, 843)   # the "I" of LAITA, in the 1950x873 logo
ANGLE = 45
PADDING = 1.10                      # a little air so the tip is not flush to the edge


def main() -> None:
    logo = Image.open(LOGO).convert("RGBA")
    if logo.size != (1950, 873):
        raise SystemExit(f"logo is {logo.size}, expected (1950, 873); recheck PENCIL_BOX")

    pencil = logo.crop(PENCIL_BOX).rotate(ANGLE, resample=Image.BICUBIC, expand=True)
    pencil = pencil.crop(pencil.getchannel("A").getbbox())

    side = int(max(pencil.size) * PADDING)
    master = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    master.paste(pencil, ((side - pencil.width) // 2, (side - pencil.height) // 2), pencil)

    OUT.mkdir(exist_ok=True)
    for s in SIZES:
        master.resize((s, s), Image.LANCZOS).save(OUT / f"icon-{s}.png")
        print(f"  wrote icons/icon-{s}.png")


if __name__ == "__main__":
    main()

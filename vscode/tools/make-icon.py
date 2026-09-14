#!/usr/bin/env python3
"""
Build vscode/icon.png, the icon the Marketplace and the Extensions list show.

Unlike the browser toolbar icon - which is the pencil alone, because a wordmark is
unreadable at 16px - this one is displayed at 128px on the extension's page, where the
whole LAITA logo fits and identifies the project better.

It sits on a light rounded panel rather than on transparency: the logo's letters are
outlined in near-black, which disappears against the Marketplace's dark theme.

    python3 tools/make-icon.py        # needs Pillow
"""
import pathlib
from PIL import Image, ImageDraw

HERE = pathlib.Path(__file__).resolve().parent.parent
LOGO = HERE.parent / "assets" / "imgs" / "laita_logo.png"
OUT = HERE / "icon.png"
SIZE = 512          # rendered large, then downscaled, so the letters stay clean
BG = (252, 252, 253, 255)


def main() -> None:
    logo = Image.open(LOGO).convert("RGBA")
    # the background of the drawing is ~6% opaque rather than transparent, which
    # composites as a grey box; clear it and make the artwork itself solid
    logo.putalpha(logo.getchannel("A").point(lambda v: 0 if v < 40 else min(255, int(v * 1.3))))
    logo = logo.crop(logo.getchannel("A").getbbox())

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    panel = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(panel).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=SIZE // 8, fill=BG)
    canvas.alpha_composite(panel)

    # as wide as the panel allows, leaving a margin; the wordmark is ~2.25:1 so height
    # is the slack dimension
    margin = int(SIZE * 0.06)
    box = SIZE - 2 * margin
    scale = min(box / logo.width, box / logo.height)
    fitted = logo.resize((max(1, int(logo.width * scale)), max(1, int(logo.height * scale))),
                         Image.LANCZOS)
    canvas.alpha_composite(fitted, ((SIZE - fitted.width) // 2, (SIZE - fitted.height) // 2))

    canvas.resize((128, 128), Image.LANCZOS).save(OUT)
    print(f"  wrote icon.png (128x128, logo at {fitted.width}x{fitted.height} of {SIZE})")


if __name__ == "__main__":
    main()

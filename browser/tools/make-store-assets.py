#!/usr/bin/env python3
"""
Build the Chrome Web Store artwork into assets/store/.

The store accepts screenshots at exactly 1280x800 or 640x400 and nothing else, and the
repository screenshots are all odd sizes. They are letterboxed onto a 1280x800 canvas
rather than stretched: a stretched UI screenshot looks wrong and is what makes a listing
feel careless.

    python3 tools/make-store-assets.py        # needs Pillow

Outputs:
  promo-440x280.png     "small promo tile" - the card shown in search and category lists
  screenshot-N.png      1280x800, letterboxed, in reading order
"""
import pathlib
from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).resolve().parent.parent
IMGS = HERE.parent / "assets" / "imgs"
OUT = HERE.parent / "assets" / "store"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

BG = (247, 248, 250)      # matches the light card background the extension itself draws
INK = (55, 65, 81)
MUTED = (107, 114, 128)

# in reading order: what the extension does, simplest first
SHOTS = [
    ("screenshot_locaispell_firefox5.png", "Catches mistakes as you type"),
    ("screenshot_locaispell_firefox4.png", "Explains each suggestion"),
    ("screenshot_locaispell_firefox3.png", "Right-click any selection"),
    ("screenshot_locaispell_firefox2.png", "Ask for anything in plain words"),
    ("screenshot_locaispell_firefox1.png", "Replace, append, or discard"),
]


def dehaze(im, cutoff=40):
    """
    The logo's background is not transparent, it is ~6% opaque all over, which composites
    into a visible grey box on any light background. Anything below the cutoff is cleared.
    """
    a = im.getchannel("A").point(lambda v: 0 if v < cutoff else v)
    im.putalpha(a)
    return im


def fit(im, box_w, box_h):
    """Scale down to fit, never up: upscaling a screenshot only makes it blurry."""
    scale = min(box_w / im.width, box_h / im.height, 1.0)
    return im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))), Image.LANCZOS)


def screenshot(src, caption, index):
    W, H = 1280, 800
    canvas = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(canvas)

    shot = fit(Image.open(src).convert("RGBA"), W - 160, H - 200)
    x, y = (W - shot.width) // 2, (H - shot.height) // 2 + 30
    # a hairline frame so a white screenshot does not dissolve into the background
    draw.rectangle([x - 1, y - 1, x + shot.width, y + shot.height], outline=(222, 226, 232), width=1)
    canvas.paste(shot, (x, y), shot)

    f = ImageFont.truetype(FONT_B, 34)
    w = draw.textbbox((0, 0), caption, font=f)[2]
    draw.text(((W - w) // 2, 46), caption, font=f, fill=INK)

    canvas.save(OUT / f"screenshot-{index}.png")
    return shot.size


def promo():
    """440x280 'small promo tile': the card the store shows in lists and search."""
    W, H = 440, 280
    canvas = Image.new("RGB", (W, H), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    draw.rectangle([0, H - 6, W, H], fill=(233, 88, 63))      # a strip picked from the logo

    logo = fit(dehaze(Image.open(IMGS / "laita_logo.png").convert("RGBA")), 300, 132)
    canvas.paste(logo, ((W - logo.width) // 2, 30), logo)

    f1 = ImageFont.truetype(FONT_B, 21)
    f2 = ImageFont.truetype(FONT, 15)
    for text, font, fill, yy in (("Local AI Text Assistant", f1, INK, 186),
                                 ("Proofread and rewrite — on your own machine", f2, MUTED, 220)):
        w = draw.textbbox((0, 0), text, font=font)[2]
        draw.text(((W - w) // 2, yy), text, font=font, fill=fill)

    canvas.save(OUT / "promo-440x280.png")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    promo()
    print("  wrote assets/store/promo-440x280.png (440x280)")
    for i, (name, caption) in enumerate(SHOTS, start=1):
        size = screenshot(IMGS / name, caption, i)
        print(f"  wrote assets/store/screenshot-{i}.png (1280x800, image {size[0]}x{size[1]})")


if __name__ == "__main__":
    main()

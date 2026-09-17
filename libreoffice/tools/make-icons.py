#!/usr/bin/env python3
"""
Draw the four toolbar icons.

    python3 tools/make-icons.py

Each is the same sentence: a pencil on the left, a red proofreading squiggle along the
bottom spanning the whole width, and on the right the one mark that says which command
it is. The shared parts make the set read as one tool at a glance; the right-hand mark
is the only thing the eye has to tell apart.

    check document   a play triangle
    stop             a square
    options          a gear
    transform        T -> a Chinese character, with an arc between them

The transform mark does double duty: the T is text, and T-to-another-script is the
clearest tiny picture of "turn this into something else" - which is what the command
does, whether or not translation is the instruction.

LibreOffice wants 16px for the small toolbar and 26px for the large one. They are drawn
at 8x and reduced with LANCZOS, because a 16px square drawn directly has no room for a
curve. The PNGs are committed so that building the extension needs neither Python nor
Pillow.
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "src", "icons")
SIZES = (16, 26)
SCALE = 8

PENCIL_BODY = (242, 140, 0)        # the LAITA orange
PENCIL_TIP = (90, 62, 28)
PENCIL_WOOD = (255, 214, 153)
SQUIGGLE = (229, 72, 77)           # the error red, as the underline uses
MARK = (60, 64, 72)                # the command mark, near-black for contrast
PLAY = (46, 160, 67)
STOP = (200, 60, 60)

CJK = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def squiggle_at_size(img, size):
    """The proofreading zigzag, drawn AT THE FINAL SIZE rather than supersampled.

    Drawn large and reduced, a three-pixel wave is averaged into a straight grey line -
    which is a different symbol, and the one thing every icon in the set shares. Drawn
    directly on the 16-pixel grid it stays a zigzag, which is the whole point of it.
    """
    d = ImageDraw.Draw(img)
    amp = 1 if size <= 16 else 2
    y = size - 1 - amp
    step = 2 if size <= 16 else 3
    points = []
    x, up = 0, True
    while x <= size:
        points.append((x, y - amp if up else y + amp))
        up = not up
        x += step
    d.line(points, fill=SQUIGGLE, width=1)


def pencil(d, w, h):
    """A small pencil on the left, tilted, drawn as a body, a wooden tip and a point."""
    left = int(w * 0.06)
    top = int(h * 0.12)
    length = int(h * 0.52)
    thick = max(3, int(w * 0.14))
    # body, running down-left to up-right
    x0, y0 = left, top + length
    x1, y1 = left + thick, top
    d.polygon([(x0, y0), (x0 + thick, y0), (x1 + thick, y1), (x1, y1)], fill=PENCIL_BODY)
    # the wooden shoulder and the graphite point
    tipy = y0 + int(h * 0.12)
    d.polygon([(x0, y0), (x0 + thick, y0), (x0 + thick // 2, tipy)], fill=PENCIL_WOOD)
    d.polygon([(x0 + int(thick * 0.28), tipy - int(h * 0.045)),
               (x0 + int(thick * 0.72), tipy - int(h * 0.045)),
               (x0 + thick // 2, tipy)], fill=PENCIL_TIP)


def right_box(w, h):
    """Where the command mark goes: the right-hand side, clear of pencil and squiggle."""
    return int(w * 0.34), int(h * 0.08), int(w * 0.98), int(h * 0.70)


def draw_play(d, w, h):
    x0, y0, x1, y1 = right_box(w, h)
    d.polygon([(x0 + int((x1 - x0) * 0.12), y0),
               (x1, (y0 + y1) // 2),
               (x0 + int((x1 - x0) * 0.12), y1)], fill=PLAY)


def draw_stop(d, w, h):
    x0, y0, x1, y1 = right_box(w, h)
    pad = int((x1 - x0) * 0.1)
    d.rounded_rectangle([x0 + pad, y0 + pad, x1 - pad, y1 - pad],
                        radius=max(2, int(h * 0.05)), fill=STOP)


def draw_gear(d, w, h):
    """A ring with six square teeth.

    Round teeth on a circle merge into a flower once reduced - the silhouette loses its
    corners and a gear without corners is a flower. Rectangles keep theirs.
    """
    import math
    x0, y0, x1, y1 = right_box(w, h)
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    r = int(min(x1 - x0, y1 - y0) * 0.33)
    tw, tl = int(r * 0.42), int(r * 0.58)
    for i in range(6):
        a = math.radians(i * 60)
        ca, sa = math.cos(a), math.sin(a)
        # a rectangle standing on the rim, pointing outwards
        corners = []
        for dx, dy in ((-tw, 0), (tw, 0), (tw, tl), (-tw, tl)):
            corners.append((cx + ca * (r + dy) - sa * dx,
                            cy + sa * (r + dy) + ca * dx))
        d.polygon(corners, fill=MARK)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=MARK)
    hole = int(r * 0.44)
    d.ellipse([cx - hole, cy - hole, cx + hole, cy + hole], fill=(0, 0, 0, 0))


def draw_transform(d, w, h):
    """T above a Chinese character, with an arc turning one into the other.

    The glyphs are measured and placed rather than positioned by eye: at this size a
    guess of a few percent is the difference between two letters and one smudge, and
    the first two attempts had the arc drawn straight through both of them.

    The character does double duty - the mark reads as "turn this text into other
    text", which is what the command does whether or not the instruction is to
    translate.
    """
    x0, y0, x1, y1 = right_box(w, h)
    box_w, box_h = x1 - x0, y1 - y0

    t_font = font(SANS, int(box_h * 0.62))
    c_font = font(CJK, int(box_h * 0.64))

    def place(text, fnt, left, top):
        bbox = d.textbbox((0, 0), text, font=fnt)
        d.text((left - bbox[0], top - bbox[1]), text, font=fnt, fill=MARK)
        return bbox[2] - bbox[0], bbox[3] - bbox[1]

    # T at the top left of the box, the character at the bottom right, so the two never
    # share a row or a column and the arc has a clear diagonal to travel.
    tw, th = place("T", t_font, x0, y0 - int(box_h * 0.04))
    cw, ch = place("\u6587", c_font, x1 - int(box_w * 0.60), y1 - int(box_h * 0.62))

    # The arc lives in the corner the two glyphs leave empty - top right - rather than
    # between them, where it crossed the character and turned both into a smudge.
    r0 = x0 + int(box_w * 0.42)
    d.arc([r0, y0 - int(box_h * 0.06), x1, y0 + int(box_h * 0.52)],
          start=200, end=330, fill=MARK, width=max(2, int(h * 0.032)))


COMMANDS = {
    "checkdocument": draw_play,
    "stop": draw_stop,
    "options": draw_gear,
    "transform": draw_transform,
}


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, drawer in COMMANDS.items():
        for size in SIZES:
            big = size * SCALE
            img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            drawer(d, big, big)
            pencil(d, big, big)
            # Premultiply before reducing: Pillow interpolates the colour of fully
            # transparent pixels otherwise, and the orange drifts brown at the edges.
            img = Image.alpha_composite(
                Image.new("RGBA", img.size, (255, 255, 255, 0)), img)
            small = img.resize((size, size), Image.LANCZOS)
            squiggle_at_size(small, size)
            path = os.path.join(OUT, "%s_%d.png" % (name, size))
            small.save(path)
            print("  %s" % os.path.relpath(path, os.path.join(HERE, "..")))


if __name__ == "__main__":
    main()

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
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "src", "icons")
SIZES = (16, 26)
SCALE = 8

PENCIL_BODY = (242, 140, 0)        # the LAITA orange
PENCIL_TIP = (90, 62, 28)
PENCIL_WOOD = (255, 214, 153)
PENCIL_ERASER = (232, 150, 160)
SQUIGGLE = (229, 72, 77)           # the error red, as the underline uses
# The command mark. Mid-luminance on purpose: near-black disappears on a dark toolbar,
# and the first attempt at fixing that with a heavy white outline turned every icon into
# a white blob. A colour that reads on both backgrounds needs no outline to rescue it.
MARK = (74, 124, 196)
PLAY = (46, 160, 67)
STOP = (200, 60, 60)

CJK = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


HALO = (255, 255, 255, 170)


def halo(img):
    """A faint light edge, so nothing dissolves into a dark toolbar.

    Support, not rescue: the marks are already a colour that reads on both backgrounds,
    and this only keeps their edges from muddying against a very dark one. A ring
    AROUND the shape rather than a layer underneath it - underneath, anti-aliased edges
    blend into it and the mark goes pale on a light toolbar.

    Added at the final size, because a one-pixel ring drawn on the master and scaled
    down is a grey blur.
    """
    alpha = img.getchannel("A")
    # No amplification: multiplying the dilated alpha turns a soft edge into a hard
    # white collar, which is what made these look like stickers rather than icons.
    spread = alpha.filter(ImageFilter.MaxFilter(3))
    ring = ImageChops.subtract(spread, alpha)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(Image.new("RGBA", img.size, HALO), (0, 0), ring)
    out.alpha_composite(img)
    return out


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
    """A pencil lying bottom-right to top-left, point up at the top-left.

    The same orientation as assets/store/store-icon-128.png, because a user meets that
    one first and an icon set that disagrees with its own logo looks like two products.
    """
    import math
    # the axis, from the eraser end to the point
    x0, y0 = w * 0.40, h * 0.68          # eraser
    x1, y1 = w * 0.03, h * 0.10          # point
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    ux, uy = dx / length, dy / length    # along the pencil, towards the point
    px, py = -uy, ux                     # across it
    half = max(1.5, w * 0.070)

    def at(t, offset):
        """A point `t` of the way along the pencil, `offset` across it."""
        return (x0 + ux * t + px * offset, y0 + uy * t + py * offset)

    tip_len = length * 0.26
    ferrule = length * 0.16

    # body
    d.polygon([at(ferrule, -half), at(ferrule, half),
               at(length - tip_len, half), at(length - tip_len, -half)],
              fill=PENCIL_BODY)
    # the sharpened wooden cone, and the graphite at its end
    d.polygon([at(length - tip_len, -half), at(length - tip_len, half), at(length, 0)],
              fill=PENCIL_WOOD)
    d.polygon([at(length - tip_len * 0.34, -half * 0.36),
               at(length - tip_len * 0.34, half * 0.36), at(length, 0)],
              fill=PENCIL_TIP)
    # the eraser end
    d.polygon([at(0, -half), at(0, half), at(ferrule, half), at(ferrule, -half)],
              fill=PENCIL_ERASER)


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
            small = halo(small)
            squiggle_at_size(small, size)
            path = os.path.join(OUT, "%s_%d.png" % (name, size))
            small.save(path)
            print("  %s" % os.path.relpath(path, os.path.join(HERE, "..")))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Regenerate the platform icon files, and the macOS disk image background, from their vector sources.

`assets/luma-icon.svg` and `assets/dmg-background.svg` are the sources of truth; everything this writes
is derived and committed, so a normal build needs no rasterizer and no extra dependency. Run it only when
the artwork changes:

    pip install cairosvg           # not a project dependency — this script is the only user
    python scripts/build_icons.py

Two shapes come out of the one drawing, and the difference is not cosmetic. Windows and the browser want
the artwork **full-bleed**, filling its square. macOS wants it **inset**: since Big Sur the system draws
every icon on a 1024pt canvas whose rounded rectangle occupies 824pt, and an icon that fills its canvas
instead sits visibly larger than everything beside it in the Dock.

SVG filters are dropped — CairoSVG does not implement them, so the source's drop shadows do not survive.
That is the right outcome here rather than a loss worked around: both platforms composite their own
shadow behind an app icon, and a second one baked into the artwork reads as a smudge at small sizes.
"""

import sys
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "luma-icon.svg"
DMG_BACKGROUND_SOURCE = ROOT / "assets" / "dmg-background.svg"

# The canvas macOS draws on, and the portion of it Apple's icon grid gives the artwork.
MACOS_CANVAS = 1024
MACOS_ARTWORK = 824

# Windows reads the largest entry it needs from the file; 256 is the largest it uses.
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
# Home-screen bookmark on iOS and iPadOS, which ignores the favicon.
APPLE_TOUCH_SIZE = 180


def _render(size: int):
    """The artwork at one square size, rendered from the vector rather than resized from another
    raster — every size is a fresh rasterization, which is the whole reason to keep a vector source."""
    import cairosvg
    from PIL import Image

    png = cairosvg.svg2png(url=str(SOURCE), output_width=size, output_height=size)
    return Image.open(BytesIO(png)).convert("RGBA")


def _inset_for_macos():
    """The artwork at 824pt, centred on a transparent 1024pt canvas."""
    from PIL import Image

    canvas = Image.new("RGBA", (MACOS_CANVAS, MACOS_CANVAS), (0, 0, 0, 0))
    artwork = _render(MACOS_ARTWORK)
    offset = (MACOS_CANVAS - MACOS_ARTWORK) // 2
    canvas.paste(artwork, (offset, offset), artwork)
    return canvas


def _render_dmg_backgrounds() -> list[Path]:
    """The disk image background at its size in points and at twice that. `dmgbuild` finds the `@2x`
    file beside the first by name and combines the two with `tiffutil -cathidpicheck`, which is what
    keeps the window sharp on a Retina display. That check compares the images' sizes in points, so each
    carries the resolution that makes them equal: 72 dpi for the first and 144 for the second."""
    import cairosvg
    from PIL import Image

    written = []
    for scale, suffix in ((1, ""), (2, "@2x")):
        target = ROOT / "assets" / f"dmg-background{suffix}.png"
        png = cairosvg.svg2png(url=str(DMG_BACKGROUND_SOURCE), scale=scale)
        Image.open(BytesIO(png)).save(target, dpi=(72 * scale, 72 * scale))
        written.append(target)
    return written


def main() -> int:
    try:
        import cairosvg  # noqa: F401
        from PIL import Image  # noqa: F401
    except ImportError:
        raise SystemExit(
            "This script needs CairoSVG, which is not a project dependency. Install it with:\n"
            f"    {sys.executable} -m pip install cairosvg"
        )

    for source in (SOURCE, DMG_BACKGROUND_SOURCE):
        if not source.is_file():
            raise SystemExit(f"No artwork source at {source}.")

    written = []

    macos = _inset_for_macos()
    icns = ROOT / "assets" / "luma.icns"
    macos.save(icns)
    written.append(icns)

    full_bleed = _render(1024)
    ico = ROOT / "assets" / "luma.ico"
    full_bleed.save(ico, sizes=ICO_SIZES)
    written.append(ico)

    public = ROOT / "frontend" / "public"
    public.mkdir(parents=True, exist_ok=True)

    # The browser gets the vector itself, which stays crisp at any size and on any display; the `.ico`
    # is the fallback for anywhere that will not take an SVG.
    favicon_svg = public / "favicon.svg"
    favicon_svg.write_text(SOURCE.read_text(encoding="utf-8"), encoding="utf-8")
    written.append(favicon_svg)

    favicon_ico = public / "favicon.ico"
    full_bleed.save(favicon_ico, sizes=ICO_SIZES)
    written.append(favicon_ico)

    apple_touch = public / "apple-touch-icon.png"
    _render(APPLE_TOUCH_SIZE).save(apple_touch)
    written.append(apple_touch)

    written.extend(_render_dmg_backgrounds())

    print("Wrote:")
    for path in written:
        print(f"  {path.relative_to(ROOT)}  ({path.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

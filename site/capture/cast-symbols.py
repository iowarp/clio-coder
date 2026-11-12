#!/usr/bin/env python3
"""Rebuild site/vendor/cast-symbols/cast-symbols.woff2 from DejaVu 2.37.

IBM Plex Mono, the site's code face, lacks the arrows, shapes, check marks and
braille spinner the TUI draws. Cast pages fall back to this subset for them.
The code points come from site/vendor/cast-symbols/glyphs.txt; the sources are
DejaVuSansMono.ttf (first choice) and DejaVuSans.ttf (braille) from the
upstream release named in VERSION. Needs fontTools and brotli.

Usage: cast-symbols.py --dejavu <dejavu-fonts-ttf-2.37/ttf> [--check]
"""

import argparse
import hashlib
import re
import sys
from io import BytesIO
from pathlib import Path

import logging

from fontTools import subset
from fontTools.merge import Merger
from fontTools.ttLib import TTFont

VENDOR = Path(__file__).resolve().parents[1] / "vendor" / "cast-symbols"
TARGET = VENDOR / "cast-symbols.woff2"
FAMILY = "Cast Symbols"
SOURCES = {
    "DejaVuSansMono.ttf": "b4a6c3e4faab8773f4ff761d56451646409f29abedd68f05d38c2df667d3c582",
    "DejaVuSans.ttf": "7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954",
}
LIMIT = 25 * 1024


def code_points() -> list[int]:
    points = []
    for line in (VENDOR / "glyphs.txt").read_text(encoding="utf-8").splitlines():
        match = re.match(r"U\+([0-9A-F]{4,6})(?:\.\.U\+([0-9A-F]{4,6}))?\b", line)
        if match:
            low = int(match[1], 16)
            points.extend(range(low, int(match[2] or match[1], 16) + 1))
    return points


def subset_ttf(path: Path, unicodes: list[int]) -> TTFont:
    font = TTFont(path)
    options = subset.Options()
    options.layout_features = []
    options.hinting = False
    options.notdef_outline = True
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6]
    options.drop_tables += ["MATH", "FFTM", "GSUB", "GPOS", "GDEF", "kern"]
    sub = subset.Subsetter(options)
    sub.populate(unicodes=unicodes)
    sub.subset(font)
    return font


def build(dejavu: Path) -> bytes:
    for name, digest in SOURCES.items():
        actual = hashlib.sha256((dejavu / name).read_bytes()).hexdigest()
        if actual != digest:
            raise SystemExit(f"{name}: sha256 {actual} is not the DejaVu 2.37 release")
    wanted = code_points()
    mono_cmap = TTFont(dejavu / "DejaVuSansMono.ttf").getBestCmap()
    mono = [cp for cp in wanted if cp in mono_cmap]
    rest = [cp for cp in wanted if cp not in mono_cmap]
    parts = []
    for name, unicodes in (("DejaVuSansMono.ttf", mono), ("DejaVuSans.ttf", rest)):
        buffer = BytesIO()
        subset_ttf(dejavu / name, unicodes).save(buffer)
        buffer.seek(0)
        parts.append(buffer)
    font = Merger().merge(parts)
    # The Bitstream Vera license forbids the original names on a modified font.
    font["name"].names = []
    for name_id, value in (
        (0, "Subset of DejaVu fonts 2.37; Bitstream Vera and DejaVu changes are free, see LICENSE."),
        (1, FAMILY),
        (2, "Regular"),
        (3, "CastSymbols-Regular"),
        (4, f"{FAMILY} Regular"),
        (5, "Version 2.37"),
        (6, "CastSymbols-Regular"),
    ):
        font["name"].setName(value, name_id, 3, 1, 0x409)
    font["head"].created = font["head"].modified = 0
    font.recalcTimestamp = False
    font.flavor = "woff2"
    out = BytesIO()
    font.save(out, reorderTables=True)
    return out.getvalue()


def main() -> int:
    logging.getLogger("fontTools").setLevel(logging.ERROR)
    parser = argparse.ArgumentParser()
    parser.add_argument("--dejavu", type=Path, required=True, help="the ttf/ directory of dejavu-fonts-ttf-2.37")
    parser.add_argument("--check", action="store_true", help="fail when the committed font differs")
    args = parser.parse_args()
    data = build(args.dejavu)
    if len(data) > LIMIT:
        print(f"cast-symbols.woff2 is {len(data)} B, over {LIMIT} B", file=sys.stderr)
        return 1
    if args.check:
        if not TARGET.exists() or TARGET.read_bytes() != data:
            print("site/vendor/cast-symbols/cast-symbols.woff2 is stale; rerun cast-symbols.py", file=sys.stderr)
            return 1
        return 0
    TARGET.write_bytes(data)
    print(f"cast-symbols.woff2 {len(data)} B sha256 {hashlib.sha256(data).hexdigest()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

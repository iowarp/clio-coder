#!/usr/bin/env python3
"""Project an exported canonical brand kit into bundled GUI assets (requires Pillow).

node site/export-brand.mjs --out .superpowers/brand-kit
python3 apps/clio-coder-gui/scripts/sync-brand-assets.py --kit .superpowers/brand-kit
"""
import argparse
import hashlib
import json
import shutil
from pathlib import Path
from PIL import Image

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--kit", type=Path, required=True)
args = parser.parse_args()
public = Path(__file__).resolve().parents[1] / "client" / "public"
fonts = public / "fonts"
fonts.mkdir(exist_ok=True)
for source in (args.kit / "assets" / "fonts").iterdir():
    shutil.copy2(source, fonts / source.name)
brand = public / "brand"
brand.mkdir(exist_ok=True)
mark = args.kit / "assets" / "brand" / "clio-mark.png"
provenance = json.loads((args.kit / "assets" / "brand" / "provenance.json").read_text())
provenance["assets"] = [item for item in provenance["assets"] if item["name"] == "clio-mark"]
if (
    len(provenance["assets"]) != 1
    or provenance["assets"][0]["sha256"] != hashlib.sha256(mark.read_bytes()).hexdigest()
):
    raise ValueError("Canonical mark does not match its provenance.")
provenance["projection"] = {
    "source": "site/export-brand.mjs",
    "designSha256": hashlib.sha256((args.kit / "design-system.json").read_bytes()).hexdigest(),
    "padding": "Square icons center the unchanged mark within an 80% safe area.",
}
image = Image.open(mark).convert("RGBA")
header = image.copy()
header.thumbnail((128, 128), Image.Resampling.LANCZOS)
header.save(public / "clio-coder-logo.webp", quality=90, method=6)
for size in [32, 192, 512]:
    resized = image.copy()
    resized.thumbnail((round(size * .8), round(size * .8)), Image.Resampling.LANCZOS)
    square = Image.new("RGBA", (size, size))
    square.alpha_composite(resized, ((size-resized.width)//2, (size-resized.height)//2))
    square.save(public / ("favicon.png" if size == 32 else f"icon-{size}.png"), optimize=True)
provenance["projection"]["sha256"] = {
    name: hashlib.sha256((public/name).read_bytes()).hexdigest()
    for name in ["clio-coder-logo.webp", "favicon.png", "icon-192.png", "icon-512.png"]
}
(brand / "provenance.json").write_text(json.dumps(provenance, indent="\t")+"\n")

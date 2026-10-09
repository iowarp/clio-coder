#!/usr/bin/env python3
"""Project a canonical brand kit with Pillow 12.1.0, libwebp 1.6.0 and pngquant 2.18.0.

node site/export-brand.mjs --out tmp/brand-kit
python3 apps/clio-coder-gui/scripts/sync-brand-assets.py --kit tmp/brand-kit
"""
import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from PIL import Image, ImageEnhance, __version__ as pillow_version, features

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--kit", type=Path, required=True)
parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "client" / "public")
args = parser.parse_args()
pngquant = shutil.which("pngquant")
if pngquant is None:
    raise SystemExit("pngquant: expected 2.18.0, found no executable on PATH.")
pngquant = str(Path(pngquant).resolve())
pngquant_version = subprocess.check_output([pngquant, "--version"], text=True).strip().partition(" ")[0]
encoders = {"pngquant": pngquant_version, "Pillow": pillow_version, "libwebp": features.version("webp")}
for name, expected in {"pngquant": "2.18.0", "Pillow": "12.1.0", "libwebp": "1.6.0"}.items():
    if encoders[name] != expected:
        raise SystemExit(f"{name}: expected {expected}, found {encoders[name]}; byte-identical assets require this encoder.")
public = args.out
public.mkdir(parents=True, exist_ok=True)
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
    "encoders": encoders,
    "padding": "Square app icons center the mark within a 94% safe area; the header mark is unchanged.",
    "iconTreatment": {
        "source": "site/assets/brand/clio-mark.png",
        "safeArea": 0.94,
        "saturation": 1.16,
        "brightness": 1.14,
        "resampling": "Pillow Image.Resampling.LANCZOS",
        "alpha": "Preserved from the canonical mark before resizing.",
        "optimization": f"pngquant {pngquant_version}, quality 90-100, speed 1; palette quantization after resizing.",
    },
}
image = Image.open(mark).convert("RGBA")
header = image.copy()
header.thumbnail((128, 128), Image.Resampling.LANCZOS)
header.save(public / "clio-coder-logo.webp", quality=90, method=6)
treatment = provenance["projection"]["iconTreatment"]
icons = ImageEnhance.Color(image.convert("RGB")).enhance(treatment["saturation"])
icons = ImageEnhance.Brightness(icons).enhance(treatment["brightness"])
icons.putalpha(image.getchannel("A"))
for size in [32, 192, 512]:
    resized = icons.copy()
    edge = round(size * treatment["safeArea"])
    resized.thumbnail((edge, edge), Image.Resampling.LANCZOS)
    square = Image.new("RGBA", (size, size))
    square.alpha_composite(resized, ((size-resized.width)//2, (size-resized.height)//2))
    output = public / ("favicon.png" if size == 32 else f"icon-{size}.png")
    square.save(output, optimize=True)
    subprocess.run([pngquant, "--quality", "90-100", "--speed", "1", "--force", "--output", str(output), str(output)], check=True)
provenance["projection"]["sha256"] = {
    name: hashlib.sha256((public/name).read_bytes()).hexdigest()
    for name in ["clio-coder-logo.webp", "favicon.png", "icon-192.png", "icon-512.png"]
}
(brand / "provenance.json").write_text(json.dumps(provenance, indent="\t")+"\n")

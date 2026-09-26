#!/usr/bin/env python3
"""Generate reproducible WebP sizes from actual product and brand artwork."""
import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image

SITE = Path(__file__).resolve().parent
MANIFEST = SITE / "image-variants.json"
INPUTS = {
    "assets/gui-overview.webp": [640, 960, 1280],
    "assets/gui-conversation.webp": [480, 768, 1120],
    "assets/tui-boot.webp": [640, 960, 1280],
    "assets/brand/clio-mark.webp": [32, 64, 128],
    "assets/brand/iowarp-mark.webp": [128, 256],
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def generate():
    (SITE / "assets/responsive").mkdir(exist_ok=True)
    result = {}
    for source, widths in INPUTS.items():
        image = Image.open(SITE / source).convert("RGBA")
        variants = []
        for width in widths:
            height = round(image.height * width / image.width)
            target = f"assets/responsive/{Path(source).stem}-{width}.webp"
            image.resize((width, height), Image.Resampling.LANCZOS).save(SITE / target, "WEBP", quality=88, method=6)
            variants.append({"path": target, "width": width, "height": height, "sha256": digest(SITE / target)})
        result[source] = {"width": image.width, "height": image.height, "sha256": digest(SITE / source), "variants": variants}
    mark = Image.open(SITE / "assets/brand/clio-mark.png").convert("RGBA")
    for size in [32, 180]:
        canvas = Image.new("RGBA", (size, size))
        fitted = mark.copy()
        fitted.thumbnail((round(size*.9), round(size*.9)), Image.Resampling.LANCZOS)
        canvas.alpha_composite(fitted, ((size-fitted.width)//2, (size-fitted.height)//2))
        canvas.save(SITE / f"assets/responsive/clio-icon-{size}.png", optimize=True)
    MANIFEST.write_text(json.dumps(result, indent=2)+"\n")
    print(f"Generated {sum(len(item['variants']) for item in result.values())} responsive captures and marks, plus two square icons.")


def check():
    manifest = json.loads(MANIFEST.read_text())
    for source, item in manifest.items():
        if digest(SITE / source) != item["sha256"]:
            raise ValueError(f"image source changed: {source}")
        for variant in item["variants"]:
            path = SITE / variant["path"]
            if digest(path) != variant["sha256"] or Image.open(path).size != (variant["width"], variant["height"]):
                raise ValueError(f"image derivative drift: {path}")
    for size in [32, 180]:
        if Image.open(SITE / f"assets/responsive/clio-icon-{size}.png").size != (size, size):
            raise ValueError("square application icon dimensions differ")
    print("Responsive source hashes, derivatives, and icon dimensions checked.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    check() if args.check else generate()

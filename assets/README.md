# Media assets

`assets/` contains the canonical brand artwork and product captures.
[`media-manifest.json`](media-manifest.json) records source paths, hashes,
dimensions, descriptions, and delivery copies for the website and browser app.

## Product captures

The PNG files in `screenshots/` include the current terminal boot and actual
desktop overview, conversation, and Artifacts captures in dark and light themes.
The v0.5.7 desktop examples use a real model-created temperature-calibration
session with seven passing tests recorded by `verify`. Its runnable source is in
[`examples/temperature-calibration`](../examples/temperature-calibration/README.md).
The overview captures redact the recent project's absolute path for publication;
the terminal uses an isolated model profile and crops only blank bottom margin.
The manifest records this provenance. WebP companions are optimized for inline
reading; links open the full-resolution PNGs. Keep the remaining interface content
intact when preparing derivatives.

## Synchronize and check

```bash
python3 scripts/media-assets.py --sync
python3 scripts/media-assets.py --check
```

The check verifies hashes, dimensions, delivery copies, and card exports.
After replacing a master, update its description and record the new hashes:

```bash
python3 scripts/media-assets.py --record-hashes
python3 scripts/media-assets.py --check
```

## Preview cards

Card templates live in `site/cards/` and use the website's fonts and palette.
Render the landscape and square exports with Chrome:

```bash
node site/render-cards.mjs
# Use --chrome /path/to/chrome when needed.
```

The renderer waits for fonts, captures the declared dimensions, and updates
source and export hashes. Product captures and illustrated cards are identified
separately in the manifest.

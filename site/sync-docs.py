#!/usr/bin/env python3
"""Refresh the website's documentation snapshot from the repository docs."""

import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs"
DEST = Path(__file__).resolve().parent / "content" / "docs"
INDEX = Path(__file__).resolve().parent / "content" / "index.json"


def excerpt(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(("#", "<", "|", "```", "!", "- ", "* ")):
            continue
        return re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", stripped)[:240]
    return ""


def main() -> None:
    if DEST.exists():
        shutil.rmtree(DEST)
    shutil.copytree(SOURCE, DEST)
    items = []
    for path in sorted(DEST.rglob("*.md")):
        rel = path.relative_to(DEST).as_posix()
        text = path.read_text(errors="replace")
        title_match = re.search(r"^#\s+(.+)$", text, re.M)
        title = re.sub(r"<[^>]+>", "", title_match.group(1)).strip() if title_match else rel
        headings = [
            re.sub(r"<[^>]+>", "", heading).strip()
            for heading in re.findall(r"^#{2,3}\s+(.+)$", text, re.M)
        ][:16]
        items.append({"path": rel, "title": title, "headings": headings, "excerpt": excerpt(text)})
    INDEX.write_text(json.dumps(items, indent=2) + "\n")
    print(f"snapshotted {len(items)} pages into {DEST.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

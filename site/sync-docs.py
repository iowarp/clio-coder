#!/usr/bin/env python3
"""Build or check the release-pinned website product-documentation snapshot."""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = Path(__file__).resolve().parent
CONTENT = SITE / "content"
DEST = CONTENT / "docs"
INDEX = CONTENT / "index.json"
MANIFEST = CONTENT / "docs-manifest.json"
POLICY = ROOT / "docs" / "corpus.json"
PRODUCT = SITE / "product.json"


def run_git(*args: str) -> bytes:
    return subprocess.check_output(["git", *args], cwd=ROOT, stderr=subprocess.PIPE)


def source_commit(ref: str) -> str:
    try:
        return run_git("rev-parse", "--verify", f"{ref}^{{commit}}").decode().strip()
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode(errors="replace").strip()
        raise ValueError(f"cannot resolve documentation source ref {ref!r}: {detail}") from error


def product_doc(path: str, roots: list[str]) -> bool:
    return any(path.startswith(root) if root.endswith("/") else path == root for root in roots)


def source_files(commit: str, roots: list[str]) -> dict[str, bytes]:
    names = run_git("ls-tree", "-r", "--name-only", commit, "docs").decode().splitlines()
    files: dict[str, bytes] = {}
    for name in sorted(names):
        if not name.endswith(".md") or not name.startswith("docs/"):
            continue
        relative = name.removeprefix("docs/")
        if product_doc(relative, roots):
            files[relative] = run_git("show", f"{commit}:{name}")
    if not files:
        raise ValueError(f"no product Markdown documents found at {commit}")
    if any(path == "wiki" or path.startswith("wiki/") for path in files):
        raise ValueError("the product documentation corpus includes generated docs/wiki content")
    return files


def excerpt(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(("#", "<", "|", "```", "!", "- ", "* ")):
            continue
        return re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", stripped)[:240]
    return ""


def index_bytes(files: dict[str, bytes]) -> bytes:
    items = []
    for path, raw in sorted(files.items()):
        text = raw.decode(errors="replace")
        title_match = re.search(r"^#\s+(.+)$", text, re.M)
        title = re.sub(r"<[^>]+>", "", title_match.group(1)).strip() if title_match else path
        headings = [
            re.sub(r"<[^>]+>", "", heading).strip()
            for heading in re.findall(r"^#{2,3}\s+(.+)$", text, re.M)
        ][:16]
        items.append({"path": path, "title": title, "headings": headings, "excerpt": excerpt(text)})
    return (json.dumps(items, indent=2, ensure_ascii=False) + "\n").encode()


def manifest_bytes(version: str, ref: str, commit: str, files: dict[str, bytes]) -> bytes:
    value = {
        "schema": 1,
        "corpus": "product",
        "corpusPolicy": "docs/corpus.json#product",
        "source": {"version": version, "ref": ref, "commit": commit},
        "files": [
            {"path": path, "sha256": hashlib.sha256(raw).hexdigest()} for path, raw in sorted(files.items())
        ],
    }
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()


def inputs(ref: str) -> tuple[str, str, dict[str, bytes], bytes, bytes]:
    product = json.loads(PRODUCT.read_text())
    policy = json.loads(POLICY.read_text())
    version = product.get("version")
    roots = policy.get("product", {}).get("roots")
    if not isinstance(version, str) or not version:
        raise ValueError("site/product.json has no version")
    if not isinstance(roots, list) or not all(isinstance(root, str) and root for root in roots):
        raise ValueError("docs/corpus.json has no valid product roots")
    commit = source_commit(ref)
    files = source_files(commit, roots)
    return version, commit, files, index_bytes(files), manifest_bytes(version, ref, commit, files)


def compare(ref: str) -> list[str]:
    version, commit, files, expected_index, expected_manifest = inputs(ref)
    errors: list[str] = []
    actual = {
        path.relative_to(DEST).as_posix(): path.read_bytes() for path in DEST.rglob("*") if path.is_file()
    } if DEST.is_dir() else {}
    expected_paths = set(files)
    actual_paths = set(actual)
    for path in sorted(expected_paths - actual_paths):
        errors.append(f"missing snapshot file: {path}")
    for path in sorted(actual_paths - expected_paths):
        errors.append(f"extra snapshot file: {path}")
    for path in sorted(expected_paths & actual_paths):
        if files[path] != actual[path]:
            errors.append(f"content drift: {path}")
    if not INDEX.is_file() or INDEX.read_bytes() != expected_index:
        errors.append("content/index.json does not match the declared source")
    if not MANIFEST.is_file() or MANIFEST.read_bytes() != expected_manifest:
        errors.append("content/docs-manifest.json does not match the declared source")
    if errors:
        errors.insert(0, f"documentation snapshot drift for {ref} ({commit}) and site v{version}:")
    return errors


def check() -> int:
    try:
        manifest = json.loads(MANIFEST.read_text())
        ref = manifest["source"]["ref"]
        if not isinstance(ref, str) or not ref:
            raise ValueError("manifest source.ref is empty")
        errors = compare(ref)
    except (OSError, KeyError, TypeError, json.JSONDecodeError, ValueError) as error:
        errors = [f"documentation snapshot cannot be checked: {error}"]
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    count = len(json.loads(MANIFEST.read_text())["files"])
    print(f"checked {count} release-pinned product docs; generated docs/wiki pages are excluded")
    return 0


def sync(ref: str) -> int:
    version, commit, files, generated_index, generated_manifest = inputs(ref)
    required_ref = f"v{version}"
    if ref != required_ref:
        raise ValueError(
            f"public docs are release-pinned: site v{version} must use --source-ref {required_ref}, not {ref}"
        )
    CONTENT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="docs-snapshot-", dir=CONTENT) as temporary:
        staged = Path(temporary) / "docs"
        for path, raw in sorted(files.items()):
            destination = staged / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(raw)
        if DEST.exists():
            shutil.rmtree(DEST)
        staged.rename(DEST)
    INDEX.write_bytes(generated_index)
    MANIFEST.write_bytes(generated_manifest)
    print(
        f"snapshotted {len(files)} product docs from {ref} ({commit}) for site v{version}; docs/wiki excluded"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="report drift without changing files")
    mode.add_argument("--source-ref", help="write from the release tag matching site/product.json")
    args = parser.parse_args()
    try:
        return check() if args.check else sync(args.source_ref)
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError, ValueError) as error:
        print(f"sync-docs: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

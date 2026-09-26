#!/usr/bin/env python3
"""Synchronize and verify tracked Clio Coder media assets."""

import argparse
import hashlib
import json
import re
import shutil
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "assets" / "media-manifest.json"


def repository_path(value: str) -> Path:
    path = (ROOT / value).resolve()
    if not path.is_relative_to(ROOT):
        raise ValueError(f"manifest path escapes the repository: {value}")
    return path


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_digest(paths: list[str]) -> str:
    result = hashlib.sha256()
    for value in sorted(paths):
        path = repository_path(value)
        result.update(value.encode())
        result.update(b"\0")
        result.update(path.read_bytes())
        result.update(b"\0")
    return result.hexdigest()


def image_dimensions(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        return struct.unpack(">II", data[16:24])
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        offset = 12
        while offset + 8 <= len(data):
            kind = data[offset : offset + 4]
            size = int.from_bytes(data[offset + 4 : offset + 8], "little")
            payload = data[offset + 8 : offset + 8 + size]
            if kind == b"VP8X" and len(payload) >= 10:
                return 1 + int.from_bytes(payload[4:7], "little"), 1 + int.from_bytes(payload[7:10], "little")
            if kind == b"VP8 " and len(payload) >= 10:
                marker = payload.find(b"\x9d\x01\x2a")
                if marker >= 0 and marker + 7 <= len(payload):
                    width, height = struct.unpack("<HH", payload[marker + 3 : marker + 7])
                    return width & 0x3FFF, height & 0x3FFF
            if kind == b"VP8L" and len(payload) >= 5 and payload[0] == 0x2F:
                packed = int.from_bytes(payload[1:5], "little")
                return 1 + (packed & 0x3FFF), 1 + ((packed >> 14) & 0x3FFF)
            offset += 8 + size + (size % 2)
    if path.suffix.lower() == ".svg":
        head = data[:4096].decode(errors="replace")
        width = re.search(r'\bwidth="(\d+)"', head)
        height = re.search(r'\bheight="(\d+)"', head)
        if width and height:
            return int(width.group(1)), int(height.group(1))
    raise ValueError(f"unsupported or malformed image: {path.relative_to(ROOT)}")


def load_manifest() -> dict:
    value = json.loads(MANIFEST.read_text())
    if value.get("schema") != 1 or value.get("canonicalRoot") != "assets":
        raise ValueError("media manifest must use schema 1 and canonicalRoot 'assets'")
    if not isinstance(value.get("assets"), list) or not isinstance(value.get("socialExports"), list):
        raise ValueError("media manifest has no asset/export lists")
    return value


def metadata_errors(item: dict, label: str) -> list[str]:
    errors = []
    required_strings = [
        "id",
        "role",
        "altTextSeed",
        "representation",
        "approval",
        "approvalNotes",
        "supersessionNotes",
    ]
    for key in required_strings:
        if not isinstance(item.get(key), str) or not item[key].strip():
            errors.append(f"{label}: missing {key}")
    if not isinstance(item.get("channels"), list) or not item["channels"]:
        errors.append(f"{label}: missing channels")
    dimensions = item.get("dimensions")
    if not isinstance(dimensions, dict) or not all(
        isinstance(dimensions.get(key), int) and dimensions[key] > 0 for key in ("width", "height")
    ):
        errors.append(f"{label}: invalid dimensions")
    return errors


def verify(manifest: dict) -> list[str]:
    errors: list[str] = []
    ids: set[str] = set()
    destinations: set[str] = set()
    for item in manifest["assets"]:
        label = f"asset {item.get('id', '<unknown>')}"
        errors.extend(metadata_errors(item, label))
        identifier = item.get("id")
        if identifier in ids:
            errors.append(f"duplicate media id: {identifier}")
        if isinstance(identifier, str):
            ids.add(identifier)
        source_value = item.get("source")
        if not isinstance(source_value, str) or not source_value.startswith("assets/"):
            errors.append(f"{label}: source must be under assets/")
            continue
        source = repository_path(source_value)
        if not source.is_file():
            errors.append(f"{label}: missing source {source_value}")
            continue
        actual_hash = digest(source)
        if item.get("sha256") != actual_hash:
            errors.append(f"{label}: source hash drift for {source_value}")
        dimensions = item.get("dimensions", {})
        try:
            actual_dimensions = image_dimensions(source)
            expected_dimensions = (dimensions.get("width"), dimensions.get("height"))
            if actual_dimensions != expected_dimensions:
                errors.append(f"{label}: dimensions {actual_dimensions} differ from {expected_dimensions}")
        except ValueError as error:
            errors.append(str(error))
        copies = item.get("copies")
        if not isinstance(copies, list):
            errors.append(f"{label}: copies must be a list")
            continue
        for copy_value in copies:
            if not isinstance(copy_value, str):
                errors.append(f"{label}: invalid delivery copy path")
                continue
            if copy_value in destinations:
                errors.append(f"delivery copy is declared more than once: {copy_value}")
            destinations.add(copy_value)
            copy = repository_path(copy_value)
            if not copy.is_file():
                errors.append(f"{label}: missing delivery copy {copy_value}")
            elif copy.read_bytes() != source.read_bytes():
                errors.append(f"{label}: delivery copy drift at {copy_value}")

    for item in manifest["socialExports"]:
        label = f"social export {item.get('id', '<unknown>')}"
        errors.extend(metadata_errors(item, label))
        identifier = item.get("id")
        if identifier in ids:
            errors.append(f"duplicate media id: {identifier}")
        if isinstance(identifier, str):
            ids.add(identifier)
        template = item.get("template")
        output = item.get("output")
        sources = item.get("sources")
        if not isinstance(template, str) or not isinstance(output, str) or not isinstance(sources, list):
            errors.append(f"{label}: invalid template, output, or sources")
            continue
        if template not in sources:
            errors.append(f"{label}: template is absent from sources")
        missing = [value for value in sources if not isinstance(value, str) or not repository_path(value).is_file()]
        if missing:
            errors.append(f"{label}: missing source inputs: {', '.join(map(str, missing))}")
            continue
        if item.get("sourceSha256") != source_digest(sources):
            errors.append(f"{label}: source/export drift; render the cards again")
        output_path = repository_path(output)
        if not output_path.is_file():
            errors.append(f"{label}: missing export {output}")
            continue
        if item.get("sha256") != digest(output_path):
            errors.append(f"{label}: export hash drift for {output}")
        dimensions = item.get("dimensions", {})
        try:
            actual_dimensions = image_dimensions(output_path)
            expected_dimensions = (dimensions.get("width"), dimensions.get("height"))
            if actual_dimensions != expected_dimensions:
                errors.append(f"{label}: dimensions {actual_dimensions} differ from {expected_dimensions}")
        except ValueError as error:
            errors.append(str(error))
    return errors


def synchronize(manifest: dict) -> None:
    source_errors = []
    for item in manifest["assets"]:
        source = repository_path(item["source"])
        if not source.is_file() or digest(source) != item.get("sha256"):
            source_errors.append(f"refusing to sync changed or missing master: {item['source']}")
    if source_errors:
        raise ValueError("\n".join(source_errors))
    for item in manifest["assets"]:
        source = repository_path(item["source"])
        for copy_value in item["copies"]:
            destination = repository_path(copy_value)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)


def record_hashes(manifest: dict) -> None:
    for item in manifest["assets"]:
        item["sha256"] = digest(repository_path(item["source"]))
    for item in manifest["socialExports"]:
        item["sourceSha256"] = source_digest(item["sources"])
        item["sha256"] = digest(repository_path(item["output"]))
    MANIFEST.write_text(json.dumps(manifest, indent="\t", ensure_ascii=False) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="verify without changing files")
    mode.add_argument("--sync", action="store_true", help="synchronize declared delivery copies")
    mode.add_argument("--record-hashes", action="store_true", help="record intentionally changed source/export bytes")
    args = parser.parse_args()
    try:
        manifest = load_manifest()
        if args.sync:
            synchronize(manifest)
        elif args.record_hashes:
            record_hashes(manifest)
            manifest = load_manifest()
        errors = verify(manifest)
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        errors = [str(error)]
    if errors:
        print("media-assets: " + "\nmedia-assets: ".join(errors), file=sys.stderr)
        return 1
    action = "synchronized and checked" if args.sync else "recorded and checked" if args.record_hashes else "checked"
    print(f"media-assets: {action} {len(manifest['assets'])} masters and {len(manifest['socialExports'])} social exports")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

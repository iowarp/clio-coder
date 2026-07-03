"""Portable benchmark result manifest helpers."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

REPO_ROOT = Path(__file__).resolve().parents[2]


def utc_run_date() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def clio_version(clio_bin: str = "clio") -> str:
    env_version = os.environ.get("CLIO_VERSION")
    if env_version:
        return env_version
    try:
        proc = subprocess.run([clio_bin, "--version"], capture_output=True, text=True, timeout=5, check=False)
    except Exception:
        return "unknown"
    return (proc.stdout or proc.stderr or "unknown").strip().splitlines()[0] or "unknown"


def clio_commit(repo_root: Path = REPO_ROOT) -> str | None:
    env_commit = os.environ.get("CLIO_COMMIT")
    if env_commit:
        return env_commit
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--short=12", "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except Exception:
        return None
    value = proc.stdout.strip()
    return value or None


def target_profile(**values: str | None) -> dict[str, str]:
    return {key: value for key, value in values.items() if value}


def artifact_hashes(paths: Iterable[Path], root: Path) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for path in paths:
        if not path.exists() or not path.is_file():
            continue
        try:
            key = path.resolve().relative_to(root.resolve()).as_posix()
        except ValueError:
            key = path.name
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        hashes[key] = digest
    return dict(sorted(hashes.items()))


def write_result_manifest(
    out_dir: Path,
    *,
    suite: str,
    dataset: str,
    dataset_split: str,
    model: str,
    profile: dict[str, Any],
    instances: int,
    resolved: int,
    errors: int,
    artifact_paths: Iterable[Path],
    summary: dict[str, Any],
    notes: list[str] | None = None,
    clio_bin: str = "clio",
) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "suite": suite,
        "dataset": dataset,
        "datasetSplit": dataset_split,
        "clioVersion": clio_version(clio_bin),
        "clioCommit": clio_commit(),
        "runDate": utc_run_date(),
        "model": model,
        "targetProfile": profile,
        "instances": int(instances),
        "resolved": int(resolved),
        "errors": int(errors),
        "artifactHashes": artifact_hashes(artifact_paths, out_dir),
        "notes": notes or [],
    }
    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest_path, summary_path

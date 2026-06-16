#!/usr/bin/env python3
"""Recompute clean predictions.jsonl from existing checkouts.

The first generation run captured polluted diffs (git add -A staged .clio/ and artifacts).
This rebuilds model_patch as a source-only diff vs swebench_base, excluding Clio's .clio/
index, without re-running the fleet. Reads checkouts under <out>/checkouts/<instance_id>.
"""
import json
import subprocess
import sys
from pathlib import Path


def sh(cmd, cwd=None):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)


def clean_diff(co: Path) -> str:
    sh(["git", "reset", "-q"], cwd=co)
    r = sh(["git", "diff", "swebench_base", "--", ".", ":(exclude).clio", ":(exclude).clio/**"], cwd=co)
    return r.stdout


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "runs/calib")
    model_name = sys.argv[2] if len(sys.argv) > 2 else "clio-coder-qwopus3.6-27b"
    checkouts = sorted((out / "checkouts").iterdir())
    preds = out / "predictions.jsonl"
    with open(preds, "w") as pf:
        for co in checkouts:
            iid = co.name
            patch = clean_diff(co)
            pf.write(json.dumps({
                "instance_id": iid,
                "model_name_or_path": model_name,
                "model_patch": patch,
            }) + "\n")
            files = [l for l in patch.splitlines() if l.startswith("diff --git")]
            print(f"{iid:34s} patch_bytes={len(patch):6d} files={len(files)} empty={not patch.strip()}")
    print(f"wrote {preds}")


if __name__ == "__main__":
    main()

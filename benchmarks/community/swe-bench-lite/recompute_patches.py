#!/usr/bin/env -S uv run --no-project python
"""Recompute clean predictions.jsonl from existing checkouts.

The first generation run captured polluted diffs (git add -A staged .clio/ and artifacts).
This rebuilds model_patch as a source-only diff vs swebench_base, excluding Clio's .clio/
index, without re-running the fleet. Reads checkouts under <out>/checkouts/<instance_id>.
"""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from result_manifest import target_profile, write_result_manifest

DATASET = "princeton-nlp/SWE-bench_Lite"


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
    rows = []
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
            rows.append({"instance_id": iid, "patch_bytes": len(patch), "files": len(files), "empty_patch": not patch.strip()})
            print(f"{iid:34s} patch_bytes={len(patch):6d} files={len(files)} empty={not patch.strip()}")
    resolved = sum(1 for row in rows if not row["empty_patch"])
    manifest, summary = write_result_manifest(
        out,
        suite="swe-bench-lite",
        dataset=DATASET,
        dataset_split="test",
        model=model_name,
        profile=target_profile(model=model_name),
        instances=len(rows),
        resolved=resolved,
        errors=0,
        artifact_paths=[preds],
        summary={
            "suite": "swe-bench-lite",
            "dataset": DATASET,
            "datasetSplit": "test",
            "instances": len(rows),
            "resolved": resolved,
            "errors": 0,
            "emptyPatches": sum(1 for row in rows if row["empty_patch"]),
            "patchBytes": sum(int(row["patch_bytes"]) for row in rows),
        },
        notes=[
            "Resolved counts reflect non-empty recomputed patches. Official SWE-bench resolution requires external harness scoring."
        ],
    )
    print(f"wrote {preds}")
    print(f"wrote {manifest}")
    print(f"wrote {summary}")


if __name__ == "__main__":
    main()

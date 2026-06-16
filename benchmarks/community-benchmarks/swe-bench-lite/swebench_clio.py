#!/usr/bin/env python3
"""SWE-bench Lite adapter for Clio Coder.

Per instance:
  1. Clone {repo}@{base_commit} into an isolated checkout (bare-repo cache + local clone).
  2. Run `clio run --json "<issue>"` headless in the checkout, driving the configured fleet.
  3. `git diff` the working tree against base_commit -> model_patch.
  4. Append {instance_id, model_name_or_path, model_patch} to predictions.jsonl,
     and a richer row (wall_s, tokens, exit, timed_out) to metrics.jsonl.

Generation runs on the host against the local fleet. Evaluation is separate
(swebench.harness.run_evaluation or sb-cli) and needs Docker.

Usage:
  python swebench_clio.py --instances pytest-dev__pytest-6116 --out runs/smoke
  python swebench_clio.py --limit 3 --smallest --out runs/smoke
  python swebench_clio.py --all --out runs/full      # gated: 300 instances
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

DATASET = "princeton-nlp/SWE-bench_Lite"
CLIO = os.environ.get("CLIO_BIN", "clio")
DEFAULT_MODEL_NAME = os.environ.get("CLIO_PRED_MODEL", "clio-coder-qwopus3.6-27b")

TASK_TEMPLATE = """You are resolving a GitHub issue in the {repo} repository (checked out at commit {base_commit}).

Fix the issue by editing the repository's NON-TEST source files only. Do not modify, add, or
delete test files; the evaluation harness supplies its own tests. Make the smallest change that
correctly resolves the issue. Use the codewiki and code_nav to locate the relevant code before
editing. When the fix is complete, stop.

--- ISSUE ---
{problem_statement}
"""


def sh(cmd, cwd=None, timeout=None, check=False):
    return subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=check
    )


def clone_instance(repo: str, base_commit: str, dest: Path, cache_dir: Path) -> None:
    cache = cache_dir / (repo.replace("/", "__") + ".git")
    if not cache.exists():
        url = f"https://github.com/{repo}.git"
        # Full bare mirror (no blob filter) so offline local clones can materialize the
        # working tree at any historical commit. Cached once per repo.
        r = sh(["git", "clone", "--bare", url, str(cache)])
        if r.returncode != 0:
            raise RuntimeError(f"clone --bare failed for {repo}: {r.stderr[-400:]}")
    if dest.exists():
        shutil.rmtree(dest)
    r = sh(["git", "clone", "--no-checkout", str(cache), str(dest)])
    if r.returncode != 0:
        raise RuntimeError(f"local clone failed: {r.stderr[-400:]}")
    r = sh(["git", "-C", str(dest), "checkout", base_commit])
    if r.returncode != 0:
        # fetch the commit directly into the working clone, then check out
        sh(["git", "-C", str(dest), "fetch", "origin", base_commit])
        r = sh(["git", "-C", str(dest), "checkout", base_commit])
        if r.returncode != 0:
            raise RuntimeError(f"checkout {base_commit} failed: {r.stderr[-400:]}")
    # baseline tag so `git diff base` is unambiguous even if the agent commits
    sh(["git", "-C", str(dest), "tag", "-f", "swebench_base", base_commit])


def run_clio(checkout: Path, task: str, events_path: Path, timeout_s: int, target, model):
    cmd = [CLIO, "run", "--json"]
    if target:
        cmd += ["--target", target]
    if model:
        cmd += ["--model", model]
    cmd += [task]
    env = {**os.environ, "CLIO_NO_UPDATE_NOTIFIER": "1"}
    t0 = time.time()
    timed_out = False
    with open(events_path, "w") as ef:
        try:
            proc = subprocess.run(
                cmd, cwd=str(checkout), env=env, stdout=ef,
                stderr=subprocess.PIPE, text=True, timeout=timeout_s,
            )
            code = proc.returncode
        except subprocess.TimeoutExpired:
            code, timed_out = 124, True
    return time.time() - t0, code, timed_out


def diff_against_base(checkout: Path) -> str:
    # The model_patch must be the agent's SOURCE edits only. Two sources of noise are
    # excluded: untracked build/test artifacts (git diff <commit> already ignores untracked
    # files), and Clio's own `.clio/` index (codewiki.json is ~100k lines). Unstage first so
    # any earlier staging does not leak in, then diff the working tree against base with
    # `.clio` excluded.
    sh(["git", "-C", str(checkout), "reset", "-q"])
    r = sh([
        "git", "-C", str(checkout), "diff", "swebench_base", "--",
        ".", ":(exclude).clio", ":(exclude).clio/**",
    ])
    return r.stdout


def tokens_from_events(events_path: Path):
    total, run_id = 0, None
    try:
        for line in open(events_path):
            try:
                e = json.loads(line)
            except Exception:
                continue
            if run_id is None:
                run_id = (e.get("session") or {}).get("runId") or e.get("runId")
            msg = e.get("message") or {}
            usage = msg.get("usage") or {}
            total = max(total, int(usage.get("totalTokens") or 0))
    except FileNotFoundError:
        pass
    return total, run_id


def tokens_from_receipt(run_id):
    if not run_id:
        return None
    p = Path.home() / ".local/state/clio/receipts" / f"{run_id}.json"
    if not p.exists():
        return None
    try:
        r = json.load(open(p))
    except Exception:
        return None
    for path in (("usage", "totalTokens"), ("tokens",), ("usage", "total")):
        cur = r
        for k in path:
            cur = cur.get(k) if isinstance(cur, dict) else None
        if isinstance(cur, (int, float)) and cur:
            return int(cur)
    return None


def generate_one(inst, workdir: Path, cache_dir: Path, model_name, timeout_s, target, model):
    iid = inst["instance_id"]
    checkout = workdir / "checkouts" / iid
    events_path = workdir / "events" / f"{iid}.jsonl"
    events_path.parent.mkdir(parents=True, exist_ok=True)
    (workdir / "checkouts").mkdir(parents=True, exist_ok=True)
    clone_instance(inst["repo"], inst["base_commit"], checkout, cache_dir)
    task = TASK_TEMPLATE.format(
        repo=inst["repo"], base_commit=inst["base_commit"],
        problem_statement=inst["problem_statement"],
    )
    wall, code, timed_out = run_clio(checkout, task, events_path, timeout_s, target, model)
    patch = diff_against_base(checkout)
    stream_tokens, run_id = tokens_from_events(events_path)
    tokens = tokens_from_receipt(run_id) or stream_tokens or None
    pred = {"instance_id": iid, "model_name_or_path": model_name, "model_patch": patch}
    metric = {
        "instance_id": iid, "repo": inst["repo"], "wall_s": round(wall, 1),
        "tokens": tokens, "exit": code, "timed_out": timed_out,
        "patch_bytes": len(patch), "empty_patch": not patch.strip(), "run_id": run_id,
    }
    return pred, metric


def select_instances(ds, args):
    rows = list(ds)
    if args.instances:
        wanted = set(args.instances)
        return [r for r in rows if r["instance_id"] in wanted]
    if args.smallest:
        rows = sorted(rows, key=lambda r: len(r["patch"]))
    if args.repos:
        repos = set(args.repos)
        rows = [r for r in rows if r["repo"] in repos]
    if args.limit:
        rows = rows[: args.limit]
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="output dir for predictions/metrics/events")
    ap.add_argument("--instances", nargs="*", help="explicit instance_ids")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--repos", nargs="*", help="restrict to these repos")
    ap.add_argument("--smallest", action="store_true", help="prefer smallest gold patches")
    ap.add_argument("--all", action="store_true", help="run all 300 (gated)")
    ap.add_argument("--timeout", type=int, default=1800, help="per-instance clio wall cap (s)")
    ap.add_argument("--target", default=None, help="clio --target override")
    ap.add_argument("--model", default=None, help="clio --model override")
    ap.add_argument("--model-name", default=DEFAULT_MODEL_NAME, help="model_name_or_path in predictions")
    ap.add_argument(
        "--cache",
        default=os.environ.get("SWEBENCH_REPO_CACHE", str(Path.home() / ".cache/clio-community-bench/repos")),
        help="bare-repo cache dir shared across runs",
    )
    args = ap.parse_args()
    if not (args.instances or args.limit or args.all or args.repos):
        ap.error("select instances with --instances, --limit, --repos, or --all")

    from datasets import load_dataset

    ds = load_dataset(DATASET, split="test")
    chosen = select_instances(ds, args)
    if not chosen:
        print("no instances matched", file=sys.stderr)
        return 2

    workdir = Path(args.out)
    workdir.mkdir(parents=True, exist_ok=True)
    cache_dir = Path(args.cache)
    cache_dir.mkdir(parents=True, exist_ok=True)
    preds_path = workdir / "predictions.jsonl"
    metrics_path = workdir / "metrics.jsonl"
    print(f"generating {len(chosen)} prediction(s) -> {preds_path}", file=sys.stderr)

    with open(preds_path, "w") as pf, open(metrics_path, "w") as mf:
        for i, inst in enumerate(chosen, 1):
            iid = inst["instance_id"]
            print(f"[{i}/{len(chosen)}] {iid} ({inst['repo']}) ...", file=sys.stderr, flush=True)
            try:
                pred, metric = generate_one(
                    inst, workdir, cache_dir, args.model_name, args.timeout, args.target, args.model
                )
            except Exception as e:
                print(f"  ERROR {iid}: {e}", file=sys.stderr)
                pred = {"instance_id": iid, "model_name_or_path": args.model_name, "model_patch": ""}
                metric = {"instance_id": iid, "error": str(e)[:300]}
            pf.write(json.dumps(pred) + "\n"); pf.flush()
            mf.write(json.dumps(metric) + "\n"); mf.flush()
            print(f"  -> wall={metric.get('wall_s')}s tokens={metric.get('tokens')} "
                  f"patch_bytes={metric.get('patch_bytes')} empty={metric.get('empty_patch')}",
                  file=sys.stderr)
    print(f"done. predictions: {preds_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

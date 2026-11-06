#!/usr/bin/env python3
"""Plan a parameter sweep as a Slurm job array, then tabulate its results.

plan       Reads a sweep file, expands the grid or seeded sample, and writes the
           manifest, the batch script(s), one directory per run holding its
           params.json, and plan.json with the exact submission to make. It
           submits nothing and prints every generated script and the submission.
aggregate  Reads plan.json, each task's scheduler state (sacct, read-only),
           the verify claims recorded for the sweep's check
           (`clio-coder claims list --check <id> --json`), and each run's
           metrics file, and writes results.tsv and results.md beside the
           manifest. Every run gets a row; failed and unverified runs stay.

The sweep file is YAML when PyYAML is importable and JSON otherwise (JSON is
valid YAML, so one file serves both). Python 3.10+, stdlib only otherwise.

Exit codes: 0 done, 1 the sweep or its inputs are invalid, 2 usage error.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
import os
import random
import re
import shlex
import shutil
import subprocess
import sys
from datetime import datetime, timezone

PLAN_VERSION = 1
NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
PARAM = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
RESERVED = {"PATH", "HOME", "USER", "IFS", "PWD", "SHELL", "LANG", "TMPDIR", "LD_LIBRARY_PATH"}
TOKEN = re.compile(r"^[A-Za-z0-9._:-]+$")
MEMORY = re.compile(r"^\d+[KMGT]?$")
TIME = re.compile(r"^(\d+-)?\d{1,2}(:\d{2}){0,2}$")
MAX_RUNS = 10000
TERMINAL = {"COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL", "PREEMPTED", "BOOT_FAIL", "DEADLINE"}
SACCT_FORMAT = "JobID,JobName,Partition,Account,AllocCPUS,State,ExitCode,Start,End,Elapsed,MaxRSS,MaxVMSize"


class SweepError(Exception):
    pass


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_sweep(path: str) -> dict:
    text = open(path, encoding="utf-8").read()
    try:
        import yaml  # type: ignore[import-not-found]
    except ImportError:
        yaml = None
    try:
        data = yaml.safe_load(text) if yaml is not None else json.loads(text)
    except Exception as error:  # noqa: BLE001 - the parser's own message is the diagnostic
        reader = "YAML" if yaml is not None else "JSON (PyYAML is not installed, so the sweep file must be JSON)"
        raise SweepError(f"{path}: not valid {reader}: {error}") from error
    if not isinstance(data, dict):
        raise SweepError(f"{path}: the sweep file must be a mapping")
    return data


def project_path(root: str, value: object, field: str, must_exist: bool = False) -> str:
    """A project-relative path, normalized, that stays inside the project."""
    if not isinstance(value, str) or not value or "\0" in value or os.path.isabs(value):
        raise SweepError(f"{field} must be a non-empty project-relative path")
    normalized = os.path.normpath(value).replace(os.sep, "/")
    if normalized == ".." or normalized.startswith("../"):
        raise SweepError(f"{field} escapes the project: {value}")
    absolute = os.path.join(root, normalized)
    if os.path.realpath(absolute) != os.path.realpath(root) and not os.path.realpath(absolute).startswith(
        os.path.realpath(root) + os.sep
    ):
        raise SweepError(f"{field} resolves outside the project through a link: {value}")
    if must_exist and not os.path.isfile(absolute):
        raise SweepError(f"{field} is not a file: {value}")
    return normalized


def format_value(value: object, field: str) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise SweepError(f"{field}: {value} is not finite")
        return repr(value)
    if isinstance(value, str):
        if not value or any(ch in value for ch in "\t\n\r\0"):
            raise SweepError(f"{field}: values must be non-empty single-line text without tabs")
        return value
    raise SweepError(f"{field}: values must be numbers, booleans or text")


def validate(sweep: dict, root: str) -> dict:
    allowed = {"version", "name", "parameters", "mode", "sample", "template", "resources", "concurrency", "check", "metrics", "out", "submit"}
    unknown = sorted(set(sweep) - allowed)
    if unknown:
        raise SweepError(f"unknown field(s): {', '.join(unknown)}")
    if sweep.get("version") != 1:
        raise SweepError("version must be 1")
    name = sweep.get("name")
    if not isinstance(name, str) or not NAME.match(name):
        raise SweepError("name must match ^[a-z0-9][a-z0-9_-]{0,47}$")
    mode = sweep.get("mode", "grid")
    if mode not in ("grid", "sample"):
        raise SweepError("mode must be grid or sample")
    params = sweep.get("parameters")
    if not isinstance(params, dict) or not params:
        raise SweepError("parameters must be a non-empty mapping of name to values")
    for key, spec in params.items():
        if not isinstance(key, str) or not PARAM.match(key) or key in RESERVED or key.startswith(("SLURM_", "SWEEP_")):
            raise SweepError(f"parameter name '{key}' must be a shell identifier, not reserved, not SLURM_* or SWEEP_*")
        if isinstance(spec, list):
            if not spec:
                raise SweepError(f"parameters.{key} has no values")
            for index, value in enumerate(spec):
                format_value(value, f"parameters.{key}[{index}]")
        elif isinstance(spec, dict):
            if mode != "sample":
                raise SweepError(f"parameters.{key}: a range needs mode: sample; a grid takes lists")
            extra = sorted(set(spec) - {"low", "high", "log", "integer"})
            if extra:
                raise SweepError(f"parameters.{key} has unknown field(s): {', '.join(extra)}")
            low, high = spec.get("low"), spec.get("high")
            if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (low, high)) or low >= high:
                raise SweepError(f"parameters.{key} needs finite numbers low < high")
            if spec.get("log") and low <= 0:
                raise SweepError(f"parameters.{key}: a log range needs low > 0")
        else:
            raise SweepError(f"parameters.{key} must be a list of values or a {{low, high}} range")
    sample = sweep.get("sample")
    if mode == "sample":
        if not isinstance(sample, dict) or not isinstance(sample.get("count"), int) or sample["count"] < 1:
            raise SweepError("mode: sample needs sample.count, a positive integer")
        if not isinstance(sample.get("seed"), int):
            raise SweepError("mode: sample needs sample.seed, an integer, so the draw can be repeated")
    elif sample is not None:
        raise SweepError("sample belongs to mode: sample")
    submit = sweep.get("submit", "array")
    if submit not in ("array", "jobs"):
        raise SweepError("submit must be array or jobs")
    res = sweep.get("resources")
    if not isinstance(res, dict):
        raise SweepError("resources must be a mapping with at least cores")
    extra = sorted(set(res) - {"cores", "memory", "time_limit", "partition", "job_name", "directives"})
    if extra:
        raise SweepError(f"resources has unknown field(s): {', '.join(extra)}")
    if not isinstance(res.get("cores"), int) or res["cores"] < 1:
        raise SweepError("resources.cores must be a positive integer")
    if "memory" in res and not (isinstance(res["memory"], str) and MEMORY.match(res["memory"])):
        raise SweepError("resources.memory must look like 4G, 512M or 1024")
    if "time_limit" in res and not (isinstance(res["time_limit"], str) and TIME.match(res["time_limit"])):
        raise SweepError("resources.time_limit must be a Slurm time such as 00:30:00 or 1-00:00:00")
    for field in ("partition", "job_name"):
        if field in res and not (isinstance(res[field], str) and TOKEN.match(res[field])):
            raise SweepError(f"resources.{field} must be one token of letters, digits, '.', '_', ':', '-'")
    directives = res.get("directives", [])
    if not isinstance(directives, list) or not all(isinstance(d, str) and re.match(r"^--[a-z][a-z-]*(=\S+)?$", d) for d in directives):
        raise SweepError("resources.directives must be a list of sbatch long options such as --nodes=2")
    if directives and submit == "array":
        # The Slurm MCP server writes its own header in array mode and the script's directives never apply.
        raise SweepError("resources.directives apply only with submit: jobs; in array mode the server's header replaces them")
    concurrency = sweep.get("concurrency")
    if not isinstance(concurrency, int) or concurrency < 1:
        raise SweepError("concurrency must be a positive integer: the most runs in flight at once")
    check = sweep.get("check")
    if not isinstance(check, str) or not re.match(r"^[a-z0-9][a-z0-9._:-]*$", check):
        raise SweepError("check must name the .clio-coder/verifiers.yaml check that judges one run")
    template = project_path(root, sweep.get("template"), "template", must_exist=True)
    out = project_path(root, sweep.get("out", f"sweeps/{name}"), "out")
    metrics = sweep.get("metrics")
    if metrics is not None and (not isinstance(metrics, str) or "/" in metrics or metrics in ("", ".", "..")):
        raise SweepError("metrics must be a file name inside each run directory")
    return {
        "name": name,
        "mode": mode,
        "parameters": params,
        "sample": sample,
        "submit": submit,
        "resources": res,
        "concurrency": concurrency,
        "check": check,
        "template": template,
        "out": out,
        "metrics": metrics,
    }


def expand(spec: dict) -> list[dict[str, str]]:
    names = list(spec["parameters"])
    if spec["mode"] == "grid":
        columns = [[format_value(v, n) for v in spec["parameters"][n]] for n in names]
        rows = [dict(zip(names, combo)) for combo in itertools.product(*columns)]
    else:
        rng = random.Random(spec["sample"]["seed"])
        rows = []
        for _ in range(spec["sample"]["count"]):
            row = {}
            for name in names:
                p = spec["parameters"][name]
                if isinstance(p, list):
                    row[name] = format_value(rng.choice(p), name)
                    continue
                low, high = float(p["low"]), float(p["high"])
                value = math.exp(rng.uniform(math.log(low), math.log(high))) if p.get("log") else rng.uniform(low, high)
                row[name] = str(round(value)) if p.get("integer") else repr(value)
            rows.append(row)
    if len(rows) > MAX_RUNS:
        raise SweepError(f"the sweep expands to {len(rows)} runs, above the {MAX_RUNS}-run limit")
    return rows


def array_expression(count: int, concurrency: int) -> str:
    span = "0" if count == 1 else f"0-{count - 1}"
    return span if concurrency >= count else f"{span}%{concurrency}"


def run_body(spec: dict, root: str, sweep_sha: str, manifest_sha: str, task: str | None) -> list[str]:
    """The shell lines a task runs after any header: select its parameters, enter its run directory, run the template."""
    out = os.path.join(root, spec["out"])
    manifest = os.path.join(out, "manifest.tsv")
    runs = os.path.join(out, "runs")
    names = list(spec["parameters"])
    task_expr = task if task is not None else '"${SLURM_ARRAY_TASK_ID:?not an array task}"'
    lines = [
        f"# Generated by hpc-sweep for sweep '{spec['name']}'. Regenerate with sweep.py plan; do not edit.",
        f"# sweep file sha256 {sweep_sha}; manifest sha256 {manifest_sha}",
        "set -euo pipefail",
        f"SWEEP_TASK_ID={task_expr}",
        f"SWEEP_MANIFEST={shlex.quote(manifest)}",
        f'SWEEP_RUN_DIR={shlex.quote(runs)}/"$SWEEP_TASK_ID"',
        'SWEEP_PARAMS=$(sed -n "$((SWEEP_TASK_ID + 1))p" "$SWEEP_MANIFEST")',
        '[ -n "$SWEEP_PARAMS" ] || { echo "sweep: no manifest line for task $SWEEP_TASK_ID" >&2; exit 64; }',
        f"IFS=$'\\t' read -r {' '.join(names)} <<< \"$SWEEP_PARAMS\"",
        f"export SWEEP_TASK_ID SWEEP_RUN_DIR {' '.join(names)}",
        'mkdir -p "$SWEEP_RUN_DIR"',
        'cd "$SWEEP_RUN_DIR"',
        f"bash {shlex.quote(os.path.join(root, spec['template']))}",
    ]
    return lines


def write(path: str, text: str, mode: int | None = None) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(text)
    if mode is not None:
        os.chmod(tmp, mode)
    os.replace(tmp, path)


def cmd_plan(args: argparse.Namespace) -> int:
    root = os.path.realpath(args.root)
    sweep_file = os.path.realpath(args.sweep)
    spec = validate(load_sweep(sweep_file), root)
    rows = expand(spec)
    out = os.path.join(root, spec["out"])
    runs = os.path.join(out, "runs")
    # A rerun of plan must never hide results already on disk behind a fresh manifest.
    for index in range(len(rows)):
        existing = os.path.join(runs, str(index))
        if os.path.isdir(existing) and set(os.listdir(existing)) - {"params.json"}:
            raise SweepError(f"{os.path.relpath(existing, root)} already holds run output; choose another sweep name or out directory")
    names = list(spec["parameters"])
    manifest_text = "".join("\t".join(row[n] for n in names) + "\n" for row in rows)
    manifest_sha = hashlib.sha256(manifest_text.encode()).hexdigest()
    sweep_sha = sha256_file(sweep_file)
    template_sha = sha256_file(os.path.join(root, spec["template"]))
    write(os.path.join(out, "manifest.tsv"), manifest_text)
    for index, row in enumerate(rows):
        write(os.path.join(runs, str(index), "params.json"), json.dumps({"task": index, **row}, indent=1) + "\n")
    res = spec["resources"]
    base_args = {
        "cores": res["cores"],
        **({"memory": res["memory"]} if "memory" in res else {}),
        **({"time_limit": res["time_limit"]} if "time_limit" in res else {}),
        "job_name": res.get("job_name", f"sweep-{spec['name']}"),
        **({"partition": res["partition"]} if "partition" in res else {}),
    }
    scripts: list[str] = []
    if spec["submit"] == "array":
        script = os.path.join(out, "array.sh")
        write(script, "\n".join(["#!/bin/bash", *run_body(spec, root, sweep_sha, manifest_sha, None)]) + "\n", 0o755)
        scripts.append(script)
        submissions = [{"tool": "mcp_slurm__slurm_submit", "arguments": {"script_path": script, "array": array_expression(len(rows), spec["concurrency"]), **base_args}, "tasks": list(range(len(rows)))}]
    else:
        submissions = []
        for index in range(len(rows)):
            script = os.path.join(out, "jobs", f"task-{index}.sh")
            header = ["#!/bin/bash", *[f"#SBATCH {d}" for d in res.get("directives", [])]]
            write(script, "\n".join([*header, *run_body(spec, root, sweep_sha, manifest_sha, str(index))]) + "\n", 0o755)
            scripts.append(script)
            submissions.append({"tool": "mcp_slurm__slurm_submit", "arguments": {"script_path": script, **base_args, "job_name": f"{base_args['job_name']}-{index}"}, "tasks": [index]})
    plan = {
        "version": PLAN_VERSION,
        "name": spec["name"],
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "root": root,
        "sweep": {"path": os.path.relpath(sweep_file, root), "sha256": sweep_sha},
        "template": {"path": spec["template"], "sha256": template_sha},
        "manifest": {"path": os.path.join(spec["out"], "manifest.tsv"), "sha256": manifest_sha},
        "runs": os.path.join(spec["out"], "runs"),
        "parameters": names,
        "tasks": [{"task": i, "params": row} for i, row in enumerate(rows)],
        "submit": spec["submit"],
        "concurrency": spec["concurrency"],
        "submissions": submissions,
        "check": spec["check"],
        "metrics": spec["metrics"],
    }
    write(os.path.join(out, "plan.json"), json.dumps(plan, indent=1) + "\n")
    if args.json:
        print(json.dumps(plan, indent=1))
        return 0
    rel = lambda p: os.path.relpath(p, root)  # noqa: E731
    print(f"DRY RUN: sweep '{spec['name']}', {len(rows)} runs, {spec['mode']}; nothing was submitted.")
    print(f"sweep file {plan['sweep']['path']} sha256 {sweep_sha}")
    print(f"manifest {plan['manifest']['path']} sha256 {manifest_sha}")
    print(f"template {spec['template']} sha256 {template_sha}")
    print(f"run directories {plan['runs']}/<task>/ (params.json written for each)")
    print("")
    print("task\t" + "\t".join(names))
    for i, row in enumerate(rows):
        print(f"{i}\t" + "\t".join(row[n] for n in names))
    for script in scripts if args.all_scripts or len(scripts) <= 3 else scripts[:2]:
        print(f"\n--- {rel(script)} ---")
        print(open(script, encoding="utf-8").read().rstrip("\n"))
    if len(scripts) > 3 and not args.all_scripts:
        print(f"\n({len(scripts) - 2} more job scripts differ only in SWEEP_TASK_ID and job name; --all-scripts prints them)")
    print("\nSubmission it would make, through the Slurm MCP server:")
    for sub in submissions:
        print(f"  {sub['tool']}({json.dumps(sub['arguments'])})")
    if spec["submit"] == "array":
        print(f"  The array expression caps the sweep at {spec['concurrency']} running task(s) at once.")
    else:
        print(f"  Submit at most {spec['concurrency']} of these at a time; send the next only when one is terminal.")
    print(f"\nPer-run check: verify(check=\"{spec['check']}/<task>\") for each finished run; the check must declare runs: {plan['runs']}")
    print(f"plan written to {rel(os.path.join(out, 'plan.json'))}")
    return 0


def sacct_states(job_ids: list[str]) -> dict[str, tuple[str, str]]:
    if shutil.which("sacct") is None:
        return {}
    states: dict[str, tuple[str, str]] = {}
    for job in job_ids:
        try:
            result = subprocess.run(["sacct", "-j", job, f"--format={SACCT_FORMAT}", "--parsable2", "--noheader"], capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode != 0:
            continue
        for line in result.stdout.splitlines():
            fields = line.split("|")
            if len(fields) >= 7 and "." not in fields[0]:
                states[fields[0]] = (fields[5].split(" ")[0], fields[6])
    return states


def claim_for(claims: list[dict], check: str, run_arg_candidates: set[str]) -> dict | None:
    chosen = None
    for claim in claims:
        keys = claim.get("keys") or {}
        command = keys.get("command") or []
        if keys.get("check") != check or not command:
            continue
        if os.path.normpath(str(command[-1])) not in run_arg_candidates:
            continue
        if chosen is None or str(claim.get("at", "")) >= str(chosen.get("at", "")):
            chosen = claim
    return chosen


def read_metrics(path: str) -> dict[str, str] | None:
    try:
        data = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    out: dict[str, str] = {}
    for key, value in data.items():
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            out[str(key)] = repr(value) if isinstance(value, float) else str(value)
        elif isinstance(value, list):
            out[str(key)] = f"[{len(value)} values]"
    return out


def cmd_aggregate(args: argparse.Namespace) -> int:
    plan_path = os.path.realpath(args.plan)
    plan = json.load(open(plan_path, encoding="utf-8"))
    if plan.get("version") != PLAN_VERSION:
        raise SweepError(f"{args.plan}: unsupported plan version {plan.get('version')}")
    root = plan["root"]
    out_dir = os.path.dirname(plan_path)
    # Job ids: one array id, or task=jobid pairs for submit: jobs.
    job_of: dict[int, str] = {}
    sacct_ids: list[str] = []
    for value in args.job:
        if "=" in value:
            task, job = value.split("=", 1)
            job_of[int(task)] = job
            sacct_ids.append(job)
        else:
            if plan["submit"] != "array":
                raise SweepError("submit: jobs takes --job <task>=<job id> for each task")
            for entry in plan["tasks"]:
                job_of[entry["task"]] = f"{value}_{entry['task']}"
            sacct_ids.append(value)
    states = sacct_states(sorted(set(sacct_ids)))
    for value in args.state:
        task, _, rest = value.partition("=")
        state, _, code = rest.partition(":")
        job = job_of.get(int(task))
        if job is None:
            raise SweepError(f"--state {value}: task {task} has no job id")
        states.setdefault(job, (state.upper(), f"{code or '?'}:0"))
    if args.claims == "-":
        claims_doc = json.load(sys.stdin)
    elif args.claims:
        claims_doc = json.load(open(args.claims, encoding="utf-8"))
    else:
        claims_doc = {"claims": []}
    claims = claims_doc.get("claims", []) if isinstance(claims_doc, dict) else []
    check_cwd = os.path.normpath(args.check_cwd)
    names = plan["parameters"]
    rows = []
    metric_keys: list[str] = []
    for entry in plan["tasks"]:
        task = entry["task"]
        run_rel = os.path.normpath(os.path.join(plan["runs"], str(task)))
        run_arg = os.path.normpath(os.path.relpath(run_rel, check_cwd)) if check_cwd != "." else run_rel
        job = job_of.get(task, "")
        state, exit_code = states.get(job, ("UNKNOWN", "")) if job else ("NOT SUBMITTED", "")
        claim = claim_for(claims, plan["check"], {run_arg})
        metrics = read_metrics(os.path.join(root, run_rel, plan["metrics"])) if plan.get("metrics") else None
        for key in metrics or {}:
            if key not in metric_keys:
                metric_keys.append(key)
        ran_ok = state == "COMPLETED" and exit_code.split(":")[0] == "0"
        if not ran_ok:
            verdict = "run failed" if state in TERMINAL else "not terminal" if state not in ("UNKNOWN", "NOT SUBMITTED") else state.lower()
        elif claim is None:
            verdict = "unverified"
        else:
            verdict = str(claim.get("verdict"))
        conditions = claim.get("conditions", {}) if claim else {}
        rows.append({
            "task": task,
            "params": entry["params"],
            "verdict": verdict,
            "job": job,
            "state": state,
            "exit": exit_code,
            "metrics": metrics,
            "claim": claim.get("id", "")[:12] if claim else "",
            "rule": conditions.get("rule", "") if claim else "",
            "commit": (conditions.get("commit") or "")[:12] if claim else "",
        })
    # A metric that repeats a parameter's name is labelled apart, so a column never names two things.
    metric_labels = [f"metric.{k}" if k in names else k for k in metric_keys]
    header = ["task", *names, "verdict", "job", "state", "exit", *metric_labels, "tolerance", "commit", "claim"]
    def cells(row: dict) -> list[str]:
        metrics = row["metrics"]
        return [
            str(row["task"]),
            *[row["params"][n] for n in names],
            row["verdict"],
            row["job"] or "-",
            row["state"],
            row["exit"] or "-",
            *[(metrics or {}).get(k, "-") if metrics is not None else "missing" for k in metric_keys],
            row["rule"] or "-",
            row["commit"] or "-",
            row["claim"] or "-",
        ]
    tally: dict[str, int] = {}
    for row in rows:
        tally[row["verdict"]] = tally.get(row["verdict"], 0) + 1
    tally_line = ", ".join(f"{count} {verdict}" for verdict, count in sorted(tally.items()))
    write(os.path.join(out_dir, "results.tsv"), "\n".join("\t".join(c.replace("\t", " ") for c in r) for r in [header, *map(cells, rows)]) + "\n")
    md = [
        f"# Sweep {plan['name']}",
        "",
        f"- sweep file `{plan['sweep']['path']}` sha256 `{plan['sweep']['sha256']}`",
        f"- manifest `{plan['manifest']['path']}` sha256 `{plan['manifest']['sha256']}`",
        f"- template `{plan['template']['path']}` sha256 `{plan['template']['sha256']}`",
        f"- submissions: " + "; ".join(json.dumps(s["arguments"]) for s in plan["submissions"]),
        f"- per-run check `{plan['check']}`; verdicts are agreement within the check's declared tolerance, not truth",
        f"- tabulated {datetime.now(timezone.utc).isoformat(timespec='seconds')}: {tally_line}",
        "",
        "| " + " | ".join(header) + " |",
        "|" + "|".join("---" for _ in header) + "|",
        *("| " + " | ".join(c.replace("|", "\\|") for c in cells(r)) + " |" for r in rows),
        "",
    ]
    write(os.path.join(out_dir, "results.md"), "\n".join(md))
    print("\n".join(md))
    print(f"wrote {os.path.relpath(os.path.join(out_dir, 'results.tsv'), root)} and {os.path.relpath(os.path.join(out_dir, 'results.md'), root)}")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan", help="expand the sweep and write the manifest, scripts and plan; submits nothing")
    plan.add_argument("sweep")
    plan.add_argument("--root", default=".", help="project root the sweep's paths are relative to (default: .)")
    plan.add_argument("--json", action="store_true", help="print plan.json instead of the dry-run text")
    plan.add_argument("--all-scripts", action="store_true", help="print every per-task script in submit: jobs mode")
    agg = sub.add_parser("aggregate", help="tabulate states, verdicts and metrics into results.tsv and results.md")
    agg.add_argument("plan", help="the plan.json that plan wrote")
    agg.add_argument("--job", action="append", default=[], help="array job id, or <task>=<job id> for submit: jobs")
    agg.add_argument("--claims", help="file (or - for stdin) holding `clio-coder claims list --check <id> --json`")
    agg.add_argument("--state", action="append", default=[], help="<task>=<STATE>[:<exit>] where sacct is unavailable")
    agg.add_argument("--check-cwd", default=".", help="the check's declared cwd, when it is not the project root")
    args = parser.parse_args(argv)
    try:
        return cmd_plan(args) if args.command == "plan" else cmd_aggregate(args)
    except SweepError as error:
        print(f"sweep: {error}", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError) as error:
        print(f"sweep: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

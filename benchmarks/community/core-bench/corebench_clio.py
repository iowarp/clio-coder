#!/usr/bin/env -S uv run --no-project python
"""CORE-Bench adapter for Clio Coder.

CORE-Bench asks an agent to reproduce the published computational result of a
real paper. Each task is a Code Ocean capsule holding the paper's code and
data. The agent has to get the code running and report the numbers the paper
reported, into `report.json`. That is close to a restatement of what Clio is
for, which is why it is here.

Three difficulty levels, mirroring upstream's capsule preparation exactly:

- `easy`: the capsule's `results/` directory is left in place and the agent
  only reads it. No code is executed by the agent at all.
- `medium`: `results/` is emptied; `REPRODUCING.md` and the `environment/`
  directory stay, so the agent follows written reproduction instructions.
- `hard`: `results/` is emptied and `REPRODUCING.md`, `environment/`, and the
  capsule's run scripts are removed, so the agent has to work out the
  environment and the commands from the README.

Grading reimplements upstream's `eval_result_json` exactly. A numeric answer is
correct when it falls inside the 95% prediction interval computed from the gold
runs, which is how the benchmark absorbs the run-to-run variance of real
scientific code. List answers compare exactly and string answers compare
case-insensitively. A task is resolved only when every question is right.

Upstream isolates each agent run in a Docker container. This adapter runs Clio
in a prepared workspace on the host, because that is what the rest of this tree
does and because Clio's own tool policy is part of what is being measured. At
`medium` and `hard` the agent is expected to install software and run the
paper's code. Run those levels inside a container.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import time
import urllib.request
from collections.abc import Iterable
from pathlib import Path, PurePosixPath
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
ADAPTER_DIR = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = Path(os.environ.get("CORE_BENCH_DATA_DIR", ADAPTER_DIR / "data"))
DATASET = "siegelz/core-bench"
HF_BASE = "https://huggingface.co/datasets/siegelz/core-bench/resolve/main"
CAPSULE_BASE = "https://corebench.cs.princeton.edu/capsules"
GPG_PASSPHRASE = os.environ.get("CORE_BENCH_GPG_PASSPHRASE", "reproducibility")
CLIO = os.environ.get("CLIO_CODER_BIN", "clio-coder")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from clio_process import run_json_command
from clio_usage import fold_message_end_usage, receipt_total_tokens, run_id_from_events
from result_manifest import target_profile, write_result_manifest
from uv_command import uv_python_cmd

SPLITS = ("train", "test")
LEVELS = ("easy", "medium", "hard")
GRADER_PACKAGES = ("numpy", "scipy")
REGISTRY_RE = re.compile(r"`(registry\.codeocean\.com/published/[\w-]+:v\d+)`")

# Upstream's prompt templates, kept verbatim so a score means the same thing.
PROMPT_TEMPLATES = {
    "easy": (
        "Your goal is to answer questions about the output of scientific code. You should read through "
        "the files in the `results` directory to answer the following questions: {json_fields}. Save your "
        "answers to a file named report.json in the environment directory you started in that contains the "
        "capsule directory itself whose keys are the questions and values are the answers. **You should not "
        "actually run or execute any code.** All answers can be obtained by reading through the results directory."
    ),
    "medium": (
        "Your goal is to test the computational reproducibility of the repository cloned to your current "
        "directory, which is code from a scientific paper. Specifically, you need to {task_prompt}. Save your "
        "report to a file named report.json in the environment directory you started in that contains the "
        "capsule itself, where you fill in all of the following fields: {json_fields}. You should read the "
        "instructions on how to reproduce the capsule in REPRODUCING.md."
    ),
    "hard": (
        "Your goal is to test the computational reproducibility of the repository cloned to your current "
        "directory, which is code from a scientific paper. Specifically, you need to {task_prompt}. Save your "
        "report to a file named report.json in the environment directory you started in that contains the "
        "capsule itself, where you fill in all of the following fields: {json_fields}. You should install all "
        "of the requirements found in the Readme file and then run the commands necessary to answer the questions."
    ),
}

# Dedent before interpolating any task values. A multi-line capsule title would
# otherwise erase the f-string's common indentation and shift the whole header.
PROMPT_HEADER_TEMPLATE = textwrap.dedent(
    """\
    You are working on CORE-Bench task {capsule_id} at difficulty
    `{level}`: {capsule_title}.

    The capsule directory is in your working directory. Write `report.json`
    beside it, not inside it.

    """
)

# The scorer is upstream's eval_result_json, run in its own interpreter so the
# adapter itself needs nothing beyond the standard library.
SCORER_PROGRAM = textwrap.dedent(
    """\
    import json
    import math
    import sys

    import numpy as np
    from scipy.stats import t

    payload = json.load(open(sys.argv[1], encoding="utf-8"))
    gt_result = payload["gold"]
    reported_result = dict(payload["reported"])

    numeric_keys = [key for key in gt_result[0] if isinstance(gt_result[0][key], (int, float))]
    list_keys = [key for key in gt_result[0] if isinstance(gt_result[0][key], list)]
    string_keys = [key for key in gt_result[0] if isinstance(gt_result[0][key], str)]

    written_keys = [key for key in numeric_keys + list_keys + string_keys if "fig" not in key]
    vision_keys = [key for key in numeric_keys + list_keys + string_keys if "fig" in key]

    correct_written = 0
    correct_vision = 0
    detail = {}

    for key in list(reported_result):
        try:
            value = reported_result[key]
            if isinstance(value, str) and "%" in value:
                value = value.replace("%", "")
            reported_result[key] = float(value)
        except (TypeError, ValueError):
            pass

    sample_size = len(gt_result)
    bounds = {}
    if sample_size > 1:
        t_value = float(t.ppf(0.975, sample_size - 1))
        for key in numeric_keys:
            values = [row[key] for row in gt_result]
            mean = float(np.mean(values))
            spread = float(np.std(values, ddof=1))
            margin = t_value * spread * math.sqrt(1 + 1 / sample_size)
            bounds[key] = (mean - margin, mean + margin)
    else:
        for key in numeric_keys:
            value = float(gt_result[0][key])
            bounds[key] = (value, value)

    for key in reported_result:
        hit = False
        if key in numeric_keys:
            low, high = bounds[key]
            hit = isinstance(reported_result[key], float) and low <= reported_result[key] <= high
        elif key in list_keys:
            hit = reported_result[key] == gt_result[0][key]
        elif key in string_keys:
            hit = str(reported_result[key]).lower() == str(gt_result[0][key]).lower()
        hit = bool(hit)
        detail[key] = hit
        if hit:
            if "fig" in key:
                correct_vision += 1
            else:
                correct_written += 1

    print(
        json.dumps(
            {
                "correctWrittenAnswers": correct_written,
                "correctVisionAnswers": correct_vision,
                "totalWrittenQuestions": len(written_keys),
                "totalVisionQuestions": len(vision_keys),
                "perQuestion": detail,
                "numericBounds": {key: list(value) for key, value in bounds.items()},
            }
        )
    )
    """
)


class DataBlocked(RuntimeError):
    """Raised when the adapter is wired but required public data is absent."""


def corebench_model(model: str | None) -> str:
    return (
        model
        or os.environ.get("CLIO_CODER_PRED_MODEL")
        or os.environ.get("CLIO_CODER_MODEL")
        or os.environ.get("CLIO_CODER_MAIN_MODEL")
        or "unspecified"
    )


def corebench_target_profile(target: str | None, model: str | None) -> dict[str, str]:
    return target_profile(
        target=target,
        model=model or os.environ.get("CLIO_CODER_MAIN_MODEL"),
        thinking=os.environ.get("CLIO_CODER_MAIN_THINKING"),
    )


def explicit_target(value: str) -> str:
    target = value.strip()
    if not target:
        raise argparse.ArgumentTypeError("target id must not be empty")
    return target


def task_id_of(task: dict[str, Any]) -> str:
    return f"CORE-Bench/{task.get('capsule_id')}"


def normalize_task_id(task_id: str) -> str:
    value = str(task_id).strip()
    if value.startswith("CORE-Bench/"):
        return value
    return f"CORE-Bench/{value}"


def task_slug(task_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", task_id)


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                rows.append(json.loads(stripped))
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_no}: invalid JSONL: {exc}") from exc
    return rows


def dataset_path(data_dir: Path, split: str) -> Path:
    return data_dir / f"core_{split}.json"


def capsule_archive(data_dir: Path, capsule_id: str) -> Path:
    return data_dir / "capsules" / f"{capsule_id}.tar.gz"


def load_tasks(data_dir: Path, split: str) -> tuple[dict[str, dict[str, Any]], str]:
    path = dataset_path(data_dir, split)
    if not path.exists():
        hint = "" if split == "train" else " The test split is GPG-encrypted upstream; `ensure-data` decrypts it."
        raise DataBlocked(f"CORE-Bench data not found: {path}. Run `ensure-data --split {split}` first.{hint}")
    rows = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(rows, list) or not rows:
        raise DataBlocked(f"CORE-Bench data is empty or malformed: {path}")
    return {task_id_of(row): row for row in rows}, str(path)


def question_keys(task: dict[str, Any]) -> list[str]:
    results = task.get("results")
    if isinstance(results, list) and results and isinstance(results[0], dict):
        return list(results[0].keys())
    return []


def public_task(task: dict[str, Any]) -> dict[str, Any]:
    """The part of a task that may be written into a run directory.

    `results` holds the gold answers, so it stays out of the agent's workspace.
    The question keys do not: the agent is told which fields to fill in, which
    is exactly what upstream's prompt does.
    """
    return {
        "task_id": task_id_of(task),
        "capsule_id": task.get("capsule_id"),
        "capsule_title": task.get("capsule_title"),
        "capsule_doi": task.get("capsule_doi"),
        "field": task.get("field"),
        "language": task.get("language"),
        "task_prompt": task.get("task_prompt"),
        "report_fields": question_keys(task),
    }


def selected_tasks(
    tasks: dict[str, dict[str, Any]],
    task_ids: list[str],
    fields: list[str],
    languages: list[str],
    limit: int,
    offset: int,
) -> list[dict[str, Any]]:
    if task_ids:
        selected = []
        for raw in task_ids:
            task_id = normalize_task_id(raw)
            if task_id not in tasks:
                raise KeyError(f"task id not found: {task_id}")
            selected.append(tasks[task_id])
        return selected
    ordered = sorted(tasks.values(), key=lambda task: str(task.get("capsule_id")))
    if fields:
        wanted = {name.strip().lower() for name in fields if name.strip()}
        ordered = [task for task in ordered if str(task.get("field", "")).lower() in wanted]
    if languages:
        wanted = {name.strip().lower() for name in languages if name.strip()}
        ordered = [task for task in ordered if str(task.get("language", "")).lower() in wanted]
    if offset:
        ordered = ordered[offset:]
    return ordered[:limit] if limit > 0 else ordered


def decrypt_test_split(encrypted: Path, out: Path, timeout: int) -> None:
    if shutil.which("gpg") is None:
        raise DataBlocked(
            "the CORE-Bench test split is GPG-encrypted upstream and `gpg` is not on PATH; "
            "install GnuPG or decrypt core_test.json.gpg yourself"
        )
    proc = subprocess.run(
        [
            "gpg",
            "--batch",
            "--yes",
            "--pinentry-mode",
            "loopback",
            "--passphrase",
            GPG_PASSPHRASE,
            "--output",
            str(out),
            "--decrypt",
            str(encrypted),
        ],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise DataBlocked(
            f"could not decrypt {encrypted}: {proc.stderr.strip()[-400:]}. "
            "Set CORE_BENCH_GPG_PASSPHRASE if upstream changed the passphrase."
        )


def ensure_data(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    data_dir.mkdir(parents=True, exist_ok=True)
    out = dataset_path(data_dir, args.split)
    if out.exists() and not args.force:
        print(f"CORE-Bench data already exists: {out}", file=sys.stderr)
        return 0
    if args.split == "train":
        url = f"{HF_BASE}/core_train.json"
        print(f"downloading {url} -> {out}", file=sys.stderr)
        with urllib.request.urlopen(url, timeout=args.timeout) as response:
            out.write_bytes(response.read())
    else:
        encrypted = data_dir / "core_test.json.gpg"
        if not encrypted.exists() or args.force:
            url = f"{HF_BASE}/core_test.json.gpg"
            print(f"downloading {url} -> {encrypted}", file=sys.stderr)
            with urllib.request.urlopen(url, timeout=args.timeout) as response:
                encrypted.write_bytes(response.read())
        print(f"decrypting {encrypted} -> {out}", file=sys.stderr)
        decrypt_test_split(encrypted, out, args.timeout)
    tasks, source = load_tasks(data_dir, args.split)
    print(json.dumps({"path": source, "split": args.split, "tasks": len(tasks)}, indent=2, sort_keys=True))
    return 0


def inspect_data(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    tasks, source = load_tasks(data_dir, args.split)
    ordered = sorted(tasks.values(), key=lambda task: str(task.get("capsule_id")))
    fields: dict[str, int] = {}
    languages: dict[str, int] = {}
    for task in ordered:
        key = str(task.get("field") or "unknown")
        fields[key] = fields.get(key, 0) + 1
        language = str(task.get("language") or "unknown")
        languages[language] = languages.get(language, 0) + 1
    cached = sorted(path.stem.removesuffix(".tar") for path in (data_dir / "capsules").glob("*.tar.gz"))
    payload = {
        "dataset": DATASET,
        "datasetSplit": args.split,
        "source": source,
        "tasks": len(ordered),
        "byField": dict(sorted(fields.items())),
        "byLanguage": dict(sorted(languages.items())),
        "questionsPerTask": {
            "min": min(len(question_keys(task)) for task in ordered),
            "max": max(len(question_keys(task)) for task in ordered),
        },
        "capsulesCached": len(cached),
        "gpgAvailable": shutil.which("gpg") is not None,
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def ensure_capsule(data_dir: Path, capsule_id: str, timeout: int) -> Path:
    archive = capsule_archive(data_dir, capsule_id)
    if archive.exists():
        return archive
    archive.parent.mkdir(parents=True, exist_ok=True)
    url = f"{CAPSULE_BASE}/{capsule_id}.tar.gz"
    print(f"downloading capsule {url}", file=sys.stderr)
    temporary = archive.with_suffix(archive.suffix + ".partial")
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response, temporary.open("wb") as out:
            shutil.copyfileobj(response, out, length=1024 * 1024)
    except Exception as exc:
        temporary.unlink(missing_ok=True)
        raise DataBlocked(f"could not download capsule {capsule_id}: {exc}") from exc
    temporary.replace(archive)
    print(f"  {archive.stat().st_size / 1048576:.1f} MB", file=sys.stderr)
    return archive


def extract_capsule(archive: Path, destination: Path) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        raise RuntimeError(f"capsule extraction destination is not empty: {destination}")
    destination_root = destination.resolve()
    with tarfile.open(archive, "r:gz") as tar:
        members = []
        for member in tar.getmembers():
            archive_path = PurePosixPath(member.name)
            target = destination.joinpath(*archive_path.parts).resolve()
            try:
                target.relative_to(destination_root)
                contained = True
            except ValueError:
                contained = False
            # The destination is empty, and only regular files/directories are
            # admitted. Rejecting links prevents a later member from traversing
            # an archive-created symlink even when its own lexical path is safe.
            safe_type = member.isdir() or member.isreg()
            if archive_path.is_absolute() or ".." in archive_path.parts or not contained or not safe_type:
                print(f"  skipping unsafe archive member: {member.name}", file=sys.stderr)
                continue
            members.append(member)
        tar.extractall(destination, members=members)
    roots = [child for child in destination.iterdir() if child.is_dir()]
    return roots[0] if len(roots) == 1 else destination


def prepare_capsule(capsule_dir: Path, level: str) -> None:
    """Strip the capsule down to the level's starting state.

    These are upstream's rules, verbatim. `easy` keeps the published results so
    the agent only reads them. Every other level empties `results/`, and every
    level except `medium` removes the written reproduction instructions, the
    prepared environment, and the run scripts.
    """
    if level != "easy":
        results_dir = capsule_dir / "results"
        if results_dir.exists():
            shutil.rmtree(results_dir)
        results_dir.mkdir(parents=True, exist_ok=True)
    if level != "medium":
        (capsule_dir / "REPRODUCING.md").unlink(missing_ok=True)
        environment_dir = capsule_dir / "environment"
        if environment_dir.exists():
            shutil.rmtree(environment_dir)
        (capsule_dir / "code" / "run.sh").unlink(missing_ok=True)
        (capsule_dir / "code" / "run").unlink(missing_ok=True)


def registry_link(capsule_dir: Path) -> str:
    reproducing = capsule_dir / "REPRODUCING.md"
    if not reproducing.exists():
        return ""
    match = REGISTRY_RE.search(reproducing.read_text(encoding="utf-8", errors="replace"))
    return match.group(1) if match else ""


def render_clio_prompt(task: dict[str, Any], level: str, link: str) -> str:
    template = PROMPT_TEMPLATES[level]
    body = (
        template.replace("{task_prompt}", str(task.get("task_prompt") or ""))
        .replace("{json_fields}", str(question_keys(task)))
        .replace("{registry_link}", link)
    )
    header = PROMPT_HEADER_TEMPLATE.format(
        capsule_id=task.get("capsule_id"),
        level=level,
        capsule_title=task.get("capsule_title"),
    )
    return header + body + "\n"


def run_clio(
    prompt: str,
    cwd: Path,
    events_path: Path,
    timeout: int,
    target: str,
    model: str | None,
) -> dict[str, Any]:
    cmd = [CLIO, "--no-context-files", "run", "--json", "--target", target]
    if model:
        cmd.extend(["--model", model])
    cmd.append(prompt)
    started = time.monotonic()
    code, timed_out, stderr = run_json_command(cmd, cwd=cwd, events_path=events_path, timeout=timeout)
    return {
        "exit": code,
        "timed_out": timed_out,
        "wall_s": round(time.monotonic() - started, 3),
        "stderr": stderr[-4000:],
        "events": str(events_path),
    }


def find_report(workspace: Path) -> Path | None:
    """The report the agent wrote, wherever it put it.

    The prompt asks for `report.json` beside the capsule. Agents that write it
    inside the capsule instead have still produced an answer, and refusing to
    read it would score a formatting slip as a reproduction failure. The
    location is recorded so a strict reading can still separate the two.
    """
    direct = workspace / "report.json"
    if direct.exists():
        return direct
    candidates = sorted(workspace.glob("*/report.json")) + sorted(workspace.glob("*/*/report.json"))
    return candidates[0] if candidates else None


def generated_artifacts(run_dir: Path, *extra: Path) -> list[Path]:
    candidates = [
        run_dir / "metrics.jsonl",
        run_dir / "results.jsonl",
        run_dir / "result.json",
        run_dir / "workspace" / "report.json",
        run_dir / "task-public.json",
        *extra,
    ]
    tasks_dir = run_dir / "tasks"
    if tasks_dir.exists():
        candidates.extend(sorted(tasks_dir.glob("**/workspace/report.json")))
        candidates.extend(sorted(tasks_dir.glob("**/result.json")))
    return [path for path in candidates if path.exists()]


def generate_attempt(
    task: dict[str, Any],
    data_dir: Path,
    run_dir: Path,
    level: str,
    timeout: int,
    download_timeout: int,
    target: str | None,
    model: str | None,
    *,
    force: bool = False,
    dry_run: bool = False,
) -> dict[str, Any]:
    if force and run_dir.exists():
        shutil.rmtree(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "events").mkdir(parents=True, exist_ok=True)
    workspace = run_dir / "workspace"
    capsule_id = str(task.get("capsule_id"))
    if not workspace.exists() or force:
        if workspace.exists():
            shutil.rmtree(workspace)
        archive = ensure_capsule(data_dir, capsule_id, download_timeout)
        capsule_dir = extract_capsule(archive, workspace)
        prepare_capsule(capsule_dir, level)
    else:
        capsule_dir = workspace / capsule_id
    link = registry_link(capsule_dir) if capsule_dir.exists() else ""
    prompt_text = render_clio_prompt(task, level, link)
    (run_dir / "prompt.md").write_text(prompt_text, encoding="utf-8")
    (workspace / "task.txt").write_text(prompt_text, encoding="utf-8")
    (run_dir / "task-public.json").write_text(
        json.dumps(public_task(task), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    metric: dict[str, Any]
    if dry_run:
        metric = {"exit": 0, "timed_out": False, "wall_s": 0.0, "dry_run": True, "events": None}
    else:
        metric = run_clio(
            prompt=prompt_text,
            cwd=workspace,
            events_path=run_dir / "events" / "clio.jsonl",
            timeout=timeout,
            target=target,
            model=model,
        )

    report_path = find_report(workspace)
    events_path = run_dir / "events" / "clio.jsonl"
    run_id = run_id_from_events(events_path)
    observed_usage = fold_message_end_usage(events_path)
    stream_tokens = None if observed_usage is None else observed_usage["totalTokens"]
    metric.update(
        {
            "task_id": task_id_of(task),
            "capsule_id": capsule_id,
            "level": level,
            "field": task.get("field"),
            "language": task.get("language"),
            "tokens": receipt_total_tokens(run_id) or stream_tokens,
            "tokens_measured": stream_tokens is not None,
            "run_id": run_id,
            "report_path": str(report_path.relative_to(run_dir)) if report_path else None,
            "report_beside_capsule": bool(report_path and report_path.parent == workspace),
            "missing_report": report_path is None,
        }
    )
    return metric


def read_report(run_dir: Path) -> tuple[dict[str, Any] | None, str]:
    report_path = find_report(run_dir / "workspace")
    if report_path is None:
        return None, "missing"
    try:
        payload = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return None, f"unreadable: {exc}"
    if not isinstance(payload, dict):
        return None, "report.json is not an object"
    return payload, str(report_path.name)


def score_report(task: dict[str, Any], reported: dict[str, Any], timeout: float) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="clio-corebench-") as tmp:
        tmp_dir = Path(tmp)
        payload_path = tmp_dir / "payload.json"
        payload_path.write_text(
            json.dumps({"gold": task.get("results") or [], "reported": reported}), encoding="utf-8"
        )
        program_path = tmp_dir / "score.py"
        program_path.write_text(SCORER_PROGRAM, encoding="utf-8")
        proc = subprocess.run(
            [*uv_python_cmd(GRADER_PACKAGES), str(program_path), str(payload_path)],
            cwd=tmp_dir,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    if proc.returncode != 0:
        raise RuntimeError(f"CORE-Bench scorer failed: {proc.stderr.strip()[-400:]}")
    return json.loads(proc.stdout.strip().splitlines()[-1])


def grade_attempt(task: dict[str, Any], run_dir: Path, timeout: float) -> dict[str, Any]:
    reported, source = read_report(run_dir)
    base = {
        "task_id": task_id_of(task),
        "capsule_id": task.get("capsule_id"),
        "field": task.get("field"),
        "evaluator": "core-bench.eval_result_json",
        "reportSource": source,
    }
    if reported is None:
        result = {
            **base,
            "passed": False,
            "status": "fail",
            "result": f"no usable report.json ({source})",
            "correctWrittenAnswers": 0,
            "correctVisionAnswers": 0,
            "totalWrittenQuestions": len([key for key in question_keys(task) if "fig" not in key]),
            "totalVisionQuestions": len([key for key in question_keys(task) if "fig" in key]),
        }
        (run_dir / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return result
    scored = score_report(task, reported, timeout)
    total = int(scored["totalWrittenQuestions"]) + int(scored["totalVisionQuestions"])
    correct = int(scored["correctWrittenAnswers"]) + int(scored["correctVisionAnswers"])
    passed = total > 0 and correct == total
    result = {
        **base,
        **scored,
        "passed": passed,
        "status": "pass" if passed else "fail",
        "result": "passed" if passed else f"{correct}/{total} questions correct",
        "questionsCorrect": correct,
        "questionsTotal": total,
    }
    (run_dir / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result


def suite_summary(
    chosen: list[dict[str, Any]],
    metrics_rows: list[dict[str, Any]],
    grade_rows: list[dict[str, Any]],
    split: str,
    level: str,
) -> dict[str, Any]:
    resolved = sum(1 for row in grade_rows if row.get("passed"))
    questions_correct = sum(int(row.get("questionsCorrect") or 0) for row in grade_rows)
    questions_total = sum(int(row.get("questionsTotal") or 0) for row in grade_rows)
    by_field: dict[str, dict[str, int]] = {}
    for task, row in zip(chosen, grade_rows, strict=False):
        bucket = by_field.setdefault(str(task.get("field") or "unknown"), {"tasks": 0, "resolved": 0})
        bucket["tasks"] += 1
        if row.get("passed"):
            bucket["resolved"] += 1
    generation_errors = sum(
        1
        for metric in metrics_rows
        if metric.get("error") or metric.get("timed_out") or metric.get("exit") not in (0, None)
    )
    measured_rows = [metric for metric in metrics_rows if metric.get("tokens")]
    return {
        "suite": "core-bench",
        "dataset": DATASET,
        "datasetSplit": split,
        "level": level,
        "tasks": len(chosen),
        "samples": len(metrics_rows),
        "resolved": resolved,
        # An error is the harness failing to obtain an answer, not a model
        # answering wrong. A missing report is a model failure and is counted
        # separately rather than folded in here.
        "errors": generation_errors,
        "failedTasks": len(chosen) - resolved,
        "missingReports": sum(1 for metric in metrics_rows if metric.get("missing_report")),
        "reportsInsideCapsule": sum(
            1 for metric in metrics_rows if metric.get("report_path") and not metric.get("report_beside_capsule")
        ),
        # The per-question rate is the more informative number on this suite:
        # a capsule with six questions can be almost reproduced and still score
        # zero at the task level.
        "questionsCorrect": questions_correct,
        "questionsTotal": questions_total,
        "questionAccuracy": round(questions_correct / questions_total, 6) if questions_total else None,
        "byField": dict(sorted(by_field.items())),
        "timedOut": sum(1 for metric in metrics_rows if metric.get("timed_out")),
        "wallSeconds": round(sum(float(metric.get("wall_s") or 0) for metric in metrics_rows), 3),
        # Counted only over the attempts that actually reported usage, and
        # reported next to that coverage: a suite total of 0 across unobserved
        # attempts would claim the work was free, so absence stays absent.
        "tokens": sum(int(metric.get("tokens") or 0) for metric in measured_rows) if measured_rows else None,
        "tokensMeasuredAttempts": len(measured_rows),
        "tokensTotalAttempts": len(metrics_rows),
        "scoringRule": (
            "CORE-Bench resolves a task only when every reported field is right. A numeric field is right when it "
            "falls inside the 95% prediction interval of the gold runs; lists compare exactly and strings compare "
            "case-insensitively."
        ),
    }


def recorded_provenance(out_dir: Path) -> tuple[str | None, dict[str, str] | None]:
    """The model and target profile an earlier manifest in this directory recorded.

    grade-task rewrites the directory run-task wrote, and the generation flags
    are not repeated on the verifier command line. Re-deriving them from the
    grader's own environment would rename the model that produced the answer,
    so the generation record wins whenever it exists.
    """
    manifest_path = out_dir / "manifest.json"
    if not manifest_path.exists():
        return None, None
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, None
    model = manifest.get("model")
    profile = manifest.get("targetProfile")
    return (
        model if isinstance(model, str) and model and model != "unspecified" else None,
        profile if isinstance(profile, dict) and profile else None,
    )


def write_suite_manifest(
    out_dir: Path,
    chosen: list[dict[str, Any]],
    summary: dict[str, Any],
    model: str | None,
    target: str | None,
    split: str,
    notes: list[str],
    *,
    inherit_provenance: bool = False,
) -> tuple[Path, Path]:
    recorded_model, recorded_profile = recorded_provenance(out_dir) if inherit_provenance else (None, None)
    return write_result_manifest(
        out_dir,
        suite="core-bench",
        dataset=DATASET,
        dataset_split=split,
        model=recorded_model or corebench_model(model),
        profile=recorded_profile or corebench_target_profile(target, model),
        instances=len(chosen),
        resolved=int(summary.get("resolved") or 0),
        errors=int(summary.get("errors") or 0),
        artifact_paths=generated_artifacts(out_dir),
        summary=summary,
        notes=notes,
        clio_bin=CLIO,
    )


def level_notes(level: str) -> list[str]:
    notes = [
        "Scoring reimplements upstream eval_result_json: numeric answers must fall inside the gold runs' 95% "
        "prediction interval, lists compare exactly, strings compare case-insensitively.",
        "A task is resolved only when every reported field is right; questionAccuracy is the per-question rate.",
        "Upstream isolates each run in Docker. This adapter runs Clio in a prepared workspace on the host.",
    ]
    if level == "easy":
        notes.append("At level easy the agent only reads the published results directory and executes nothing.")
    else:
        notes.append(f"At level {level} the agent installs software and runs the paper's code. Use a container.")
    return notes


def run_suite(args: argparse.Namespace) -> int:
    if not (args.task_id or args.limit or args.field or args.language or args.all):
        raise DataBlocked("select tasks with --task-id, --field, --language, --limit, or --all")
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    tasks, source = load_tasks(data_dir, args.split)
    chosen = selected_tasks(tasks, args.task_id, args.field, args.language, args.limit, args.offset)
    if not chosen:
        print("no CORE-Bench tasks matched", file=sys.stderr)
        return 2

    out_dir = Path(args.out)
    if out_dir.exists() and any(out_dir.iterdir()) and not args.force:
        raise FileExistsError(f"output directory is not empty: {out_dir}; pass --force to replace it")
    if args.force and out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = out_dir / "metrics.jsonl"
    results_path = out_dir / "results.jsonl"
    metrics_rows: list[dict[str, Any]] = []
    grade_rows: list[dict[str, Any]] = []

    print(f"running {len(chosen)} CORE-Bench task(s) at level {args.level} from {source} -> {out_dir}", file=sys.stderr)
    with metrics_path.open("w", encoding="utf-8") as metrics, results_path.open("w", encoding="utf-8") as results:
        for task_index, task in enumerate(chosen, 1):
            task_id = task_id_of(task)
            task_dir = out_dir / "tasks" / task_slug(task_id)
            print(f"[{task_index}/{len(chosen)}] {task_id} ({task.get('field')}) ...", file=sys.stderr, flush=True)
            try:
                metric = generate_attempt(
                    task,
                    data_dir,
                    task_dir,
                    args.level,
                    args.timeout,
                    args.download_timeout,
                    args.target,
                    args.model,
                    force=args.force,
                    dry_run=args.dry_run,
                )
                grade = grade_attempt(task, task_dir, args.grade_timeout)
            except DataBlocked:
                raise
            except Exception as exc:
                metric = {"task_id": task_id, "error": str(exc)[:400], "exit": None}
                grade = {"task_id": task_id, "passed": False, "status": "error", "result": str(exc)[:400]}
                if not args.continue_on_error:
                    raise
            metrics_rows.append(metric)
            grade_rows.append(grade)
            metrics.write(json.dumps(metric) + "\n")
            metrics.flush()
            results.write(json.dumps(grade) + "\n")
            results.flush()
            print(
                f"  -> exit={metric.get('exit')} pass={grade.get('passed')} "
                f"questions={grade.get('questionsCorrect')}/{grade.get('questionsTotal')} "
                f"tokens={metric.get('tokens')}",
                file=sys.stderr,
            )

    summary = suite_summary(chosen, metrics_rows, grade_rows, args.split, args.level)
    manifest_path, summary_path = write_suite_manifest(
        out_dir, chosen, summary, args.model, args.target, args.split, notes=level_notes(args.level)
    )
    print(f"manifest: {manifest_path}", file=sys.stderr)
    print(f"summary: {summary_path}", file=sys.stderr)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def regrade_suite(args: argparse.Namespace) -> int:
    """Rescore a finished run directory without calling a model again.

    Reproducing a capsule costs a long agent run and a large download, so a
    change to the scorer or to where a report is looked for had no way to be
    applied except by reproducing every capsule a second time. The reports are
    already on disk; this reads them, rescores them, and rewrites the same
    suite artifacts the run wrote.
    """
    out_dir = Path(args.out)
    metrics_path = out_dir / "metrics.jsonl"
    if not metrics_path.exists():
        raise DataBlocked(f"no generation record to regrade: {metrics_path}")
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    tasks, _ = load_tasks(data_dir, args.split)
    metrics_rows = read_jsonl(metrics_path)
    missing = [str(row.get("task_id")) for row in metrics_rows if str(row.get("task_id")) not in tasks]
    if missing:
        raise KeyError(f"task ids in {metrics_path} are not in the {args.split} split: {missing[:5]}")
    chosen = [tasks[str(row["task_id"])] for row in metrics_rows]
    level = str(metrics_rows[0].get("level") or args.level) if metrics_rows else args.level

    grade_rows: list[dict[str, Any]] = []
    print(f"regrading {len(metrics_rows)} attempt(s) in {out_dir}", file=sys.stderr)
    for index, (task, metric) in enumerate(zip(chosen, metrics_rows, strict=True), 1):
        task_dir = out_dir / "tasks" / task_slug(str(metric["task_id"]))
        if not task_dir.exists():
            raise DataBlocked(f"generated attempt directory missing: {task_dir}")
        report_path = find_report(task_dir / "workspace")
        # The metric row is the generation record, and these fields describe
        # the report rather than the run, so they follow the lookup that just
        # happened.
        metric["report_path"] = str(report_path.relative_to(task_dir)) if report_path else None
        metric["report_beside_capsule"] = bool(report_path and report_path.parent == task_dir / "workspace")
        metric["missing_report"] = report_path is None
        grade = grade_attempt(task, task_dir, args.grade_timeout)
        grade_rows.append(grade)
        print(f"[{index}/{len(metrics_rows)}] {metric['task_id']} pass={grade.get('passed')}", file=sys.stderr)

    write_jsonl(metrics_path, metrics_rows)
    write_jsonl(out_dir / "results.jsonl", grade_rows)
    summary = suite_summary(chosen, metrics_rows, grade_rows, args.split, level)
    manifest_path, summary_path = write_suite_manifest(
        out_dir,
        chosen,
        summary,
        args.model,
        args.target,
        args.split,
        notes=[*level_notes(level), "Rescored from the reports already in this directory; no model was called."],
        inherit_provenance=True,
    )
    print(f"manifest: {manifest_path}", file=sys.stderr)
    print(f"summary: {summary_path}", file=sys.stderr)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def run_task(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    tasks, _ = load_tasks(data_dir, args.split)
    task_id = normalize_task_id(args.task_id)
    if task_id not in tasks:
        raise KeyError(f"task id not found: {task_id}")
    run_dir = Path(args.out)
    if run_dir.exists() and any(run_dir.iterdir()) and not args.force:
        raise FileExistsError(f"output directory is not empty: {run_dir}; pass --force to replace it")
    metric = generate_attempt(
        tasks[task_id],
        data_dir,
        run_dir,
        args.level,
        args.timeout,
        args.download_timeout,
        args.target,
        args.model,
        force=args.force,
        dry_run=args.dry_run,
    )
    write_jsonl(run_dir / "metrics.jsonl", [metric])
    summary = {
        "suite": "core-bench",
        "dataset": DATASET,
        "datasetSplit": args.split,
        "level": args.level,
        "taskId": task_id,
        "generated": True,
        "resolved": 0,
        "errors": 1 if metric.get("timed_out") or metric.get("exit") not in (0, None) else 0,
        "missingReport": bool(metric.get("missing_report")),
        "reportPath": metric.get("report_path"),
        # Absent rather than zero when the attempt's run reported no usage.
        "tokens": metric.get("tokens"),
        "tokensMeasured": bool(metric.get("tokens_measured")),
    }
    write_suite_manifest(
        run_dir,
        [tasks[task_id]],
        summary,
        args.model,
        args.target,
        args.split,
        notes=["Generation-only manifest. grade-task rewrites this directory with scored results."],
    )
    print(json.dumps(metric, indent=2, sort_keys=True))
    return 0 if metric.get("exit") == 0 else 1


def grade_task(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    tasks, _ = load_tasks(data_dir, args.split)
    task_id = normalize_task_id(args.task_id)
    if task_id not in tasks:
        raise KeyError(f"task id not found: {task_id}")
    run_dir = Path(args.run)
    result = grade_attempt(tasks[task_id], run_dir, args.grade_timeout)
    write_jsonl(run_dir / "results.jsonl", [result])
    summary = {
        "suite": "core-bench",
        "dataset": DATASET,
        "datasetSplit": args.split,
        "taskId": task_id,
        "samples": 1,
        "resolved": 1 if result.get("passed") else 0,
        # A wrong reproduction is a model failure, not a harness error;
        # run-task already recorded the generation errors this directory saw.
        "errors": 0,
        "failedTasks": 0 if result.get("passed") else 1,
        "questionsCorrect": result.get("questionsCorrect"),
        "questionsTotal": result.get("questionsTotal"),
        "reportSource": result.get("reportSource"),
        "scoringRule": "CORE-Bench resolves a task only when every reported field is right.",
    }
    write_suite_manifest(
        run_dir,
        [tasks[task_id]],
        summary,
        None,
        None,
        args.split,
        notes=["Scored against the capsule's gold runs."],
        inherit_provenance=True,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result.get("passed") else 1


def add_data_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--data-dir", default=None, help=f"dataset and capsule cache; default: {DEFAULT_DATA_DIR}")
    parser.add_argument(
        "--split",
        default="test",
        choices=list(SPLITS),
        help="test is the 45-task scored split and is GPG-encrypted upstream; train is 45 public tasks",
    )


def add_level_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--level",
        default="hard",
        choices=list(LEVELS),
        help="easy reads the published results only; medium keeps REPRODUCING.md; hard removes both",
    )


def add_selection_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--task-id", action="append", default=[], help="task id such as CORE-Bench/capsule-7038571; repeatable")
    parser.add_argument("--field", action="append", default=[], help="scientific field, e.g. 'Computer Science'; repeatable")
    parser.add_argument("--language", action="append", default=[], help="capsule language, e.g. Python or R; repeatable")
    parser.add_argument("--limit", type=int, default=0, help="limit selected tasks")
    parser.add_argument("--offset", type=int, default=0, help="skip this many tasks before applying --limit")
    parser.add_argument("--all", action="store_true", help="run all selected/default tasks")


def add_clio_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--timeout", type=int, default=7200, help="per-task Clio wall-clock timeout in seconds")
    parser.add_argument("--download-timeout", type=int, default=1800, help="per-capsule download timeout in seconds")
    parser.add_argument(
        "--target",
        type=explicit_target,
        default=None,
        help="configured clio-coder target id (required unless --dry-run is used)",
    )
    parser.add_argument("--model", default=None, help="clio-coder --model override")
    parser.add_argument("--force", action="store_true", help="replace existing run directories and re-extract capsules")
    parser.add_argument("--dry-run", action="store_true", help="prepare the workspace and prompt without calling Clio")


def add_grade_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--grade-timeout", type=float, default=120.0, help="scorer subprocess timeout in seconds")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    ensure = sub.add_parser("ensure-data", help="download a split, decrypting the test split with gpg")
    add_data_args(ensure)
    ensure.add_argument("--force", action="store_true")
    ensure.add_argument("--timeout", type=int, default=300)
    ensure.set_defaults(func=ensure_data)

    inspect = sub.add_parser("inspect-data", help="summarize a split by field, language, and question count")
    add_data_args(inspect)
    inspect.set_defaults(func=inspect_data)

    run = sub.add_parser("run", help="run and grade selected CORE-Bench capsules")
    add_data_args(run)
    add_level_arg(run)
    add_selection_args(run)
    run.add_argument("--out", required=True)
    run.add_argument("--continue-on-error", action="store_true", help="keep running after adapter errors")
    add_clio_args(run)
    add_grade_args(run)
    run.set_defaults(func=run_suite)

    again = sub.add_parser("regrade", help="rescore an existing run directory without calling a model")
    add_data_args(again)
    add_level_arg(again)
    again.add_argument("--out", required=True, help="run directory a previous `run` produced")
    again.add_argument("--target", default=None, help="target recorded in the manifest when it records none")
    again.add_argument("--model", default=None, help="model recorded in the manifest when it records none")
    add_grade_args(again)
    again.set_defaults(func=regrade_suite)

    one = sub.add_parser("run-task", help="run Clio for one CORE-Bench capsule")
    add_data_args(one)
    add_level_arg(one)
    one.add_argument("--task-id", required=True)
    one.add_argument("--out", required=True)
    add_clio_args(one)
    one.set_defaults(func=run_task)

    grade = sub.add_parser("grade-task", help="grade one generated CORE-Bench task directory")
    add_data_args(grade)
    grade.add_argument("--task-id", required=True)
    grade.add_argument("--run", required=True)
    add_grade_args(grade)
    grade.set_defaults(func=grade_task)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command in {"run", "run-task"} and not args.dry_run and not args.target:
        parser.error(f"{args.command} requires an explicit --target (or use --dry-run to avoid calling Clio)")
    try:
        return args.func(args)
    except DataBlocked as exc:
        print(f"DATA_BLOCKED: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env -S uv run --no-project python
"""OpenAI HumanEval adapter for Clio Coder.

This adapter intentionally stays thin: it loads the public HumanEval dataset,
runs Clio once or more per task in isolated run directories, and grades the
resulting completions against the HumanEval tests. It can run directly or emit a
normal `clio eval` task file so the Clio eval harness is exercised too.

External data is not vendored. Use `ensure-data`, pass `--data` pointing at a
HumanEval.jsonl(.gz), or install OpenAI's `human-eval` package from
https://github.com/openai/human-eval.

WARNING: grading executes model-generated Python. Run in a sandbox/container for
untrusted models or prompts.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import urllib.request
from pathlib import Path
from typing import Any, Iterable

REPO_ROOT = Path(__file__).resolve().parents[3]
ADAPTER_DIR = Path(__file__).resolve().parent
DEFAULT_DATA = Path(os.environ.get("HUMANEVAL_DATA", ADAPTER_DIR / "data" / "HumanEval.jsonl.gz"))
DEFAULT_RUN_ROOT = ADAPTER_DIR / "runs" / "eval-tasks"
DATASET = "openai/human-eval"
DATASET_SPLIT = "test"
HUMANEVAL_URL = "https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz"
CLIO = os.environ.get("CLIO_BIN", "clio")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from result_manifest import target_profile, write_result_manifest
from uv_command import uv_python_cmd, uv_script_cmd

try:
    from clio_fleet import load_fleet

    _FLEET = load_fleet()
except Exception:
    _FLEET = None

PYTHON_BLOCK_RE = re.compile(r"```(?:python)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)


class DataBlocked(RuntimeError):
    """Raised when the adapter is wired but required public data is absent."""


def humaneval_model(model: str | None) -> str:
    return (
        model
        or os.environ.get("CLIO_PRED_MODEL")
        or os.environ.get("CLIO_MODEL")
        or os.environ.get("CLIO_MAIN_MODEL")
        or ((_FLEET or {}).get("predictionModelName") if isinstance(_FLEET, dict) else None)
        or "unspecified"
    )


def humaneval_target_profile(target: str | None, model: str | None) -> dict[str, str]:
    return target_profile(
        profile=(_FLEET or {}).get("profile") if isinstance(_FLEET, dict) else None,
        target=target or os.environ.get("CLIO_MAIN_TARGET"),
        model=model or os.environ.get("CLIO_MAIN_MODEL"),
        thinking=os.environ.get("CLIO_MAIN_THINKING"),
    )


def normalize_task_id(task_id: str) -> str:
    value = str(task_id).strip()
    if value.isdigit():
        return f"HumanEval/{value}"
    return value


def task_number(task_id: str) -> int:
    try:
        return int(str(task_id).split("/")[-1])
    except ValueError:
        return 10**9


def task_slug(task_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", task_id)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    opener = gzip.open if path.suffix == ".gz" else open
    rows: list[dict[str, Any]] = []
    with opener(path, "rt", encoding="utf-8") as handle:  # type: ignore[arg-type]
        for line_no, line in enumerate(handle, 1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                rows.append(json.loads(stripped))
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_no}: invalid JSONL: {exc}") from exc
    return rows


def load_problems(path: str | os.PathLike[str] | None = None) -> tuple[dict[str, dict[str, Any]], str, str]:
    """Load HumanEval problems from a local file or the official package."""
    if path:
        data_path = Path(path)
        if not data_path.exists():
            raise DataBlocked(f"HumanEval data not found: {data_path}")
        rows = read_jsonl(data_path)
        return {row["task_id"]: row for row in rows}, str(data_path), "jsonl"

    if DEFAULT_DATA.exists():
        rows = read_jsonl(DEFAULT_DATA)
        return {row["task_id"]: row for row in rows}, str(DEFAULT_DATA), "jsonl"

    try:
        from human_eval.data import read_problems as official_read_problems
    except Exception as exc:
        raise DataBlocked(
            "HumanEval data is not available. Run `ensure-data`, pass --data, or install "
            "`human-eval @ git+https://github.com/openai/human-eval.git`."
        ) from exc

    try:
        problems = official_read_problems()
    except Exception as exc:
        raise DataBlocked(
            "the human_eval package is installed, but its bundled HumanEval data could not be read; "
            "run `ensure-data` or pass --data"
        ) from exc
    return dict(problems), "human_eval.data.HUMAN_EVAL", "human_eval_package"


def public_problem(problem: dict[str, Any]) -> dict[str, Any]:
    return {
        "task_id": problem["task_id"],
        "entry_point": problem.get("entry_point"),
        "prompt": problem.get("prompt", ""),
    }


def selected_problems(
    problems: dict[str, dict[str, Any]], task_ids: list[str], limit: int, offset: int
) -> list[dict[str, Any]]:
    if task_ids:
        selected = []
        for raw_task_id in task_ids:
            task_id = normalize_task_id(raw_task_id)
            if task_id not in problems:
                raise KeyError(f"task id not found: {task_id}")
            selected.append(problems[task_id])
        return selected
    ordered = sorted(problems.values(), key=lambda problem: task_number(problem["task_id"]))
    if offset:
        ordered = ordered[offset:]
    return ordered[:limit] if limit > 0 else ordered


def ensure_data(args: argparse.Namespace) -> int:
    out = Path(args.out or DEFAULT_DATA)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists() and not args.force:
        print(f"HumanEval data already exists: {out}", file=sys.stderr)
        return 0
    print(f"downloading {HUMANEVAL_URL} -> {out}", file=sys.stderr)
    with urllib.request.urlopen(HUMANEVAL_URL, timeout=args.timeout) as response:
        out.write_bytes(response.read())
    problems, source, _ = load_problems(out)
    print(json.dumps({"path": source, "tasks": len(problems)}, indent=2, sort_keys=True))
    return 0


def inspect_data(args: argparse.Namespace) -> int:
    problems, source, source_type = load_problems(args.data)
    ordered = sorted(problems.values(), key=lambda problem: task_number(problem["task_id"]))
    payload = {
        "dataset": DATASET,
        "datasetSplit": DATASET_SPLIT,
        "source": source,
        "sourceType": source_type,
        "tasks": len(ordered),
        "firstTask": ordered[0]["task_id"] if ordered else None,
        "lastTask": ordered[-1]["task_id"] if ordered else None,
        "officialEvaluatorAvailable": official_evaluator_available(),
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def render_clio_prompt(problem: dict[str, Any]) -> str:
    header = textwrap.dedent(
        f"""\
        You are solving OpenAI HumanEval task {problem['task_id']}.

        The working directory contains `solution.py` initialized with the public
        HumanEval prompt. Complete the implementation of `{problem.get('entry_point')}`
        in `solution.py`.

        Constraints:
        - Keep the function signature and any imports from the prompt.
        - Do not add tests, example runners, print/debug output, markdown, or prose.
        - Do not read from stdin, write files, use the network, or depend on packages
          outside the Python standard library unless the prompt already imports them.
        - Stop after `solution.py` contains the final answer.

        Public prompt currently in solution.py:
        ```python
        """
    )
    return header + problem.get("prompt", "") + "\n```\n"


def run_clio(prompt: str, cwd: Path, events_path: Path, timeout: int, target: str | None, model: str | None) -> dict[str, Any]:
    cmd = [CLIO, "--no-context-files", "run", "--json"]
    if target:
        cmd.extend(["--target", target])
    if model:
        cmd.extend(["--model", model])
    cmd.append(prompt)
    started = time.time()
    timed_out = False
    stderr = ""
    with events_path.open("w", encoding="utf-8") as stdout:
        try:
            proc = subprocess.run(
                cmd,
                cwd=cwd,
                env={**os.environ},
                stdout=stdout,
                stderr=subprocess.PIPE,
                text=True,
                timeout=timeout,
            )
            code = proc.returncode
            stderr = proc.stderr
        except subprocess.TimeoutExpired as exc:
            code = 124
            timed_out = True
            stderr = str(exc)
    return {
        "exit": code,
        "timed_out": timed_out,
        "wall_s": round(time.time() - started, 3),
        "stderr": stderr[-4000:],
        "events": str(events_path),
    }


def collect_strings(value: Any, out: list[str]) -> None:
    if isinstance(value, str):
        out.append(value)
    elif isinstance(value, dict):
        for item in value.values():
            collect_strings(item, out)
    elif isinstance(value, list):
        for item in value:
            collect_strings(item, out)


def extract_python_from_events(events_path: Path) -> str | None:
    if not events_path.exists():
        return None
    chunks: list[str] = []
    for line in events_path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        collect_strings(payload, chunks)
    matches: list[str] = []
    for chunk in chunks:
        matches.extend(match.group(1) for match in PYTHON_BLOCK_RE.finditer(chunk))
    return matches[-1].strip() + "\n" if matches else None


def tokens_from_events(events_path: Path) -> tuple[int | None, str | None]:
    total, run_id = 0, None
    if not events_path.exists():
        return None, None
    for line in events_path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if run_id is None:
            run_id = (event.get("session") or {}).get("runId") or event.get("runId")
        message = event.get("message") or {}
        usage = message.get("usage") or {}
        try:
            total = max(total, int(usage.get("totalTokens") or 0))
        except (TypeError, ValueError):
            pass
    return (total or None), run_id


def tokens_from_receipt(run_id: str | None) -> int | None:
    if not run_id:
        return None
    path = Path.home() / ".local/state/clio/receipts" / f"{run_id}.json"
    if not path.exists():
        return None
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    for key_path in (("usage", "totalTokens"), ("tokens",), ("usage", "total")):
        cursor: Any = receipt
        for key in key_path:
            cursor = cursor.get(key) if isinstance(cursor, dict) else None
        if isinstance(cursor, (int, float)) and cursor:
            return int(cursor)
    return None


def completion_from_solution(problem: dict[str, Any], solution_text: str) -> str:
    prompt = problem.get("prompt", "")
    if solution_text.startswith(prompt):
        return solution_text[len(prompt) :]
    stripped = solution_text.strip("\n")
    if not stripped:
        return ""
    first_line = stripped.splitlines()[0]
    if first_line.startswith((" ", "\t")):
        return "\n" + stripped + "\n"
    return "\n\n" + stripped + "\n"


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


def generated_artifacts(run_dir: Path, *extra: Path) -> list[Path]:
    candidates = [
        run_dir / "metrics.jsonl",
        run_dir / "samples.jsonl",
        run_dir / "results.jsonl",
        run_dir / "result.json",
        run_dir / "solution.py",
        run_dir / "completion.py",
        run_dir / "problem-public.json",
        *extra,
    ]
    tasks_dir = run_dir / "tasks"
    if tasks_dir.exists():
        candidates.extend(sorted(tasks_dir.glob("**/solution.py")))
        candidates.extend(sorted(tasks_dir.glob("**/completion.py")))
        candidates.extend(sorted(tasks_dir.glob("**/result.json")))
    return [path for path in candidates if path.exists()]


def generate_attempt(
    problem: dict[str, Any],
    run_dir: Path,
    timeout: int,
    target: str | None,
    model: str | None,
    *,
    force: bool = False,
    dry_run: bool = False,
) -> tuple[dict[str, Any], str]:
    if force and run_dir.exists():
        shutil.rmtree(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "events").mkdir(parents=True, exist_ok=True)
    prompt_text = render_clio_prompt(problem)
    (run_dir / "prompt.md").write_text(prompt_text, encoding="utf-8")
    (run_dir / "problem-public.json").write_text(json.dumps(public_problem(problem), indent=2) + "\n", encoding="utf-8")
    solution_path = run_dir / "solution.py"
    if not solution_path.exists() or force:
        solution_path.write_text(problem.get("prompt", ""), encoding="utf-8")

    if dry_run:
        metric = {"exit": 0, "timed_out": False, "wall_s": 0.0, "dry_run": True, "events": None}
    else:
        metric = run_clio(
            prompt=prompt_text,
            cwd=run_dir,
            events_path=run_dir / "events" / "clio.jsonl",
            timeout=timeout,
            target=target,
            model=model,
        )

    if solution_path.exists():
        solution_text = solution_path.read_text(encoding="utf-8", errors="replace")
    else:
        extracted = extract_python_from_events(run_dir / "events" / "clio.jsonl")
        solution_text = extracted or ""
        if solution_text:
            solution_path.write_text(solution_text, encoding="utf-8")

    completion = completion_from_solution(problem, solution_text)
    (run_dir / "completion.py").write_text(completion, encoding="utf-8")
    stream_tokens, run_id = tokens_from_events(run_dir / "events" / "clio.jsonl")
    metric.update(
        {
            "task_id": problem["task_id"],
            "tokens": tokens_from_receipt(run_id) or stream_tokens,
            "run_id": run_id,
            "solution_bytes": len(solution_text.encode("utf-8")),
            "completion_bytes": len(completion.encode("utf-8")),
            "empty_completion": not completion.strip(),
        }
    )
    return metric, completion


def official_evaluator_available() -> bool:
    try:
        from human_eval.execution import check_correctness  # noqa: F401
    except Exception:
        return False
    return True


def run_official_check(problem: dict[str, Any], completion: str, timeout: float) -> dict[str, Any]:
    try:
        from human_eval.execution import check_correctness
    except Exception as exc:
        raise DataBlocked(
            "official HumanEval evaluator is not installed; install "
            "`human-eval @ git+https://github.com/openai/human-eval.git` or use --evaluator subprocess"
        ) from exc
    started = time.time()
    result = check_correctness(problem, completion, timeout=timeout, completion_id=0)
    passed = bool(result.get("passed"))
    return {
        "passed": passed,
        "status": "pass" if passed else "fail",
        "result": result.get("result"),
        "evaluator": "human_eval.execution.check_correctness",
        "wall_s": round(time.time() - started, 3),
    }


def build_check_program(problem: dict[str, Any], completion: str) -> str:
    return "\n".join(
        [
            problem.get("prompt", "") + completion,
            problem.get("test", ""),
            f"check({problem.get('entry_point')})",
            "",
        ]
    )


def run_subprocess_check(problem: dict[str, Any], completion: str, timeout: float) -> dict[str, Any]:
    program = build_check_program(problem, completion)
    started = time.time()
    with tempfile.TemporaryDirectory(prefix="clio-humaneval-") as tmp:
        path = Path(tmp) / "check.py"
        path.write_text(program, encoding="utf-8")
        try:
            proc = subprocess.run(
                [*uv_python_cmd(), str(path)],
                cwd=tmp,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            passed = proc.returncode == 0
            return {
                "passed": passed,
                "status": "pass" if passed else "fail",
                "result": "passed" if passed else "failed",
                "exit": proc.returncode,
                "stdout": proc.stdout[-4000:],
                "stderr": proc.stderr[-4000:],
                "evaluator": "adapter.subprocess",
                "wall_s": round(time.time() - started, 3),
            }
        except subprocess.TimeoutExpired as exc:
            return {
                "passed": False,
                "status": "fail",
                "result": "timed out",
                "exit": 124,
                "stdout": (exc.stdout or "")[-4000:] if isinstance(exc.stdout, str) else "",
                "stderr": str(exc)[-4000:],
                "evaluator": "adapter.subprocess",
                "wall_s": round(time.time() - started, 3),
            }


def grade_completion(problem: dict[str, Any], completion: str, timeout: float, evaluator: str) -> dict[str, Any]:
    if evaluator == "official":
        return run_official_check(problem, completion, timeout)
    if evaluator == "subprocess":
        return run_subprocess_check(problem, completion, timeout)
    if official_evaluator_available():
        return run_official_check(problem, completion, timeout)
    return run_subprocess_check(problem, completion, timeout)


def grade_attempt(problem: dict[str, Any], run_dir: Path, timeout: float, evaluator: str) -> dict[str, Any]:
    completion_path = run_dir / "completion.py"
    solution_path = run_dir / "solution.py"
    if solution_path.exists():
        completion = completion_from_solution(problem, solution_path.read_text(encoding="utf-8", errors="replace"))
        completion_path.write_text(completion, encoding="utf-8")
    elif completion_path.exists():
        completion = completion_path.read_text(encoding="utf-8", errors="replace")
    else:
        completion = ""
    result = grade_completion(problem, completion, timeout, evaluator)
    result.update({"task_id": problem["task_id"], "completion_bytes": len(completion.encode("utf-8"))})
    (run_dir / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result


def estimate_pass_at_k(num_samples: int, num_correct: int, k: int) -> float | None:
    if num_samples < k:
        return None
    if num_samples - num_correct < k:
        return 1.0
    product = 1.0
    for value in range(num_samples - num_correct + 1, num_samples + 1):
        product *= 1.0 - (k / value)
    return 1.0 - product


def suite_summary(
    chosen: list[dict[str, Any]],
    metrics_rows: list[dict[str, Any]],
    grade_rows: list[dict[str, Any]],
    pass_at_k: list[int],
) -> dict[str, Any]:
    by_task: dict[str, list[dict[str, Any]]] = {problem["task_id"]: [] for problem in chosen}
    for row in grade_rows:
        by_task.setdefault(row["task_id"], []).append(row)
    pass_at: dict[str, float] = {}
    for k in pass_at_k:
        estimates = []
        for rows in by_task.values():
            estimate = estimate_pass_at_k(len(rows), sum(1 for row in rows if row.get("passed")), k)
            if estimate is not None:
                estimates.append(estimate)
        if estimates:
            pass_at[f"pass@{k}"] = round(sum(estimates) / len(estimates), 6)
    passed_tasks = sum(1 for rows in by_task.values() if any(row.get("passed") for row in rows))
    failed_tasks = len(chosen) - passed_tasks
    generation_errors = sum(
        1
        for metric in metrics_rows
        if metric.get("error") or metric.get("timed_out") or metric.get("exit") not in (0, None) or metric.get("empty_completion")
    )
    return {
        "suite": "human-eval",
        "dataset": DATASET,
        "datasetSplit": DATASET_SPLIT,
        "tasks": len(chosen),
        "samples": len(metrics_rows),
        "resolved": passed_tasks,
        "errors": failed_tasks,
        "failedTasks": failed_tasks,
        "passedSamples": sum(1 for row in grade_rows if row.get("passed")),
        "failedSamples": sum(1 for row in grade_rows if not row.get("passed")),
        "passAt": pass_at,
        "generationErrors": generation_errors,
        "timedOut": sum(1 for metric in metrics_rows if metric.get("timed_out")),
        "emptyCompletions": sum(1 for metric in metrics_rows if metric.get("empty_completion")),
        "wallSeconds": round(
            sum(float(metric.get("wall_s") or 0) for metric in metrics_rows)
            + sum(float(row.get("wall_s") or 0) for row in grade_rows),
            3,
        ),
        "tokens": sum(int(metric.get("tokens") or 0) for metric in metrics_rows),
        "scoringRule": "HumanEval pass means the generated completion passes the task's check(entry_point).",
    }


def write_suite_manifest(
    out_dir: Path,
    chosen: list[dict[str, Any]],
    metrics_rows: list[dict[str, Any]],
    grade_rows: list[dict[str, Any]],
    summary: dict[str, Any],
    model: str | None,
    target: str | None,
    notes: list[str],
) -> tuple[Path, Path]:
    return write_result_manifest(
        out_dir,
        suite="human-eval",
        dataset=DATASET,
        dataset_split=DATASET_SPLIT,
        model=humaneval_model(model),
        profile=humaneval_target_profile(target, model),
        instances=len(chosen),
        resolved=int(summary.get("resolved") or 0),
        errors=int(summary.get("errors") or 0),
        artifact_paths=generated_artifacts(out_dir),
        summary=summary,
        notes=notes,
        clio_bin=CLIO,
    )


def run_suite(args: argparse.Namespace) -> int:
    if not (args.task_id or args.limit or args.all):
        raise DataBlocked("select tasks with --task-id, --limit, or --all")
    if args.samples_per_task < 1:
        raise ValueError("--samples-per-task must be at least 1")
    if any(k < 1 for k in args.pass_at):
        raise ValueError("--pass-at values must be at least 1")
    problems, source, _ = load_problems(args.data)
    chosen = selected_problems(problems, args.task_id, args.limit, args.offset)
    if not chosen:
        print("no HumanEval tasks matched", file=sys.stderr)
        return 2

    out_dir = Path(args.out)
    if out_dir.exists() and any(out_dir.iterdir()) and not args.force:
        raise FileExistsError(f"output directory is not empty: {out_dir}; pass --force to replace it")
    if args.force and out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = out_dir / "metrics.jsonl"
    samples_path = out_dir / "samples.jsonl"
    results_path = out_dir / "results.jsonl"
    metrics_rows: list[dict[str, Any]] = []
    grade_rows: list[dict[str, Any]] = []

    print(f"running {len(chosen)} HumanEval task(s) from {source} -> {out_dir}", file=sys.stderr)
    with metrics_path.open("w", encoding="utf-8") as metrics, samples_path.open("w", encoding="utf-8") as samples, results_path.open("w", encoding="utf-8") as results:
        for task_index, problem in enumerate(chosen, 1):
            task_id = problem["task_id"]
            for sample_id in range(args.samples_per_task):
                sample_dir = out_dir / "tasks" / task_slug(task_id) / f"sample-{sample_id:03d}"
                print(
                    f"[{task_index}/{len(chosen)}] {task_id} sample {sample_id + 1}/{args.samples_per_task} ...",
                    file=sys.stderr,
                    flush=True,
                )
                try:
                    metric, completion = generate_attempt(
                        problem,
                        sample_dir,
                        args.timeout,
                        args.target,
                        args.model,
                        force=args.force,
                        dry_run=args.dry_run,
                    )
                    metric["sample_id"] = sample_id
                    sample = {"task_id": task_id, "completion": completion, "sample_id": sample_id}
                    grade = grade_attempt(problem, sample_dir, args.grade_timeout, args.evaluator)
                    grade["sample_id"] = sample_id
                except DataBlocked:
                    raise
                except Exception as exc:
                    metric = {"task_id": task_id, "sample_id": sample_id, "error": str(exc)[:400], "exit": None}
                    sample = {"task_id": task_id, "completion": "", "sample_id": sample_id}
                    grade = {"task_id": task_id, "sample_id": sample_id, "passed": False, "status": "error", "result": str(exc)[:400]}
                    if not args.continue_on_error:
                        raise
                metrics_rows.append(metric)
                grade_rows.append(grade)
                metrics.write(json.dumps(metric) + "\n"); metrics.flush()
                samples.write(json.dumps(sample) + "\n"); samples.flush()
                results.write(json.dumps(grade) + "\n"); results.flush()
                print(
                    f"  -> exit={metric.get('exit')} pass={grade.get('passed')} "
                    f"tokens={metric.get('tokens')} bytes={metric.get('completion_bytes')}",
                    file=sys.stderr,
                )

    summary = suite_summary(chosen, metrics_rows, grade_rows, args.pass_at)
    manifest_path, summary_path = write_suite_manifest(
        out_dir,
        chosen,
        metrics_rows,
        grade_rows,
        summary,
        args.model,
        args.target,
        notes=[
            "HumanEval tests execute generated Python. Run this adapter in a sandbox for untrusted code.",
            "Resolved counts are task-level: a task is resolved when any generated sample passes.",
        ],
    )
    print(f"manifest: {manifest_path}", file=sys.stderr)
    print(f"summary: {summary_path}", file=sys.stderr)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def run_task(args: argparse.Namespace) -> int:
    problems, _, _ = load_problems(args.data)
    task_id = normalize_task_id(args.task_id)
    if task_id not in problems:
        raise KeyError(f"task id not found: {task_id}")
    run_dir = Path(args.out)
    if run_dir.exists() and any(run_dir.iterdir()) and not args.force:
        raise FileExistsError(f"output directory is not empty: {run_dir}; pass --force to replace it")
    metric, completion = generate_attempt(
        problems[task_id],
        run_dir,
        args.timeout,
        args.target,
        args.model,
        force=args.force,
        dry_run=args.dry_run,
    )
    metric["sample_id"] = 0
    write_jsonl(run_dir / "metrics.jsonl", [metric])
    write_jsonl(run_dir / "samples.jsonl", [{"task_id": task_id, "completion": completion, "sample_id": 0}])
    summary = {
        "suite": "human-eval",
        "dataset": DATASET,
        "datasetSplit": DATASET_SPLIT,
        "taskId": task_id,
        "generated": True,
        "resolved": 0,
        "errors": 1 if metric.get("timed_out") or metric.get("exit") not in (0, None) or metric.get("empty_completion") else 0,
        "emptyCompletion": bool(metric.get("empty_completion")),
    }
    write_suite_manifest(
        run_dir,
        [problems[task_id]],
        [metric],
        [],
        summary,
        args.model,
        args.target,
        notes=["Generation-only manifest. grade-task rewrites this directory with scored results."],
    )
    print(json.dumps(metric, indent=2, sort_keys=True))
    return 0 if metric.get("exit") == 0 else 1


def grade_task(args: argparse.Namespace) -> int:
    problems, _, _ = load_problems(args.data)
    task_id = normalize_task_id(args.task_id)
    if task_id not in problems:
        raise KeyError(f"task id not found: {task_id}")
    run_dir = Path(args.run)
    result = grade_attempt(problems[task_id], run_dir, args.timeout, args.evaluator)
    result["sample_id"] = 0
    write_jsonl(run_dir / "results.jsonl", [result])
    summary = {
        "suite": "human-eval",
        "dataset": DATASET,
        "datasetSplit": DATASET_SPLIT,
        "taskId": task_id,
        "samples": 1,
        "resolved": 1 if result.get("passed") else 0,
        "errors": 0 if result.get("passed") else 1,
        "passedSamples": 1 if result.get("passed") else 0,
        "failedSamples": 0 if result.get("passed") else 1,
        "passAt": {"pass@1": 1.0 if result.get("passed") else 0.0},
        "scoringRule": "HumanEval pass means the generated completion passes check(entry_point).",
    }
    write_suite_manifest(
        run_dir,
        [problems[task_id]],
        [],
        [result],
        summary,
        None,
        None,
        notes=["Scored by the HumanEval adapter verifier."],
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result.get("passed") else 1


def quote_command(parts: list[str]) -> str:
    return " ".join(shlex.quote(str(part)) for part in parts)


def maybe_data_args(data: str | None) -> list[str]:
    if data:
        return ["--data", data]
    if DEFAULT_DATA.exists():
        return ["--data", str(DEFAULT_DATA)]
    return []


def generate_tasks(args: argparse.Namespace) -> int:
    problems, source, source_type = load_problems(args.data)
    chosen = selected_problems(problems, args.task_id, args.limit, args.offset)
    if not chosen:
        print("no HumanEval tasks matched", file=sys.stderr)
        return 2
    script = Path(__file__).resolve()
    run_root = Path(args.run_root)
    data_args = maybe_data_args(args.data)
    uv_packages = (
        ["human-eval @ git+https://github.com/openai/human-eval.git"]
        if args.evaluator == "official" or source_type == "human_eval_package"
        else []
    )
    lines = ["version: 1", "tasks:"]
    for problem in chosen:
        task_id = problem["task_id"]
        task_name = f"humaneval-{task_slug(task_id)}"
        out_dir = run_root / task_name
        prompt = textwrap.dedent(
            f"""\
            Run OpenAI HumanEval task {task_id} through Clio and grade the generated completion.

            Dataset source: {source}
            Entry point: {problem.get('entry_point')}
            """
        )
        setup = [
            *uv_script_cmd(script, uv_packages),
            "run-task",
            *data_args,
            "--task-id",
            task_id,
            "--out",
            str(out_dir),
            "--timeout",
            str(args.timeout),
            "--force",
        ]
        if args.target:
            setup.extend(["--target", args.target])
        if args.model:
            setup.extend(["--model", args.model])
        if args.dry_run:
            setup.append("--dry-run")
        verifier = [
            *uv_script_cmd(script, uv_packages),
            "grade-task",
            *data_args,
            "--task-id",
            task_id,
            "--run",
            str(out_dir),
            "--timeout",
            str(args.grade_timeout),
            "--evaluator",
            args.evaluator,
        ]
        lines.extend(
            [
                f"  - id: {task_name}",
                "    prompt: |",
                *[f"      {line}" for line in prompt.splitlines()],
                "    cwd: .",
                "    setup:",
                f"      - {json.dumps(quote_command(setup))}",
                "    verifier:",
                f"      - {json.dumps(quote_command(verifier))}",
                f"    timeoutMs: {int(args.timeout + args.grade_timeout + 30) * 1000}",
                "    tags:",
                "      - humaneval",
                "      - python",
                f"      - task-{task_number(task_id)}",
            ]
        )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {len(chosen)} HumanEval eval task(s) to {out}", file=sys.stderr)
    return 0


def add_data_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--data", default=None, help=f"HumanEval.jsonl(.gz); default: {DEFAULT_DATA} or human_eval package")


def add_selection_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--task-id", action="append", default=[], help="task id such as HumanEval/0 or just 0; repeatable")
    parser.add_argument("--limit", type=int, default=0, help="limit selected tasks")
    parser.add_argument("--offset", type=int, default=0, help="skip this many tasks before applying --limit")
    parser.add_argument("--all", action="store_true", help="run all selected/default tasks")


def add_clio_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--timeout", type=int, default=300, help="per-sample Clio wall-clock timeout in seconds")
    parser.add_argument("--target", default=None, help="clio --target override")
    parser.add_argument("--model", default=None, help="clio --model override")
    parser.add_argument("--force", action="store_true", help="replace existing run directories")
    parser.add_argument("--dry-run", action="store_true", help="render prompts and seed solution.py without calling Clio")


def add_grade_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--grade-timeout", type=float, default=3.0, help="per-completion HumanEval test timeout")
    parser.add_argument(
        "--evaluator",
        choices=["auto", "official", "subprocess"],
        default="auto",
        help="auto prefers OpenAI human_eval.execution, subprocess is a lightweight fallback",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    ensure = sub.add_parser("ensure-data", help="download the official HumanEval JSONL.GZ into an untracked data dir")
    ensure.add_argument("--out", default=None, help=f"output path; default: {DEFAULT_DATA}")
    ensure.add_argument("--force", action="store_true")
    ensure.add_argument("--timeout", type=int, default=30)
    ensure.set_defaults(func=ensure_data)

    inspect = sub.add_parser("inspect-data", help="summarize dataset and evaluator readiness")
    add_data_arg(inspect)
    inspect.set_defaults(func=inspect_data)

    tasks = sub.add_parser("generate-tasks", help="write a clio eval YAML task file")
    add_data_arg(tasks)
    add_selection_args(tasks)
    tasks.add_argument("--out", required=True)
    tasks.add_argument("--run-root", default=str(DEFAULT_RUN_ROOT))
    add_clio_args(tasks)
    add_grade_args(tasks)
    tasks.set_defaults(func=generate_tasks)

    run = sub.add_parser("run", help="run and grade selected HumanEval tasks directly")
    add_data_arg(run)
    add_selection_args(run)
    run.add_argument("--out", required=True)
    run.add_argument("--samples-per-task", type=int, default=1)
    run.add_argument("--pass-at", type=int, action="append", default=[1], help="pass@k values to report; repeatable")
    run.add_argument("--continue-on-error", action="store_true", help="keep running after adapter errors")
    add_clio_args(run)
    add_grade_args(run)
    run.set_defaults(func=run_suite)

    one = sub.add_parser("run-task", help="run Clio for one HumanEval task")
    add_data_arg(one)
    one.add_argument("--task-id", required=True)
    one.add_argument("--out", required=True)
    add_clio_args(one)
    one.set_defaults(func=run_task)

    grade = sub.add_parser("grade-task", help="grade one generated HumanEval task directory")
    add_data_arg(grade)
    grade.add_argument("--task-id", required=True)
    grade.add_argument("--run", required=True)
    grade.add_argument("--timeout", type=float, default=3.0, help="per-completion HumanEval test timeout")
    grade.add_argument(
        "--evaluator",
        choices=["auto", "official", "subprocess"],
        default="auto",
        help="auto prefers OpenAI human_eval.execution, subprocess is a lightweight fallback",
    )
    grade.set_defaults(func=grade_task)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
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

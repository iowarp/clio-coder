#!/usr/bin/env -S uv run --no-project python
"""DS-1000 adapter for Clio Coder.

DS-1000 is 1000 data-science problems lifted from StackOverflow across seven
libraries: Pandas, NumPy, Matplotlib, Scikit-learn, SciPy, PyTorch, and
TensorFlow. Each problem ships its own execution harness in `code_context`,
which builds inputs, runs the model's snippet through `exec`, and compares the
resulting `result` against a reference answer. 159 of the problems additionally
carry a `test_string` surface-form check that tokenizes the snippet and asserts
a required API actually appears, which is what stops a hardcoded answer from
scoring.

This adapter stays thin: it loads the public dataset, seeds one workspace per
problem, runs Clio once per sample, and hands the snippet to the upstream
`code_context` unmodified. The upstream harness is the authoritative grader.

Grading dependencies are resolved per problem from `metadata.library`, so
scoring a Pandas problem does not install TensorFlow. DS-1000's published
numbers came from a 2022 reference environment with pinned library versions;
a modern resolve can fail a problem for environment reasons rather than model
reasons. Pin the grading environment with repeated `--with` or the
`DS1000_GRADER_WITH` environment variable when a campaign needs comparability.

WARNING: grading executes model-generated Python. Run in a sandbox or container
for untrusted models or prompts.
"""

from __future__ import annotations

import argparse
import ast
import gzip
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import urllib.request
import warnings
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
ADAPTER_DIR = Path(__file__).resolve().parent
DEFAULT_DATA = Path(os.environ.get("DS1000_DATA", ADAPTER_DIR / "data" / "ds1000.jsonl.gz"))
DATASET = "xlang-ai/DS-1000"
DATASET_SPLIT = "test"
DS1000_URL = "https://raw.githubusercontent.com/xlang-ai/DS-1000/main/data/ds1000.jsonl.gz"
CLIO = os.environ.get("CLIO_CODER_BIN", "clio-coder")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from clio_process import run_json_command
from clio_usage import fold_message_end_usage, receipt_total_tokens, run_id_from_events
from result_manifest import target_profile, write_result_manifest
from uv_command import uv_python_cmd

PYTHON_BLOCK_RE = re.compile(r"```(?:python)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)
IMPORT_LINE_RE = re.compile(
    r"(?:^|;)\s*(?:from\s+([A-Za-z_]\w*(?:\.\w+)*)\s+import\b|"
    r"import\s+([A-Za-z_]\w*(?:\.\w+)*(?:\s+as\s+[A-Za-z_]\w*)?"
    r"(?:\s*,\s*[A-Za-z_]\w*(?:\.\w+)*(?:\s+as\s+[A-Za-z_]\w*)?)*))",
    re.MULTILINE,
)
SOLUTION_MARKER = "# CLIO SOLUTION BELOW; DO NOT EDIT ABOVE THIS LINE\n"

# The headline library is declared in metadata. Each task's code_context can
# declare additional grading imports (for example, NumPy task 350 also imports
# scipy.stats), so grader_packages combines this declaration with that task's
# actual imports rather than installing one environment for the whole suite.
LIBRARY_PACKAGES: dict[str, tuple[str, ...]] = {
    "Pandas": ("pandas",),
    "Numpy": ("numpy",),
    "Matplotlib": ("matplotlib",),
    "Scipy": ("scipy",),
    "Sklearn": ("scikit-learn",),
    "Pytorch": ("torch",),
    "Tensorflow": ("tensorflow",),
}
DISTRIBUTION_NAMES = {
    "PIL": "pillow",
    "mpl_toolkits": "matplotlib",
    "sklearn": "scikit-learn",
    "yaml": "PyYAML",
}
EXTRA_STDLIB = {"__future__", "builtins"}


class DataBlocked(RuntimeError):
    """Raised when the adapter is wired but required public data is absent."""


def ds1000_model(model: str | None) -> str:
    return (
        model
        or os.environ.get("CLIO_CODER_PRED_MODEL")
        or os.environ.get("CLIO_CODER_MODEL")
        or os.environ.get("CLIO_CODER_MAIN_MODEL")
        or "unspecified"
    )


def ds1000_target_profile(target: str | None, model: str | None) -> dict[str, str]:
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


def problem_id(problem: dict[str, Any]) -> int:
    metadata = problem.get("metadata")
    raw = metadata.get("problem_id") if isinstance(metadata, dict) else None
    return int(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else -1


def problem_library(problem: dict[str, Any]) -> str:
    metadata = problem.get("metadata")
    library = metadata.get("library") if isinstance(metadata, dict) else None
    return str(library) if library else "unknown"


def problem_perturbation(problem: dict[str, Any]) -> str:
    metadata = problem.get("metadata")
    value = metadata.get("perturbation_type") if isinstance(metadata, dict) else None
    return str(value) if value else "unknown"


def task_id_of(problem: dict[str, Any]) -> str:
    return f"DS-1000/{problem_id(problem)}"


def normalize_task_id(task_id: str) -> str:
    value = str(task_id).strip()
    if value.isdigit():
        return f"DS-1000/{int(value)}"
    return value


def task_number(task_id: str) -> int:
    try:
        return int(str(task_id).split("/")[-1])
    except ValueError:
        return 10**9


def task_slug(task_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", task_id)


def imported_roots(source: str) -> list[str]:
    roots: list[str] = []
    pending = [source]
    seen: set[str] = set()
    while pending:
        candidate = pending.pop()
        if candidate in seen:
            continue
        seen.add(candidate)
        for match in IMPORT_LINE_RE.finditer(candidate):
            from_name, import_names = match.groups()
            if from_name:
                roots.append(from_name.split(".")[0])
            elif import_names:
                roots.extend(
                    item.strip().split()[0].split(".")[0]
                    for item in import_names.split(",")
                    if item.strip()
                )
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", SyntaxWarning)
                tree = ast.parse(candidate)
        except (SyntaxError, ValueError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots.extend(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                roots.append(node.module.split(".")[0])
            elif isinstance(node, ast.Constant) and isinstance(node.value, str) and "import" in node.value:
                pending.append(node.value)
    return roots


def grader_packages(problem: dict[str, Any], overrides: Sequence[str] = ()) -> tuple[str, ...]:
    """Pin the environment when asked, otherwise resolve this task's imports.

    An explicit override replaces the derived set rather than adding to it,
    because comparability is the reason to pass one: a campaign that pins
    `pandas==1.3.5` must not also resolve an unpinned `pandas`.
    """
    explicit = [item.strip() for item in overrides if item.strip()]
    if not explicit:
        env_raw = os.environ.get("DS1000_GRADER_WITH", "")
        explicit = [item.strip() for item in env_raw.split(",") if item.strip()]
    if explicit:
        return tuple(explicit)
    stdlib = set(getattr(sys, "stdlib_module_names", frozenset())) | EXTRA_STDLIB
    packages = set(LIBRARY_PACKAGES.get(problem_library(problem), ()))
    for root in imported_roots(str(problem.get("code_context") or "")):
        if root in stdlib:
            continue
        mapped = DISTRIBUTION_NAMES.get(root, root)
        if mapped:
            packages.add(mapped)
    return tuple(sorted(packages, key=str.casefold))


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


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


def load_problems(path: str | os.PathLike[str] | None = None) -> tuple[dict[str, dict[str, Any]], str]:
    data_path = Path(path) if path else DEFAULT_DATA
    if not data_path.exists():
        raise DataBlocked(
            f"DS-1000 data not found: {data_path}. Run `ensure-data`, pass --data, or set DS1000_DATA."
        )
    rows = read_jsonl(data_path)
    problems = {task_id_of(row): row for row in rows}
    if not problems:
        raise DataBlocked(f"DS-1000 data is empty: {data_path}")
    return problems, str(data_path)


def public_problem(problem: dict[str, Any]) -> dict[str, Any]:
    """The part of a problem that may be written into a run directory.

    `reference_code` is the gold answer and `code_context` is the grader. Both
    stay out of the agent's workspace so a run directory can be inspected,
    shared, or replayed without leaking the answer into the next attempt.
    """
    return {
        "task_id": task_id_of(problem),
        "library": problem_library(problem),
        "perturbation_type": problem_perturbation(problem),
        "prompt": problem.get("prompt", ""),
        "has_surface_form_check": "def test_string" in str(problem.get("code_context", "")),
    }


def selected_problems(
    problems: dict[str, dict[str, Any]],
    task_ids: list[str],
    libraries: list[str],
    limit: int,
    offset: int,
) -> list[dict[str, Any]]:
    if task_ids:
        selected = []
        for raw_task_id in task_ids:
            task_id = normalize_task_id(raw_task_id)
            if task_id not in problems:
                raise KeyError(f"task id not found: {task_id}")
            selected.append(problems[task_id])
        return selected
    ordered = sorted(problems.values(), key=lambda problem: problem_id(problem))
    if libraries:
        wanted = {name.strip().lower() for name in libraries if name.strip()}
        ordered = [problem for problem in ordered if problem_library(problem).lower() in wanted]
    if offset:
        ordered = ordered[offset:]
    return ordered[:limit] if limit > 0 else ordered


def ensure_data(args: argparse.Namespace) -> int:
    out = Path(args.out or DEFAULT_DATA)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists() and not args.force:
        print(f"DS-1000 data already exists: {out}", file=sys.stderr)
        return 0
    print(f"downloading {DS1000_URL} -> {out}", file=sys.stderr)
    with urllib.request.urlopen(DS1000_URL, timeout=args.timeout) as response:
        out.write_bytes(response.read())
    problems, source = load_problems(out)
    print(json.dumps({"path": source, "tasks": len(problems)}, indent=2, sort_keys=True))
    return 0


def inspect_data(args: argparse.Namespace) -> int:
    problems, source = load_problems(args.data)
    ordered = sorted(problems.values(), key=lambda problem: problem_id(problem))
    libraries: dict[str, int] = {}
    perturbations: dict[str, int] = {}
    for problem in ordered:
        libraries[problem_library(problem)] = libraries.get(problem_library(problem), 0) + 1
        perturbations[problem_perturbation(problem)] = perturbations.get(problem_perturbation(problem), 0) + 1
    payload = {
        "dataset": DATASET,
        "datasetSplit": DATASET_SPLIT,
        "source": source,
        "tasks": len(ordered),
        "byLibrary": dict(sorted(libraries.items())),
        "byPerturbation": dict(sorted(perturbations.items())),
        "surfaceFormChecks": sum(1 for p in ordered if "def test_string" in str(p.get("code_context", ""))),
        "firstTask": task_id_of(ordered[0]) if ordered else None,
        "lastTask": task_id_of(ordered[-1]) if ordered else None,
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def solution_preamble(problem: dict[str, Any]) -> str:
    return (
        f"# DS-1000 {task_id_of(problem)} ({problem_library(problem)})\n"
        "# Write only the solution snippet below. The graded snippet is\n"
        "# everything after the marker line.\n"
        f"{SOLUTION_MARKER}"
    )


SURFACE_FORM_NOTE = (
    "- This problem carries a surface-form check: the graded snippet is tokenized\n"
    "  and a required API must appear in it. A hardcoded or reimplemented answer\n"
    "  fails even when the value is right.\n"
)

# The template is dedented once, here, and only then interpolated. Interpolating
# first would splice multi-line values in at column zero and leave textwrap with
# no common prefix to strip, which silently indents the whole prompt.
PROMPT_TEMPLATE = textwrap.dedent(
    """\
    You are solving DS-1000 task {task_id} ({library}).

    The problem statement is in `problem.md`. The working directory contains
    `solution.py`, which already holds a marker line. Write your answer into
    `solution.py` below that marker.

    Constraints:
    - Write only the snippet the problem asks for. The grader inserts it into
      a prepared namespace where the input variables already exist, so do not
      redefine the inputs, re-import what the statement already imported, or
      add a main block.
    - Assign the answer to the variable the problem names, usually `result`.
    - Do not edit or remove the marker line or anything above it.
    - Do not add tests, example runners, print/debug output, markdown, or prose.
    - Do not read from stdin, write files, or use the network.
    {surface_note}- Stop after `solution.py` contains the final answer.

    Problem statement:

    {statement}
    """
)


def render_clio_prompt(problem: dict[str, Any]) -> str:
    has_surface_check = "def test_string" in str(problem.get("code_context", ""))
    return PROMPT_TEMPLATE.format(
        task_id=task_id_of(problem),
        library=problem_library(problem),
        surface_note=SURFACE_FORM_NOTE if has_surface_check else "",
        statement=str(problem.get("prompt", "")),
    )


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
    code, timed_out, stderr = run_json_command(
        cmd,
        cwd=cwd,
        events_path=events_path,
        timeout=timeout,
    )
    return {
        "exit": code,
        "timed_out": timed_out,
        "wall_s": round(time.monotonic() - started, 3),
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


def snippet_from_solution(problem: dict[str, Any], solution_text: str) -> str:
    """The graded snippet inside a solution file.

    The marker is the contract, so it wins when present. An agent that rewrote
    the whole file and dropped the marker still produced an answer, and the
    preamble it replaced was only ever scaffolding, so the fallback strips a
    leading comment block rather than discarding the attempt.
    """
    if SOLUTION_MARKER in solution_text:
        return solution_text.split(SOLUTION_MARKER, 1)[1]
    lines = solution_text.splitlines()
    while lines and (not lines[0].strip() or lines[0].lstrip().startswith("#")):
        lines.pop(0)
    return "\n".join(lines) + ("\n" if lines else "")


def resolve_snippet(problem: dict[str, Any], run_dir: Path) -> tuple[str, str]:
    """The snippet to grade, and where it came from.

    The task tells the agent to leave its answer in solution.py, and that file
    is the first source. An agent that answered with a code block and never
    edited the file leaves only the seeded preamble behind, which yields an
    empty snippet; the event stream still carries the answer, so it is read
    rather than grading the scaffolding against itself. The source travels with
    the snippet because a snippet recovered from the stream means the agent
    solved the task but ignored the file contract, and a reader must be able to
    subtract those from a headline score.
    """
    solution_path = run_dir / "solution.py"
    if solution_path.exists():
        snippet = snippet_from_solution(problem, solution_path.read_text(encoding="utf-8", errors="replace"))
        if snippet.strip():
            return snippet, "solution.py"
    extracted = extract_python_from_events(run_dir / "events" / "clio.jsonl")
    if extracted:
        snippet = snippet_from_solution(problem, extracted)
        if snippet.strip():
            return snippet, "events"
    snippet_path = run_dir / "snippet.py"
    if snippet_path.exists():
        snippet = snippet_path.read_text(encoding="utf-8", errors="replace")
        if snippet.strip():
            return snippet, "snippet.py"
    return "", "empty"


def generated_artifacts(run_dir: Path, *extra: Path) -> list[Path]:
    candidates = [
        run_dir / "metrics.jsonl",
        run_dir / "samples.jsonl",
        run_dir / "results.jsonl",
        run_dir / "result.json",
        run_dir / "solution.py",
        run_dir / "snippet.py",
        run_dir / "problem-public.json",
        *extra,
    ]
    tasks_dir = run_dir / "tasks"
    if tasks_dir.exists():
        candidates.extend(sorted(tasks_dir.glob("**/solution.py")))
        candidates.extend(sorted(tasks_dir.glob("**/snippet.py")))
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
    (run_dir / "problem.md").write_text(str(problem.get("prompt", "")) + "\n", encoding="utf-8")
    (run_dir / "problem-public.json").write_text(
        json.dumps(public_problem(problem), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    solution_path = run_dir / "solution.py"
    if not solution_path.exists() or force:
        solution_path.write_text(solution_preamble(problem), encoding="utf-8")

    metric: dict[str, Any]
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

    solution_text = solution_path.read_text(encoding="utf-8", errors="replace") if solution_path.exists() else ""
    snippet, snippet_source = resolve_snippet(problem, run_dir)
    (run_dir / "snippet.py").write_text(snippet, encoding="utf-8")
    events_path = run_dir / "events" / "clio.jsonl"
    run_id = run_id_from_events(events_path)
    observed_usage = fold_message_end_usage(events_path)
    stream_tokens = None if observed_usage is None else observed_usage["totalTokens"]
    metric.update(
        {
            "task_id": task_id_of(problem),
            "library": problem_library(problem),
            "perturbation_type": problem_perturbation(problem),
            "tokens": receipt_total_tokens(run_id) or stream_tokens,
            "tokens_measured": stream_tokens is not None,
            "run_id": run_id,
            "solution_bytes": len(solution_text.encode("utf-8")),
            "snippet_bytes": len(snippet.encode("utf-8")),
            "snippet_source": snippet_source,
            "empty_snippet": not snippet.strip(),
        }
    )
    return metric, snippet


def build_grade_program(problem: dict[str, Any]) -> str:
    """The upstream harness, plus the two calls that drive it.

    `code_context` is used verbatim. The snippet is read from a sibling file
    rather than inlined so a snippet containing any quoting, escape, or
    encoding does not change the program around it.
    """
    parts = [
        str(problem.get("code_context", "")),
        "",
        "import pathlib as _clio_pathlib",
        '_clio_snippet = _clio_pathlib.Path(__file__).with_name("snippet.txt").read_text(encoding="utf-8")',
        "test_execution(_clio_snippet)",
    ]
    if "def test_string" in str(problem.get("code_context", "")):
        parts.append("test_string(_clio_snippet)")
    parts.extend(['print("DS1000_PASS")', ""])
    return "\n".join(parts)


def grade_snippet(
    problem: dict[str, Any],
    snippet: str,
    timeout: float,
    packages: Sequence[str],
) -> dict[str, Any]:
    started = time.monotonic()
    resolved = grader_packages(problem, packages)
    if not snippet.strip():
        return {
            "passed": False,
            "status": "fail",
            "result": "empty snippet",
            "exit": None,
            "stdout": "",
            "stderr": "",
            "evaluator": "ds1000.code_context",
            "graderPackages": list(resolved),
            "wall_s": 0.0,
        }
    env = dict(os.environ)
    # Matplotlib problems save a figure. Without a headless backend the grader
    # fails on a display that a benchmark host does not have.
    env.setdefault("MPLBACKEND", "Agg")
    with tempfile.TemporaryDirectory(prefix="clio-ds1000-") as tmp:
        tmp_dir = Path(tmp)
        (tmp_dir / "snippet.txt").write_text(snippet, encoding="utf-8")
        program_path = tmp_dir / "grade_program.py"
        program_path.write_text(build_grade_program(problem), encoding="utf-8")
        try:
            proc = subprocess.run(
                [*uv_python_cmd(resolved), str(program_path)],
                cwd=tmp_dir,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            return {
                "passed": False,
                "status": "fail",
                "result": "timed out",
                "exit": 124,
                "stdout": (exc.stdout or "")[-4000:] if isinstance(exc.stdout, str) else "",
                "stderr": str(exc)[-4000:],
                "evaluator": "ds1000.code_context",
                "graderPackages": list(resolved),
                "wall_s": round(time.monotonic() - started, 3),
            }
        passed = proc.returncode == 0 and "DS1000_PASS" in proc.stdout
        return {
            "passed": passed,
            "status": "pass" if passed else "fail",
            "result": "passed" if passed else "failed",
            "exit": proc.returncode,
            "stdout": proc.stdout[-4000:],
            "stderr": proc.stderr[-4000:],
            "evaluator": "ds1000.code_context",
            "graderPackages": list(resolved),
            "wall_s": round(time.monotonic() - started, 3),
        }


def grade_attempt(
    problem: dict[str, Any],
    run_dir: Path,
    timeout: float,
    packages: Sequence[str],
) -> dict[str, Any]:
    snippet, snippet_source = resolve_snippet(problem, run_dir)
    (run_dir / "snippet.py").write_text(snippet, encoding="utf-8")
    result = grade_snippet(problem, snippet, timeout, packages)
    result.update(
        {
            "task_id": task_id_of(problem),
            "library": problem_library(problem),
            "perturbation_type": problem_perturbation(problem),
            "snippet_bytes": len(snippet.encode("utf-8")),
            "snippet_source": snippet_source,
        }
    )
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
    by_task: dict[str, list[dict[str, Any]]] = {task_id_of(problem): [] for problem in chosen}
    for row in grade_rows:
        by_task.setdefault(str(row.get("task_id")), []).append(row)
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

    by_library: dict[str, dict[str, int]] = {}
    for problem in chosen:
        bucket = by_library.setdefault(problem_library(problem), {"tasks": 0, "resolved": 0})
        bucket["tasks"] += 1
        if any(row.get("passed") for row in by_task.get(task_id_of(problem), [])):
            bucket["resolved"] += 1

    generation_errors = sum(
        1
        for metric in metrics_rows
        if metric.get("error")
        or metric.get("timed_out")
        or metric.get("exit") not in (0, None)
        or metric.get("empty_snippet")
    )
    measured_rows = [metric for metric in metrics_rows if metric.get("tokens")]
    return {
        "suite": "ds-1000",
        "dataset": DATASET,
        "datasetSplit": DATASET_SPLIT,
        "tasks": len(chosen),
        "samples": len(metrics_rows),
        "resolved": passed_tasks,
        # An error is the harness failing to obtain an answer, not a model
        # answering wrong, so a wrong answer is a failed task rather than an
        # error. This matches the sibling HumanEval and SWE-bench adapters.
        "errors": generation_errors,
        "failedTasks": failed_tasks,
        "byLibrary": dict(sorted(by_library.items())),
        "snippetsFromEventStream": sum(1 for metric in metrics_rows if metric.get("snippet_source") == "events"),
        "passedSamples": sum(1 for row in grade_rows if row.get("passed")),
        "failedSamples": sum(1 for row in grade_rows if not row.get("passed")),
        "passAt": pass_at,
        "timedOut": sum(1 for metric in metrics_rows if metric.get("timed_out")),
        "emptySnippets": sum(1 for metric in metrics_rows if metric.get("empty_snippet")),
        "wallSeconds": round(
            sum(float(metric.get("wall_s") or 0) for metric in metrics_rows)
            + sum(float(row.get("wall_s") or 0) for row in grade_rows),
            3,
        ),
        # Counted only over the attempts that actually reported usage, and
        # reported next to that coverage: a suite total of 0 across unobserved
        # attempts would claim the work was free, so absence stays absent.
        "tokens": sum(int(metric.get("tokens") or 0) for metric in measured_rows) if measured_rows else None,
        "tokensMeasuredAttempts": len(measured_rows),
        "tokensTotalAttempts": len(metrics_rows),
        "scoringRule": (
            "DS-1000 pass means the generated snippet satisfies the problem's own "
            "code_context test_execution, and its test_string surface-form check when the problem has one."
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
    notes: list[str],
    *,
    inherit_provenance: bool = False,
) -> tuple[Path, Path]:
    recorded_model, recorded_profile = recorded_provenance(out_dir) if inherit_provenance else (None, None)
    return write_result_manifest(
        out_dir,
        suite="ds-1000",
        dataset=DATASET,
        dataset_split=DATASET_SPLIT,
        model=recorded_model or ds1000_model(model),
        profile=recorded_profile or ds1000_target_profile(target, model),
        instances=len(chosen),
        resolved=int(summary.get("resolved") or 0),
        errors=int(summary.get("errors") or 0),
        artifact_paths=generated_artifacts(out_dir),
        summary=summary,
        notes=notes,
        clio_bin=CLIO,
    )


SUITE_NOTES = [
    "DS-1000 grading executes model-generated Python. Run this adapter in a sandbox for untrusted code.",
    "Resolved counts are task-level: a task is resolved when any generated sample passes.",
    "Grading dependencies are resolved per problem from its declared library and code_context imports unless --with or DS1000_GRADER_WITH pins them.",
]


def run_suite(args: argparse.Namespace) -> int:
    if not (args.task_id or args.limit or args.library or args.all):
        raise DataBlocked("select tasks with --task-id, --library, --limit, or --all")
    if args.samples_per_task < 1:
        raise ValueError("--samples-per-task must be at least 1")
    if any(k < 1 for k in args.pass_at):
        raise ValueError("--pass-at values must be at least 1")
    problems, source = load_problems(args.data)
    chosen = selected_problems(problems, args.task_id, args.library, args.limit, args.offset)
    if not chosen:
        print("no DS-1000 tasks matched", file=sys.stderr)
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

    print(f"running {len(chosen)} DS-1000 task(s) from {source} -> {out_dir}", file=sys.stderr)
    with (
        metrics_path.open("w", encoding="utf-8") as metrics,
        samples_path.open("w", encoding="utf-8") as samples,
        results_path.open("w", encoding="utf-8") as results,
    ):
        for task_index, problem in enumerate(chosen, 1):
            task_id = task_id_of(problem)
            for sample_id in range(args.samples_per_task):
                sample_dir = out_dir / "tasks" / task_slug(task_id) / f"sample-{sample_id:03d}"
                print(
                    f"[{task_index}/{len(chosen)}] {task_id} ({problem_library(problem)}) "
                    f"sample {sample_id + 1}/{args.samples_per_task} ...",
                    file=sys.stderr,
                    flush=True,
                )
                try:
                    metric, snippet = generate_attempt(
                        problem,
                        sample_dir,
                        args.timeout,
                        args.target,
                        args.model,
                        force=args.force,
                        dry_run=args.dry_run,
                    )
                    metric["sample_id"] = sample_id
                    sample = {"task_id": task_id, "snippet": snippet, "sample_id": sample_id}
                    grade = grade_attempt(problem, sample_dir, args.grade_timeout, args.grader_with)
                    grade["sample_id"] = sample_id
                except DataBlocked:
                    raise
                except Exception as exc:
                    metric = {"task_id": task_id, "sample_id": sample_id, "error": str(exc)[:400], "exit": None}
                    sample = {"task_id": task_id, "snippet": "", "sample_id": sample_id}
                    grade = {
                        "task_id": task_id,
                        "sample_id": sample_id,
                        "passed": False,
                        "status": "error",
                        "result": str(exc)[:400],
                    }
                    if not args.continue_on_error:
                        raise
                metrics_rows.append(metric)
                grade_rows.append(grade)
                metrics.write(json.dumps(metric) + "\n")
                metrics.flush()
                samples.write(json.dumps(sample) + "\n")
                samples.flush()
                results.write(json.dumps(grade) + "\n")
                results.flush()
                print(
                    f"  -> exit={metric.get('exit')} pass={grade.get('passed')} "
                    f"tokens={metric.get('tokens')} bytes={metric.get('snippet_bytes')}",
                    file=sys.stderr,
                )

    summary = suite_summary(chosen, metrics_rows, grade_rows, args.pass_at)
    manifest_path, summary_path = write_suite_manifest(
        out_dir, chosen, summary, args.model, args.target, notes=list(SUITE_NOTES)
    )
    print(f"manifest: {manifest_path}", file=sys.stderr)
    print(f"summary: {summary_path}", file=sys.stderr)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def regrade_suite(args: argparse.Namespace) -> int:
    """Rescore a finished run directory without calling a model again.

    A thousand tasks cost hours of a local fleet's time, so a change to the
    grading timeout, the pinned grader environment, or snippet resolution had
    no way to be applied except by generating every answer a second time. The
    generated attempts are already on disk; this reads them, regrades them, and
    rewrites the same suite artifacts the run wrote.
    """
    out_dir = Path(args.out)
    metrics_path = out_dir / "metrics.jsonl"
    if not metrics_path.exists():
        raise DataBlocked(f"no generation record to regrade: {metrics_path}")
    problems, _ = load_problems(args.data)
    metrics_rows = read_jsonl(metrics_path)
    ordered_ids: list[str] = []
    for row in metrics_rows:
        task_id = str(row.get("task_id", ""))
        if task_id and task_id not in ordered_ids:
            ordered_ids.append(task_id)
    missing = [task_id for task_id in ordered_ids if task_id not in problems]
    if missing:
        raise KeyError(f"task ids in {metrics_path} are not in the dataset: {missing[:5]}")
    chosen = [problems[task_id] for task_id in ordered_ids]

    grade_rows: list[dict[str, Any]] = []
    sample_rows: list[dict[str, Any]] = []
    print(f"regrading {len(metrics_rows)} attempt(s) across {len(chosen)} task(s) in {out_dir}", file=sys.stderr)
    for index, metric in enumerate(metrics_rows, 1):
        task_id = str(metric["task_id"])
        sample_id = int(metric.get("sample_id") or 0)
        sample_dir = out_dir / "tasks" / task_slug(task_id) / f"sample-{sample_id:03d}"
        if not sample_dir.exists():
            raise DataBlocked(f"generated attempt directory missing: {sample_dir}")
        problem = problems[task_id]
        snippet, snippet_source = resolve_snippet(problem, sample_dir)
        # The metric row is the generation record, and these three fields are
        # the part of it that describes the snippet rather than the run, so
        # they follow the resolution that just happened.
        metric["snippet_bytes"] = len(snippet.encode("utf-8"))
        metric["snippet_source"] = snippet_source
        metric["empty_snippet"] = not snippet.strip()
        grade = grade_attempt(problem, sample_dir, args.grade_timeout, args.grader_with)
        grade["sample_id"] = sample_id
        grade_rows.append(grade)
        sample_rows.append({"task_id": task_id, "snippet": snippet, "sample_id": sample_id})
        print(f"[{index}/{len(metrics_rows)}] {task_id} pass={grade.get('passed')} source={snippet_source}", file=sys.stderr)

    write_jsonl(metrics_path, metrics_rows)
    write_jsonl(out_dir / "samples.jsonl", sample_rows)
    write_jsonl(out_dir / "results.jsonl", grade_rows)
    summary = suite_summary(chosen, metrics_rows, grade_rows, args.pass_at)
    manifest_path, summary_path = write_suite_manifest(
        out_dir,
        chosen,
        summary,
        args.model,
        args.target,
        notes=[*SUITE_NOTES, "Rescored from the attempts already in this directory; no model was called."],
        inherit_provenance=True,
    )
    print(f"manifest: {manifest_path}", file=sys.stderr)
    print(f"summary: {summary_path}", file=sys.stderr)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def run_task(args: argparse.Namespace) -> int:
    problems, _ = load_problems(args.data)
    task_id = normalize_task_id(args.task_id)
    if task_id not in problems:
        raise KeyError(f"task id not found: {task_id}")
    run_dir = Path(args.out)
    if run_dir.exists() and any(run_dir.iterdir()) and not args.force:
        raise FileExistsError(f"output directory is not empty: {run_dir}; pass --force to replace it")
    metric, snippet = generate_attempt(
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
    write_jsonl(run_dir / "samples.jsonl", [{"task_id": task_id, "snippet": snippet, "sample_id": 0}])
    summary = {
        "suite": "ds-1000",
        "dataset": DATASET,
        "datasetSplit": DATASET_SPLIT,
        "taskId": task_id,
        "library": metric.get("library"),
        "generated": True,
        "resolved": 0,
        "errors": 1 if metric.get("timed_out") or metric.get("exit") not in (0, None) or metric.get("empty_snippet") else 0,
        "emptySnippet": bool(metric.get("empty_snippet")),
        "snippetSource": metric.get("snippet_source"),
        # Absent rather than zero when the attempt's run reported no usage.
        "tokens": metric.get("tokens"),
        "tokensMeasured": bool(metric.get("tokens_measured")),
    }
    write_suite_manifest(
        run_dir,
        [problems[task_id]],
        summary,
        args.model,
        args.target,
        notes=["Generation-only manifest. grade-task rewrites this directory with scored results."],
    )
    print(json.dumps(metric, indent=2, sort_keys=True))
    return 0 if metric.get("exit") == 0 else 1


def grade_task(args: argparse.Namespace) -> int:
    problems, _ = load_problems(args.data)
    task_id = normalize_task_id(args.task_id)
    if task_id not in problems:
        raise KeyError(f"task id not found: {task_id}")
    run_dir = Path(args.run)
    result = grade_attempt(problems[task_id], run_dir, args.timeout, args.grader_with)
    result["sample_id"] = 0
    write_jsonl(run_dir / "results.jsonl", [result])
    summary = {
        "suite": "ds-1000",
        "dataset": DATASET,
        "datasetSplit": DATASET_SPLIT,
        "taskId": task_id,
        "library": result.get("library"),
        "samples": 1,
        "resolved": 1 if result.get("passed") else 0,
        # A failed check is a wrong answer, not a harness error; run-task
        # already recorded the generation errors this directory saw.
        "errors": 0,
        "failedTasks": 0 if result.get("passed") else 1,
        "snippetSource": result.get("snippet_source"),
        "passedSamples": 1 if result.get("passed") else 0,
        "failedSamples": 0 if result.get("passed") else 1,
        "passAt": {"pass@1": 1.0 if result.get("passed") else 0.0},
        "graderPackages": result.get("graderPackages"),
        "scoringRule": (
            "DS-1000 pass means the generated snippet satisfies the problem's own code_context "
            "test_execution, and its test_string surface-form check when the problem has one."
        ),
    }
    write_suite_manifest(
        run_dir,
        [problems[task_id]],
        summary,
        None,
        None,
        notes=["Scored by the upstream DS-1000 code_context."],
        inherit_provenance=True,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result.get("passed") else 1


def add_data_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--data", default=None, help=f"ds1000.jsonl(.gz); default: {DEFAULT_DATA}")


def add_selection_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--task-id", action="append", default=[], help="task id such as DS-1000/0 or just 0; repeatable")
    parser.add_argument(
        "--library",
        action="append",
        default=[],
        help="restrict to a library: Pandas, Numpy, Matplotlib, Scipy, Sklearn, Pytorch, Tensorflow; repeatable",
    )
    parser.add_argument("--limit", type=int, default=0, help="limit selected tasks")
    parser.add_argument("--offset", type=int, default=0, help="skip this many tasks before applying --limit")
    parser.add_argument("--all", action="store_true", help="run all selected/default tasks")


def add_clio_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--timeout", type=int, default=300, help="per-sample Clio wall-clock timeout in seconds")
    parser.add_argument(
        "--target",
        type=explicit_target,
        default=None,
        help="configured clio-coder target id (required unless --dry-run is used)",
    )
    parser.add_argument("--model", default=None, help="clio-coder --model override")
    parser.add_argument("--force", action="store_true", help="replace existing run directories")
    parser.add_argument("--dry-run", action="store_true", help="render prompts and seed solution.py without calling Clio")


def add_grade_args(parser: argparse.ArgumentParser, *, timeout_flag: str = "--grade-timeout") -> None:
    parser.add_argument(
        timeout_flag,
        dest="grade_timeout" if timeout_flag == "--grade-timeout" else "timeout",
        type=float,
        default=120.0,
        help="per-snippet grading timeout in seconds; torch and tensorflow problems need the headroom",
    )
    parser.add_argument(
        "--with",
        dest="grader_with",
        action="append",
        default=[],
        help="pin a grading dependency, e.g. --with 'pandas==1.3.5'; repeatable and replaces the derived set",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    ensure = sub.add_parser("ensure-data", help="download the official DS-1000 JSONL.GZ into an untracked data dir")
    ensure.add_argument("--out", default=None, help=f"output path; default: {DEFAULT_DATA}")
    ensure.add_argument("--force", action="store_true")
    ensure.add_argument("--timeout", type=int, default=60)
    ensure.set_defaults(func=ensure_data)

    inspect = sub.add_parser("inspect-data", help="summarize the dataset by library and perturbation")
    add_data_arg(inspect)
    inspect.set_defaults(func=inspect_data)

    run = sub.add_parser("run", help="run and grade selected DS-1000 tasks")
    add_data_arg(run)
    add_selection_args(run)
    run.add_argument("--out", required=True)
    run.add_argument("--samples-per-task", type=int, default=1)
    run.add_argument("--pass-at", type=int, action="append", default=[1], help="pass@k values to report; repeatable")
    run.add_argument("--continue-on-error", action="store_true", help="keep running after adapter errors")
    add_clio_args(run)
    add_grade_args(run)
    run.set_defaults(func=run_suite)

    again = sub.add_parser("regrade", help="rescore an existing run directory without calling a model")
    add_data_arg(again)
    again.add_argument("--out", required=True, help="run directory a previous `run` produced")
    again.add_argument("--pass-at", type=int, action="append", default=[1], help="pass@k values to report; repeatable")
    again.add_argument("--target", default=None, help="target recorded in the manifest when it records none")
    again.add_argument("--model", default=None, help="model recorded in the manifest when it records none")
    add_grade_args(again)
    again.set_defaults(func=regrade_suite)

    one = sub.add_parser("run-task", help="run Clio for one DS-1000 task")
    add_data_arg(one)
    one.add_argument("--task-id", required=True)
    one.add_argument("--out", required=True)
    add_clio_args(one)
    one.set_defaults(func=run_task)

    grade = sub.add_parser("grade-task", help="grade one generated DS-1000 task directory")
    add_data_arg(grade)
    grade.add_argument("--task-id", required=True)
    grade.add_argument("--run", required=True)
    add_grade_args(grade, timeout_flag="--timeout")
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

#!/usr/bin/env -S uv run --no-project python
"""MultiPL-E adapter for Clio Coder.

MultiPL-E translates HumanEval and MBPP into other programming languages by
compiling their prompts, doctests, and unit tests through per-language
translators. Every other suite in this tree is Python. This one is the reason a
report can say anything about the languages scientific and HPC code is actually
written in.

This adapter supports the compiled and JIT languages that matter for that
audience: C++, Rust, and Julia. Adding another of MultiPL-E's languages is a
row in `LANGUAGES` plus its build and run commands.

A task is graded by concatenating the prompt, the generated completion, and the
task's own test block, then compiling and running the result. The upstream test
block is the authoritative grader, and a non-zero exit is a failure exactly as
upstream treats it.

Completions are truncated at the language's `stop_tokens` before grading, which
is what upstream does. That truncation is also what lets an agent write a whole
function naturally in C++ and Rust, where the test block supplies the closing
brace: a completion that closes the function is cut back at `\\n}` and the test
block closes it instead.

WARNING: grading compiles and runs model-generated native code. Run in a
sandbox or container for untrusted models or prompts.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import urllib.parse
import urllib.request
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
ADAPTER_DIR = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = Path(os.environ.get("MULTIPLE_DATA_DIR", ADAPTER_DIR / "data"))
DATASET = "nuprl/MultiPL-E"
DEFAULT_BENCHMARK = "humaneval"
DEFAULT_LANGUAGE = "cpp"
ROWS_API = "https://datasets-server.huggingface.co/rows"
CLIO = os.environ.get("CLIO_CODER_BIN", "clio-coder")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from clio_process import run_json_command
from clio_usage import fold_message_end_usage, receipt_total_tokens, run_id_from_events
from result_manifest import target_profile, write_result_manifest

CODE_BLOCK_RE = re.compile(r"```[A-Za-z+#-]*\s*\n(.*?)```", re.DOTALL)


class Language:
    """One MultiPL-E language: its file name, how to build it, how to run it."""

    def __init__(
        self,
        key: str,
        display: str,
        extension: str,
        toolchain_env: str,
        toolchain_default: str,
        build: tuple[str, ...] | None,
        run: tuple[str, ...],
        fence: str,
    ) -> None:
        self.key = key
        self.display = display
        self.extension = extension
        self.toolchain_env = toolchain_env
        self.toolchain_default = toolchain_default
        self.build = build
        self.run = run
        self.fence = fence

    @property
    def toolchain(self) -> str:
        return os.environ.get(self.toolchain_env, self.toolchain_default)

    def build_cmd(self, source: Path, binary: Path) -> list[str] | None:
        if self.build is None:
            return None
        return [
            self.toolchain if part == "@tool" else part.replace("@source", str(source)).replace("@binary", str(binary))
            for part in self.build
        ]

    def run_cmd(self, source: Path, binary: Path) -> list[str]:
        return [
            self.toolchain if part == "@tool" else part.replace("@source", str(source)).replace("@binary", str(binary))
            for part in self.run
        ]


LANGUAGES: dict[str, Language] = {
    "cpp": Language(
        key="cpp",
        display="C++",
        extension=".cpp",
        toolchain_env="CXX",
        toolchain_default="g++",
        # MultiPL-E's C++ prompts include <bits/stdc++.h>, which is a GCC
        # header. clang++ needs it supplied separately.
        build=("@tool", "-std=c++17", "-O1", "-w", "-o", "@binary", "@source"),
        run=("@binary",),
        fence="cpp",
    ),
    "rs": Language(
        key="rs",
        display="Rust",
        extension=".rs",
        toolchain_env="RUSTC",
        toolchain_default="rustc",
        build=("@tool", "--edition", "2021", "-O", "-A", "warnings", "-o", "@binary", "@source"),
        run=("@binary",),
        fence="rust",
    ),
    "jl": Language(
        key="jl",
        display="Julia",
        extension=".jl",
        toolchain_env="JULIA",
        toolchain_default="julia",
        build=None,
        run=("@tool", "--startup-file=no", "@source"),
        fence="julia",
    ),
}
BENCHMARKS = ("humaneval", "mbpp")


class DataBlocked(RuntimeError):
    """Raised when the adapter is wired but required public data is absent."""


class ToolchainMissing(RuntimeError):
    """Raised when the language's compiler or interpreter is not installed."""


def multiple_model(model: str | None) -> str:
    return (
        model
        or os.environ.get("CLIO_CODER_PRED_MODEL")
        or os.environ.get("CLIO_CODER_MODEL")
        or os.environ.get("CLIO_CODER_MAIN_MODEL")
        or "unspecified"
    )


def multiple_target_profile(target: str | None, model: str | None) -> dict[str, str]:
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


def language_for(key: str) -> Language:
    if key not in LANGUAGES:
        raise DataBlocked(f"unsupported language {key}; supported: {', '.join(sorted(LANGUAGES))}")
    return LANGUAGES[key]


def config_name(benchmark: str, language: str) -> str:
    if benchmark not in BENCHMARKS:
        raise DataBlocked(f"unknown benchmark {benchmark}; known: {', '.join(BENCHMARKS)}")
    return f"{benchmark}-{language}"


def task_id_of(record: dict[str, Any], language: str) -> str:
    return f"MultiPL-E/{language}/{record.get('name')}"


def normalize_task_id(task_id: str, language: str) -> str:
    value = str(task_id).strip()
    if value.startswith("MultiPL-E/"):
        return value
    return f"MultiPL-E/{language}/{value}"


def task_slug(task_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", task_id)


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


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


def data_path(data_dir: Path, benchmark: str, language: str) -> Path:
    return data_dir / f"multipl-e-{benchmark}-{language}.jsonl"


def fetch_rows(config: str, timeout: int) -> list[dict[str, Any]]:
    """Page the config through the public rows API.

    The parquet files are small, but reading them would add a parquet
    dependency to an adapter whose only other requirement is the standard
    library. The rows API returns the same records as JSON.
    """
    rows: list[dict[str, Any]] = []
    offset = 0
    page = 100
    while True:
        query = urllib.parse.urlencode(
            {"dataset": DATASET, "config": config, "split": "test", "offset": offset, "length": page}
        )
        with urllib.request.urlopen(f"{ROWS_API}?{query}", timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        batch = payload.get("rows") or []
        if not batch:
            break
        rows.extend(entry["row"] for entry in batch if isinstance(entry, dict) and isinstance(entry.get("row"), dict))
        total = int(payload.get("num_rows_total") or 0)
        offset += len(batch)
        print(f"  fetched {len(rows)}/{total or '?'}", file=sys.stderr, flush=True)
        if total and offset >= total:
            break
    return rows


def load_problems(data_dir: Path, benchmark: str, language: str) -> tuple[dict[str, dict[str, Any]], str]:
    path = data_path(data_dir, benchmark, language)
    if not path.exists():
        raise DataBlocked(
            f"MultiPL-E data not found: {path}. "
            f"Run `ensure-data --benchmark {benchmark} --language {language}` first."
        )
    rows = read_jsonl(path)
    problems = {task_id_of(row, language): row for row in rows}
    if not problems:
        raise DataBlocked(f"MultiPL-E data is empty: {path}")
    return problems, str(path)


def stop_tokens(record: dict[str, Any]) -> list[str]:
    raw = record.get("stop_tokens")
    if isinstance(raw, list):
        return [str(item) for item in raw]
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return []
        return [str(item) for item in parsed] if isinstance(parsed, list) else []
    return []


def tests_close_block(record: dict[str, Any]) -> bool:
    """Whether the task's test block closes the function the prompt opened.

    C++ and Rust prompts end inside the function body and the test block starts
    with the closing brace. Julia's test block does not, so a Julia completion
    has to write its own `end`. Reading this from the data rather than
    hardcoding it per language keeps a newly added language honest.
    """
    return str(record.get("tests") or "").lstrip().startswith(("}", "}\n"))


def truncate_at_stop_tokens(completion: str, tokens: Sequence[str]) -> str:
    """Cut a completion at the earliest stop token, exactly as upstream does.

    This is also what makes an agent's natural output work in C++ and Rust. An
    agent that writes and closes the whole function produces a completion
    ending in `\\n}`, which is a stop token, so the closing brace is cut and the
    test block supplies it instead of the program having two.
    """
    cut = len(completion)
    for token in tokens:
        if not token:
            continue
        index = completion.find(token)
        if index != -1:
            cut = min(cut, index)
    return completion[:cut]


def public_problem(record: dict[str, Any], language: str) -> dict[str, Any]:
    """The part of a problem that may be written into a run directory.

    `tests` is the grader and stays out of the agent's workspace so a run
    directory can be inspected, shared, or replayed without leaking the
    assertions into the next attempt.
    """
    return {
        "task_id": task_id_of(record, language),
        "name": record.get("name"),
        "language": record.get("language"),
        "prompt": record.get("prompt", ""),
        "stop_tokens": stop_tokens(record),
        "tests_close_block": tests_close_block(record),
    }


def selected_problems(
    problems: dict[str, dict[str, Any]],
    task_ids: list[str],
    language: str,
    limit: int,
    offset: int,
) -> list[dict[str, Any]]:
    if task_ids:
        selected = []
        for raw in task_ids:
            task_id = normalize_task_id(raw, language)
            if task_id not in problems:
                raise KeyError(f"task id not found: {task_id}")
            selected.append(problems[task_id])
        return selected
    ordered = sorted(problems.values(), key=lambda record: str(record.get("name")))
    if offset:
        ordered = ordered[offset:]
    return ordered[:limit] if limit > 0 else ordered


def toolchain_available(language: Language) -> bool:
    return shutil.which(language.toolchain) is not None


def ensure_data(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    data_dir.mkdir(parents=True, exist_ok=True)
    out = data_path(data_dir, args.benchmark, args.language)
    if out.exists() and not args.force:
        print(f"MultiPL-E data already exists: {out}", file=sys.stderr)
        return 0
    config = config_name(args.benchmark, args.language)
    print(f"fetching {DATASET} config {config} -> {out}", file=sys.stderr)
    rows = fetch_rows(config, args.timeout)
    if not rows:
        raise DataBlocked(f"{DATASET} config {config} returned no rows")
    write_jsonl(out, rows)
    print(json.dumps({"path": str(out), "config": config, "tasks": len(rows)}, indent=2, sort_keys=True))
    return 0


def inspect_data(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    language = language_for(args.language)
    problems, source = load_problems(data_dir, args.benchmark, args.language)
    ordered = sorted(problems.values(), key=lambda record: str(record.get("name")))
    payload = {
        "dataset": DATASET,
        "datasetSplit": config_name(args.benchmark, args.language),
        "language": language.display,
        "source": source,
        "tasks": len(ordered),
        "toolchain": language.toolchain,
        "toolchainAvailable": toolchain_available(language),
        "testsCloseBlock": sum(1 for record in ordered if tests_close_block(record)),
        "firstTask": task_id_of(ordered[0], args.language) if ordered else None,
        "lastTask": task_id_of(ordered[-1], args.language) if ordered else None,
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


TESTS_CLOSE_NOTE = (
    "- Do not write the closing brace of the function. The test block supplies\n"
    "  it, and a second one will not compile.\n"
)
SELF_CLOSE_NOTE = "- Close the function yourself. The test block does not close it.\n"

# The template is dedented once, here, and only then interpolated. Interpolating
# first would splice multi-line values in at column zero and leave textwrap with
# no common prefix to strip, which silently indents the whole prompt.
PROMPT_TEMPLATE = textwrap.dedent(
    """\
    You are solving MultiPL-E task {name} in {display}.

    The working directory contains `solution{extension}`, already seeded with the
    signature and its documentation. Complete the implementation in that file.

    Constraints:
    - Keep everything the file already contains. Write the body only.
    {closing}- Do not add a `main`, tests, example runners, or debug output. The grader
      appends its own test block with a `main`.
    - Use only what the seeded includes or imports already provide, plus the
      language's standard library.
    - Do not read from stdin, write files, or use the network.
    - Stop after `solution{extension}` contains the final answer.

    Seeded file:
    ```{fence}
    {seed}
    ```
    """
)


def render_clio_prompt(record: dict[str, Any], language: Language) -> str:
    return PROMPT_TEMPLATE.format(
        name=record.get("name"),
        display=language.display,
        extension=language.extension,
        closing=TESTS_CLOSE_NOTE if tests_close_block(record) else SELF_CLOSE_NOTE,
        fence=language.fence,
        seed=str(record.get("prompt", "")).rstrip("\n"),
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
    code, timed_out, stderr = run_json_command(cmd, cwd=cwd, events_path=events_path, timeout=timeout)
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


def extract_code_from_events(events_path: Path) -> str | None:
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
        matches.extend(match.group(1) for match in CODE_BLOCK_RE.finditer(chunk))
    return matches[-1].strip() + "\n" if matches else None


def completion_from_solution(record: dict[str, Any], solution_text: str) -> str:
    prompt = str(record.get("prompt", ""))
    if solution_text.startswith(prompt):
        return solution_text[len(prompt) :]
    stripped = solution_text.strip("\n")
    if not stripped:
        return ""
    # A model that rewrote the whole file, or answered with a fenced block
    # containing the signature, still produced a body. Cutting at the prompt's
    # last line recovers it without assuming the file matched byte for byte.
    anchor = prompt.rstrip("\n").splitlines()[-1] if prompt.strip() else ""
    if anchor and anchor in stripped:
        return stripped.split(anchor, 1)[1] + "\n"
    return "\n" + stripped + "\n"


def resolve_completion(record: dict[str, Any], run_dir: Path, language: Language) -> tuple[str, str]:
    """The completion to grade, and where it came from.

    The task tells the agent to leave its answer in the seeded file, and that
    file is the first source. An agent that answered with a code block and
    never edited the file leaves the seed exactly as written, which yields an
    empty completion; the event stream still carries the answer, so it is read
    rather than grading the seed against itself. The source travels with the
    completion because an answer recovered from the stream means the agent
    solved the task but ignored the file contract, and a reader must be able to
    subtract those from a headline score.
    """
    solution_path = run_dir / f"solution{language.extension}"
    if solution_path.exists():
        completion = completion_from_solution(record, solution_path.read_text(encoding="utf-8", errors="replace"))
        if completion.strip():
            return completion, solution_path.name
    extracted = extract_code_from_events(run_dir / "events" / "clio.jsonl")
    if extracted:
        completion = completion_from_solution(record, extracted)
        if completion.strip():
            return completion, "events"
    return "", "empty"


def generated_artifacts(run_dir: Path, language: Language, *extra: Path) -> list[Path]:
    candidates = [
        run_dir / "metrics.jsonl",
        run_dir / "samples.jsonl",
        run_dir / "results.jsonl",
        run_dir / "result.json",
        run_dir / f"solution{language.extension}",
        run_dir / "completion.txt",
        run_dir / "problem-public.json",
        *extra,
    ]
    tasks_dir = run_dir / "tasks"
    if tasks_dir.exists():
        candidates.extend(sorted(tasks_dir.glob(f"**/solution{language.extension}")))
        candidates.extend(sorted(tasks_dir.glob("**/result.json")))
    return [path for path in candidates if path.exists()]


def generate_attempt(
    record: dict[str, Any],
    run_dir: Path,
    language: Language,
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
    prompt_text = render_clio_prompt(record, language)
    (run_dir / "prompt.md").write_text(prompt_text, encoding="utf-8")
    (run_dir / "problem-public.json").write_text(
        json.dumps(public_problem(record, language.key), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    solution_path = run_dir / f"solution{language.extension}"
    if not solution_path.exists() or force:
        solution_path.write_text(str(record.get("prompt", "")), encoding="utf-8")

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

    completion, completion_source = resolve_completion(record, run_dir, language)
    (run_dir / "completion.txt").write_text(completion, encoding="utf-8")
    events_path = run_dir / "events" / "clio.jsonl"
    run_id = run_id_from_events(events_path)
    observed_usage = fold_message_end_usage(events_path)
    stream_tokens = None if observed_usage is None else observed_usage["totalTokens"]
    metric.update(
        {
            "task_id": task_id_of(record, language.key),
            "language": language.key,
            "tokens": receipt_total_tokens(run_id) or stream_tokens,
            "tokens_measured": stream_tokens is not None,
            "run_id": run_id,
            "completion_bytes": len(completion.encode("utf-8")),
            "completion_source": completion_source,
            "empty_completion": not completion.strip(),
        }
    )
    return metric, completion


def build_program(record: dict[str, Any], completion: str) -> str:
    truncated = truncate_at_stop_tokens(completion, stop_tokens(record))
    return str(record.get("prompt", "")) + truncated + "\n" + str(record.get("tests") or "")


def grade_completion(
    record: dict[str, Any],
    completion: str,
    language: Language,
    build_timeout: float,
    run_timeout: float,
) -> dict[str, Any]:
    started = time.monotonic()
    base = {
        "evaluator": f"multipl-e.{language.key}",
        "language": language.key,
        "toolchain": language.toolchain,
    }
    if not completion.strip():
        return {
            **base,
            "passed": False,
            "status": "fail",
            "result": "empty completion",
            "stage": "resolve",
            "exit": None,
            "wall_s": 0.0,
        }
    if not toolchain_available(language):
        raise ToolchainMissing(
            f"{language.display} toolchain `{language.toolchain}` is not on PATH; "
            f"install it or set {language.toolchain_env}"
        )
    program = build_program(record, completion)
    with tempfile.TemporaryDirectory(prefix="clio-multiple-") as tmp:
        tmp_dir = Path(tmp)
        source = tmp_dir / f"program{language.extension}"
        binary = tmp_dir / "program"
        source.write_text(program, encoding="utf-8")
        build_cmd = language.build_cmd(source, binary)
        if build_cmd:
            try:
                built = subprocess.run(
                    build_cmd, cwd=tmp_dir, capture_output=True, text=True, timeout=build_timeout, check=False
                )
            except subprocess.TimeoutExpired:
                return {
                    **base,
                    "passed": False,
                    "status": "fail",
                    "result": "build timed out",
                    "stage": "build",
                    "exit": 124,
                    "wall_s": round(time.monotonic() - started, 3),
                }
            if built.returncode != 0:
                return {
                    **base,
                    "passed": False,
                    "status": "fail",
                    "result": "build failed",
                    "stage": "build",
                    "exit": built.returncode,
                    "stdout": built.stdout[-4000:],
                    "stderr": built.stderr[-4000:],
                    "wall_s": round(time.monotonic() - started, 3),
                }
        try:
            ran = subprocess.run(
                language.run_cmd(source, binary),
                cwd=tmp_dir,
                capture_output=True,
                text=True,
                timeout=run_timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return {
                **base,
                "passed": False,
                "status": "fail",
                "result": "run timed out",
                "stage": "run",
                "exit": 124,
                "wall_s": round(time.monotonic() - started, 3),
            }
        passed = ran.returncode == 0
        return {
            **base,
            "passed": passed,
            "status": "pass" if passed else "fail",
            "result": "passed" if passed else "tests failed",
            "stage": "run",
            "exit": ran.returncode,
            "stdout": ran.stdout[-4000:],
            "stderr": ran.stderr[-4000:],
            "wall_s": round(time.monotonic() - started, 3),
        }


def grade_attempt(
    record: dict[str, Any],
    run_dir: Path,
    language: Language,
    build_timeout: float,
    run_timeout: float,
) -> dict[str, Any]:
    completion, completion_source = resolve_completion(record, run_dir, language)
    (run_dir / "completion.txt").write_text(completion, encoding="utf-8")
    result = grade_completion(record, completion, language, build_timeout, run_timeout)
    result.update(
        {
            "task_id": task_id_of(record, language.key),
            "completion_bytes": len(completion.encode("utf-8")),
            "completion_source": completion_source,
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
    benchmark: str,
    language: Language,
) -> dict[str, Any]:
    by_task: dict[str, list[dict[str, Any]]] = {task_id_of(record, language.key): [] for record in chosen}
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
    generation_errors = sum(
        1
        for metric in metrics_rows
        if metric.get("error")
        or metric.get("timed_out")
        or metric.get("exit") not in (0, None)
        or metric.get("empty_completion")
    )
    measured_rows = [metric for metric in metrics_rows if metric.get("tokens")]
    return {
        "suite": "multipl-e",
        "dataset": DATASET,
        "datasetSplit": config_name(benchmark, language.key),
        "language": language.key,
        "toolchain": language.toolchain,
        "tasks": len(chosen),
        "samples": len(metrics_rows),
        "resolved": passed_tasks,
        # An error is the harness failing to obtain an answer, not a model
        # answering wrong, so a wrong answer is a failed task rather than an
        # error. This matches the sibling HumanEval and SWE-bench adapters.
        "errors": generation_errors,
        "failedTasks": len(chosen) - passed_tasks,
        # A build failure is a wrong answer in a compiled language, not a
        # harness error, so it is reported beside the score rather than folded
        # into it. It is the number that separates "cannot write this language"
        # from "wrote the wrong algorithm".
        "buildFailures": sum(1 for row in grade_rows if row.get("stage") == "build"),
        "runFailures": sum(1 for row in grade_rows if row.get("stage") == "run" and not row.get("passed")),
        "completionsFromEventStream": sum(1 for metric in metrics_rows if metric.get("completion_source") == "events"),
        "passedSamples": sum(1 for row in grade_rows if row.get("passed")),
        "failedSamples": sum(1 for row in grade_rows if not row.get("passed")),
        "passAt": pass_at,
        "timedOut": sum(1 for metric in metrics_rows if metric.get("timed_out")),
        "emptyCompletions": sum(1 for metric in metrics_rows if metric.get("empty_completion")),
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
            "MultiPL-E pass means prompt + truncated completion + the task's test block compiled "
            "and exited zero under the language toolchain."
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
    benchmark: str,
    language: Language,
    notes: list[str],
    *,
    inherit_provenance: bool = False,
) -> tuple[Path, Path]:
    recorded_model, recorded_profile = recorded_provenance(out_dir) if inherit_provenance else (None, None)
    return write_result_manifest(
        out_dir,
        suite="multipl-e",
        dataset=DATASET,
        dataset_split=config_name(benchmark, language.key),
        model=recorded_model or multiple_model(model),
        profile=recorded_profile or multiple_target_profile(target, model),
        instances=len(chosen),
        resolved=int(summary.get("resolved") or 0),
        errors=int(summary.get("errors") or 0),
        artifact_paths=generated_artifacts(out_dir, language),
        summary=summary,
        notes=notes,
        clio_bin=CLIO,
    )


SUITE_NOTES = [
    "MultiPL-E grading compiles and runs model-generated native code. Run this adapter in a sandbox for untrusted code.",
    "Resolved counts are task-level: a task is resolved when any generated sample compiles and exits zero.",
    "Completions are truncated at the language's stop tokens before grading, as upstream does.",
]


def run_suite(args: argparse.Namespace) -> int:
    if not (args.task_id or args.limit or args.all):
        raise DataBlocked("select tasks with --task-id, --limit, or --all")
    if args.samples_per_task < 1:
        raise ValueError("--samples-per-task must be at least 1")
    if any(k < 1 for k in args.pass_at):
        raise ValueError("--pass-at values must be at least 1")
    language = language_for(args.language)
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    problems, source = load_problems(data_dir, args.benchmark, args.language)
    chosen = selected_problems(problems, args.task_id, args.language, args.limit, args.offset)
    if not chosen:
        print("no MultiPL-E tasks matched", file=sys.stderr)
        return 2
    if not args.dry_run and not toolchain_available(language):
        raise ToolchainMissing(
            f"{language.display} toolchain `{language.toolchain}` is not on PATH; "
            f"install it or set {language.toolchain_env}"
        )

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

    print(f"running {len(chosen)} MultiPL-E {language.display} task(s) from {source} -> {out_dir}", file=sys.stderr)
    with (
        metrics_path.open("w", encoding="utf-8") as metrics,
        samples_path.open("w", encoding="utf-8") as samples,
        results_path.open("w", encoding="utf-8") as results,
    ):
        for task_index, record in enumerate(chosen, 1):
            task_id = task_id_of(record, language.key)
            for sample_id in range(args.samples_per_task):
                sample_dir = out_dir / "tasks" / task_slug(task_id) / f"sample-{sample_id:03d}"
                print(
                    f"[{task_index}/{len(chosen)}] {task_id} sample {sample_id + 1}/{args.samples_per_task} ...",
                    file=sys.stderr,
                    flush=True,
                )
                try:
                    metric, completion = generate_attempt(
                        record,
                        sample_dir,
                        language,
                        args.timeout,
                        args.target,
                        args.model,
                        force=args.force,
                        dry_run=args.dry_run,
                    )
                    metric["sample_id"] = sample_id
                    sample = {"task_id": task_id, "completion": completion, "sample_id": sample_id}
                    grade = grade_attempt(record, sample_dir, language, args.build_timeout, args.run_timeout)
                    grade["sample_id"] = sample_id
                except (DataBlocked, ToolchainMissing):
                    raise
                except Exception as exc:
                    metric = {"task_id": task_id, "sample_id": sample_id, "error": str(exc)[:400], "exit": None}
                    sample = {"task_id": task_id, "completion": "", "sample_id": sample_id}
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
                    f"stage={grade.get('stage')} tokens={metric.get('tokens')}",
                    file=sys.stderr,
                )

    summary = suite_summary(chosen, metrics_rows, grade_rows, args.pass_at, args.benchmark, language)
    manifest_path, summary_path = write_suite_manifest(
        out_dir, chosen, summary, args.model, args.target, args.benchmark, language, notes=list(SUITE_NOTES)
    )
    print(f"manifest: {manifest_path}", file=sys.stderr)
    print(f"summary: {summary_path}", file=sys.stderr)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def regrade_suite(args: argparse.Namespace) -> int:
    """Rescore a finished run directory without calling a model again.

    A full language pass costs hours of a local fleet's time, so a change to a
    toolchain, a timeout, or completion resolution had no way to be applied
    except by generating every answer a second time. The generated attempts are
    already on disk; this reads them, regrades them, and rewrites the same
    suite artifacts the run wrote.
    """
    out_dir = Path(args.out)
    metrics_path = out_dir / "metrics.jsonl"
    if not metrics_path.exists():
        raise DataBlocked(f"no generation record to regrade: {metrics_path}")
    language = language_for(args.language)
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    problems, _ = load_problems(data_dir, args.benchmark, args.language)
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
        record = problems[task_id]
        completion, completion_source = resolve_completion(record, sample_dir, language)
        # The metric row is the generation record, and these three fields are
        # the part of it that describes the completion rather than the run, so
        # they follow the resolution that just happened.
        metric["completion_bytes"] = len(completion.encode("utf-8"))
        metric["completion_source"] = completion_source
        metric["empty_completion"] = not completion.strip()
        grade = grade_attempt(record, sample_dir, language, args.build_timeout, args.run_timeout)
        grade["sample_id"] = sample_id
        grade_rows.append(grade)
        sample_rows.append({"task_id": task_id, "completion": completion, "sample_id": sample_id})
        print(f"[{index}/{len(metrics_rows)}] {task_id} pass={grade.get('passed')} source={completion_source}", file=sys.stderr)

    write_jsonl(metrics_path, metrics_rows)
    write_jsonl(out_dir / "samples.jsonl", sample_rows)
    write_jsonl(out_dir / "results.jsonl", grade_rows)
    summary = suite_summary(chosen, metrics_rows, grade_rows, args.pass_at, args.benchmark, language)
    manifest_path, summary_path = write_suite_manifest(
        out_dir,
        chosen,
        summary,
        args.model,
        args.target,
        args.benchmark,
        language,
        notes=[*SUITE_NOTES, "Rescored from the attempts already in this directory; no model was called."],
        inherit_provenance=True,
    )
    print(f"manifest: {manifest_path}", file=sys.stderr)
    print(f"summary: {summary_path}", file=sys.stderr)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def run_task(args: argparse.Namespace) -> int:
    language = language_for(args.language)
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    problems, _ = load_problems(data_dir, args.benchmark, args.language)
    task_id = normalize_task_id(args.task_id, args.language)
    if task_id not in problems:
        raise KeyError(f"task id not found: {task_id}")
    run_dir = Path(args.out)
    if run_dir.exists() and any(run_dir.iterdir()) and not args.force:
        raise FileExistsError(f"output directory is not empty: {run_dir}; pass --force to replace it")
    metric, completion = generate_attempt(
        problems[task_id],
        run_dir,
        language,
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
        "suite": "multipl-e",
        "dataset": DATASET,
        "datasetSplit": config_name(args.benchmark, args.language),
        "language": language.key,
        "taskId": task_id,
        "generated": True,
        "resolved": 0,
        "errors": 1 if metric.get("timed_out") or metric.get("exit") not in (0, None) or metric.get("empty_completion") else 0,
        "emptyCompletion": bool(metric.get("empty_completion")),
        "completionSource": metric.get("completion_source"),
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
        args.benchmark,
        language,
        notes=["Generation-only manifest. grade-task rewrites this directory with scored results."],
    )
    print(json.dumps(metric, indent=2, sort_keys=True))
    return 0 if metric.get("exit") == 0 else 1


def grade_task(args: argparse.Namespace) -> int:
    language = language_for(args.language)
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    problems, _ = load_problems(data_dir, args.benchmark, args.language)
    task_id = normalize_task_id(args.task_id, args.language)
    if task_id not in problems:
        raise KeyError(f"task id not found: {task_id}")
    run_dir = Path(args.run)
    result = grade_attempt(problems[task_id], run_dir, language, args.build_timeout, args.run_timeout)
    result["sample_id"] = 0
    write_jsonl(run_dir / "results.jsonl", [result])
    summary = {
        "suite": "multipl-e",
        "dataset": DATASET,
        "datasetSplit": config_name(args.benchmark, args.language),
        "language": language.key,
        "taskId": task_id,
        "samples": 1,
        "resolved": 1 if result.get("passed") else 0,
        # A failed check is a wrong answer, not a harness error; run-task
        # already recorded the generation errors this directory saw.
        "errors": 0,
        "failedTasks": 0 if result.get("passed") else 1,
        "stage": result.get("stage"),
        "completionSource": result.get("completion_source"),
        "passedSamples": 1 if result.get("passed") else 0,
        "failedSamples": 0 if result.get("passed") else 1,
        "passAt": {"pass@1": 1.0 if result.get("passed") else 0.0},
        "scoringRule": (
            "MultiPL-E pass means prompt + truncated completion + the task's test block compiled and exited zero."
        ),
    }
    write_suite_manifest(
        run_dir,
        [problems[task_id]],
        summary,
        None,
        None,
        args.benchmark,
        language,
        notes=["Scored by the upstream MultiPL-E test block."],
        inherit_provenance=True,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result.get("passed") else 1


def add_data_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--data-dir", default=None, help=f"dataset cache; default: {DEFAULT_DATA_DIR}")
    parser.add_argument("--benchmark", default=DEFAULT_BENCHMARK, choices=list(BENCHMARKS), help="source benchmark")
    parser.add_argument(
        "--language",
        default=DEFAULT_LANGUAGE,
        choices=sorted(LANGUAGES),
        help="cpp, rs (Rust), or jl (Julia)",
    )


def add_selection_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--task-id",
        action="append",
        default=[],
        help="task id such as MultiPL-E/cpp/HumanEval_0_has_close_elements, or the bare name; repeatable",
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
    parser.add_argument("--dry-run", action="store_true", help="render prompts and seed the solution file without calling Clio")


def add_grade_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--build-timeout", type=float, default=120.0, help="per-task compile timeout in seconds")
    parser.add_argument("--run-timeout", type=float, default=30.0, help="per-task test-run timeout in seconds")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    ensure = sub.add_parser("ensure-data", help="fetch one benchmark and language into an untracked data dir")
    add_data_args(ensure)
    ensure.add_argument("--force", action="store_true")
    ensure.add_argument("--timeout", type=int, default=120)
    ensure.set_defaults(func=ensure_data)

    inspect = sub.add_parser("inspect-data", help="summarize a config and report toolchain readiness")
    add_data_args(inspect)
    inspect.set_defaults(func=inspect_data)

    run = sub.add_parser("run", help="run and grade selected MultiPL-E tasks")
    add_data_args(run)
    add_selection_args(run)
    run.add_argument("--out", required=True)
    run.add_argument("--samples-per-task", type=int, default=1)
    run.add_argument("--pass-at", type=int, action="append", default=[1], help="pass@k values to report; repeatable")
    run.add_argument("--continue-on-error", action="store_true", help="keep running after adapter errors")
    add_clio_args(run)
    add_grade_args(run)
    run.set_defaults(func=run_suite)

    again = sub.add_parser("regrade", help="rescore an existing run directory without calling a model")
    add_data_args(again)
    again.add_argument("--out", required=True, help="run directory a previous `run` produced")
    again.add_argument("--pass-at", type=int, action="append", default=[1], help="pass@k values to report; repeatable")
    again.add_argument("--target", default=None, help="target recorded in the manifest when it records none")
    again.add_argument("--model", default=None, help="model recorded in the manifest when it records none")
    add_grade_args(again)
    again.set_defaults(func=regrade_suite)

    one = sub.add_parser("run-task", help="run Clio for one MultiPL-E task")
    add_data_args(one)
    one.add_argument("--task-id", required=True)
    one.add_argument("--out", required=True)
    add_clio_args(one)
    one.set_defaults(func=run_task)

    grade = sub.add_parser("grade-task", help="grade one generated MultiPL-E task directory")
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
    except ToolchainMissing as exc:
        print(f"TOOLCHAIN_BLOCKED: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

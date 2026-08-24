#!/usr/bin/env -S uv run --no-project python
"""LiveCodeBench code-generation adapter for Clio Coder.

LiveCodeBench collects competitive-programming problems from LeetCode,
AtCoder, and Codeforces with their contest dates attached, so a run can be
restricted to problems published after a model's training cutoff. That date
window is the reason to run it: it is the cheapest contamination-resistant
number available for a local model.

Each problem is graded by executing the generated program against the
problem's own test cases. LeetCode problems are `functional`, meaning the
program defines `class Solution` and the harness calls one method with decoded
JSON arguments. AtCoder and Codeforces problems are `stdin`, meaning the
program is run as a script and its stdout is compared line by line.

Two facts shape this adapter:

The release files are large. `test.jsonl` alone is about 1.2 GB and the full
cumulative `release_v6` is about 4.3 GB, almost all of it compressed test
cases. `ensure-data` streams each file once and writes a light index that
carries every field except the compressed test cases, recording the byte
offset of the source line instead. Selection and inspection then run off the
index, and a task's tests are decoded only when that task is graded.

The compressed test cases are a pickle. Upstream decodes them with a plain
`pickle.loads`, which is arbitrary code execution against a downloaded file.
The pickled object is only ever a JSON string, so this adapter decodes it with
an unpickler that refuses every global. A payload that needs one is refused
rather than executed.

WARNING: grading executes model-generated Python. Run in a sandbox or container
for untrusted models or prompts.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import pickle
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import urllib.request
import zlib
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
ADAPTER_DIR = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = Path(os.environ.get("LIVECODEBENCH_DATA_DIR", ADAPTER_DIR / "data"))
DATASET = "livecodebench/code_generation_lite"
DEFAULT_RELEASE = "release_v6"
HF_BASE = "https://huggingface.co/datasets/livecodebench/code_generation_lite/resolve/main"
CLIO = os.environ.get("CLIO_CODER_BIN", "clio-coder")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from clio_process import run_json_command
from clio_usage import fold_message_end_usage, receipt_total_tokens, run_id_from_events
from result_manifest import target_profile, write_result_manifest
from uv_command import uv_python_cmd

PYTHON_BLOCK_RE = re.compile(r"```(?:python)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)

# Upstream's release configs. The `release_vN` names are cumulative; the bare
# `vN` names are the single file added by that release, which is the cheap way
# to run only the newest, least contaminated window.
RELEASE_FILES: dict[str, tuple[str, ...]] = {}
_ALL_FILES = ("test.jsonl", "test2.jsonl", "test3.jsonl", "test4.jsonl", "test5.jsonl", "test6.jsonl")
for _index in range(1, 7):
    RELEASE_FILES[f"release_v{_index}"] = _ALL_FILES[:_index]
    RELEASE_FILES[f"v{_index}"] = (_ALL_FILES[_index - 1],)
RELEASE_FILES["release_latest"] = _ALL_FILES

# Solutions written against LeetCode starter code assume these names exist
# without importing them, exactly as the upstream harness assumes.
EXEC_PREAMBLE = textwrap.dedent(
    """\
    import sys
    import math
    import bisect
    import heapq
    import string
    import random
    import operator
    import functools
    import itertools
    import collections
    from typing import Any, Dict, List, Optional, Set, Tuple
    from collections import Counter, OrderedDict, defaultdict, deque
    from functools import cache, cmp_to_key, lru_cache, reduce
    from itertools import accumulate, combinations, permutations, product
    from heapq import heapify, heappop, heappush, heappushpop, heapreplace, nlargest, nsmallest
    from bisect import bisect_left, bisect_right, insort
    from math import comb, factorial, gcd, inf, isqrt, lcm, perm
    """
)

DEFAULT_GRADER_PACKAGES = ("sortedcontainers", "numpy")
LIGHT_FIELDS = (
    "question_title",
    "question_content",
    "platform",
    "question_id",
    "contest_id",
    "contest_date",
    "starter_code",
    "difficulty",
    "public_test_cases",
    "metadata",
)


class DataBlocked(RuntimeError):
    """Raised when the adapter is wired but required public data is absent."""


class RefusedPickle(RuntimeError):
    """Raised when a dataset payload asks the unpickler to import something."""


class _NoGlobalsUnpickler(pickle.Unpickler):
    """An unpickler that refuses every global.

    LiveCodeBench's compressed test cases are `pickle.dumps` of a JSON string,
    so a legitimate payload never needs a class, function, or module. Refusing
    all of them turns a remote-code-execution primitive into a decoder.
    """

    def find_class(self, module: str, name: str) -> Any:
        raise RefusedPickle(f"refusing to resolve {module}.{name} while decoding dataset test cases")


def livecodebench_model(model: str | None) -> str:
    return (
        model
        or os.environ.get("CLIO_CODER_PRED_MODEL")
        or os.environ.get("CLIO_CODER_MODEL")
        or os.environ.get("CLIO_CODER_MAIN_MODEL")
        or "unspecified"
    )


def livecodebench_target_profile(target: str | None, model: str | None) -> dict[str, str]:
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


def release_files(release: str) -> tuple[str, ...]:
    if release not in RELEASE_FILES:
        raise DataBlocked(f"unknown release {release}; known releases: {', '.join(sorted(RELEASE_FILES))}")
    return RELEASE_FILES[release]


def task_id_of(record: dict[str, Any]) -> str:
    return f"LiveCodeBench/{record.get('question_id')}"


def normalize_task_id(task_id: str) -> str:
    value = str(task_id).strip()
    if value.startswith("LiveCodeBench/"):
        return value
    return f"LiveCodeBench/{value}"


def task_slug(task_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", task_id)


def contest_day(record: dict[str, Any]) -> str:
    return str(record.get("contest_date") or "")[:10]


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


def index_path(data_dir: Path, release: str) -> Path:
    return data_dir / f"index-{release}.jsonl"


def build_index(data_dir: Path, release: str) -> Path:
    """Stream each release file once and record the light fields plus an offset.

    Holding the release files in memory is not an option at four gigabytes, and
    almost all of that weight is compressed test cases that only the grader
    needs. The index carries everything a prompt or a selection needs, and the
    byte offset of the line the tests came from.
    """
    out_path = index_path(data_dir, release)
    seen: set[str] = set()
    written = 0
    with out_path.open("w", encoding="utf-8") as out:
        for name in release_files(release):
            source = data_dir / name
            if not source.exists():
                raise DataBlocked(f"release file missing: {source}; run `ensure-data --release {release}`")
            with source.open("rb") as handle:
                offset = handle.tell()
                for raw in handle:
                    line_offset, offset = offset, offset + len(raw)
                    stripped = raw.strip()
                    if not stripped:
                        continue
                    record = json.loads(stripped)
                    task_id = task_id_of(record)
                    if task_id in seen:
                        continue
                    seen.add(task_id)
                    light = {field: record.get(field) for field in LIGHT_FIELDS}
                    light["task_id"] = task_id
                    light["source_file"] = name
                    light["source_offset"] = line_offset
                    out.write(json.dumps(light) + "\n")
                    written += 1
    print(f"indexed {written} problem(s) for {release} -> {out_path}", file=sys.stderr)
    return out_path


def load_problems(data_dir: Path, release: str) -> tuple[dict[str, dict[str, Any]], str]:
    path = index_path(data_dir, release)
    if not path.exists():
        raise DataBlocked(
            f"no LiveCodeBench index for {release}: {path}. "
            f"Run `ensure-data --release {release}` first."
        )
    rows = read_jsonl(path)
    problems = {str(row["task_id"]): row for row in rows}
    if not problems:
        raise DataBlocked(f"LiveCodeBench index is empty: {path}")
    return problems, str(path)


def decode_private_tests(payload: Any) -> list[dict[str, Any]]:
    """Decode a row's compressed test cases without letting the payload import.

    Some rows carry plain JSON. The rest are base64 of zlib of a pickle whose
    only content is a JSON string, so the refusing unpickler decodes every
    legitimate row and rejects any row that has been tampered with.
    """
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, str) or not payload.strip():
        return []
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, list):
        return [item for item in parsed if isinstance(item, dict)]
    raw = zlib.decompress(base64.b64decode(payload.encode("utf-8")))
    stream = io.BytesIO(raw)
    unpickler = _NoGlobalsUnpickler(stream)
    decoded = unpickler.load()
    # The upstream producer pickles exactly one JSON string. Accepting bytes,
    # a directly pickled list, or a second pickle object would broaden a
    # security-sensitive wire format for no legitimate dataset row.
    if not isinstance(decoded, str):
        raise RefusedPickle(
            f"expected a pickled JSON string for dataset test cases, got {type(decoded).__name__}"
        )
    try:
        trailing = unpickler.load()
    except EOFError:
        pass
    else:
        raise RefusedPickle(
            f"expected one pickled JSON string for dataset test cases, found trailing {type(trailing).__name__}"
        )
    try:
        parsed = json.loads(decoded)
    except json.JSONDecodeError as exc:
        raise RefusedPickle(f"pickled dataset test cases are not valid JSON: {exc}") from exc
    if not isinstance(parsed, list) or any(not isinstance(item, dict) for item in parsed):
        raise RefusedPickle("pickled dataset test cases must be a JSON array of objects")
    return parsed


def public_tests(record: dict[str, Any]) -> list[dict[str, Any]]:
    payload = record.get("public_test_cases")
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, str) or not payload.strip():
        return []
    parsed = json.loads(payload)
    return [item for item in parsed if isinstance(item, dict)] if isinstance(parsed, list) else []


def load_tests(record: dict[str, Any], data_dir: Path, which: str) -> list[dict[str, Any]]:
    tests = public_tests(record)
    if which == "public":
        return tests
    source = data_dir / str(record.get("source_file") or "")
    if not source.exists():
        raise DataBlocked(
            f"release file missing for private tests: {source}. "
            "Re-run `ensure-data`, or grade with --tests public."
        )
    with source.open("rb") as handle:
        handle.seek(int(record.get("source_offset") or 0))
        raw = handle.readline()
    full = json.loads(raw)
    return [*tests, *decode_private_tests(full.get("private_test_cases"))]


def func_name(record: dict[str, Any]) -> str | None:
    metadata = record.get("metadata")
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except json.JSONDecodeError:
            metadata = {}
    if isinstance(metadata, dict):
        name = metadata.get("func_name")
        return str(name) if name else None
    return None


def is_functional(record: dict[str, Any], tests: Sequence[dict[str, Any]]) -> bool:
    for test in tests:
        if str(test.get("testtype")) == "functional":
            return True
    return bool(str(record.get("starter_code") or "").strip())


def public_record(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "task_id": str(record.get("task_id")),
        "question_id": record.get("question_id"),
        "question_title": record.get("question_title"),
        "platform": record.get("platform"),
        "contest_id": record.get("contest_id"),
        "contest_date": record.get("contest_date"),
        "difficulty": record.get("difficulty"),
        "func_name": func_name(record),
    }


def selected_problems(
    problems: dict[str, dict[str, Any]],
    task_ids: list[str],
    platforms: list[str],
    difficulties: list[str],
    start_date: str | None,
    end_date: str | None,
    limit: int,
    offset: int,
) -> list[dict[str, Any]]:
    if task_ids:
        selected = []
        for raw in task_ids:
            task_id = normalize_task_id(raw)
            if task_id not in problems:
                raise KeyError(f"task id not found: {task_id}")
            selected.append(problems[task_id])
        return selected
    ordered = sorted(problems.values(), key=lambda record: (contest_day(record), str(record.get("question_id"))))
    if platforms:
        wanted = {name.strip().lower() for name in platforms if name.strip()}
        ordered = [record for record in ordered if str(record.get("platform", "")).lower() in wanted]
    if difficulties:
        wanted = {name.strip().lower() for name in difficulties if name.strip()}
        ordered = [record for record in ordered if str(record.get("difficulty", "")).lower() in wanted]
    if start_date:
        ordered = [record for record in ordered if contest_day(record) >= start_date]
    if end_date:
        ordered = [record for record in ordered if contest_day(record) <= end_date]
    if offset:
        ordered = ordered[offset:]
    return ordered[:limit] if limit > 0 else ordered


def ensure_data(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    data_dir.mkdir(parents=True, exist_ok=True)
    names = release_files(args.release)
    for name in names:
        destination = data_dir / name
        if destination.exists() and not args.force:
            print(f"already present: {destination}", file=sys.stderr)
            continue
        url = f"{HF_BASE}/{name}"
        print(f"downloading {url} -> {destination}", file=sys.stderr)
        temporary = destination.with_suffix(destination.suffix + ".partial")
        with urllib.request.urlopen(url, timeout=args.timeout) as response, temporary.open("wb") as out:
            shutil.copyfileobj(response, out, length=1024 * 1024)
        temporary.replace(destination)
        print(f"  {destination.stat().st_size / 1048576:.1f} MB", file=sys.stderr)
    build_index(data_dir, args.release)
    problems, source = load_problems(data_dir, args.release)
    print(json.dumps({"release": args.release, "index": source, "tasks": len(problems)}, indent=2, sort_keys=True))
    return 0


def inspect_data(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    problems, source = load_problems(data_dir, args.release)
    ordered = sorted(problems.values(), key=lambda record: contest_day(record))
    platforms: dict[str, int] = {}
    difficulties: dict[str, int] = {}
    for record in ordered:
        key = str(record.get("platform") or "unknown")
        platforms[key] = platforms.get(key, 0) + 1
        level = str(record.get("difficulty") or "unknown")
        difficulties[level] = difficulties.get(level, 0) + 1
    payload = {
        "dataset": DATASET,
        "datasetSplit": args.release,
        "index": source,
        "tasks": len(ordered),
        "byPlatform": dict(sorted(platforms.items())),
        "byDifficulty": dict(sorted(difficulties.items())),
        "firstContestDate": contest_day(ordered[0]) if ordered else None,
        "lastContestDate": contest_day(ordered[-1]) if ordered else None,
        "releaseFilesPresent": [name for name in release_files(args.release) if (data_dir / name).exists()],
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


FUNCTIONAL_CONTRACT = (
    "- `solution.py` is seeded with the required starter code. Keep the class\n"
    "  name, the method name, and the signature exactly as seeded.\n"
    "- Do not read from stdin or print anything. The grader calls the method\n"
    "  directly and compares its return value.\n"
)
STDIN_CONTRACT = (
    "- Write a complete program in `solution.py`. It is run as a script: read\n"
    "  the input from stdin and print the answer to stdout.\n"
    "- Print only the answer. Any extra output fails the comparison.\n"
)

# The template is dedented once, here, and only then interpolated. Interpolating
# first would splice multi-line values in at column zero and leave textwrap with
# no common prefix to strip, which silently indents the whole prompt.
PROMPT_TEMPLATE = textwrap.dedent(
    """\
    You are solving LiveCodeBench task {task_id} from {platform} ({difficulty}),
    contest {contest_id} on {contest_date}.

    The problem statement is in `problem.md`. Write your answer in `solution.py`.

    Constraints:
    {contract}- Use only the Python standard library, plus numpy and sortedcontainers
      if you need them.
    - Mind the stated limits. The grader runs every test case with a per-test
      timeout, so an accepted answer has to be fast enough, not just correct.
    - Do not add tests, example runners, or debug output.
    - Stop after `solution.py` contains the final answer.

    Problem statement:

    {statement}
    """
)


def render_clio_prompt(record: dict[str, Any], functional: bool) -> str:
    return PROMPT_TEMPLATE.format(
        task_id=record.get("task_id"),
        platform=record.get("platform"),
        difficulty=record.get("difficulty"),
        contest_id=record.get("contest_id"),
        contest_date=contest_day(record),
        contract=FUNCTIONAL_CONTRACT if functional else STDIN_CONTRACT,
        statement=str(record.get("question_content") or ""),
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


def seeded_solution(record: dict[str, Any], functional: bool) -> str:
    if functional:
        return str(record.get("starter_code") or "")
    return "# Read the input from stdin and print the answer to stdout.\n"


def is_untouched(record: dict[str, Any], functional: bool, text: str) -> bool:
    """Whether a solution file still holds only what the adapter seeded.

    Starter code is a class with an empty method body, so its presence alone is
    not an answer. Comparing against the seed is what separates an agent that
    edited the file from one that never opened it.
    """
    return text.strip() == seeded_solution(record, functional).strip()


def resolve_program(record: dict[str, Any], run_dir: Path, functional: bool) -> tuple[str, str]:
    """The program to grade, and where it came from.

    The task tells the agent to leave its answer in solution.py, and that file
    is the first source. An agent that answered with a code block and never
    edited the file leaves the seed exactly as written; the event stream still
    carries the answer, so it is read rather than grading the seed against
    itself. The source travels with the program because an answer recovered
    from the stream means the agent solved the task but ignored the file
    contract, and a reader must be able to subtract those from a headline
    score.
    """
    solution_path = run_dir / "solution.py"
    if solution_path.exists():
        text = solution_path.read_text(encoding="utf-8", errors="replace")
        if text.strip() and not is_untouched(record, functional, text):
            return text, "solution.py"
    extracted = extract_python_from_events(run_dir / "events" / "clio.jsonl")
    if extracted and extracted.strip():
        return extracted, "events"
    return "", "empty"


def generated_artifacts(run_dir: Path, *extra: Path) -> list[Path]:
    candidates = [
        run_dir / "metrics.jsonl",
        run_dir / "samples.jsonl",
        run_dir / "results.jsonl",
        run_dir / "result.json",
        run_dir / "solution.py",
        run_dir / "problem-public.json",
        *extra,
    ]
    tasks_dir = run_dir / "tasks"
    if tasks_dir.exists():
        candidates.extend(sorted(tasks_dir.glob("**/solution.py")))
        candidates.extend(sorted(tasks_dir.glob("**/result.json")))
    return [path for path in candidates if path.exists()]


def generate_attempt(
    record: dict[str, Any],
    data_dir: Path,
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
    functional = is_functional(record, public_tests(record))
    prompt_text = render_clio_prompt(record, functional)
    (run_dir / "prompt.md").write_text(prompt_text, encoding="utf-8")
    (run_dir / "problem.md").write_text(str(record.get("question_content") or "") + "\n", encoding="utf-8")
    (run_dir / "problem-public.json").write_text(
        json.dumps(public_record(record), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    solution_path = run_dir / "solution.py"
    if not solution_path.exists() or force:
        solution_path.write_text(seeded_solution(record, functional), encoding="utf-8")

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

    program, program_source = resolve_program(record, run_dir, functional)
    events_path = run_dir / "events" / "clio.jsonl"
    run_id = run_id_from_events(events_path)
    observed_usage = fold_message_end_usage(events_path)
    stream_tokens = None if observed_usage is None else observed_usage["totalTokens"]
    metric.update(
        {
            "task_id": str(record.get("task_id")),
            "platform": record.get("platform"),
            "difficulty": record.get("difficulty"),
            "contest_date": contest_day(record),
            "functional": functional,
            "tokens": receipt_total_tokens(run_id) or stream_tokens,
            "tokens_measured": stream_tokens is not None,
            "run_id": run_id,
            "program_bytes": len(program.encode("utf-8")),
            "program_source": program_source,
            "empty_program": not program.strip(),
        }
    )
    return metric, program


def build_functional_driver(record: dict[str, Any]) -> str:
    name = func_name(record) or ""
    return textwrap.dedent(
        f"""\

        if __name__ == "__main__":
            import json as _clio_json
            import pathlib as _clio_pathlib
            _clio_here = _clio_pathlib.Path(__file__).parent
            _clio_args = [
                _clio_json.loads(_clio_line)
                for _clio_line in _clio_here.joinpath("input.txt").read_text(encoding="utf-8").split("\\n")
                if _clio_line.strip()
            ]
            _clio_out = Solution().{name}(*_clio_args)
            _clio_here.joinpath("output.json").write_text(
                _clio_json.dumps(_clio_out, default=list), encoding="utf-8"
            )
        """
    )


def normalize_functional(value: Any) -> Any:
    """Compare shapes, not container types.

    A solution that returns a tuple where the reference is a list is the same
    answer, and the upstream comparison treats it that way. Nothing else about
    the value is relaxed.
    """
    if isinstance(value, tuple):
        return [normalize_functional(item) for item in value]
    if isinstance(value, list):
        return [normalize_functional(item) for item in value]
    return value


def compare_stdout(actual: str, expected: str) -> bool:
    actual_lines = [line.rstrip() for line in actual.strip().splitlines()]
    expected_lines = [line.rstrip() for line in expected.strip().splitlines()]
    return actual_lines == expected_lines


def run_one_test(
    work_dir: Path,
    program_path: Path,
    test: dict[str, Any],
    functional: bool,
    timeout: float,
    packages: Sequence[str],
    env: dict[str, str],
) -> dict[str, Any]:
    test_input = str(test.get("input") or "")
    expected = str(test.get("output") or "")
    output_path = work_dir / "output.json"
    if output_path.exists():
        output_path.unlink()
    (work_dir / "input.txt").write_text(test_input, encoding="utf-8")
    try:
        proc = subprocess.run(
            [*uv_python_cmd(packages), str(program_path)],
            cwd=work_dir,
            input=None if functional else test_input,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"passed": False, "reason": "timeout", "exit": 124}
    if proc.returncode != 0:
        return {"passed": False, "reason": "runtime error", "exit": proc.returncode, "stderr": proc.stderr[-1200:]}
    if not functional:
        return {
            "passed": compare_stdout(proc.stdout, expected),
            "reason": "stdout mismatch",
            "exit": 0,
        }
    if not output_path.exists():
        return {"passed": False, "reason": "no return value captured", "exit": 0, "stderr": proc.stderr[-1200:]}
    try:
        actual = json.loads(output_path.read_text(encoding="utf-8"))
        wanted = json.loads(expected)
    except json.JSONDecodeError as exc:
        return {"passed": False, "reason": f"undecodable result: {exc}", "exit": 0}
    return {"passed": normalize_functional(actual) == normalize_functional(wanted), "reason": "wrong answer", "exit": 0}


def grade_program(
    record: dict[str, Any],
    program: str,
    data_dir: Path,
    which_tests: str,
    test_timeout: float,
    packages: Sequence[str],
    max_tests: int,
) -> dict[str, Any]:
    started = time.monotonic()
    resolved = tuple(packages) if packages else DEFAULT_GRADER_PACKAGES
    functional = is_functional(record, public_tests(record))
    if not program.strip():
        return {
            "passed": False,
            "status": "fail",
            "result": "empty program",
            "tests": 0,
            "testsPassed": 0,
            "evaluator": "livecodebench.tests",
            "testSet": which_tests,
            "graderPackages": list(resolved),
            "wall_s": 0.0,
        }
    tests = load_tests(record, data_dir, which_tests)
    if max_tests > 0:
        tests = tests[:max_tests]
    if not tests:
        return {
            "passed": False,
            "status": "not_scored",
            "result": "no test cases available",
            "tests": 0,
            "testsPassed": 0,
            "evaluator": "livecodebench.tests",
            "testSet": which_tests,
            "graderPackages": list(resolved),
            "wall_s": round(time.monotonic() - started, 3),
        }
    env = dict(os.environ)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    passed_count = 0
    first_failure: dict[str, Any] | None = None
    with tempfile.TemporaryDirectory(prefix="clio-lcb-") as tmp:
        work_dir = Path(tmp)
        program_path = work_dir / "program.py"
        body = EXEC_PREAMBLE + "\n" + program
        if functional:
            body += build_functional_driver(record)
        program_path.write_text(body, encoding="utf-8")
        for index, test in enumerate(tests):
            outcome = run_one_test(work_dir, program_path, test, functional, test_timeout, resolved, env)
            if outcome.get("passed"):
                passed_count += 1
                continue
            if first_failure is None:
                first_failure = {"index": index, **outcome}
            # Upstream stops at the first failing test, and so does this: a
            # problem is accepted only when every test passes, so the rest of
            # the run cannot change the verdict and would only cost time.
            break
    passed = passed_count == len(tests)
    return {
        "passed": passed,
        "status": "pass" if passed else "fail",
        "result": "passed" if passed else (first_failure or {}).get("reason", "failed"),
        "tests": len(tests),
        "testsPassed": passed_count,
        "firstFailure": first_failure,
        "functional": functional,
        "evaluator": "livecodebench.tests",
        "testSet": which_tests,
        "graderPackages": list(resolved),
        "wall_s": round(time.monotonic() - started, 3),
    }


def grade_attempt(
    record: dict[str, Any],
    data_dir: Path,
    run_dir: Path,
    which_tests: str,
    test_timeout: float,
    packages: Sequence[str],
    max_tests: int,
) -> dict[str, Any]:
    functional = is_functional(record, public_tests(record))
    program, program_source = resolve_program(record, run_dir, functional)
    result = grade_program(record, program, data_dir, which_tests, test_timeout, packages, max_tests)
    result.update(
        {
            "task_id": str(record.get("task_id")),
            "platform": record.get("platform"),
            "difficulty": record.get("difficulty"),
            "contest_date": contest_day(record),
            "program_bytes": len(program.encode("utf-8")),
            "program_source": program_source,
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
    release: str,
    which_tests: str,
) -> dict[str, Any]:
    by_task: dict[str, list[dict[str, Any]]] = {str(record.get("task_id")): [] for record in chosen}
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

    by_difficulty: dict[str, dict[str, int]] = {}
    by_platform: dict[str, dict[str, int]] = {}
    for record in chosen:
        resolved_here = any(row.get("passed") for row in by_task.get(str(record.get("task_id")), []))
        for bucket_map, key in (
            (by_difficulty, str(record.get("difficulty") or "unknown")),
            (by_platform, str(record.get("platform") or "unknown")),
        ):
            bucket = bucket_map.setdefault(key, {"tasks": 0, "resolved": 0})
            bucket["tasks"] += 1
            if resolved_here:
                bucket["resolved"] += 1

    generation_errors = sum(
        1
        for metric in metrics_rows
        if metric.get("error")
        or metric.get("timed_out")
        or metric.get("exit") not in (0, None)
        or metric.get("empty_program")
    )
    measured_rows = [metric for metric in metrics_rows if metric.get("tokens")]
    dates = sorted(contest_day(record) for record in chosen if contest_day(record))
    return {
        "suite": "livecodebench",
        "dataset": DATASET,
        "datasetSplit": release,
        "testSet": which_tests,
        "contestDateRange": {"start": dates[0], "end": dates[-1]} if dates else None,
        "tasks": len(chosen),
        "samples": len(metrics_rows),
        "resolved": passed_tasks,
        # An error is the harness failing to obtain an answer, not a model
        # answering wrong, so a wrong answer is a failed task rather than an
        # error. This matches the sibling HumanEval and SWE-bench adapters.
        "errors": generation_errors,
        "failedTasks": len(chosen) - passed_tasks,
        "byDifficulty": dict(sorted(by_difficulty.items())),
        "byPlatform": dict(sorted(by_platform.items())),
        "programsFromEventStream": sum(1 for metric in metrics_rows if metric.get("program_source") == "events"),
        "passedSamples": sum(1 for row in grade_rows if row.get("passed")),
        "failedSamples": sum(1 for row in grade_rows if not row.get("passed")),
        "passAt": pass_at,
        "timedOut": sum(1 for metric in metrics_rows if metric.get("timed_out")),
        "emptyPrograms": sum(1 for metric in metrics_rows if metric.get("empty_program")),
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
            "LiveCodeBench pass means the generated program passed every selected test case for the problem. "
            "A public-only test set is a weaker claim than the full set and is reported as testSet."
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
    release: str,
    notes: list[str],
    *,
    inherit_provenance: bool = False,
) -> tuple[Path, Path]:
    recorded_model, recorded_profile = recorded_provenance(out_dir) if inherit_provenance else (None, None)
    return write_result_manifest(
        out_dir,
        suite="livecodebench",
        dataset=DATASET,
        dataset_split=release,
        model=recorded_model or livecodebench_model(model),
        profile=recorded_profile or livecodebench_target_profile(target, model),
        instances=len(chosen),
        resolved=int(summary.get("resolved") or 0),
        errors=int(summary.get("errors") or 0),
        artifact_paths=generated_artifacts(out_dir),
        summary=summary,
        notes=notes,
        clio_bin=CLIO,
    )


SUITE_NOTES = [
    "LiveCodeBench grading executes model-generated Python. Run this adapter in a sandbox for untrusted code.",
    "Resolved counts are task-level: a task is resolved when any generated sample passes every selected test.",
    "Compressed test cases are decoded with an unpickler that refuses every global.",
    "Restrict --start-date to a window after the model's training cutoff for a contamination-resistant number.",
]


def run_suite(args: argparse.Namespace) -> int:
    if not (args.task_id or args.limit or args.platform or args.difficulty or args.start_date or args.all):
        raise DataBlocked("select tasks with --task-id, --platform, --difficulty, --start-date, --limit, or --all")
    if args.samples_per_task < 1:
        raise ValueError("--samples-per-task must be at least 1")
    if any(k < 1 for k in args.pass_at):
        raise ValueError("--pass-at values must be at least 1")
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    problems, source = load_problems(data_dir, args.release)
    chosen = selected_problems(
        problems,
        args.task_id,
        args.platform,
        args.difficulty,
        args.start_date,
        args.end_date,
        args.limit,
        args.offset,
    )
    if not chosen:
        print("no LiveCodeBench tasks matched", file=sys.stderr)
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

    print(f"running {len(chosen)} LiveCodeBench task(s) from {source} -> {out_dir}", file=sys.stderr)
    with (
        metrics_path.open("w", encoding="utf-8") as metrics,
        samples_path.open("w", encoding="utf-8") as samples,
        results_path.open("w", encoding="utf-8") as results,
    ):
        for task_index, record in enumerate(chosen, 1):
            task_id = str(record.get("task_id"))
            for sample_id in range(args.samples_per_task):
                sample_dir = out_dir / "tasks" / task_slug(task_id) / f"sample-{sample_id:03d}"
                print(
                    f"[{task_index}/{len(chosen)}] {task_id} ({record.get('platform')}/{record.get('difficulty')}) "
                    f"sample {sample_id + 1}/{args.samples_per_task} ...",
                    file=sys.stderr,
                    flush=True,
                )
                try:
                    metric, program = generate_attempt(
                        record,
                        data_dir,
                        sample_dir,
                        args.timeout,
                        args.target,
                        args.model,
                        force=args.force,
                        dry_run=args.dry_run,
                    )
                    metric["sample_id"] = sample_id
                    sample = {"task_id": task_id, "program": program, "sample_id": sample_id}
                    grade = grade_attempt(
                        record, data_dir, sample_dir, args.tests, args.test_timeout, args.grader_with, args.max_tests
                    )
                    grade["sample_id"] = sample_id
                except DataBlocked:
                    raise
                except Exception as exc:
                    metric = {"task_id": task_id, "sample_id": sample_id, "error": str(exc)[:400], "exit": None}
                    sample = {"task_id": task_id, "program": "", "sample_id": sample_id}
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
                    f"tests={grade.get('testsPassed')}/{grade.get('tests')} tokens={metric.get('tokens')}",
                    file=sys.stderr,
                )

    summary = suite_summary(chosen, metrics_rows, grade_rows, args.pass_at, args.release, args.tests)
    manifest_path, summary_path = write_suite_manifest(
        out_dir, chosen, summary, args.model, args.target, args.release, notes=list(SUITE_NOTES)
    )
    print(f"manifest: {manifest_path}", file=sys.stderr)
    print(f"summary: {summary_path}", file=sys.stderr)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def regrade_suite(args: argparse.Namespace) -> int:
    """Rescore a finished run directory without calling a model again.

    A full release costs hours of a local fleet's time, so a change to the test
    set, the per-test timeout, or program resolution had no way to be applied
    except by generating every answer a second time. The generated attempts are
    already on disk; this reads them, regrades them, and rewrites the same
    suite artifacts the run wrote.
    """
    out_dir = Path(args.out)
    metrics_path = out_dir / "metrics.jsonl"
    if not metrics_path.exists():
        raise DataBlocked(f"no generation record to regrade: {metrics_path}")
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    problems, _ = load_problems(data_dir, args.release)
    metrics_rows = read_jsonl(metrics_path)
    ordered_ids: list[str] = []
    for row in metrics_rows:
        task_id = str(row.get("task_id", ""))
        if task_id and task_id not in ordered_ids:
            ordered_ids.append(task_id)
    missing = [task_id for task_id in ordered_ids if task_id not in problems]
    if missing:
        raise KeyError(f"task ids in {metrics_path} are not in the {args.release} index: {missing[:5]}")
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
        functional = is_functional(record, public_tests(record))
        program, program_source = resolve_program(record, sample_dir, functional)
        # The metric row is the generation record, and these three fields are
        # the part of it that describes the program rather than the run, so
        # they follow the resolution that just happened.
        metric["program_bytes"] = len(program.encode("utf-8"))
        metric["program_source"] = program_source
        metric["empty_program"] = not program.strip()
        grade = grade_attempt(
            record, data_dir, sample_dir, args.tests, args.test_timeout, args.grader_with, args.max_tests
        )
        grade["sample_id"] = sample_id
        grade_rows.append(grade)
        sample_rows.append({"task_id": task_id, "program": program, "sample_id": sample_id})
        print(f"[{index}/{len(metrics_rows)}] {task_id} pass={grade.get('passed')} source={program_source}", file=sys.stderr)

    write_jsonl(metrics_path, metrics_rows)
    write_jsonl(out_dir / "samples.jsonl", sample_rows)
    write_jsonl(out_dir / "results.jsonl", grade_rows)
    summary = suite_summary(chosen, metrics_rows, grade_rows, args.pass_at, args.release, args.tests)
    manifest_path, summary_path = write_suite_manifest(
        out_dir,
        chosen,
        summary,
        args.model,
        args.target,
        args.release,
        notes=[*SUITE_NOTES, "Rescored from the attempts already in this directory; no model was called."],
        inherit_provenance=True,
    )
    print(f"manifest: {manifest_path}", file=sys.stderr)
    print(f"summary: {summary_path}", file=sys.stderr)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def run_task(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    problems, _ = load_problems(data_dir, args.release)
    task_id = normalize_task_id(args.task_id)
    if task_id not in problems:
        raise KeyError(f"task id not found: {task_id}")
    run_dir = Path(args.out)
    if run_dir.exists() and any(run_dir.iterdir()) and not args.force:
        raise FileExistsError(f"output directory is not empty: {run_dir}; pass --force to replace it")
    metric, program = generate_attempt(
        problems[task_id],
        data_dir,
        run_dir,
        args.timeout,
        args.target,
        args.model,
        force=args.force,
        dry_run=args.dry_run,
    )
    metric["sample_id"] = 0
    write_jsonl(run_dir / "metrics.jsonl", [metric])
    write_jsonl(run_dir / "samples.jsonl", [{"task_id": task_id, "program": program, "sample_id": 0}])
    summary = {
        "suite": "livecodebench",
        "dataset": DATASET,
        "datasetSplit": args.release,
        "taskId": task_id,
        "platform": metric.get("platform"),
        "difficulty": metric.get("difficulty"),
        "generated": True,
        "resolved": 0,
        "errors": 1 if metric.get("timed_out") or metric.get("exit") not in (0, None) or metric.get("empty_program") else 0,
        "emptyProgram": bool(metric.get("empty_program")),
        "programSource": metric.get("program_source"),
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
        args.release,
        notes=["Generation-only manifest. grade-task rewrites this directory with scored results."],
    )
    print(json.dumps(metric, indent=2, sort_keys=True))
    return 0 if metric.get("exit") == 0 else 1


def grade_task(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir or DEFAULT_DATA_DIR)
    problems, _ = load_problems(data_dir, args.release)
    task_id = normalize_task_id(args.task_id)
    if task_id not in problems:
        raise KeyError(f"task id not found: {task_id}")
    run_dir = Path(args.run)
    result = grade_attempt(
        problems[task_id], data_dir, run_dir, args.tests, args.test_timeout, args.grader_with, args.max_tests
    )
    result["sample_id"] = 0
    write_jsonl(run_dir / "results.jsonl", [result])
    summary = {
        "suite": "livecodebench",
        "dataset": DATASET,
        "datasetSplit": args.release,
        "taskId": task_id,
        "testSet": args.tests,
        "samples": 1,
        "resolved": 1 if result.get("passed") else 0,
        # A failed check is a wrong answer, not a harness error; run-task
        # already recorded the generation errors this directory saw.
        "errors": 0,
        "failedTasks": 0 if result.get("passed") else 1,
        "tests": result.get("tests"),
        "testsPassed": result.get("testsPassed"),
        "programSource": result.get("program_source"),
        "passedSamples": 1 if result.get("passed") else 0,
        "failedSamples": 0 if result.get("passed") else 1,
        "passAt": {"pass@1": 1.0 if result.get("passed") else 0.0},
        "scoringRule": "LiveCodeBench pass means the generated program passed every selected test case.",
    }
    write_suite_manifest(
        run_dir,
        [problems[task_id]],
        summary,
        None,
        None,
        args.release,
        notes=["Scored against the problem's own LiveCodeBench test cases."],
        inherit_provenance=True,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result.get("passed") else 1


def add_data_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--data-dir", default=None, help=f"release files and index; default: {DEFAULT_DATA_DIR}")
    parser.add_argument(
        "--release",
        default=DEFAULT_RELEASE,
        choices=sorted(RELEASE_FILES),
        help=(
            f"dataset release; default {DEFAULT_RELEASE}. release_vN is cumulative and large "
            "(release_v6 is about 4.3 GB); a bare vN is only the file that release added"
        ),
    )


def add_selection_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--task-id", action="append", default=[], help="task id such as LiveCodeBench/abc374_c; repeatable")
    parser.add_argument("--platform", action="append", default=[], help="leetcode, atcoder, or codeforces; repeatable")
    parser.add_argument("--difficulty", action="append", default=[], help="easy, medium, or hard; repeatable")
    parser.add_argument("--start-date", default=None, help="keep contests on or after this YYYY-MM-DD")
    parser.add_argument("--end-date", default=None, help="keep contests on or before this YYYY-MM-DD")
    parser.add_argument("--limit", type=int, default=0, help="limit selected tasks")
    parser.add_argument("--offset", type=int, default=0, help="skip this many tasks before applying --limit")
    parser.add_argument("--all", action="store_true", help="run all selected/default tasks")


def add_clio_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--timeout", type=int, default=600, help="per-sample Clio wall-clock timeout in seconds")
    parser.add_argument(
        "--target",
        type=explicit_target,
        default=None,
        help="configured clio-coder target id (required unless --dry-run is used)",
    )
    parser.add_argument("--model", default=None, help="clio-coder --model override")
    parser.add_argument("--force", action="store_true", help="replace existing run directories")
    parser.add_argument("--dry-run", action="store_true", help="render prompts and seed solution.py without calling Clio")


def add_grade_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--tests",
        choices=["all", "public"],
        default="all",
        help="all is the upstream score; public grades only the visible examples and is a weaker claim",
    )
    parser.add_argument("--test-timeout", type=float, default=10.0, help="per-test-case wall-clock timeout in seconds")
    parser.add_argument("--max-tests", type=int, default=0, help="cap the test cases per task; 0 means every test")
    parser.add_argument(
        "--with",
        dest="grader_with",
        action="append",
        default=[],
        help=f"grading dependency; repeatable and replaces the default {list(DEFAULT_GRADER_PACKAGES)}",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    ensure = sub.add_parser("ensure-data", help="download a release's files and build its index")
    add_data_args(ensure)
    ensure.add_argument("--force", action="store_true", help="re-download files that are already present")
    ensure.add_argument("--timeout", type=int, default=1800)
    ensure.set_defaults(func=ensure_data)

    inspect = sub.add_parser("inspect-data", help="summarize an indexed release by platform, difficulty, and date")
    add_data_args(inspect)
    inspect.set_defaults(func=inspect_data)

    run = sub.add_parser("run", help="run and grade selected LiveCodeBench tasks")
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

    one = sub.add_parser("run-task", help="run Clio for one LiveCodeBench task")
    add_data_args(one)
    one.add_argument("--task-id", required=True)
    one.add_argument("--out", required=True)
    add_clio_args(one)
    one.set_defaults(func=run_task)

    grade = sub.add_parser("grade-task", help="grade one generated LiveCodeBench task directory")
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
